/** Manifest id; also the add-on's route mount (`/addons/monzo-addon`). */
export const ADDON_ID = "monzo-addon";

// --- Monzo endpoints -------------------------------------------------------
export const AUTH_URL = "https://auth.monzo.com/";
export const API_BASE = "https://api.monzo.com";
export const TOKEN_URL = `${API_BASE}/oauth2/token`;
export const LOGOUT_URL = `${API_BASE}/oauth2/logout`;

/** Suggested redirect URL: it never has to load, the user only copies the address bar. */
export const SUGGESTED_REDIRECT_URL = "https://localhost/monzo-callback";

// --- Secrets (OS keyring) --------------------------------------------------
export const SECRET_CLIENT_SECRET = "monzo_client_secret";
/** Only ever used through `auth: { type: "bearer", secretKey }`; never read back into code. */
export const SECRET_ACCESS_TOKEN = "monzo_access_token";
export const SECRET_REFRESH_TOKEN = "monzo_refresh_token";

// --- Storage (non-secret add-on state) -------------------------------------
export const KEY_CLIENT_ID = "monzo_client_id";
export const KEY_REDIRECT_URL = "monzo_redirect_url";
/** ms since epoch the current access token stops working (decimal string). */
export const KEY_EXPIRES_AT = "monzo_expires_at";
/** `state` of an in-flight authorisation, until the pasted redirect is verified. */
export const KEY_OAUTH_STATE = "monzo_oauth_state";
/** JSON: Monzo account id -> Wealthfolio account id. */
export const KEY_MAPPING = "monzo_account_mapping";
/**
 * JSON: ISO timestamp the next sync fetches `since` (the watermark). Normally the start of
 * the last successful sync; held back to the earliest still-pending transaction.
 */
export const KEY_LAST_SYNC = "monzo_last_sync";
/** JSON: ISO timestamp the last successful sync actually finished (display only). */
export const KEY_LAST_RUN = "monzo_last_run";
/**
 * JSON: import ledger, Monzo transaction id -> "<Wealthfolio account id>:<content hash>" of
 * the activity it became (kit `ImportLedger`). Lets a re-fetched transaction be recognised
 * even when its comment changed, without writing the id into the comment.
 */
export const KEY_IMPORTED_IDS = "monzo_imported_ids";
/**
 * ms since epoch the user last completed the OAuth login (decimal string). Set when the
 * authorisation code is exchanged, not on token refresh: Monzo shares the whole history only
 * for 5 minutes after a login, so a sync soon after this asks for all of it.
 */
export const KEY_AUTHENTICATED_AT = "monzo_authenticated_at";
/**
 * JSON `true` once a sync has covered the last 90 days. Versions before 2.4.0 fetched only
 * the last 30 days on a first sync, so one existing watermark gets a one-off re-check.
 */
export const KEY_RECHECKED_90_DAYS = "monzo_rechecked_90_days";
/** JSON: what the dashboard shows of the last successful sync (its result and step list). */
export const KEY_LAST_RESULT = "monzo_last_result";
/** JSON: category id -> custom label. */
export const KEY_CATEGORY_LABELS = "monzo_category_labels";

// --- v1.x keys that live in the keyring and are migrated on enable ---------
export const LEGACY_TOKENS_KEY = "monzo_tokens";
export const LEGACY_PROXY_URL_KEY = "monzo_proxy_url";
