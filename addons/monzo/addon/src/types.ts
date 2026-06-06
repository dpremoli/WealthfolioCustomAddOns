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
}
