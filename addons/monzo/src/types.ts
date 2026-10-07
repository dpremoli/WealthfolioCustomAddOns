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
  account_type: string;
  closed?: boolean;
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
  metadata: Record<string, string>;
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
