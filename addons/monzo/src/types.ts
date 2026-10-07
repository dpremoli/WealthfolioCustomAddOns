/** Response body of `POST /oauth2/token` (both grant types). */
export interface MonzoTokenResponse {
  access_token: string;
  refresh_token?: string;
  /** Seconds until the access token expires (Monzo issues 6 hours). */
  expires_in?: number;
  token_type?: string;
  client_id?: string;
  user_id?: string;
}

export interface MonzoAccount {
  id: string;
  description: string;
  created: string;
  account_number?: string;
  sort_code?: string;
  currency?: string;
  /**
   * uk_retail, uk_retail_joint, uk_monzo_flex, uk_monzo_flex_backing_loan, … The API sends
   * this as `type` (`account_type` is only the name of the list filter); the client copies
   * it here so the rest of the add-on has one field to read.
   */
  account_type: string;
  type?: string;
  closed?: boolean;
  /** The account holders; their names are the default reference on payments they send. */
  owners?: { user_id?: string; preferred_name?: string; preferred_first_name?: string }[];
}

export interface MonzoMerchant {
  id?: string;
  name?: string;
  category?: string;
  address?: {
    address?: string;
    city?: string;
    country?: string;
    postcode?: string;
  };
}

export interface MonzoTransaction {
  id: string;
  created: string;
  settled: string; // empty string if pending, ISO timestamp if settled
  amount: number; // minor units (pence), negative = debit, positive = credit
  currency: string;
  local_amount?: number;
  local_currency?: string;
  description: string;
  notes: string;
  category: string;
  /** An object when requested with `expand[]=merchant`; otherwise just the merchant id. */
  merchant?: MonzoMerchant | string | null;
  is_load: boolean;
  /**
   * The other side of a bank transfer or Monzo-to-Monzo payment: who it was sent to (or came
   * from). For these, `description` is only the payment reference (by default the sender's
   * own name) or an internal id, so the name lives here.
   */
  counterparty?: {
    name?: string;
    preferred_name?: string;
    account_number?: string;
    sort_code?: string;
    user_id?: string;
  } | null;
  /** Payment scheme, e.g. "mastercard", "payport_faster_payments", "uk_retail_pot". */
  scheme?: string;
  metadata: Record<string, string>;
  /** Only present on declined transactions (INSUFFICIENT_FUNDS, CARD_INACTIVE, …). */
  decline_reason?: string | null;
}

export interface AccountMapping {
  [monzoAccountId: string]: string; // maps to wealthfolioAccountId
}

export interface SyncResult {
  imported: number;
  skipped: number;
  duplicates: number;
  // Spending count by resolved category label (e.g. "Eating Out": 12), for the UI breakdown.
  breakdown?: Record<string, number>;
  // Verbose diagnostic lines surfaced in the UI's Log tab.
  log?: string[];
  // ISO timestamp the sync finished at.
  finishedAt?: string;
}

/** Phases of a live sync, as rendered by the kit's `<SyncActivity>`. */
export type SyncPhaseId = "fetch" | "import" | "done";
