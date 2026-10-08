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
} as const;

/** Per-connection sync state (watermark + imported refs), in storage. */
export const syncKey = (connectionId: string) => `t212_sync_${connectionId}`;

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
