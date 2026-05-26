import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { useSync } from "./use-sync";

// --- helpers -------------------------------------------------------------

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

const ORDER = {
  order: {
    id: 1,
    side: "BUY",
    currency: "USD",
    instrument: { ticker: "AAPL_US_EQ", isin: "US0378331005", name: "Apple Inc" },
  },
  fill: { type: "TRADE", filledAt: "2026-04-01T10:00:00.000Z", price: 100, quantity: 2 },
};

function routeFetch(url: string): Response {
  if (url.includes("/orders")) return jsonResponse({ items: [ORDER], nextPagePath: null });
  return jsonResponse({ items: [], nextPagePath: null }); // dividends + transactions empty
}

interface Conn {
  id: string;
  name: string;
  apiKey: string;
  apiSecret?: string;
  accountId: string;
}

type SyncStateMap = Record<string, { lastSync: string | null; importedRefs: string[] }>;

function makeCtx(opts: {
  connections?: Conn[];
  checkImport?: (a: ActivityImport[]) => Promise<ActivityImport[]>;
  searchTicker?: () => Promise<unknown[]>;
  syncStates?: SyncStateMap;
}) {
  const connections = opts.connections ?? [
    { id: "c1", name: "Trading 212 (Invest)", apiKey: "k", apiSecret: "s", accountId: "acc-1" },
  ];

  const secrets = new Map<string, string>([
    ["t212_settings", JSON.stringify({ proxyUrl: "http://proxy", env: "demo" })],
    ["t212_connections", JSON.stringify(connections)],
  ]);

  // Pre-populate per-connection sync states. Defaults to a past lastSync so existing
  // tests drive the JSON incremental path without needing to mock the export endpoints.
  // Pass syncStates: { c1: { lastSync: null, importedRefs: [] } } to trigger CSV path.
  for (const conn of connections) {
    const state = opts.syncStates?.[conn.id] ?? {
      lastSync: "2026-01-01T00:00:00.000Z",
      importedRefs: [],
    };
    secrets.set(`t212_sync_${conn.id}`, JSON.stringify(state));
  }

  const importFn = vi.fn(async (acts: ActivityImport[]) => ({
    summary: { imported: acts.length, skipped: 0, duplicates: 0 },
  }));
  const searchTicker = vi.fn(opts.searchTicker ?? (async () => [{ symbol: "AAPL", score: 1 }]));

  return {
    ctx: {
      api: {
        secrets: {
          get: async (k: string) => secrets.get(k) ?? null,
          set: async (k: string, v: string) => void secrets.set(k, v),
          delete: async (k: string) => void secrets.delete(k),
        },
        market: { searchTicker },
        activities: {
          checkImport: opts.checkImport ?? (async (a: ActivityImport[]) => a),
          import: importFn,
        },
      },
    },
    secrets,
    importFn,
    searchTicker,
  };
}

// --- tests ---------------------------------------------------------------

describe("useSync — JSON incremental path", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => routeFetch(String(url))));
  });

  it("imports new activities and records the per-connection watermark", async () => {
    const { ctx, secrets, importFn } = makeCtx({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.syncAll();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.results?.totals).toEqual({
      imported: 1,
      duplicates: 0,
      unresolved: 0,
    });
    expect(result.current.results?.perAccount[0].accountId).toBe("acc-1");
    expect(importFn).toHaveBeenCalledTimes(1);

    const state = JSON.parse(secrets.get("t212_sync_c1")!);
    expect(state.lastSync).toBeTruthy();
    expect(state.importedRefs).toContain("t212-order-1");

    // Verbose log is captured for the UI.
    const lg = result.current.results!.perAccount[0].log.join("\n");
    expect(lg).toContain("Incremental sync");
    expect(lg).toContain("Mapped 1 activities");
    expect(lg).toContain("1 imported");
  });

  it("adaptively halves batches the backend rejects, importing everything", async () => {
    // 120 distinct orders. The starting chunk size (20) exceeds the simulated
    // backend limit of 10, so each chunk must be halved before it's accepted.
    const orders = Array.from({ length: 120 }, (_, i) => ({
      order: {
        id: i + 1,
        side: "BUY",
        currency: "USD",
        instrument: { ticker: "AAPL_US_EQ", isin: "US0378331005", name: "Apple Inc" },
      },
      fill: { type: "TRADE", filledAt: "2026-04-01T10:00:00.000Z", price: 100, quantity: 1 },
    }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/orders"))
          return jsonResponse({ items: orders, nextPagePath: null });
        return jsonResponse({ items: [], nextPagePath: null });
      }),
    );

    // Simulate Wealthfolio rejecting any batch larger than 10.
    const { ctx, importFn } = makeCtx({
      checkImport: async (a) => {
        if (a.length > 10) throw new Error("Unprocessable Entity");
        return a;
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.syncAll();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.results?.totals.imported).toBe(120);
    // 6 chunks of 20 → each halved to 10+10 → 12 accepted import batches.
    expect(importFn).toHaveBeenCalledTimes(12);
  });

  it("surfaces the payload when a single activity is genuinely rejected", async () => {
    const orders = Array.from({ length: 5 }, (_, i) => ({
      order: {
        id: i + 1,
        side: "BUY",
        currency: "USD",
        instrument: { ticker: "AAPL_US_EQ", isin: "US0378331005", name: "Apple Inc" },
      },
      fill: { type: "TRADE", filledAt: "2026-04-01T10:00:00.000Z", price: 100, quantity: 1 },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/orders"))
          return jsonResponse({ items: orders, nextPagePath: null });
        return jsonResponse({ items: [], nextPagePath: null });
      }),
    );

    // checkImport always rejects, even a single row → genuine per-row failure.
    const { ctx } = makeCtx({
      checkImport: async () => {
        throw new Error("Unprocessable Entity");
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.syncAll();
    });

    const r = result.current.results!.perAccount[0];
    expect(r.error).toContain("checkImport rejected a single activity");
    expect(r.error).toContain("payload=");
  });

  it("skips duplicates flagged by checkImport without importing", async () => {
    const { ctx, importFn } = makeCtx({
      checkImport: async (a) => a.map((x) => ({ ...x, duplicateOfId: "existing" })),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.syncAll();
    });

    expect(result.current.results?.perAccount[0]).toMatchObject({
      imported: 0,
      duplicates: 1,
      unresolved: 0,
    });
    expect(importFn).not.toHaveBeenCalled();
  });

  it("isolates imported refs per connection (same order id in two accounts)", async () => {
    const { ctx, secrets, importFn, searchTicker } = makeCtx({
      connections: [
        { id: "c1", name: "Invest", apiKey: "k1", accountId: "acc-1" },
        { id: "c2", name: "ISA", apiKey: "k2", accountId: "acc-2" },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.syncAll();
    });

    // Both accounts import the same order id 1 — neither blocks the other.
    expect(result.current.results?.totals.imported).toBe(2);
    const acctIds = importFn.mock.calls.map((c) => c[0][0].accountId);
    expect(acctIds).toContain("acc-1");
    expect(acctIds).toContain("acc-2");

    expect(JSON.parse(secrets.get("t212_sync_c1")!).importedRefs).toContain("t212-order-1");
    expect(JSON.parse(secrets.get("t212_sync_c2")!).importedRefs).toContain("t212-order-1");

    // Shared symbol map is resolved once (cache hit on the 2nd account).
    expect(searchTicker).toHaveBeenCalledTimes(1);
    expect(secrets.get("t212_symbol_map")).toContain("AAPL");
  });

  it("one failing key does not abort the others", async () => {
    const { ctx } = makeCtx({
      connections: [
        { id: "c1", name: "Invest", apiKey: "k1", accountId: "acc-1" },
        { id: "c2", name: "ISA", apiKey: "k2", accountId: "acc-2" },
      ],
    });
    // Make the first connection's fetch throw UNAUTHORIZED.
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        call++;
        if (call === 1) throw new Error("UNAUTHORIZED");
        return routeFetch(String(url));
      }),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));
    await act(async () => {
      await result.current.syncAll();
    });

    const [first, second] = result.current.results!.perAccount;
    expect(first.error).toBeTruthy();
    expect(second.error).toBeUndefined();
    expect(second.imported).toBe(1);
  });
});

// --- CSV export / hybrid path -------------------------------------------

const CSV_HDR =
  "Action,Time,ISIN,Ticker,Name,No. of shares,Price / share,Currency (Price / share)," +
  "Exchange rate,Total,Currency (Total),Withholding tax,Currency (Withholding tax)," +
  "Charge amount,Currency (Charge amount),Notes,ID," +
  "Currency conversion fee,Currency (Currency conversion fee)";

const CSV_DEPOSIT_ROW =
  "Deposit,2025-01-01T08:00:00.000Z,,,,,,,,1000,GBP,0,GBP,0,GBP,,DEP1,0,GBP";

const SAMPLE_CSV = `${CSV_HDR}\n${CSV_DEPOSIT_ROW}`;

const FINISHED_REPORT = {
  reportId: 1,
  status: "Finished",
  downloadLink: "https://test.amazonaws.com/export.csv",
  timeFrom: "2020-01-01T00:00:00Z",
  timeTo: "2026-12-31T00:00:00Z",
  dataIncluded: {
    includeDividends: true,
    includeInterest: true,
    includeOrders: true,
    includeTransactions: true,
  },
};

describe("useSync — CSV export / hybrid path", () => {
  it("walks back in one-year windows, stopping after empty windows", async () => {
    // A finished report covers every requested window, so each runExport reuses it
    // immediately (no poll). The relay returns data for the first window and an empty
    // (header-only) CSV after, so the backfill stops once two windows come back empty.
    let downloadCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/export-download")) {
          downloadCount++;
          return {
            ok: true,
            status: 200,
            text: async () => (downloadCount === 1 ? SAMPLE_CSV : CSV_HDR),
            headers: { get: () => null },
          } as unknown as Response;
        }
        if (u.includes("/exports")) {
          return jsonResponse([FINISHED_REPORT]); // covers all windows → reused
        }
        return routeFetch(u);
      }),
    );

    const { ctx, importFn, secrets } = makeCtx({
      syncStates: { c1: { lastSync: null, importedRefs: [] } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.syncAll();
    });

    expect(result.current.error).toBeNull();
    expect(importFn).toHaveBeenCalledTimes(1);
    expect(result.current.results?.totals.imported).toBe(1);
    // First window had data; the next two were empty → walk stopped (3 downloads).
    expect(downloadCount).toBe(3);

    const state = JSON.parse(secrets.get("t212_sync_c1")!);
    expect(state.lastSync).toBeTruthy();
    expect(state.importedRefs).toContain("t212-txn-DEP1");
  });

  it("checkpoints each window and resumes (no lastSync) when interrupted mid-backfill", async () => {
    // Window 0 downloads data; window 1's download fails → backfill breaks after
    // importing window 0. lastSync must stay null and a checkpoint must be saved.
    let downloadCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/export-download")) {
          downloadCount++;
          if (downloadCount === 1) {
            return {
              ok: true,
              status: 200,
              text: async () => SAMPLE_CSV,
              headers: { get: () => null },
            } as unknown as Response;
          }
          return { ok: false, status: 500, text: async () => "boom", headers: { get: () => null } } as unknown as Response;
        }
        if (u.includes("/exports")) return jsonResponse([FINISHED_REPORT]);
        return routeFetch(u);
      }),
    );

    const { ctx, importFn, secrets } = makeCtx({
      syncStates: { c1: { lastSync: null, importedRefs: [] } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.syncAll();
    });

    // Window 0's single activity was imported and its refs persisted.
    expect(importFn).toHaveBeenCalledTimes(1);
    expect(result.current.results?.totals.imported).toBe(1);

    const state = JSON.parse(secrets.get("t212_sync_c1")!);
    expect(state.lastSync).toBeNull(); // backfill incomplete → not finalized
    expect(state.backfillCheckpoint).toBeTruthy(); // resume point saved
    expect(state.importedRefs).toContain("t212-txn-DEP1");
  });

  it("falls back to JSON paging when the export fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts?: RequestInit) => {
        const u = String(url);
        const method = ((opts?.method as string | undefined) ?? "GET").toUpperCase();

        if (u.includes("/exports") && method === "GET") {
          return jsonResponse([]); // no existing reports
        }
        if (u.includes("/exports") && method === "POST") {
          // Simulate export service error → runExport throws → fallback to JSON
          return { ok: false, status: 500, text: async () => "Error", headers: { get: () => null } } as unknown as Response;
        }
        return routeFetch(u); // JSON paging returns the ORDER fixture
      }),
    );

    const { ctx, importFn } = makeCtx({
      syncStates: { c1: { lastSync: null, importedRefs: [] } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.syncAll();
    });

    expect(result.current.error).toBeNull();
    // JSON fallback imported the ORDER fixture
    expect(importFn).toHaveBeenCalledTimes(1);
    expect(result.current.results?.totals.imported).toBe(1);
  });
});
