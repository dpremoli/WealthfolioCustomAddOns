import type { AddonContext } from "@wealthfolio/addon-sdk";
import { brokeredRequest } from "@wf-addons/kit";
import {
  KEY_CLIENT_ID,
  KEY_EXPIRES_AT,
  KEY_OAUTH_STATE,
  KEY_REDIRECT_URL,
  SECRET_ACCESS_TOKEN,
  SECRET_CLIENT_SECRET,
  SECRET_REFRESH_TOKEN,
  TOKEN_URL,
} from "../constants";
import type { MonzoTokenResponse } from "../types";
import {
  OAuthInputError,
  buildAuthUrl,
  codeExchangeBody,
  expiresAtFrom,
  generateState,
  parsePastedAuth,
  refreshBody,
  verifyState,
} from "./oauth";

/** Why a Monzo call cannot proceed; the UI turns each into a specific hint. */
export type MonzoAuthErrorKind =
  /** No tokens stored: connect first. */
  | "not-connected"
  /** Client id / secret / redirect URL missing (e.g. after upgrading from v1). */
  | "needs-credentials"
  /** Tokens are dead (refresh rejected / 401 after refresh): connect again. */
  | "reconnect"
  /** 403: the Monzo app approval (strong customer authentication) is still pending. */
  | "approval";

export class MonzoAuthError extends Error {
  constructor(
    readonly kind: MonzoAuthErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "MonzoAuthError";
  }
}

export const APPROVAL_MESSAGE =
  "Monzo refused access (403). Open the Monzo app and approve the access request for your " +
  "client, then try again. If you already approved it, disconnect and reconnect in Settings.";

export interface Credentials {
  clientId: string;
  redirectUrl: string;
  clientSecret: string | null;
}

export async function loadCredentials(ctx: AddonContext): Promise<Credentials> {
  const [clientId, redirectUrl, clientSecret] = await Promise.all([
    ctx.api.storage.get(KEY_CLIENT_ID),
    ctx.api.storage.get(KEY_REDIRECT_URL),
    ctx.api.secrets.get(SECRET_CLIENT_SECRET),
  ]);
  return {
    clientId: clientId?.trim() ?? "",
    redirectUrl: redirectUrl?.trim() ?? "",
    clientSecret: clientSecret?.trim() || null,
  };
}

export interface SettingsInput {
  clientId: string;
  redirectUrl: string;
  /** Left blank to keep the stored secret. */
  clientSecret?: string;
}

/** Saves the OAuth client settings; an in-flight authorisation is dropped if they changed. */
export async function saveSettings(ctx: AddonContext, input: SettingsInput): Promise<void> {
  const clientId = input.clientId.trim();
  const redirectUrl = input.redirectUrl.trim();
  const before = await loadCredentials(ctx);
  await ctx.api.storage.set(KEY_CLIENT_ID, clientId);
  await ctx.api.storage.set(KEY_REDIRECT_URL, redirectUrl);
  const secret = input.clientSecret?.trim();
  if (secret) await ctx.api.secrets.set(SECRET_CLIENT_SECRET, secret);
  if (before.clientId !== clientId || before.redirectUrl !== redirectUrl || secret) {
    await ctx.api.storage.delete(KEY_OAUTH_STATE);
  }
}

export interface ConnectionStatus {
  connected: boolean;
  /** Epoch ms the access token stops working, if known. */
  expiresAt: number | null;
  /** Client id, secret and redirect URL are all saved. */
  hasCredentials: boolean;
  hasRefreshToken: boolean;
}

/**
 * "Connected" means tokens were stored (their expiry is recorded in storage). The access
 * token itself is never read back: it is only ever referenced by key in broker requests.
 */
export async function getConnectionStatus(ctx: AddonContext): Promise<ConnectionStatus> {
  const [expiresRaw, refresh, creds] = await Promise.all([
    ctx.api.storage.get(KEY_EXPIRES_AT),
    ctx.api.secrets.get(SECRET_REFRESH_TOKEN),
    loadCredentials(ctx),
  ]);
  const expires = expiresRaw ? Number(expiresRaw) : NaN;
  return {
    connected: !!expiresRaw,
    expiresAt: Number.isFinite(expires) ? expires : null,
    hasCredentials: !!(creds.clientId && creds.clientSecret && creds.redirectUrl),
    hasRefreshToken: !!refresh,
  };
}

export async function getExpiresAt(ctx: AddonContext): Promise<number | null> {
  const raw = await ctx.api.storage.get(KEY_EXPIRES_AT);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Persists a token response: secrets for the tokens, storage for the expiry. A response
 * without a refresh token leaves any stored one untouched.
 */
export async function storeTokens(
  ctx: AddonContext,
  res: MonzoTokenResponse,
  now = Date.now(),
): Promise<void> {
  if (!res.access_token) throw new Error("Monzo's token response did not include an access token.");
  await ctx.api.secrets.set(SECRET_ACCESS_TOKEN, res.access_token);
  if (res.refresh_token) await ctx.api.secrets.set(SECRET_REFRESH_TOKEN, res.refresh_token);
  await ctx.api.storage.set(KEY_EXPIRES_AT, String(expiresAtFrom(res, now)));
}

/** Forgets the tokens (keeps the client id/secret/redirect so reconnecting is one click). */
export async function disconnect(ctx: AddonContext): Promise<void> {
  await ctx.api.secrets.delete(SECRET_ACCESS_TOKEN);
  await ctx.api.secrets.delete(SECRET_REFRESH_TOKEN);
  await ctx.api.storage.delete(KEY_EXPIRES_AT);
  await ctx.api.storage.delete(KEY_OAUTH_STATE);
}

export interface AuthorisationStart {
  url: string;
  state: string;
}

/** Generates and stores a fresh `state`, and returns the Monzo login URL for it. */
export async function beginAuthorisation(ctx: AddonContext): Promise<AuthorisationStart> {
  const creds = await loadCredentials(ctx);
  if (!creds.clientId || !creds.clientSecret || !creds.redirectUrl) {
    throw new MonzoAuthError(
      "needs-credentials",
      "Save your Monzo client ID, client secret and redirect URL first.",
    );
  }
  const state = generateState();
  await ctx.api.storage.set(KEY_OAUTH_STATE, state);
  return { url: buildAuthUrl({ clientId: creds.clientId, redirectUrl: creds.redirectUrl, state }), state };
}

/** The `state` of an in-flight authorisation, if any. */
export function pendingState(ctx: AddonContext): Promise<string | null> {
  return ctx.api.storage.get(KEY_OAUTH_STATE);
}

/** Best-effort human message out of a Monzo error body. */
function errorDetail(body: string): string {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    for (const k of ["error_description", "message", "error", "code"]) {
      if (typeof j[k] === "string" && j[k]) return j[k] as string;
    }
  } catch {
    /* not JSON */
  }
  return body.trim().slice(0, 200);
}

async function postToken(ctx: AddonContext, body: string) {
  return brokeredRequest(ctx, {
    url: TOKEN_URL,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    timeoutSecs: 30,
  });
}

function parseTokenResponse(body: string): MonzoTokenResponse {
  try {
    return JSON.parse(body) as MonzoTokenResponse;
  } catch {
    throw new Error("Monzo returned an unreadable token response.");
  }
}

/**
 * Finishes the paste-the-redirect flow: parses what the user pasted (full URL or bare
 * code), verifies `state` when present, exchanges the code and stores the tokens.
 */
export async function completeAuthorisation(ctx: AddonContext, pasted: string): Promise<void> {
  const parsed = parsePastedAuth(pasted);
  verifyState(parsed, await pendingState(ctx));

  const creds = await loadCredentials(ctx);
  if (!creds.clientId || !creds.clientSecret || !creds.redirectUrl) {
    throw new MonzoAuthError(
      "needs-credentials",
      "Save your Monzo client ID, client secret and redirect URL first.",
    );
  }
  const res = await postToken(
    ctx,
    codeExchangeBody({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      redirectUrl: creds.redirectUrl,
      code: parsed.code,
    }),
  );
  if (res.status < 200 || res.status >= 300) {
    throw new OAuthInputError(
      `Monzo rejected the code (${res.status}${errorDetail(res.body) ? `: ${errorDetail(res.body)}` : ""}). ` +
        "Codes are single-use and short-lived, and the redirect URL must match the one registered " +
        "exactly. Click Connect Monzo to get a fresh link.",
    );
  }
  const tokens = parseTokenResponse(res.body);
  // A fresh connection must not keep a refresh token from an earlier one.
  if (!tokens.refresh_token) await ctx.api.secrets.delete(SECRET_REFRESH_TOKEN);
  await storeTokens(ctx, tokens);
  await ctx.api.storage.delete(KEY_OAUTH_STATE);
}

// One refresh at a time per context: Monzo refresh tokens are single-use, so two racing
// refreshes (e.g. Settings loading accounts while a sync runs) would invalidate each other.
const inflight = new WeakMap<AddonContext, Promise<void>>();

/** Exchanges the stored refresh token for a new access token and stores the result. */
export function refreshAccessToken(ctx: AddonContext): Promise<void> {
  const running = inflight.get(ctx);
  if (running) return running;
  const p = doRefresh(ctx).finally(() => inflight.delete(ctx));
  inflight.set(ctx, p);
  return p;
}

async function doRefresh(ctx: AddonContext): Promise<void> {
  const [creds, refreshToken] = await Promise.all([
    loadCredentials(ctx),
    ctx.api.secrets.get(SECRET_REFRESH_TOKEN),
  ]);
  if (!refreshToken) {
    throw new MonzoAuthError(
      "reconnect",
      "Monzo did not give this connection a refresh token, so it cannot renew itself. " +
        "Reconnect in Settings (use a Confidential OAuth client).",
    );
  }
  if (!creds.clientId || !creds.clientSecret) {
    throw new MonzoAuthError(
      "needs-credentials",
      "Enter your Monzo client ID and client secret in Settings so the saved connection can be renewed.",
    );
  }
  const res = await postToken(
    ctx,
    refreshBody({ clientId: creds.clientId, clientSecret: creds.clientSecret, refreshToken }),
  );
  if (res.status < 200 || res.status >= 300) {
    const detail = errorDetail(res.body);
    if (res.status >= 400 && res.status < 500) {
      throw new MonzoAuthError(
        "reconnect",
        `Monzo rejected the saved refresh token (${res.status}${detail ? `: ${detail}` : ""}). ` +
          "Check the client ID and secret match the ones used to connect, or reconnect in Settings.",
      );
    }
    throw new Error(`Monzo token refresh failed (${res.status}${detail ? `: ${detail}` : ""}).`);
  }
  await storeTokens(ctx, parseTokenResponse(res.body));
}

