import type { AddonContext } from "@wealthfolio/addon-sdk";
import type { MonzoTokens } from "../types";

const TOKENS_KEY = "monzo_tokens";

export async function getTokens(ctx: AddonContext): Promise<MonzoTokens | null> {
  const raw = await ctx.api.secrets.get(TOKENS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MonzoTokens;
  } catch {
    return null;
  }
}

export async function setTokens(ctx: AddonContext, tokens: MonzoTokens): Promise<void> {
  await ctx.api.secrets.set(TOKENS_KEY, JSON.stringify(tokens));
}

export async function clearTokens(ctx: AddonContext): Promise<void> {
  await ctx.api.secrets.delete(TOKENS_KEY);
}

export function isTokenExpired(tokens: MonzoTokens): boolean {
  // 5-minute buffer before 6-hour Monzo token expiry
  return Date.now() > tokens.expires_at - 300_000;
}
