// Trading 212 public API shapes (subset we consume).
// Source: https://docs.trading212.com/api  (cross-checked against the OpenAPI spec).

import type { SyncProgress as KitSyncProgress } from "@wf-addons/kit";

export type T212Env = "live" | "demo";

// How the add-on syncs a connection into its Wealthfolio account. Mirrors the
// account's own `trackingMode`: TRANSACTIONS imports the full activity history;
// HOLDINGS writes a current positions/cash snapshot.
export type T212TrackingMode = "TRANSACTIONS" | "HOLDINGS";

/** What the API client needs to call Trading 212 for one connection. */
export interface T212Config {
  env: T212Env;
  /** Name of the secret holding base64(keyId:secret); the host injects it as Basic auth. */
  secretKey: string;
}

// Shared connection settings (one environment for all keys).
export interface T212Settings {
  env: T212Env;
  // Auto-refresh already-synced accounts in the background (≈ once a day, and when
  // Wealthfolio refreshes its portfolio) so HOLDINGS snapshots build a daily history
  // without a manual click. Absent ⇒ enabled (opt-out).
  autoSync?: boolean;
  // Route Trading 212 card spending into a dedicated "<name> Card" cash account (created
  // on the fly) so Wealthfolio's Spending module can categorise it, instead of mixing it
  // into the investing account. Absent ⇒ off (opt-in; existing users unaffected).
  extractCard?: boolean;
  // Wealthfolio account type for the card account when extraction is on. CASH (default) is
  // accurate for a debit card; CREDIT_CARD treats it as a credit-card liability so Wealthfolio can
  // link cash→card payments as transfers (avoids double-counting). Absent ⇒ "CASH".
  cardAccountType?: "CASH" | "CREDIT_CARD";
}

// One Trading 212 API key linked to one Wealthfolio account.
export interface T212Connection {
  id: string; // stable random id, used to key per-connection sync state
  name: string; // Wealthfolio account name set at creation
  // Last 4 characters of the API key ID, for display only. The credentials themselves
  // live in the secret `t212_auth_<id>` and are used only via the network broker.
  keyIdLast4?: string;
  // True for a connection migrated from v1 that only had a legacy single API key (no
  // secret). It is kept but skipped by sync until the user re-enters key ID + secret.
  needsCredentials?: boolean;
  accountId: string; // linked Wealthfolio securities account id
  // Mode the linked account was created in / last synced in. Absent ⇒ TRANSACTIONS
  // (connections created before the mode picker existed keep their behaviour).
  trackingMode?: T212TrackingMode;
  // Trading 212 product flavour. ISA accounts can't have a card, so card extraction is
  // skipped for them regardless of the global toggle. Absent ⇒ "invest" (backwards
  // compatible — pre-1.12 connections behave like Invest, matching the prior default).
  kind?: "invest" | "isa";
  // Linked Wealthfolio CASH account that receives card spending, when card extraction
  // is enabled. Created on the fly the first time the connection syncs with it on.
  cardAccountId?: string;
}

// Per-connection sync state (stored under t212_sync_{id}).
export interface ConnectionSyncState {
  lastSync: string | null;
  importedRefs: string[]; // loaded into a Set at runtime
  // Oldest window boundary (ISO) a full backfill has imported so far. Set after
  // each window so an interrupted backfill resumes there instead of restarting;
  // cleared once the backfill completes.
  backfillCheckpoint?: string | null;
  // When the current full backfill started (ISO). Its windows end here, so once it
  // completes this — not the finish time — becomes `lastSync`; otherwise anything that
  // happened while the backfill ran (or between an interrupted run and its resume)
  // would fall between the CSV windows and the first incremental sync.
  backfillStartedAt?: string | null;
  // Watermark for the separate card-spending pipeline (card data is CSV-only, so it's
  // synced independently of the JSON activity watermark). Absent ⇒ card history not yet
  // backfilled; set to the sync time after the first card backfill completes.
  cardLastSync?: string | null;
}

// GET /api/v0/equity/account/summary
export interface AccountSummary {
  id: number;
  currency: string; // primary account currency (ISO 4217)
  cash?: {
    availableToTrade?: number;
    inPies?: number;
    reservedForOrders?: number;
  };
  totalValue?: number;
}

// Instrument as embedded in orders / dividends / positions.
export interface Instrument {
  ticker: string; // e.g. AAPL_US_EQ
  isin?: string;
  name?: string;
  currency?: string; // instrument currency (ISO 4217)
}

// GET /api/v0/equity/metadata/instruments
export interface TradableInstrument {
  ticker: string;
  isin?: string;
  name?: string;
  shortName?: string;
  currencyCode?: string;
  type?: string;
  addedOn?: string;
}

// GET /api/v0/equity/positions
export interface Position {
  instrument?: Instrument;
  ticker?: string;
  quantity: number;
  averagePricePaid?: number;
  currentPrice?: number;
  createdAt?: string;
}

export interface Tax {
  name?: string;
  quantity?: number; // monetary amount of the tax/fee
  currency?: string;
  chargedAt?: string;
}

export interface Fill {
  id?: number;
  filledAt?: string;
  price?: number;
  quantity?: number;
  type?: string; // TRADE | STOCK_SPLIT | STOCK_DISTRIBUTION | ...
  walletImpact?: {
    currency?: string;
    fxRate?: number;
    netValue?: number;
    realisedProfitLoss?: number;
    taxes?: Tax[];
  };
}

export interface Order {
  id: number;
  ticker?: string;
  side?: "BUY" | "SELL";
  status?: string;
  currency?: string;
  filledQuantity?: number;
  filledValue?: number;
  instrument?: Instrument;
  createdAt?: string;
}

// GET /api/v0/equity/history/orders -> items
export interface HistoricalOrder {
  fill?: Fill;
  order?: Order;
}

// GET /api/v0/equity/history/dividends -> items
export interface DividendItem {
  ticker: string;
  reference: string;
  type?: string; // ORDINARY | INTEREST | BONUS | ...
  amount: number; // in account's primary currency
  currency?: string; // account primary currency
  tickerCurrency?: string;
  grossAmountPerShare?: number;
  quantity?: number;
  paidOn: string;
  instrument?: Instrument;
}

// GET /api/v0/equity/history/transactions -> items
export interface TransactionItem {
  // INTEREST_ON_FREE_CASH and LENDING_INTEREST are newer additions to the API spec.
  type: "DEPOSIT" | "WITHDRAW" | "FEE" | "TRANSFER" | "INTEREST_ON_FREE_CASH" | "LENDING_INTEREST";
  amount: number;
  currency?: string;
  dateTime: string;
  reference: string;
}

export interface Paginated<T> {
  items: T[];
  nextPagePath: string | null;
}

// POST /api/v0/equity/history/exports — request body
export interface ExportDataIncluded {
  includeDividends: boolean;
  includeInterest: boolean;
  includeOrders: boolean;
  includeTransactions: boolean;
}

export interface ExportRequest {
  dataIncluded: ExportDataIncluded;
  timeFrom?: string; // ISO 8601
  timeTo?: string;
}

export type ExportStatus = "Queued" | "Processing" | "Running" | "Canceled" | "Failed" | "Finished";

// GET /api/v0/equity/history/exports — array item
export interface ExportReport {
  reportId: number;
  timeFrom: string;
  timeTo: string;
  dataIncluded: ExportDataIncluded;
  status: ExportStatus;
  downloadLink?: string;
}

export interface SyncResult {
  connectionId: string;
  accountId: string;
  accountName: string;
  imported: number;
  duplicates: number;
  unresolved: number; // activities skipped because no symbol match was found
  error?: string; // set if this connection failed; others still sync
  log: string[]; // verbose diagnostic lines, surfaced in the UI
  // Per-activity-type counts (BUY/SELL/DIVIDEND/INTEREST/DEPOSIT/WITHDRAWAL/FEE/…),
  // derived from the import tally. Populated for the activity-import paths.
  breakdown?: Record<string, number>;
  // Card-account import summary when extractCard is on for this connection.
  card?: { imported: number; duplicates: number };
  // ISO timestamp the sync finished at (set whether it succeeded or errored).
  finishedAt?: string;
}

export interface MultiSyncResult {
  perAccount: SyncResult[];
  totals: { imported: number; duplicates: number; unresolved: number };
}

export type SyncPhaseId = "export" | "map" | "import" | "done";

/** Live progress emitted during a sync so the UI can show the current step. */
export interface SyncProgress extends KitSyncProgress<SyncPhaseId> {
  accountName: string;
}
