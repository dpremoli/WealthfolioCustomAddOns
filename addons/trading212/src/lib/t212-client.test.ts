import { describe, it, expect, vi } from "vitest";
import type { AddonContext } from "@wealthfolio/addon-sdk";
import {
  MIN_SPLIT_WINDOW_MS,
  Trading212Client,
  cursorFromNextPage,
  isForbidden,
  isTooLarge,
  mergeCsv,
  transactionPageParams,
} from "./t212-client";

type Req = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  auth?: { type: string; secretKey: string };
  timeoutSecs?: number;
};
type Res = { status: number; headers: Record<string, string>; body: string };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Res => ({
  status,
  headers,
  body: JSON.stringify(body),
});

function makeClient(
  handler: (req: Req, n: number) => Res | Promise<Res> | Error,
  env: "live" | "demo" = "demo",
) {
  const requests: Req[] = [];
  const request = vi.fn(async (req: Req) => {
    requests.push(req);
    const out = await handler(req, requests.length);
    if (out instanceof Error) throw out;
    return out;
  });
  const ctx = { api: { network: { request } } } as unknown as AddonContext;
  const sleep = vi.fn(async () => {});
  const client = new Trading212Client(ctx, { env, secretKey: "t212_auth_c1" }, { sleep });
  return { client, requests, request, sleep };
}

describe("Trading212Client — direct brokered calls", () => {
  it("calls the env's API host with basic auth via the secret, never an Authorization header", async () => {
    const live = makeClient(() => json({ id: 1, currency: "GBP" }), "live");
    await live.client.getAccountSummary();
    expect(live.requests[0]).toMatchObject({
      url: "https://live.trading212.com/api/v0/equity/account/summary",
      method: "GET",
      auth: { type: "basic", secretKey: "t212_auth_c1" },
      timeoutSecs: 30,
    });
    expect(Object.keys(live.requests[0].headers ?? {}).map((h) => h.toLowerCase())).not.toContain("authorization");

    const demo = makeClient(() => json({ items: [], nextPagePath: null }));
    await demo.client.pageOrders("abc", 50);
    expect(demo.requests[0].url).toBe(
      "https://demo.trading212.com/api/v0/equity/history/orders?cursor=abc&limit=50",
    );
  });

  it("maps each endpoint to its upstream path", async () => {
    const { client, requests } = makeClient((req) =>
      req.url.includes("exports") ? json([]) : json({ items: [], nextPagePath: null }),
    );
    await client.getPositions();
    await client.pageDividends();
    await client.pageTransactions({ cursor: "c", time: "t" });
    await client.listExports();
    await client.getInstruments();
    expect(requests.map((r) => r.url.replace("https://demo.trading212.com/api/v0/equity/", ""))).toEqual([
      "positions",
      "history/dividends?limit=50",
      "history/transactions?cursor=c&time=t&limit=50",
      "history/exports",
      "metadata/instruments",
    ]);
  });

  it("POSTs export requests as JSON with a longer timeout", async () => {
    const { client, requests } = makeClient(() => json({ reportId: 5 }));
    await expect(
      client.requestExport({
        dataIncluded: { includeDividends: true, includeInterest: true, includeOrders: true, includeTransactions: true },
        timeFrom: "2025-01-01T00:00:00.000Z",
        timeTo: "2026-01-01T00:00:00.000Z",
      }),
    ).resolves.toEqual({ reportId: 5 });
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "https://demo.trading212.com/api/v0/equity/history/exports",
      headers: { "Content-Type": "application/json" },
      timeoutSecs: 60,
    });
    expect(JSON.parse(requests[0].body!).timeFrom).toBe("2025-01-01T00:00:00.000Z");
  });

  it("waits out a 429 using x-ratelimit-reset / retry-after, then succeeds", async () => {
    const { client, requests, sleep } = makeClient((_r, n) =>
      n === 1 ? { status: 429, headers: { "Retry-After": "7" }, body: "" } : json({ id: 1, currency: "GBP" }),
    );
    await expect(client.getAccountSummary()).resolves.toMatchObject({ id: 1 });
    expect(requests).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it("maps 401 to UNAUTHORIZED and other non-2xx to a descriptive error", async () => {
    const a = makeClient(() => ({ status: 401, headers: {}, body: "no" }));
    await expect(a.client.getAccountSummary()).rejects.toThrow("UNAUTHORIZED");

    const b = makeClient(() => ({ status: 500, headers: {}, body: "boom" }));
    await expect(b.client.getAccountSummary()).rejects.toThrow("Trading 212 request failed (500): boom");

    const c = makeClient(() => ({ status: 403, headers: {}, body: "Scope( history:orders )" }));
    const err = await c.client.pageOrders().catch((e) => e);
    expect(isForbidden(err)).toBe(true);
    expect(err.message).toMatch(/history\/orders.*missing a permission.*Scope\( history:orders \)/);
  });

  it("retries a transient transport error but not a policy error", async () => {
    const t = makeClient((_r, n) => (n === 1 ? new Error("operation timed out") : json({ id: 1, currency: "GBP" })));
    await expect(t.client.getAccountSummary()).resolves.toMatchObject({ id: 1 });
    expect(t.requests).toHaveLength(2);

    const p = makeClient(() => new Error("Addon network host 'x' is not approved"));
    await expect(p.client.getAccountSummary()).rejects.toThrow(/not approved/);
    expect(p.requests).toHaveLength(1);
  });
});

describe("Trading212Client — export download", () => {
  const LINK = "https://trading212-reports.s3.eu-west-1.amazonaws.com/r.csv?sig=abc";

  it("downloads the signed URL with NO auth and no extra headers", async () => {
    const { client, requests } = makeClient(() => ({ status: 200, headers: {}, body: "a,b\n1,2" }));
    await expect(client.downloadExportCsv(LINK)).resolves.toBe("a,b\n1,2");
    expect(requests[0].url).toBe(LINK);
    expect(requests[0].auth).toBeUndefined();
    expect(requests[0].headers).toBeUndefined();
    expect(requests[0].timeoutSecs).toBe(60);
  });

  it("follows a redirect itself (the broker follows none), still without auth", async () => {
    const { client, requests } = makeClient((_r, n): Res =>
      n === 1
        ? { status: 302, headers: { Location: "https://other.amazonaws.com/final.csv" }, body: "" }
        : { status: 200, headers: {}, body: "a\n1" },
    );
    await expect(client.downloadExportCsv(LINK)).resolves.toBe("a\n1");
    expect(requests.map((r) => r.url)).toEqual([LINK, "https://other.amazonaws.com/final.csv"]);
    expect(requests.every((r) => !r.auth)).toBe(true);
  });

  it("names the host when the broker rejects it as not approved", async () => {
    const { client } = makeClient(() => new Error("Addon network host 'x.example.net' is not approved"));
    await expect(client.downloadExportCsv("https://files.example.net/r.csv")).rejects.toThrow(
      /host "files\.example\.net" is not approved/,
    );
  });

  it("fails on a non-2xx download", async () => {
    const { client } = makeClient(() => ({ status: 403, headers: {}, body: "expired" }));
    await expect(client.downloadExportCsv(LINK)).rejects.toThrow("Export download failed (403)");
  });
});

// --- runExport + 2 MB window splitting -----------------------------------

const HDR = "Action,Time,ID";
const TOO_LARGE_MSG = "Addon network response body is too large";
const DATA_INCLUDED = {
  includeDividends: true,
  includeInterest: true,
  includeOrders: true,
  includeTransactions: true,
};

/**
 * A fake Trading 212: every POST /history/exports creates a Finished report whose
 * download link is `https://dl.amazonaws.com/<reportId>.csv`. `csvFor(from, to)` returns
 * the CSV text for a report, or an Error to simulate the host's 2 MB response cap.
 */
function fakeExportServer(csvFor: (from: string, to: string) => string | Error) {
  const reports = new Map<number, { from: string; to: string }>();
  let nextId = 1;
  const handler = (req: Req): Res | Error => {
    const url = req.url;
    if (url.includes("/history/exports") && req.method === "POST") {
      const body = JSON.parse(req.body!);
      const reportId = nextId++;
      reports.set(reportId, { from: body.timeFrom, to: body.timeTo });
      return json({ reportId });
    }
    if (url.includes("/history/exports")) {
      return json(
        [...reports.entries()].map(([reportId, r]) => ({
          reportId,
          timeFrom: r.from,
          timeTo: r.to,
          dataIncluded: DATA_INCLUDED,
          status: "Finished",
          downloadLink: `https://dl.amazonaws.com/${reportId}.csv`,
        })),
      );
    }
    const id = Number(/dl\.amazonaws\.com\/(\d+)\.csv/.exec(url)?.[1]);
    const r = reports.get(id);
    if (!r) return { status: 404, headers: {}, body: "" };
    const out = csvFor(r.from, r.to);
    return out instanceof Error ? out : { status: 200, headers: {}, body: out };
  };
  return { handler, reports };
}

describe("Trading212Client.runExport", () => {
  it("returns a covering Finished report from knownReports without creating a new export", async () => {
    const { client, requests } = makeClient(() => ({ status: 200, headers: {}, body: `${HDR}\nDeposit,t,1` }));
    const csv = await client.runExport({
      timeFrom: "2025-01-01T00:00:00.000Z",
      timeTo: "2025-06-01T00:00:00.000Z",
      knownReports: [
        {
          reportId: 9,
          timeFrom: "2020-01-01T00:00:00Z",
          timeTo: "2026-12-31T00:00:00Z",
          dataIncluded: DATA_INCLUDED,
          status: "Finished",
          downloadLink: "https://dl.amazonaws.com/9.csv",
        },
      ],
    });
    expect(csv).toContain("Deposit");
    expect(requests).toHaveLength(1); // download only
  });

  it("does not reuse a report that left out some data types", async () => {
    const server = fakeExportServer(() => `${HDR}\nDeposit,t,1`);
    const { client, requests } = makeClient(server.handler);
    await client.runExport({
      timeFrom: "2025-01-01T00:00:00.000Z",
      timeTo: "2025-02-01T00:00:00.000Z",
      knownReports: [
        {
          reportId: 99,
          timeFrom: "2020-01-01T00:00:00Z",
          timeTo: "2026-12-31T00:00:00Z",
          dataIncluded: { ...DATA_INCLUDED, includeDividends: false },
          status: "Finished",
          downloadLink: "https://dl.amazonaws.com/99.csv",
        },
      ],
    });
    expect(requests.some((r) => r.method === "POST")).toBe(true);
    expect(requests.some((r) => r.url.endsWith("/99.csv"))).toBe(false);
  });

  it("requests a fresh export when a reused report's link has expired", async () => {
    const server = fakeExportServer(() => `${HDR}\nDeposit,t,1`);
    const { client, requests } = makeClient((req) =>
      req.url.endsWith("/99.csv") ? { status: 403, headers: {}, body: "expired" } : server.handler(req),
    );
    const notes: string[] = [];
    const csv = await client.runExport({
      timeFrom: "2025-01-01T00:00:00.000Z",
      timeTo: "2025-02-01T00:00:00.000Z",
      onNote: (m) => notes.push(m),
      knownReports: [
        {
          reportId: 99,
          timeFrom: "2020-01-01T00:00:00Z",
          timeTo: "2026-12-31T00:00:00Z",
          dataIncluded: DATA_INCLUDED,
          status: "Finished",
          downloadLink: "https://dl.amazonaws.com/99.csv",
        },
      ],
    });
    expect(csv).toContain("Deposit");
    expect(requests.some((r) => r.method === "POST")).toBe(true);
    expect(notes.join(" ")).toMatch(/requesting a new one/);
  });

  it("creates an export, polls, then downloads when nothing is reusable", async () => {
    const server = fakeExportServer(() => `${HDR}\nDeposit,t,1`);
    const { client, requests, sleep } = makeClient(server.handler);
    const csv = await client.runExport({
      timeFrom: "2025-01-01T00:00:00.000Z",
      timeTo: "2025-02-01T00:00:00.000Z",
    });
    expect(csv).toBe(`${HDR}\nDeposit,t,1`);
    expect(requests.map((r) => `${r.method} ${r.url.split("/equity/")[1] ?? "download"}`)).toEqual([
      "GET history/exports", // initial list: nothing to reuse
      "POST history/exports",
      "GET history/exports", // poll
      "GET download",
    ]);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("splits a window in half when the CSV is too large and merges the halves under one header", async () => {
    const from = "2025-01-01T00:00:00.000Z";
    const to = "2025-03-01T00:00:00.000Z"; // 59 days
    const mid = new Date((Date.parse(from) + Date.parse(to)) / 2).toISOString();
    const server = fakeExportServer((f, t) => {
      if (f === from && t === to) return new Error(TOO_LARGE_MSG);
      return `${HDR}\nrow-${f.slice(0, 10)}-${t.slice(0, 10)},x,1`;
    });
    const { client } = makeClient(server.handler);
    const notes: string[] = [];

    const csv = await client.runExport({ timeFrom: from, timeTo: to, onNote: (m) => notes.push(m) });

    const lines = csv.split("\n");
    expect(lines[0]).toBe(HDR);
    expect(lines).toHaveLength(3); // one header + one row per half
    expect(lines[1]).toContain(`row-2025-01-01-${mid.slice(0, 10)}`);
    expect(lines[2]).toContain(`row-${mid.slice(0, 10)}-2025-03-01`);
    expect(notes[0]).toMatch(/exceeds the 2 MB/);
    // Original window + its two halves were each requested as separate exports.
    expect([...server.reports.values()].map((r) => [r.from, r.to])).toEqual([
      [from, to],
      [from, mid],
      [mid, to],
    ]);
  });

  it("does not reuse the oversized covering report for the halves (no infinite loop)", async () => {
    const from = "2025-01-01T00:00:00.000Z";
    const to = "2025-03-01T00:00:00.000Z";
    const server = fakeExportServer((f, t) => (f === from && t === to ? new Error(TOO_LARGE_MSG) : `${HDR}\nok,x,1`));
    // Pre-seed: the wide report is already Finished and offered via knownReports.
    server.reports.set(100, { from, to });
    const { client, request } = makeClient(server.handler);

    const csv = await client.runExport({
      timeFrom: from,
      timeTo: to,
      knownReports: [
        { reportId: 100, timeFrom: from, timeTo: to, dataIncluded: DATA_INCLUDED, status: "Finished", downloadLink: "https://dl.amazonaws.com/100.csv" },
      ],
    });

    expect(csv.split("\n").filter((l) => l === "ok,x,1")).toHaveLength(2);
    const downloads100 = request.mock.calls.filter((c) => c[0].url.endsWith("/100.csv"));
    expect(downloads100).toHaveLength(1); // tried once, then excluded
  });

  it("splits recursively, down to the minimum window, and then gives up with a clear error", async () => {
    const from = "2025-01-01T00:00:00.000Z";
    const to = new Date(Date.parse(from) + 40 * 24 * 3600 * 1000).toISOString();
    const spans: number[] = [];
    const server = fakeExportServer((f, t) => {
      spans.push(Date.parse(t) - Date.parse(f));
      return new Error(TOO_LARGE_MSG); // everything is always too large
    });
    const { client } = makeClient(server.handler);

    await expect(client.runExport({ timeFrom: from, timeTo: to })).rejects.toThrow(/smallest window size \(7 days\)/);

    // 40d → 20d → 10d; a 10-day window can't be halved into ≥ 7-day parts, so it errors there.
    const days = spans.map((s) => Math.round(s / (24 * 3600 * 1000)));
    expect(days).toEqual([40, 20, 10]);
    expect(Math.min(...spans)).toBeGreaterThanOrEqual(MIN_SPLIT_WINDOW_MS);
  });

  it("only splits on 'too large' — other download errors propagate", async () => {
    const server = fakeExportServer(() => new Error("connection reset by peer"));
    const { client, requests } = makeClient(server.handler);
    // transport errors are retried (3x) by the broker, then surface unchanged.
    await expect(
      client.runExport({ timeFrom: "2025-01-01T00:00:00.000Z", timeTo: "2025-06-01T00:00:00.000Z" }),
    ).rejects.toThrow("connection reset by peer");
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1); // never split/re-requested
  });
});

describe("helpers", () => {
  it("isTooLarge matches the host's message", () => {
    expect(isTooLarge(new Error("Addon network response body is too large"))).toBe(true);
    expect(isTooLarge(new Error("timeout"))).toBe(false);
  });

  it("mergeCsv keeps one header and tolerates empty parts", () => {
    expect(mergeCsv("h\n1", "h\n2")).toBe("h\n1\n2");
    expect(mergeCsv("h\n1\n", "h\n2\n")).toBe("h\n1\n2\n");
    expect(mergeCsv("", "h\n2")).toBe("h\n2");
    expect(mergeCsv("h\n1", "h")).toBe("h\n1");
  });

  it("mergeCsv keeps values under their own column when the halves' headers differ", () => {
    const a = "Action,Total\nDeposit,10";
    const b = 'Action,Withholding tax,Total\nDividend,"0,15",2';
    expect(mergeCsv(a, b)).toBe('Action,Total,Withholding tax\nDeposit,10,\nDividend,2,"0,15"');
  });

  it("cursorFromNextPage / transactionPageParams parse nextPagePath", () => {
    expect(cursorFromNextPage("/api/v0/equity/history/orders?limit=50&cursor=123")).toBe("123");
    expect(cursorFromNextPage(null)).toBeNull();
    expect(transactionPageParams("/x?cursor=1&time=2026-01-01T00%3A00%3A00Z")).toEqual({
      cursor: "1",
      time: "2026-01-01T00:00:00Z",
    });
    expect(transactionPageParams(undefined)).toEqual({});
    // A literal "+" in an offset is a plus sign, not an encoded space.
    expect(transactionPageParams("/x?cursor=1&time=2026-01-01T00:00:00+01:00").time).toBe(
      "2026-01-01T00:00:00+01:00",
    );
  });
});
