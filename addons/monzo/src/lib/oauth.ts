import { AUTH_URL } from "../constants";
import type { MonzoTokenResponse } from "../types";

/** Raised for input the user can fix (bad paste, wrong state, Monzo said no). */
export class OAuthInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthInputError";
  }
}

/** Random, unguessable `state` (128 bits, hex) for one authorisation attempt. */
export function generateState(
  random: Pick<Crypto, "getRandomValues"> = globalThis.crypto,
): string {
  const bytes = random.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface AuthUrlParams {
  clientId: string;
  redirectUrl: string;
  state: string;
}

/** The URL the user opens in a browser to start the Monzo login (email magic link). */
export function buildAuthUrl({ clientId, redirectUrl, state }: AuthUrlParams): string {
  const qs = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUrl,
    response_type: "code",
    state,
  });
  return `${AUTH_URL}?${qs.toString()}`;
}

export interface PastedAuth {
  code: string;
  /** The redirect's `state`, when the user pasted the whole redirect URL (or query string). */
  state?: string;
  /** True when a URL or query string was pasted (which must then carry `state`). */
  structured?: boolean;
}

/**
 * Accepts whatever the user copied after approving: the full redirect URL
 * (`https://localhost/monzo-callback?code=...&state=...`), just its query string, or the
 * bare `code`. Throws {@link OAuthInputError} when Monzo reported an error or no code is found.
 */
export function parsePastedAuth(input: string): PastedAuth {
  const raw = input.trim().replace(/^["'<]+|["'>]+$/g, "");
  if (!raw) throw new OAuthInputError("Paste the URL your browser ended up on, or the code from it.");

  const looksStructured = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /[?&]?(code|error)=/i.test(raw);
  if (!looksStructured) return { code: raw };

  // Query string may follow a "?" in a URL, or be pasted on its own ("code=...&state=...").
  const afterQuestion = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw;
  const query = afterQuestion.split("#")[0];
  const params = new URLSearchParams(query);

  const error = params.get("error");
  if (error) {
    const detail = params.get("error_description");
    throw new OAuthInputError(`Monzo reported an error: ${detail ? `${error} (${detail})` : error}.`);
  }
  const code = params.get("code");
  if (!code) {
    if (/auth\.monzo\.com/i.test(raw) || params.get("response_type") === "code") {
      throw new OAuthInputError(
        "That is the Monzo login link itself. Open it in your browser, log in via the email " +
          "Monzo sends you, then paste the address your browser ends up on (your redirect URL " +
          "with ?code=… in it).",
      );
    }
    throw new OAuthInputError("No authorisation code found in what you pasted.");
  }
  return { code, state: params.get("state") ?? undefined, structured: true };
}

/**
 * Checks a pasted `state` against the one generated for this attempt. A bare code carries
 * no state, so there is nothing to compare; a pasted redirect URL must carry the state
 * (Monzo always echoes it back) and it must match exactly.
 */
export function verifyState(pasted: PastedAuth, expected: string | null | undefined): void {
  if (pasted.state === undefined) {
    if (!pasted.structured) return;
    throw new OAuthInputError(
      "The pasted URL has no state, so it cannot be checked against this connection attempt. " +
        "Paste the full address your browser ended up on, or just the code.",
    );
  }
  if (!expected) {
    throw new OAuthInputError("No connection is in progress. Click Connect Monzo to start again.");
  }
  if (pasted.state !== expected) {
    throw new OAuthInputError(
      "The state in the pasted URL does not match this connection attempt. Click Connect Monzo to start again and use the newest link.",
    );
  }
}

export interface CodeExchangeParams {
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  code: string;
}

/** `application/x-www-form-urlencoded` body for the authorization-code grant. */
export function codeExchangeBody(p: CodeExchangeParams): string {
  return new URLSearchParams({
    grant_type: "authorization_code",
    client_id: p.clientId,
    client_secret: p.clientSecret,
    redirect_uri: p.redirectUrl,
    code: p.code,
  }).toString();
}

export interface RefreshParams {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** `application/x-www-form-urlencoded` body for the refresh-token grant. */
export function refreshBody(p: RefreshParams): string {
  return new URLSearchParams({
    grant_type: "refresh_token",
    client_id: p.clientId,
    client_secret: p.clientSecret,
    refresh_token: p.refreshToken,
  }).toString();
}

/** Monzo issues 6-hour access tokens; used when a response omits `expires_in`. */
export const DEFAULT_EXPIRES_IN_SECS = 21_600;

/** Epoch ms at which the token from `res` expires. */
export function expiresAtFrom(res: MonzoTokenResponse, now = Date.now()): number {
  const secs = Number(res.expires_in);
  return now + (Number.isFinite(secs) && secs > 0 ? secs : DEFAULT_EXPIRES_IN_SECS) * 1000;
}

/** Refresh the access token this long before it actually expires. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

export function isExpiring(expiresAt: number | null, now = Date.now()): boolean {
  return expiresAt !== null && now >= expiresAt - REFRESH_SKEW_MS;
}
