/** Manifest id; also the add-on's route mount (`/addons/revolut-addon`). */
export const ADDON_ID = "revolut-addon";

/** Storage key for the remembered currency → Wealthfolio account map. */
export const ACCOUNTS_KEY = "revolut_accounts";

/**
 * JSON: import ledger, Revolut row id → "<Wealthfolio account id>:<content hash>" of the
 * activity it became (kit `ImportLedger`). Lets a re-imported row be recognised by its id even
 * after it was converted to a transfer, linked or edited, instead of matching it by content.
 */
export const KEY_IMPORTED_IDS = "revolut_imported_ids";
/** Rows Wealthfolio refuses, retried on every import (kit `refused-rows`). */
export const KEY_REFUSED = "revolut_refused";

/** JSON: id of the Wealthfolio account the user keeps their Revolut savings in, or "" for none. */
export const KEY_SAVINGS_ACCOUNT = "revolut_savings_account";
