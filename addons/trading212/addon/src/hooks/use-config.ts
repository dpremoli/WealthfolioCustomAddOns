import type { AddonContext } from "@wealthfolio/addon-sdk";
import type { T212Config } from "../types";

export const KEYS = {
  config: "t212_config",
  accountId: "t212_account_id",
  lastSync: "t212_last_sync",
  symbolMap: "t212_symbol_map",
  importedRefs: "t212_imported_refs",
} as const;

export async function getConfig(ctx: AddonContext): Promise<T212Config | null> {
  const raw = await ctx.api.secrets.get(KEYS.config);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T212Config;
  } catch {
    return null;
  }
}

export async function setConfig(ctx: AddonContext, config: T212Config): Promise<void> {
  await ctx.api.secrets.set(KEYS.config, JSON.stringify(config));
}

export async function clearConfig(ctx: AddonContext): Promise<void> {
  await ctx.api.secrets.delete(KEYS.config);
}

export async function getAccountId(ctx: AddonContext): Promise<string | null> {
  return ctx.api.secrets.get(KEYS.accountId);
}

export async function setAccountId(ctx: AddonContext, id: string): Promise<void> {
  await ctx.api.secrets.set(KEYS.accountId, id);
}

export async function getLastSync(ctx: AddonContext): Promise<string | null> {
  const raw = await ctx.api.secrets.get(KEYS.lastSync);
  return raw ? (JSON.parse(raw) as string) : null;
}

export async function setLastSync(ctx: AddonContext, iso: string): Promise<void> {
  await ctx.api.secrets.set(KEYS.lastSync, JSON.stringify(iso));
}

export async function resetSyncState(ctx: AddonContext): Promise<void> {
  await ctx.api.secrets.delete(KEYS.lastSync);
  await ctx.api.secrets.delete(KEYS.importedRefs);
  await ctx.api.secrets.delete(KEYS.symbolMap);
}

export async function getSymbolMap(ctx: AddonContext): Promise<Record<string, string>> {
  const raw = await ctx.api.secrets.get(KEYS.symbolMap);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function setSymbolMap(
  ctx: AddonContext,
  map: Record<string, string>,
): Promise<void> {
  await ctx.api.secrets.set(KEYS.symbolMap, JSON.stringify(map));
}

export async function getImportedRefs(ctx: AddonContext): Promise<Set<string>> {
  const raw = await ctx.api.secrets.get(KEYS.importedRefs);
  if (!raw) return new Set();
  try {
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

export async function addImportedRefs(ctx: AddonContext, refs: string[]): Promise<void> {
  if (refs.length === 0) return;
  const existing = await getImportedRefs(ctx);
  for (const r of refs) existing.add(r);
  await ctx.api.secrets.set(KEYS.importedRefs, JSON.stringify([...existing]));
}
