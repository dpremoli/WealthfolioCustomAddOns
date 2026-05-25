import type {
  AccountSummary,
  DividendItem,
  ExportReport,
  ExportRequest,
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

  private async post<T>(endpoint: string, body: unknown): Promise<T> {
    const url = new URL(`${this.config.proxyUrl.replace(/\/$/, "")}/${endpoint}`);
    url.searchParams.set("env", this.config.env);
    const headers = {
      Authorization: buildAuthHeader(this.config),
      "Content-Type": "application/json",
    };
    for (let attempt = 0; ; attempt++) {
      const resp = await fetch(url.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (resp.status === 429) {
        if (attempt >= MAX_429_RETRIES)
          throw new Error("Trading 212 rate limit exceeded. Try again shortly.");
        await sleep(this.retryDelayMs(resp));
        continue;
      }
      if (resp.status === 401) throw new Error("UNAUTHORIZED");
      if (!resp.ok)
        throw new Error(`Trading 212 request failed (${resp.status}): ${await resp.text()}`);
      const text = await resp.text();
      return (text.trim() ? (JSON.parse(text) as T) : ({} as T));
    }
  }

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

  requestExport(req: ExportRequest): Promise<{ reportId: number }> {
    return this.post<{ reportId: number }>("exports", req);
  }

  listExports(): Promise<ExportReport[]> {
    return this.get<ExportReport[]>("exports");
  }

  /** Downloads a signed export CSV via the proxy relay. No Authorization header is sent
   *  to the storage host — the signed URL is self-authenticating. */
  async downloadExportCsv(downloadLink: string): Promise<string> {
    const url = new URL(`${this.config.proxyUrl.replace(/\/$/, "")}/export-download`);
    url.searchParams.set("url", downloadLink);
    // Deliberately no Authorization header here — signed URL, not the T212 API.
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`Export download failed (${resp.status})`);
    return resp.text();
  }

  /**
   * Requests a full-history CSV export from Trading 212, polls until finished,
   * and returns the raw CSV text.
   *
   * Reuses an already-Finished report if one exists, or waits on an in-flight one,
   * before POSTing a new request — respects the 1/30s POST and 1/min list rate limits.
   *
   * @param opts       Optional timeFrom / timeTo to scope the export.
   * @param pollMs     Milliseconds between status polls (default 65 s — 1/min limit).
   */
  async runExport(
    opts: { timeFrom?: string; timeTo?: string } = {},
    pollMs = 65_000,
  ): Promise<string> {
    const covers = (r: ExportReport) =>
      (!opts.timeFrom || r.timeFrom <= opts.timeFrom) &&
      (!opts.timeTo || r.timeTo >= opts.timeTo);

    // Reuse an existing finished report if it covers the requested range.
    const existing = await this.listExports();
    const done = existing.find((r) => r.status === "Finished" && r.downloadLink && covers(r));
    if (done?.downloadLink) return this.downloadExportCsv(done.downloadLink);

    // Wait on an in-progress report rather than POSTing a duplicate.
    const inFlight = existing.find(
      (r) =>
        (r.status === "Queued" || r.status === "Processing" || r.status === "Running") &&
        covers(r),
    );

    let reportId: number;
    if (inFlight) {
      reportId = inFlight.reportId;
    } else {
      const req: ExportRequest = {
        dataIncluded: {
          includeDividends: true,
          includeInterest: true,
          includeOrders: true,
          includeTransactions: true,
        },
        timeFrom: opts.timeFrom,
        timeTo: opts.timeTo,
      };
      const result = await this.requestExport(req);
      reportId = result.reportId;
    }

    // Poll until the report finishes or we hit the 10-minute cap.
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const reports = await this.listExports();
      const report = reports.find((r) => r.reportId === reportId);
      if (!report) continue;
      if (report.status === "Finished" && report.downloadLink) {
        return this.downloadExportCsv(report.downloadLink);
      }
      if (report.status === "Failed" || report.status === "Canceled") {
        throw new Error(`Trading 212 export ${report.status.toLowerCase()}`);
      }
    }
    throw new Error("Trading 212 export timed out after 10 minutes");
  }
}

/** Extracts the `cursor` query value from a Trading 212 `nextPagePath` string. */
export function cursorFromNextPage(nextPagePath: string | null | undefined): string | null {
  if (!nextPagePath) return null;
  const q = nextPagePath.indexOf("?");
  if (q === -1) return null;
  return new URLSearchParams(nextPagePath.slice(q + 1)).get("cursor");
}

/**
 * Extracts both `cursor` and `time` from a transactions `nextPagePath`. Trading 212's
 * transactions endpoint requires either both of these together or neither, so they must
 * be carried as a pair when paging.
 */
export function transactionPageParams(
  nextPagePath: string | null | undefined,
): { cursor?: string; time?: string } {
  if (!nextPagePath) return {};
  const q = nextPagePath.indexOf("?");
  if (q === -1) return {};
  const sp = new URLSearchParams(nextPagePath.slice(q + 1));
  return {
    cursor: sp.get("cursor") ?? undefined,
    time: sp.get("time") ?? undefined,
  };
}
