// Trading 212 public API shapes (subset we consume).
// Source: https://docs.trading212.com/api  (cross-checked against the OpenAPI spec).

export type T212Env = "live" | "demo";

export interface T212Config {
  proxyUrl: string;
  env: T212Env;
  apiKey: string; // API Key (ID)
  apiSecret?: string; // API Secret — present for the modern Basic-auth scheme
}

// Shared connection settings (one proxy/env for all keys).
export interface T212Settings {
  proxyUrl: string;
  env: T212Env;
}

// One Trading 212 API key linked to one Wealthfolio account.
export interface T212Connection {
  id: string; // stable random id, used to key per-connection sync state
  name: string; // Wealthfolio account name set at creation
  apiKey: string;
  apiSecret?: string;
  accountId: string; // linked Wealthfolio securities account id
}

// Per-connection sync state (stored under t212_sync_{id}).
export interface ConnectionSyncState {
  lastSync: string | null;
  importedRefs: string[]; // loaded into a Set at runtime
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
  type: string; // ORDINARY | INTEREST | BONUS | ...
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
  type: "DEPOSIT" | "WITHDRAW" | "FEE" | "TRANSFER";
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
}

export interface MultiSyncResult {
  perAccount: SyncResult[];
  totals: { imported: number; duplicates: number; unresolved: number };
}
