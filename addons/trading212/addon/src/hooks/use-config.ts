import type { AddonContext } from "@wealthfolio/addon-sdk";
import type {
  AccountSummary,
  ConnectionSyncState,
  T212Config,
  T212Connection,
  T212Settings,
  T212TrackingMode,
} from "../types";

/** Wealthfolio account `provider` tag for accounts this addon creates. */
export const PROVIDER = "trading212-addon";

export const KEYS = {
  settings: "t212_settings",
  connections: "t212_connections",
  // v2 invalidates pre-1.7.1 entries that picked the wrong cross-listing (e.g.
  // TSM_US_EQ → TSMN.MX) before currency-aware resolution.
  symbolMap: "t212_symbol_map_v2",
  legacySymbolMap: "t212_symbol_map",
  // Legacy single-account keys — read once during migration, then deleted.
  legacyConfig: "t212_config",
  legacyAccountId: "t212_account_id",
  legacyLastSync: "t212_last_sync",
  legacyImportedRefs: "t212_imported_refs",
} as const;

const syncKey = (id: string) => `t212_sync_${id}`;

/** Generates a unique id. Wealthfolio's webview lacks crypto.randomUUID (it
 *  requires a secure context), so fall back to getRandomValues, then Math.random. */
export function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return `t212-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// --- shared settings -----------------------------------------------------

export async function getSettings(ctx: AddonContext): Promise<T212Settings | null> {
  return parse<T212Settings | null>(await ctx.api.secrets.get(KEYS.settings), null);
}

export async function setSettings(ctx: AddonContext, s: T212Settings): Promise<void> {
  await ctx.api.secrets.set(KEYS.settings, JSON.stringify(s));
}

// --- connections (whole-array CRUD) --------------------------------------

export async function getConnections(ctx: AddonContext): Promise<T212Connection[]> {
  return parse<T212Connection[]>(await ctx.api.secrets.get(KEYS.connections), []);
}

async function saveConnections(ctx: AddonContext, conns: T212Connection[]): Promise<void> {
  await ctx.api.secrets.set(KEYS.connections, JSON.stringify(conns));
}

export async function addConnection(ctx: AddonContext, conn: T212Connection): Promise<void> {
  const conns = await getConnections(ctx);
  conns.push(conn);
  await saveConnections(ctx, conns);
}

export async function updateConnection(
  ctx: AddonContext,
  id: string,
  patch: Partial<T212Connection>,
): Promise<void> {
  const conns = await getConnections(ctx);
  const next = conns.map((c) => (c.id === id ? { ...c, ...patch, id: c.id } : c));
  await saveConnections(ctx, next);
}

/** Forgets the credentials + sync state. The Wealthfolio account is left intact
 *  (the SDK has no accounts.delete); the user removes it natively if desired. */
export async function removeConnection(ctx: AddonContext, id: string): Promise<void> {
  const conns = await getConnections(ctx);
  await saveConnections(ctx, conns.filter((c) => c.id !== id));
  await ctx.api.secrets.delete(syncKey(id));
}

/** Finds the Wealthfolio account previously created for this Trading 212 account
 *  (matched by providerAccountId), or creates one. Returns its Wealthfolio id. */
export async function ensureProviderAccount(
  ctx: AddonContext,
  name: string,
  summary: AccountSummary,
  trackingMode: T212TrackingMode = "TRANSACTIONS",
): Promise<string> {
  const accounts = await ctx.api.accounts.getAll();
  const providerId = String(summary.id);
  const match = accounts.find(
    (a) => (a as { providerAccountId?: string }).providerAccountId === providerId,
  );
  if (match) return match.id;

  const created = await ctx.api.accounts.create({
    name,
    accountType: "SECURITIES",
    currency: summary.currency || "GBP",
    isDefault: false,
    isActive: true,
    trackingMode,
    provider: PROVIDER,
    providerAccountId: providerId,
  });
  return created.id;
}

/** Removes all data this add-on synced into an account under a given mode, then
 *  resets the connection's sync state. Used when a tracking-mode change is detected
 *  and confirmed: the stale data from the previous mode is cleared before re-syncing. */
export async function clearAccountData(
  ctx: AddonContext,
  connectionId: string,
  accountId: string,
  mode: T212TrackingMode,
): Promise<void> {
  if (mode === "HOLDINGS") {
    const snapshots = await ctx.api.snapshots.getAll(accountId);
    for (const s of snapshots) await ctx.api.snapshots.delete(accountId, s.snapshotDate);
  } else {
    const activities = await ctx.api.activities.getAll(accountId);
    const ids = activities.map((a) => a.id).filter((id): id is string => Boolean(id));
    // Chunk deletes so a large history stays under the backend's batch limit.
    for (let i = 0; i < ids.length; i += CLEAR_CHUNK_SIZE) {
      await ctx.api.activities.saveMany({ deleteIds: ids.slice(i, i + CLEAR_CHUNK_SIZE) });
    }
  }
  await resetSyncState(ctx, connectionId);
}

const CLEAR_CHUNK_SIZE = 100;

/** Builds the proxy-client config for one connection from the shared settings. */
export function connectionConfig(settings: T212Settings, conn: T212Connection): T212Config {
  return {
    proxyUrl: settings.proxyUrl,
    env: settings.env,
    apiKey: conn.apiKey,
    apiSecret: conn.apiSecret,
  };
}

// --- per-connection sync state -------------------------------------------

export async function getSyncState(
  ctx: AddonContext,
  id: string,
): Promise<ConnectionSyncState> {
  return parse<ConnectionSyncState>(await ctx.api.secrets.get(syncKey(id)), {
    lastSync: null,
    importedRefs: [],
  });
}

export async function setLastSync(ctx: AddonContext, id: string, iso: string): Promise<void> {
  const state = await getSyncState(ctx, id);
  state.lastSync = iso;
  await ctx.api.secrets.set(syncKey(id), JSON.stringify(state));
}

export async function setBackfillCheckpoint(
  ctx: AddonContext,
  id: string,
  iso: string | null,
): Promise<void> {
  const state = await getSyncState(ctx, id);
  state.backfillCheckpoint = iso;
  await ctx.api.secrets.set(syncKey(id), JSON.stringify(state));
}

export async function getImportedRefs(ctx: AddonContext, id: string): Promise<Set<string>> {
  const state = await getSyncState(ctx, id);
  return new Set(state.importedRefs);
}

export async function addImportedRefs(
  ctx: AddonContext,
  id: string,
  refs: string[],
): Promise<void> {
  if (refs.length === 0) return;
  const state = await getSyncState(ctx, id);
  const set = new Set(state.importedRefs);
  for (const r of refs) set.add(r);
  state.importedRefs = [...set];
  await ctx.api.secrets.set(syncKey(id), JSON.stringify(state));
}

export async function resetSyncState(ctx: AddonContext, id: string): Promise<void> {
  await ctx.api.secrets.delete(syncKey(id));
}

// --- shared symbol map (account-independent) -----------------------------

export async function getSymbolMap(ctx: AddonContext): Promise<Record<string, string>> {
  return parse<Record<string, string>>(await ctx.api.secrets.get(KEYS.symbolMap), {});
}

export async function setSymbolMap(
  ctx: AddonContext,
  map: Record<string, string>,
): Promise<void> {
  await ctx.api.secrets.set(KEYS.symbolMap, JSON.stringify(map));
}

// --- one-time migration from the single-account layout -------------------

/** Converts the legacy single-key layout into one connection. Idempotent. */
export async function migrateLegacyConfig(ctx: AddonContext): Promise<void> {
  // Drop the pre-1.7.1 symbol cache regardless — its entries may point at the
  // wrong cross-listing (resolved before the currency filter existed).
  await ctx.api.secrets.delete(KEYS.legacySymbolMap);

  const [settings, connections] = [await getSettings(ctx), await getConnections(ctx)];
  if (settings || connections.length > 0) return; // already migrated

  const legacy = parse<T212Config | null>(
    await ctx.api.secrets.get(KEYS.legacyConfig),
    null,
  );
  const legacyAccountId = await ctx.api.secrets.get(KEYS.legacyAccountId);
  if (!legacy || !legacyAccountId) return; // nothing to migrate

  await setSettings(ctx, { proxyUrl: legacy.proxyUrl, env: legacy.env });

  const id = randomId();
  await addConnection(ctx, {
    id,
    name: "Trading 212 (Invest)",
    apiKey: legacy.apiKey,
    apiSecret: legacy.apiSecret,
    accountId: legacyAccountId,
  });

  const lastSync = parse<string | null>(await ctx.api.secrets.get(KEYS.legacyLastSync), null);
  const importedRefs = parse<string[]>(await ctx.api.secrets.get(KEYS.legacyImportedRefs), []);
  await ctx.api.secrets.set(syncKey(id), JSON.stringify({ lastSync, importedRefs }));

  await ctx.api.secrets.delete(KEYS.legacyConfig);
  await ctx.api.secrets.delete(KEYS.legacyAccountId);
  await ctx.api.secrets.delete(KEYS.legacyLastSync);
  await ctx.api.secrets.delete(KEYS.legacyImportedRefs);
}
