import type { AddonContext } from "@wealthfolio/addon-sdk";
import { migrateSecretsToStorage } from "@wf-addons/kit";
import {
  KEY_CATEGORY_LABELS,
  KEY_EXPIRES_AT,
  KEY_LAST_SYNC,
  KEY_MAPPING,
  LEGACY_PROXY_URL_KEY,
  LEGACY_TOKENS_KEY,
  SECRET_ACCESS_TOKEN,
  SECRET_REFRESH_TOKEN,
} from "../constants";

interface LegacyTokens {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

/**
 * v1.x kept everything in the keyring (secrets). This moves what is not a secret to
 * add-on storage (mapping, last-sync watermark, category labels), splits the old tokens
 * JSON into the v2 secrets plus a storage expiry, and drops the proxy URL. Idempotent:
 * safe to run on every enable, and never overwrites a connection made with v2.
 *
 * Carried-over tokens can only be renewed once the user re-enters the same client id and
 * secret in Settings (v1 kept those in the proxy, not in Wealthfolio).
 */
export async function migrateFromV1(ctx: AddonContext): Promise<void> {
  await migrateSecretsToStorage(ctx, [KEY_MAPPING, KEY_LAST_SYNC, KEY_CATEGORY_LABELS]);

  const legacy = await ctx.api.secrets.get(LEGACY_TOKENS_KEY);
  if (legacy) {
    const alreadyConnected = await ctx.api.storage.get(KEY_EXPIRES_AT);
    if (!alreadyConnected) {
      let tokens: LegacyTokens | null = null;
      try {
        tokens = JSON.parse(legacy) as LegacyTokens;
      } catch {
        ctx.api.logger.warn("Monzo: ignoring unreadable v1 token blob.");
      }
      if (tokens?.access_token) {
        await ctx.api.secrets.set(SECRET_ACCESS_TOKEN, tokens.access_token);
        if (tokens.refresh_token) await ctx.api.secrets.set(SECRET_REFRESH_TOKEN, tokens.refresh_token);
        // Unknown expiry is treated as already expired so the first call refreshes (or says what is missing).
        await ctx.api.storage.set(KEY_EXPIRES_AT, String(Number(tokens.expires_at) || 0));
      }
    }
    await ctx.api.secrets.delete(LEGACY_TOKENS_KEY);
  }

  // The proxy is gone; the URL is dead weight.
  await ctx.api.secrets.delete(LEGACY_PROXY_URL_KEY);
}

const running = new WeakMap<AddonContext, Promise<void>>();

/** Starts the migration once per context and returns the shared promise. */
export function ensureMigrated(ctx: AddonContext): Promise<void> {
  let p = running.get(ctx);
  if (!p) {
    p = migrateFromV1(ctx).catch((err) => {
      ctx.api.logger.warn(`Monzo settings migration failed: ${(err as Error).message}`);
    });
    running.set(ctx, p);
  }
  return p;
}
