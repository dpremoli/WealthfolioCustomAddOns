import type {
  AccountSummary,
  DividendItem,
  HistoricalOrder,
  Paginated,
  Position,
  T212Config,
  TradableInstrument,
  TransactionItem,
} from "../types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// History endpoints allow only 6 req/min, so paging a long history hits 429
// repeatedly. Retry persistently, waiting for the rate-limit window to reset.
const MAX_429_RETRIES = 12;
const DEFAULT_BACKOFF_MS = 15_000; // ~ one token for a 6/min limit, when no header

/**
 * Builds the Authorization header for the Trading 212 API.
 * Modern keys use HTTP Basic auth (API Key ID + Secret); older keys pass the
 * raw key in the Authorization header. We support both.
 */
function buildAuthHeader(config: T212Config): string {
  if (config.apiSecret) {
    return `Basic ${btoa(`${config.apiKey}:${config.apiSecret}`)}`;
  }
  return config.apiKey;
}

export class Trading212ProxyClient {
  constructor(private readonly config: T212Config) {}

  private async get<T>(
    endpoint: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const url = new URL(`${this.config.proxyUrl.replace(/\/$/, "")}/${endpoint}`);
    url.searchParams.set("env", this.config.env);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }

    const headers = { Authorization: buildAuthHeader(this.config) };

    // Retry on rate-limit, honoring the reset/Retry-After header, until the
    // window clears — a long history needs many pages at 6 req/min.
    for (let attempt = 0; ; attempt++) {
      const resp = await fetch(url.toString(), { headers });

      if (resp.status === 429) {
        if (attempt >= MAX_429_RETRIES) {
          throw new Error("Trading 212 rate limit exceeded. Try again shortly.");
        }
        await sleep(this.retryDelayMs(resp));
        continue;
      }
      if (resp.status === 401) throw new Error("UNAUTHORIZED");
      if (!resp.ok) {
        throw new Error(`Trading 212 request failed (${resp.status}): ${await resp.text()}`);
      }
      return (await resp.json()) as T;
    }
  }

  private retryDelayMs(resp: Response): number {
    const retryAfter = resp.headers.get("retry-after");
    if (retryAfter) return Math.max(1, Number(retryAfter)) * 1000;
    const reset = resp.headers.get("x-ratelimit-reset");
    if (reset) {
      const ms = Number(reset) * 1000 - Date.now();
      if (ms > 0) return Math.min(ms + 500, 60_000); // small cushion past reset
    }
    return DEFAULT_BACKOFF_MS;
  }

  getAccountSummary(): Promise<AccountSummary> {
    return this.get<AccountSummary>("account/summary");
  }

  getInstruments(): Promise<TradableInstrument[]> {
    return this.get<TradableInstrument[]>("instruments");
  }

  getPositions(): Promise<Position[]> {
    return this.get<Position[]>("positions");
  }

  pageOrders(cursor?: string, limit = 50): Promise<Paginated<HistoricalOrder>> {
    return this.get<Paginated<HistoricalOrder>>("orders", { cursor, limit });
  }

  pageDividends(cursor?: string, limit = 50): Promise<Paginated<DividendItem>> {
    return this.get<Paginated<DividendItem>>("dividends", { cursor, limit });
  }

  pageTransactions(
    opts: { cursor?: string; time?: string; limit?: number } = {},
  ): Promise<Paginated<TransactionItem>> {
    return this.get<Paginated<TransactionItem>>("transactions", {
      cursor: opts.cursor,
      time: opts.time,
      limit: opts.limit ?? 50,
    });
  }
}

/** Extracts the `cursor` query value from a Trading 212 `nextPagePath` string. */
export function cursorFromNextPage(nextPagePath: string | null | undefined): string | null {
  if (!nextPagePath) return null;
  const q = nextPagePath.indexOf("?");
  if (q === -1) return null;
  return new URLSearchParams(nextPagePath.slice(q + 1)).get("cursor");
}
