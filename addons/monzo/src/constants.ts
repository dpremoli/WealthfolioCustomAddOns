/** Manifest id; also the add-on's route mount (`/addons/monzo-addon`). */
export const ADDON_ID = "monzo-addon";

// --- Monzo endpoints -------------------------------------------------------
export const AUTH_URL = "https://auth.monzo.com/";
export const API_BASE = "https://api.monzo.com";
export const TOKEN_URL = `${API_BASE}/oauth2/token`;

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
/** JSON: category id -> custom label. */
export const KEY_CATEGORY_LABELS = "monzo_category_labels";

// --- v1.x keys that live in the keyring and are migrated on enable ---------
export const LEGACY_TOKENS_KEY = "monzo_tokens";
export const LEGACY_PROXY_URL_KEY = "monzo_proxy_url";
