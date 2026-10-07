import type { AddonContext } from "@wealthfolio/addon-sdk";
import {
  HttpError,
  brokeredRequest,
  header,
  parseCsv,
  withQuery,
  type BrokerOptions,
} from "@wf-addons/kit";
import { API_BASE } from "../constants";
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

/** Per-request timeout for the JSON endpoints (host default is 10 s, max 120 s). */
const TIMEOUT_SECS = 30;
/** Export endpoints (and the CSV download) are slower. */
const EXPORT_TIMEOUT_SECS = 60;

/** The host caps a brokered response body at 2 MB; larger raises "...too large". */
const TOO_LARGE = /too large/i;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Smallest export window we will split down to when a CSV exceeds the 2 MB cap. */
export const MIN_SPLIT_WINDOW_MS = 7 * DAY_MS;

const MAX_REDIRECTS = 3;

export interface ExportOptions {
  timeFrom?: string;
  timeTo?: string;
  /** Pre-fetched report list so a multi-window backfill doesn't hammer the 1/min list endpoint. */
  knownReports?: ExportReport[];
  /** Receives human-readable notes (e.g. "window too large — splitting") for the sync log. */
  onNote?: (message: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True when the host refused a response because it exceeded the 2 MB body limit. */
export function isTooLarge(err: unknown): boolean {
  return TOO_LARGE.test(err instanceof Error ? err.message : String(err));
}

/** True for a Trading 212 401 (bad/expired/revoked key, or wrong environment). */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof HttpError && err.status === 401;
}

/** True for a Trading 212 403: the API key lacks the permission (scope) an endpoint needs. */
export function isForbidden(err: unknown): boolean {
  return err instanceof HttpError && err.status === 403;
}

/**
 * Trading 212 REST client. Calls the broker (`ctx.api.network.request`) directly — no
 * proxy: the host performs the HTTP request, so CORS is irrelevant. Credentials never
 * enter this code: the host injects `Authorization: Basic <secret>` from the secret named
 * in `config.secretKey`. One instance per connection.
 */
export class Trading212Client {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly ctx: AddonContext,
    private readonly config: T212Config,
    private readonly broker: BrokerOptions = {},
  ) {
    this.sleep = broker.sleep ?? defaultSleep;
  }

  private base(): string {
    return API_BASE[this.config.env];
  }

  private async json<T>(
    path: string,
    init: {
      method?: "GET" | "POST";
      params?: Record<string, string | number | undefined>;
      body?: unknown;
      timeoutSecs?: number;
    } = {},
  ): Promise<T> {
    const res = await brokeredRequest(
      this.ctx,
      {
        url: withQuery(`${this.base()}/${path}`, init.params ?? {}),
        method: init.method ?? "GET",
        headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        auth: { type: "basic", secretKey: this.config.secretKey },
        timeoutSecs: init.timeoutSecs ?? TIMEOUT_SECS,
      },
      this.broker,
    );
    if (res.status === 401) throw new HttpError(401, res.body, "UNAUTHORIZED");
    if (res.status === 403) {
      throw new HttpError(
        403,
        res.body,
        `Trading 212 refused ${path} (403): the API key is missing a permission it needs. ` +
          "Create a key with the permissions listed in Settings (and no IP restriction that " +
          `excludes this computer).${res.body ? ` ${res.body.slice(0, 200)}` : ""}`,
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new HttpError(res.status, res.body, `Trading 212 request failed (${res.status}): ${res.body}`);
    }
    const text = res.body?.trim();
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Trading 212 returned a non-JSON response (${res.status}): ${text.slice(0, 120)}`);
    }
  }

  getAccountSummary(): Promise<AccountSummary> {
    return this.json<AccountSummary>("account/summary");
  }

  /** NB: ~5 MB upstream, so it exceeds the 2 MB broker cap and will throw "too large". */
  getInstruments(): Promise<TradableInstrument[]> {
    return this.json<TradableInstrument[]>("metadata/instruments", { timeoutSecs: EXPORT_TIMEOUT_SECS });
  }

  getPositions(): Promise<Position[]> {
    return this.json<Position[]>("positions");
  }

  pageOrders(cursor?: string, limit = 50): Promise<Paginated<HistoricalOrder>> {
    return this.json<Paginated<HistoricalOrder>>("history/orders", { params: { cursor, limit } });
  }

  pageDividends(cursor?: string, limit = 50): Promise<Paginated<DividendItem>> {
    return this.json<Paginated<DividendItem>>("history/dividends", { params: { cursor, limit } });
  }

  pageTransactions(
    opts: { cursor?: string; time?: string; limit?: number } = {},
  ): Promise<Paginated<TransactionItem>> {
    return this.json<Paginated<TransactionItem>>("history/transactions", {
      params: { cursor: opts.cursor, time: opts.time, limit: opts.limit ?? 50 },
    });
  }

  requestExport(req: ExportRequest): Promise<{ reportId: number }> {
    return this.json<{ reportId: number }>("history/exports", {
      method: "POST",
      body: req,
      timeoutSecs: EXPORT_TIMEOUT_SECS,
    });
  }

  listExports(): Promise<ExportReport[]> {
    return this.json<ExportReport[]>("history/exports", { timeoutSecs: EXPORT_TIMEOUT_SECS });
  }

  /**
   * Downloads a signed export CSV. The `downloadLink` is a pre-signed URL on a storage
   * host, so the request carries NO `auth` (the signature authenticates it, and the API
   * key must never reach the storage host). The broker follows no redirects, so a 3xx is
   * followed here (without credentials) up to a few hops.
   */
  async downloadExportCsv(downloadLink: string): Promise<string> {
    let url = downloadLink;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let res;
      try {
        res = await brokeredRequest(
          this.ctx,
          { url, method: "GET", timeoutSecs: EXPORT_TIMEOUT_SECS },
          this.broker,
        );
      } catch (err) {
        throw describeDownloadError(err, url);
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = header(res, "location");
        if (!location) throw new Error(`Export download redirected (${res.status}) without a Location`);
        url = new URL(location, url).toString();
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new HttpError(res.status, "", `Export download failed (${res.status})`);
      }
      return res.body;
    }
    throw new Error("Export download redirected too many times");
  }

  /**
   * Requests (or reuses) a CSV export covering `timeFrom`–`timeTo`, polls until it
   * finishes and returns the CSV text. The host caps responses at 2 MB, so if the download
   * is "too large" the window is split in half and each half exported on its own
   * (recursively, down to {@link MIN_SPLIT_WINDOW_MS}); the CSVs are then concatenated
   * under a single header. Rows on the split boundary may appear twice — callers dedupe
   * by activity id.
   *
   * Reuses an already-Finished report if one covers the window, or waits on an in-flight
   * one, before POSTing a new request — respecting the 1/30 s POST and 1/min list limits.
   *
   * @param pollMs       Delay between status polls (default 65 s — the 1/min limit).
   * @param firstPollMs  Delay before the first poll; exports usually finish in ~10-15 s.
   */
  runExport(opts: ExportOptions = {}, pollMs = 65_000, firstPollMs = 12_000): Promise<string> {
    return this.exportWindow(opts, pollMs, firstPollMs, new Set());
  }

  private async exportWindow(
    opts: ExportOptions,
    pollMs: number,
    firstPollMs: number,
    tooLargeReports: Set<number>,
  ): Promise<string> {
    try {
      return await this.exportOnce(opts, pollMs, firstPollMs, tooLargeReports);
    } catch (err) {
      if (!isTooLarge(err)) throw err;
      const from = opts.timeFrom ? Date.parse(opts.timeFrom) : NaN;
      const to = opts.timeTo ? Date.parse(opts.timeTo) : Date.now();
      const label = `${opts.timeFrom?.slice(0, 10) ?? "?"}→${opts.timeTo?.slice(0, 10) ?? "now"}`;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to - from < 2 * MIN_SPLIT_WINDOW_MS) {
        throw new Error(
          `Export window ${label} is still over Wealthfolio's 2 MB network response limit ` +
            `at the smallest window size (${MIN_SPLIT_WINDOW_MS / DAY_MS} days).`,
        );
      }
      const mid = from + Math.floor((to - from) / 2);
      const midIso = new Date(mid).toISOString();
      opts.onNote?.(`Export ${label} exceeds the 2 MB response limit — splitting at ${midIso.slice(0, 10)}.`);
      const first = await this.exportWindow(
        { ...opts, timeFrom: new Date(from).toISOString(), timeTo: midIso },
        pollMs,
        firstPollMs,
        tooLargeReports,
      );
      const second = await this.exportWindow(
        { ...opts, timeFrom: midIso, timeTo: opts.timeTo ?? new Date(to).toISOString() },
        pollMs,
        firstPollMs,
        tooLargeReports,
      );
      return mergeCsv(first, second);
    }
  }

  private async downloadReport(report: ExportReport, tooLargeReports: Set<number>): Promise<string> {
    try {
      return await this.downloadExportCsv(report.downloadLink as string);
    } catch (err) {
      // Never reuse a report whose CSV blew the cap, or splitting would loop on it.
      if (isTooLarge(err)) tooLargeReports.add(report.reportId);
      throw err;
    }
  }

  private async exportOnce(
    opts: ExportOptions,
    pollMs: number,
    firstPollMs: number,
    tooLargeReports: Set<number>,
  ): Promise<string> {
    const wantFrom = opts.timeFrom ? Date.parse(opts.timeFrom) : NaN;
    const wantTo = opts.timeTo ? Date.parse(opts.timeTo) : NaN;
    // Only reuse a report that covers the window AND includes every data type: one
    // exported elsewhere with, say, orders only would silently drop dividends and cash.
    const covers = (r: ExportReport) =>
      !tooLargeReports.has(r.reportId) &&
      includesAll(r) &&
      (!opts.timeFrom || Date.parse(r.timeFrom) <= wantFrom) &&
      (!opts.timeTo || Date.parse(r.timeTo) >= wantTo);

    const existing = opts.knownReports ?? (await this.listExports());
    const done = existing.find((r) => r.status === "Finished" && r.downloadLink && covers(r));
    let reuseFailed = false;
    if (done) {
      try {
        return await this.downloadReport(done, tooLargeReports);
      } catch (err) {
        // An older report's signed link may have expired (the storage host answers 4xx):
        // request a fresh export instead. Anything else is a real failure.
        const expired = err instanceof HttpError && err.status >= 400 && err.status < 500;
        if (!expired) throw err;
        opts.onNote?.(`Reusing export ${done.reportId} failed (${err instanceof Error ? err.message : String(err)}) — requesting a new one.`);
        reuseFailed = true;
      }
    }

    // Wait on an in-progress report rather than POSTing a duplicate.
    const inFlight = reuseFailed
      ? undefined
      : existing.find(
          (r) => (r.status === "Queued" || r.status === "Processing" || r.status === "Running") && covers(r),
        );

    let reportId: number;
    if (inFlight) {
      reportId = inFlight.reportId;
    } else {
      const result = await this.requestExport({
        dataIncluded: {
          includeDividends: true,
          includeInterest: true,
          includeOrders: true,
          includeTransactions: true,
        },
        timeFrom: opts.timeFrom,
        timeTo: opts.timeTo,
      });
      reportId = result.reportId;
    }

    // Poll until the report finishes or we hit the 10-minute cap.
    const deadline = Date.now() + 10 * 60 * 1000;
    let firstPoll = true;
    while (Date.now() < deadline) {
      await this.sleep(firstPoll ? Math.min(firstPollMs, pollMs) : pollMs);
      firstPoll = false;
      const reports = await this.listExports();
      const report = reports.find((r) => r.reportId === reportId);
      if (!report) continue;
      if (report.status === "Finished" && report.downloadLink) {
        return this.downloadReport(report, tooLargeReports);
      }
      if (report.status === "Failed" || report.status === "Canceled") {
        throw new Error(`Trading 212 export ${report.status.toLowerCase()}`);
      }
    }
    throw new Error("Trading 212 export timed out after 10 minutes");
  }
}

/** Whether a report was created with every data type (absent flags count as included). */
function includesAll(r: ExportReport): boolean {
  const d = r.dataIncluded;
  if (!d) return true;
  return (
    d.includeDividends !== false &&
    d.includeInterest !== false &&
    d.includeOrders !== false &&
    d.includeTransactions !== false
  );
}

/**
 * Concatenates two CSVs under a single header. Trading 212 only includes optional columns
 * (e.g. a tax or merchant column) when a window has data for them, so two halves of a split
 * window can have different headers: then both are re-written under the union of columns,
 * so every value stays under its own column name.
 */
export function mergeCsv(a: string, b: string): string {
  if (!a.trim()) return b;
  if (!b.trim()) return a;
  const headerA = a.split(/\r?\n/, 1)[0];
  const nl = b.indexOf("\n");
  const headerB = (nl === -1 ? b : b.slice(0, nl)).replace(/\r$/, "");
  const body = nl === -1 ? "" : b.slice(nl + 1);
  if (!body.trim()) return a;
  if (headerA === headerB) return a.endsWith("\n") ? a + body : `${a}\n${body}`;

  const [ha = [], ...rowsA] = parseCsv(a);
  const [hb = [], ...rowsB] = parseCsv(b);
  const columns = [...ha, ...hb.filter((h) => !ha.includes(h))];
  const reorder = (head: string[], row: string[]) =>
    columns.map((c) => {
      const i = head.indexOf(c);
      return i === -1 ? "" : (row[i] ?? "");
    });
  return [columns, ...rowsA.map((r) => reorder(ha, r)), ...rowsB.map((r) => reorder(hb, r))]
    .map((row) => row.map(csvField).join(","))
    .join("\n");
}

function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * The query string of a `nextPagePath`. A literal `+` there is a plus sign (e.g. a
 * `+01:00` offset in `time`), not an encoded space, so keep it as one.
 */
function nextPageQuery(nextPagePath: string, q: number): URLSearchParams {
  return new URLSearchParams(nextPagePath.slice(q + 1).replace(/\+/g, "%2B"));
}

/** Turns a broker refusal for the download host into an actionable message naming the host. */
function describeDownloadError(err: unknown, url: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (TOO_LARGE.test(message)) return err instanceof Error ? err : new Error(message);
  if (/approved|allowed|declared/i.test(message)) {
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      /* keep the raw url */
    }
    return new Error(
      `Trading 212 export download host "${host}" is not approved for this add-on ` +
        `(allowed: *.trading212.com, *.amazonaws.com). Approve or add the host in the add-on's ` +
        `network permissions. Host said: ${message}`,
    );
  }
  return err instanceof Error ? err : new Error(message);
}

/** Extracts the `cursor` query value from a Trading 212 `nextPagePath` string. */
export function cursorFromNextPage(nextPagePath: string | null | undefined): string | null {
  if (!nextPagePath) return null;
  const q = nextPagePath.indexOf("?");
  if (q === -1) return null;
  return nextPageQuery(nextPagePath, q).get("cursor");
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
  const sp = nextPageQuery(nextPagePath, q);
  return {
    cursor: sp.get("cursor") ?? undefined,
    time: sp.get("time") ?? undefined,
  };
}
