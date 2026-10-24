/** Manifest id; also the add-on's route mount (`/addons/trading212-addon`). */
export const ADDON_ID = "trading212-addon";

/** Wealthfolio account `provider` tag for accounts this add-on creates. */
export const PROVIDER = "trading212-addon";

/** Route ids; must match `contributes.routes[].id` in manifest.json. */
export const ROUTE_DASHBOARD = "trading212";
export const ROUTE_SETTINGS = "trading212-settings";

/** Settings path that opens "Add account" on the Cash ISA (the dashboard's Import CSV). */
export const SETTINGS_ADD_CASH_ISA = "settings?add=cash-isa";

/** Add-on storage keys (non-secret state). */
export const KEYS = {
  settings: "t212_settings",
  connections: "t212_connections",
  // v6 invalidates pre-1.7.5 entries: v5's MTF deprioritisation ran before the
  // ISIN-shape drop, so an EUR position whose only real ticker was on a Cboe
  // venue (VUAAM/DXE) got stranded and dropped as unresolved. v6 drops ISIN-
  // shaped symbols first, so MTF-only listings still resolve.
  symbolMap: "t212_symbol_map_v6",
  // The last sync's activity feed (the timeline under the dashboard's Sync button).
  lastSteps: "t212_last_steps",
} as const;

/** Per-connection sync state (watermarks, check result), in storage. Small and bounded. */
export const syncKey = (connectionId: string) => `t212_sync_${connectionId}`;

/**
 * Wealthfolio refuses a stored value above ~244 KB ("too large to sync across devices"), and a
 * connection with years of history has thousands of imported-row ids, so the ids are spread over
 * REF_SHARDS keys by a hash of the id: a key holds a small share, and a sync rewrites only the
 * shards it changed.
 */
export const REF_SHARDS = 32;
export const refsKey = (connectionId: string, shard: number) =>
  `t212_refs_${connectionId}_${shard.toString(16).padStart(2, "0")}`;

/** The share counts of a connection's dividend rows (evidence for inferring a split), own key. */
export const dividendsKey = (connectionId: string) => `t212_divs_${connectionId}`;

/** What the dashboard keeps showing of a connection's last sync (result and log), across reloads. */
export const lastResultKey = (connectionId: string) => `t212_last_result_${connectionId}`;

/** Largest value written to one storage key (the host's cap is ~244 KB); bigger fails loudly here. */
export const MAX_STORED_BYTES = 200_000;

/**
 * Per-connection credentials, in secrets: base64(`keyId:secret`). Only ever used via
 * the network broker's `auth: { type: "basic", secretKey }`.
 */
export const authSecretKey = (connectionId: string) => `t212_auth_${connectionId}`;

/** Temporary secret used to validate new credentials before they replace the working ones. */
export const pendingAuthSecretKey = (connectionId: string) => `t212_auth_pending_${connectionId}`;

/** v1 layout: everything (including non-secrets) lived in the keyring. */
export const V1_KEYS = {
  settings: "t212_settings",
  connections: "t212_connections",
  symbolMap: "t212_symbol_map_v6",
  // Earlier symbol caches, dropped outright (their entries may point at the wrong
  // listing: v1 had no currency filter; v2 mis-picked some ticker collisions; v3
  // accepted a wrong first-query hit; v4 regressed European primaries onto Cboe
  // Europe MTF venues and Meta onto the reassigned FB; v5 dropped MTF-only listings).
  oldSymbolMaps: [
    "t212_symbol_map",
    "t212_symbol_map_v2",
    "t212_symbol_map_v3",
    "t212_symbol_map_v4",
    "t212_symbol_map_v5",
  ],
  // Even older single-account layout.
  legacyConfig: "t212_config",
  legacyAccountId: "t212_account_id",
  legacyLastSync: "t212_last_sync",
  legacyImportedRefs: "t212_imported_refs",
} as const;

/** Trading 212 REST API base per environment. */
export const API_BASE = {
  live: "https://live.trading212.com/api/v0/equity",
  demo: "https://demo.trading212.com/api/v0/equity",
} as const;
