import type { AddonContext } from "@wealthfolio/addon-sdk";

type KeyValueApi = Pick<AddonContext["api"]["storage"], "get" | "set" | "delete">;

/**
 * Typed JSON wrapper over a string key/value API — `ctx.api.storage` for settings
 * and sync state, `ctx.api.secrets` for credentials.
 */
export function jsonStore(api: KeyValueApi) {
  return {
    async get<T>(key: string, fallback: T): Promise<T> {
      const raw = await api.get(key);
      if (raw === null || raw === undefined || raw === "") return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    },
    set<T>(key: string, value: T): Promise<void> {
      return api.set(key, JSON.stringify(value));
    },
    delete(key: string): Promise<void> {
      return api.delete(key);
    },
  };
}

/**
 * One-time move of non-secret values that pre-3.6 builds kept in the keyring
 * (`secrets`) into durable add-on storage. A key is moved only when storage has no
 * value yet, then removed from secrets. Values are copied verbatim (they were
 * already JSON or plain strings). Safe to call on every start.
 */
export async function migrateSecretsToStorage(ctx: AddonContext, keys: string[]): Promise<string[]> {
  const moved: string[] = [];
  for (const key of keys) {
    const legacy = await ctx.api.secrets.get(key);
    if (legacy === null || legacy === undefined) continue;
    const current = await ctx.api.storage.get(key);
    if (current === null || current === undefined) {
      await ctx.api.storage.set(key, legacy);
      moved.push(key);
    }
    await ctx.api.secrets.delete(key);
  }
  return moved;
}
