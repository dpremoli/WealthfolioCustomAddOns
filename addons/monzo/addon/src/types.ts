export interface MonzoTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // ms since epoch
  token_type: string;
  user_id: string;
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
    city?: string;
    country?: string;
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
  merchant?: MonzoMerchant | null;
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

/** Live progress emitted during a sync so the UI can show the current step. */
export interface SyncProgress {
  phase: "fetch" | "import" | "done";
  message: string;
  // When both are set the UI can show a determinate bar; otherwise indeterminate.
  current?: number;
  total?: number;
}

/** One entry in the live sync timeline (every progress event becomes a step). */
export interface SyncStep extends SyncProgress {
  ts: string;
  status: "active" | "done";
}
