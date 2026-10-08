import type { AddonContext } from "@wealthfolio/addon-sdk";
import { jsonStore, migrateSecretsToStorage } from "@wf-addons/kit";
import {
  KEYS,
  PROVIDER,
  V1_KEYS,
  authSecretKey,
  pendingAuthSecretKey,
  syncKey,
} from "../constants";
import { Trading212Client } from "../lib/t212-client";
import type {
  AccountSummary,
  ConnectionSyncState,
  T212Config,
  T212Connection,
  T212Env,
  T212Settings,
  T212TrackingMode,
} from "../types";

export { KEYS, PROVIDER };

/** Typed JSON access to add-on storage (settings, connections, sync state, symbol map). */
const store = (ctx: AddonContext) => jsonStore(ctx.api.storage);
/** Typed JSON access to the keyring — credentials, plus the v1 layout read once by the migration. */
const vault = (ctx: AddonContext) => jsonStore(ctx.api.secrets);

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

// --- shared settings -----------------------------------------------------

export async function getSettings(ctx: AddonContext): Promise<T212Settings | null> {
  return store(ctx).get<T212Settings | null>(KEYS.settings, null);
}

export async function setSettings(ctx: AddonContext, s: T212Settings): Promise<void> {
  await store(ctx).set(KEYS.settings, s);
}

// --- connections (whole-array CRUD; no credentials) ----------------------

export async function getConnections(ctx: AddonContext): Promise<T212Connection[]> {
  return store(ctx).get<T212Connection[]>(KEYS.connections, []);
}

async function saveConnections(ctx: AddonContext, conns: T212Connection[]): Promise<void> {
  await store(ctx).set(KEYS.connections, conns);
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
  await store(ctx).delete(syncKey(id));
  await ctx.api.secrets.delete(authSecretKey(id));
  await ctx.api.secrets.delete(pendingAuthSecretKey(id));
}

// --- credentials (secrets) -----------------------------------------------

/**
 * Encodes API key ID + secret as the base64 `keyId:secret` value the network broker
 * expects for `auth: { type: "basic" }` (the host prepends `Basic `).
 */
export function encodeCredentials(keyId: string, secret: string): string {
  const id = keyId.trim();
  const sec = secret.trim();
  if (!id || !sec) throw new Error("Enter both the API key ID and the API secret.");
  try {
    return btoa(`${id}:${sec}`);
  } catch {
    throw new Error("The API key ID and secret must be plain ASCII text.");
  }
}

/** Last 4 characters of a key ID, kept for display only. */
export function keyIdLast4(keyId: string): string {
  return keyId.trim().slice(-4);
}

/**
 * Checks new credentials against Trading 212 (`account/summary`) by storing them under a
 * temporary secret, so a typo can't clobber working credentials. The temporary secret is
 * always removed. Throws "UNAUTHORIZED" on a 401.
 */
export async function verifyCredentials(
  ctx: AddonContext,
  env: T212Env,
  connectionId: string,
  keyId: string,
  secret: string,
): Promise<AccountSummary> {
  const pending = pendingAuthSecretKey(connectionId);
  await ctx.api.secrets.set(pending, encodeCredentials(keyId, secret));
  try {
    return await new Trading212Client(ctx, { env, secretKey: pending }).getAccountSummary();
  } finally {
    await ctx.api.secrets.delete(pending);
  }
}

/** Installs verified credentials for a connection and clears its `needsCredentials` flag. */
export async function saveCredentials(
  ctx: AddonContext,
  connectionId: string,
  keyId: string,
  secret: string,
): Promise<void> {
  await ctx.api.secrets.set(authSecretKey(connectionId), encodeCredentials(keyId, secret));
  const conns = await getConnections(ctx);
  if (conns.some((c) => c.id === connectionId)) {
    await updateConnection(ctx, connectionId, {
      keyIdLast4: keyIdLast4(keyId),
      needsCredentials: undefined,
    });
  }
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

/** Finds (or creates) the dedicated "<name> Card" account that receives this connection's
 *  card spending, and records its id on the connection. Deduped by a `${summary.id}-card`
 *  providerAccountId so it never collides with the investing account. `accountType` defaults
 *  to CASH (debit-card accurate); CREDIT_CARD models it as a credit-card liability. The type is
 *  only applied at creation — there's no accounts.update, so changing the setting later won't
 *  retype an existing card account (do that in Wealthfolio's Update Account dialog). */
export async function ensureCardAccount(
  ctx: AddonContext,
  conn: T212Connection,
  summary: AccountSummary,
  accountType: "CASH" | "CREDIT_CARD" = "CASH",
): Promise<string> {
  const providerId = `${summary.id}-card`;
  const accounts = await ctx.api.accounts.getAll();
  const match = accounts.find(
    (a) => (a as { providerAccountId?: string }).providerAccountId === providerId,
  );
  if (match) {
    if (conn.cardAccountId !== match.id) await updateConnection(ctx, conn.id, { cardAccountId: match.id });
    return match.id;
  }

  const created = await ctx.api.accounts.create({
    name: `${conn.name} Card`,
    accountType,
    currency: summary.currency || "GBP",
    isDefault: false,
    isActive: true,
    trackingMode: "TRANSACTIONS",
    provider: PROVIDER,
    providerAccountId: providerId,
  });
  await updateConnection(ctx, conn.id, { cardAccountId: created.id });
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

/** Builds the API-client config for one connection from the shared settings. */
export function connectionConfig(settings: T212Settings, conn: T212Connection): T212Config {
  return { env: settings.env, secretKey: authSecretKey(conn.id) };
}

// --- per-connection sync state -------------------------------------------

/**
 * Whether a connection is an Invest or a Stocks ISA account. Trading 212's API doesn't say,
 * so it is chosen when connecting; connections carried over from v1 have no choice recorded
 * and are recognised by name ("Trading 212 (ISA)", "My ISA", …).
 */
export function connectionKind(conn: Pick<T212Connection, "kind" | "name">): "invest" | "isa" {
  return conn.kind ?? (/\bisa\b/i.test(conn.name) ? "isa" : "invest");
}

export const kindLabel = (kind: "invest" | "isa") => (kind === "isa" ? "Stocks ISA" : "Invest");

/**
 * The card account a connection's card spending is currently synced into: only while card
 * extraction is on, and never for a Stocks ISA (no card; an older version could still have
 * recorded one).
 */
export function activeCardAccountId(
  conn: T212Connection,
  settings: Pick<T212Settings, "extractCard"> | null | undefined,
): string | undefined {
  return settings?.extractCard && connectionKind(conn) !== "isa" ? conn.cardAccountId : undefined;
}

export async function getSyncState(
  ctx: AddonContext,
  id: string,
): Promise<ConnectionSyncState> {
  return store(ctx).get<ConnectionSyncState>(syncKey(id), { lastSync: null, importedRefs: [] });
}

async function patchSyncState(
  ctx: AddonContext,
  id: string,
  patch: Partial<ConnectionSyncState>,
): Promise<void> {
  const state = await getSyncState(ctx, id);
  await store(ctx).set(syncKey(id), { ...state, ...patch });
}

export function setLastSync(ctx: AddonContext, id: string, iso: string): Promise<void> {
  return patchSyncState(ctx, id, { lastSync: iso });
}

export function setBackfillCheckpoint(
  ctx: AddonContext,
  id: string,
  iso: string | null,
): Promise<void> {
  return patchSyncState(ctx, id, { backfillCheckpoint: iso });
}

export function setBackfillStartedAt(
  ctx: AddonContext,
  id: string,
  iso: string | null,
): Promise<void> {
  return patchSyncState(ctx, id, { backfillStartedAt: iso });
}

export function setCardLastSync(ctx: AddonContext, id: string, iso: string): Promise<void> {
  return patchSyncState(ctx, id, { cardLastSync: iso });
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
  await store(ctx).set(syncKey(id), { ...state, importedRefs: [...set] });
}

export async function resetSyncState(ctx: AddonContext, id: string): Promise<void> {
  await store(ctx).delete(syncKey(id));
}

// --- shared symbol map (account-independent) -----------------------------

export async function getSymbolMap(ctx: AddonContext): Promise<Record<string, string>> {
  return store(ctx).get<Record<string, string>>(KEYS.symbolMap, {});
}

export async function setSymbolMap(
  ctx: AddonContext,
  map: Record<string, string>,
): Promise<void> {
  await store(ctx).set(KEYS.symbolMap, map);
}

// --- one-time migration: v1 (everything in the keyring) → v2 --------------

/** v1 connection record as stored in the keyring: credentials inline. */
interface V1Connection extends Omit<T212Connection, "keyIdLast4" | "needsCredentials"> {
  apiKey?: string;
  apiSecret?: string;
}

/** v1 shared settings (the proxy URL is dropped; everything else carries over). */
interface V1Settings extends Partial<T212Settings> {
  proxyUrl?: string;
}

/** The pre-multi-account single-key layout. */
interface V1LegacyConfig {
  proxyUrl?: string;
  env?: T212Env;
  apiKey?: string;
  apiSecret?: string;
}

export interface MigrationReport {
  /** True when any v1 data was found and moved. */
  migrated: boolean;
  /** Connections kept but flagged `needsCredentials` (legacy single-key, no secret). */
  needsCredentials: number;
}

/**
 * Moves the v1 layout to v2 and deletes what it moved. Idempotent and crash-safe: every
 * write is skipped when the destination already has a value, and the v1 secrets that act
 * as the "not yet migrated" marker (`t212_connections`, then `t212_settings`) are deleted
 * last, so an interrupted run simply redoes the remaining steps.
 *
 *  - connections list → storage, WITHOUT the key/secret (keeps a masked last-4 of the key ID)
 *  - key ID + secret → secret `t212_auth_<id>` as base64(`keyId:secret`)
 *  - connections with only a legacy single key (no secret) → kept, flagged `needsCredentials`
 *  - shared settings (minus `proxyUrl`), per-connection sync state, symbol map → storage
 *  - the even older single-account layout (`t212_config` + `t212_account_id`) is folded in too
 */
export async function migrateV1ToV2(ctx: AddonContext): Promise<MigrationReport> {
  const keyring = vault(ctx);
  const db = store(ctx);
  const report: MigrationReport = { migrated: false, needsCredentials: 0 };

  // Superseded symbol caches are simply dropped.
  for (const k of V1_KEYS.oldSymbolMaps) await ctx.api.secrets.delete(k);

  let v1Settings = await keyring.get<V1Settings | null>(V1_KEYS.settings, null);
  let v1Conns = await keyring.get<V1Connection[]>(V1_KEYS.connections, []);
  let legacySingle = false;

  // Even older layout: a single key/secret + account id, no connections list.
  if (v1Conns.length === 0 && !v1Settings && (await db.get<T212Connection[]>(KEYS.connections, [])).length === 0) {
    const legacy = await keyring.get<V1LegacyConfig | null>(V1_KEYS.legacyConfig, null);
    const legacyAccountId = await ctx.api.secrets.get(V1_KEYS.legacyAccountId);
    if (legacy && legacyAccountId) {
      const id = randomId();
      v1Conns = [
        {
          id,
          name: "Trading 212 (Invest)",
          apiKey: legacy.apiKey,
          apiSecret: legacy.apiSecret,
          accountId: legacyAccountId,
        },
      ];
      v1Settings = { env: legacy.env ?? "live" };
      legacySingle = true;
      const lastSync = await keyring.get<string | null>(V1_KEYS.legacyLastSync, null);
      const importedRefs = await keyring.get<string[]>(V1_KEYS.legacyImportedRefs, []);
      await db.set(syncKey(id), { lastSync, importedRefs });
    }
  }

  if (v1Conns.length > 0) {
    report.migrated = true;
    const converted: T212Connection[] = [];
    for (const c of v1Conns) {
      const { apiKey, apiSecret, ...rest } = c;
      const hasCredentials = Boolean(apiKey && apiSecret);
      if (hasCredentials) {
        await ctx.api.secrets.set(authSecretKey(c.id), encodeCredentials(apiKey!, apiSecret!));
      } else {
        report.needsCredentials++;
      }
      converted.push({
        ...rest,
        keyIdLast4: apiKey ? keyIdLast4(apiKey) : undefined,
        needsCredentials: hasCredentials ? undefined : true,
      });
    }
    // Never overwrite a v2 list that already exists (partial earlier run).
    if ((await db.get<T212Connection[] | null>(KEYS.connections, null)) === null) {
      await db.set(KEYS.connections, converted);
    }
    // Sync state: copied when storage has none yet, then removed from the keyring.
    await migrateSecretsToStorage(ctx, v1Conns.map((c) => syncKey(c.id)));
  }

  if (v1Settings) {
    report.migrated = true;
    if ((await db.get<T212Settings | null>(KEYS.settings, null)) === null) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { proxyUrl: _proxyUrl, ...rest } = v1Settings;
      await db.set(KEYS.settings, { ...rest, env: rest.env ?? "live" });
    }
  }

  // Symbol map: not a secret.
  const movedMap = await migrateSecretsToStorage(ctx, [KEYS.symbolMap]);
  if (movedMap.length > 0) report.migrated = true;

  // Delete the moved v1 secrets — the connections list and settings (the markers) last.
  if (legacySingle) {
    for (const k of [V1_KEYS.legacyConfig, V1_KEYS.legacyAccountId, V1_KEYS.legacyLastSync, V1_KEYS.legacyImportedRefs]) {
      await ctx.api.secrets.delete(k);
    }
  }
  if (v1Conns.length > 0 && !legacySingle) await ctx.api.secrets.delete(V1_KEYS.connections);
  if (v1Settings && !legacySingle) await ctx.api.secrets.delete(V1_KEYS.settings);

  return report;
}

const migrations = new WeakMap<AddonContext, Promise<MigrationReport>>();

/**
 * Runs {@link migrateV1ToV2} at most once per add-on context and shares the result, so
 * the enable hook, the pages and the auto-sync scheduler can all `await` it before
 * reading storage. A failed run is forgotten so the next caller retries.
 */
export function ensureMigrated(ctx: AddonContext): Promise<MigrationReport> {
  let p = migrations.get(ctx);
  if (!p) {
    p = migrateV1ToV2(ctx).catch((err) => {
      migrations.delete(ctx);
      throw err;
    });
    migrations.set(ctx, p);
  }
  return p;
}
