// Trading 212 public API shapes (subset we consume).
// Source: https://docs.trading212.com/api  (cross-checked against the OpenAPI spec).

export type T212Env = "live" | "demo";

export interface T212Config {
  proxyUrl: string;
  env: T212Env;
  apiKey: string; // API Key (ID)
  apiSecret?: string; // API Secret — present for the modern Basic-auth scheme
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

export interface SyncResult {
  imported: number;
  duplicates: number;
  unresolved: number; // activities skipped because no symbol match was found
}
