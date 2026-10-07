import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { useSync, runSyncAll } from "./use-sync";

// --- helpers -------------------------------------------------------------

type Res = { status: number; headers: Record<string, string>; body: string };
type Req = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  auth?: { type: string; secretKey: string };
};

function jsonResponse(body: unknown): Res {
  return { status: 200, headers: {}, body: JSON.stringify(body) };
}

function textResponse(body: string, status = 200): Res {
  return { status, headers: {}, body };
}

/** Handler behind `ctx.api.network.request`; each test replaces it with `net(...)`. */
type NetHandler = (url: string, req: Req) => Res | Promise<Res>;
let netHandler: NetHandler = (url) => routeFetch(url);
function net(h: NetHandler) {
  netHandler = h;
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

function routeFetch(url: string): Res {
  if (url.includes("/orders")) return jsonResponse({ items: [ORDER], nextPagePath: null });
  return jsonResponse({ items: [], nextPagePath: null }); // dividends + transactions empty
}

interface Conn {
  id: string;
  name: string;
  accountId: string;
  needsCredentials?: boolean;
  trackingMode?: "TRANSACTIONS" | "HOLDINGS";
  kind?: "invest" | "isa";
}

type SyncStateMap = Record<string, { lastSync: string | null; importedRefs: string[] }>;

function makeCtx(opts: {
  connections?: Conn[];
  checkImport?: (a: ActivityImport[]) => Promise<ActivityImport[]>;
  searchTicker?: () => Promise<unknown[]>;
  syncStates?: SyncStateMap;
  existingAccounts?: { id: string; providerAccountId?: string; trackingMode?: string }[];
  existingActivities?: { id: string }[];
  existingSnapshots?: { snapshotDate: string }[];
}) {
  const connections = opts.connections ?? [
    { id: "c1", name: "Trading 212 (Invest)", accountId: "acc-1" },
  ];

  const storage = new Map<string, string>([
    ["t212_settings", JSON.stringify({ env: "demo" })],
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
    storage.set(`t212_sync_${conn.id}`, JSON.stringify(state));
  }

  // Credentials live in the keyring as base64(keyId:secret), one secret per connection.
  const secrets = new Map<string, string>(
    connections.filter((c) => !c.needsCredentials).map((c) => [`t212_auth_${c.id}`, btoa(`kid-${c.id}:sec`)]),
  );

  const networkRequest = vi.fn(async (req: Req) => netHandler(req.url, req));

  const importFn = vi.fn(async (acts: ActivityImport[]) => ({
    summary: { imported: acts.length, skipped: 0, duplicates: 0 },
  }));
  const searchTicker = vi.fn(opts.searchTicker ?? (async () => [{ symbol: "AAPL", score: 1 }]));

  // Linked Wealthfolio accounts exist (ids match the connections), unless a test
  // overrides existingAccounts to simulate a deleted/stale link.
  const existingAccounts =
    opts.existingAccounts ?? connections.map((c) => ({ id: c.accountId, providerAccountId: "" }));
  const accountsCreate = vi.fn(async () => ({ id: "acc-new" }));

  const snapshotsSave = vi.fn(
    async (_accountId: string, _holdings: unknown, _cash: Record<string, string>) => {},
  );
  const snapshotsDelete = vi.fn(async (_accountId: string, _date: string) => {});
  const activitiesSaveMany = vi.fn(async (_req: { deleteIds?: string[] }) => ({}));

  return {
    ctx: {
      api: {
        storage: {
          get: async (k: string) => storage.get(k) ?? null,
          set: async (k: string, v: string) => void storage.set(k, v),
          delete: async (k: string) => void storage.delete(k),
        },
        secrets: {
          get: async (k: string) => secrets.get(k) ?? null,
          set: async (k: string, v: string) => void secrets.set(k, v),
          delete: async (k: string) => void secrets.delete(k),
        },
        network: { request: networkRequest },
        market: { searchTicker },
        accounts: {
          getAll: async () => existingAccounts,
          create: accountsCreate,
        },
        activities: {
          checkImport: opts.checkImport ?? (async (a: ActivityImport[]) => a),
          import: importFn,
          getAll: async () => opts.existingActivities ?? [],
          saveMany: activitiesSaveMany,
        },
        snapshots: {
          getAll: async () => opts.existingSnapshots ?? [],
          save: snapshotsSave,
          delete: snapshotsDelete,
        },
      },
    },
    storage,
    secrets,
    networkRequest,
    importFn,
    searchTicker,
    accountsCreate,
    snapshotsSave,
    snapshotsDelete,
    activitiesSaveMany,
  };
}

// --- tests ---------------------------------------------------------------

describe("useSync — JSON incremental path", () => {
  beforeEach(() => {
    net((url) => routeFetch(url));
  });

  it("imports new activities and records the per-connection watermark", async () => {
    const { ctx, storage, importFn } = makeCtx({});
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

    const state = JSON.parse(storage.get("t212_sync_c1")!);
    expect(state.lastSync).toBeTruthy();
    expect(state.importedRefs).toContain("t212-order-1");

    // Verbose log is captured for the UI.
    const lg = result.current.results!.perAccount[0].log.join("\n");
    expect(lg).toContain("Incremental sync");
    expect(lg).toContain("Mapped 1 activities");
    expect(lg).toContain("1 imported");

    // Structured fields the new UI consumes: per-type breakdown, finishedAt timestamp.
    const r = result.current.results!.perAccount[0];
    expect(r.breakdown).toEqual({ BUY: 1 });
    expect(r.finishedAt).toBeTruthy();
    // Live step timeline is accumulated and the last step marked done.
    expect(result.current.steps.length).toBeGreaterThan(0);
    expect(result.current.steps[result.current.steps.length - 1].status).toBe("done");
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

    net(async (url: string) => {
        if (String(url).includes("/orders"))
          return jsonResponse({ items: orders, nextPagePath: null });
        return jsonResponse({ items: [], nextPagePath: null });
      });

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
    net(async (url: string) => {
        if (String(url).includes("/orders"))
          return jsonResponse({ items: orders, nextPagePath: null });
        return jsonResponse({ items: [], nextPagePath: null });
      });

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

  it("skips activities the account already holds without importing", async () => {
    const { ctx, importFn } = makeCtx({
      existingActivities: [
        {
          id: "existing",
          activityType: "BUY",
          date: "2026-04-01T10:00:00.000Z",
          quantity: "2",
          unitPrice: "100",
          currency: "USD",
          comment: "Apple Inc",
          assetSymbol: "AAPL",
        } as { id: string },
      ],
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

  it("imports genuine identical same-day deposits even though checkImport flags them", async () => {
    const dep = (reference: string) => ({
      type: "DEPOSIT",
      amount: 50,
      currency: "GBP",
      dateTime: "2026-04-02T09:00:00.000Z",
      reference,
    });
    net((url) =>
      url.includes("/transactions")
        ? jsonResponse({ items: [dep("D1"), dep("D2")], nextPagePath: null })
        : jsonResponse({ items: [], nextPagePath: null }),
    );
    const { ctx, importFn } = makeCtx({
      checkImport: async (a) => a.map((x, i) => (i > 0 ? { ...x, duplicateOfId: "content-hash" } : x)),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));
    await act(async () => {
      await result.current.syncAll();
    });
    const imported = importFn.mock.calls.flatMap((c) => c[0]);
    expect(imported.map((a) => a.id)).toEqual(["t212-txn-D1", "t212-txn-D2"]);
    expect(imported.every((a) => a.forceImport)).toBe(true);
  });

  it("isolates imported refs per connection (same order id in two accounts)", async () => {
    const { ctx, storage, importFn, searchTicker } = makeCtx({
      connections: [
        { id: "c1", name: "Invest", accountId: "acc-1" },
        { id: "c2", name: "ISA", accountId: "acc-2" },
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

    expect(JSON.parse(storage.get("t212_sync_c1")!).importedRefs).toContain("t212-order-1");
    expect(JSON.parse(storage.get("t212_sync_c2")!).importedRefs).toContain("t212-order-1");

    // Shared symbol map is resolved once (cache hit on the 2nd account).
    expect(searchTicker).toHaveBeenCalledTimes(1);
    expect(storage.get("t212_symbol_map_v6")).toContain("AAPL");
  });

  it("one failing key does not abort the others", async () => {
    const { ctx } = makeCtx({
      connections: [
        { id: "c1", name: "Invest", accountId: "acc-1" },
        { id: "c2", name: "ISA", accountId: "acc-2" },
      ],
    });
    // Trading 212 rejects the first connection's key (401); the second still syncs.
    let call = 0;
    net(async (url: string) => {
        call++;
        if (call === 1) return textResponse("bad key", 401);
        return routeFetch(String(url));
      });

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
    net(async (url: string) => {
        const u = String(url);
        if (u.includes("amazonaws.com")) {
          downloadCount++;
          return textResponse((downloadCount === 1 ? SAMPLE_CSV : CSV_HDR));
        }
        if (u.includes("/exports")) {
          return jsonResponse([FINISHED_REPORT]); // covers all windows → reused
        }
        return routeFetch(u);
      });

    const { ctx, importFn, storage } = makeCtx({
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

    const state = JSON.parse(storage.get("t212_sync_c1")!);
    expect(state.lastSync).toBeTruthy();
    expect(state.backfillStartedAt).toBeNull();
    expect(state.importedRefs).toContain("t212-txn-DEP1");
  });

  it("routes card spending to a dedicated CASH card account when extraction is on", async () => {
    const CARD_HDR = "Action,Time,Total,Currency (Total),Merchant name,Merchant category,ID";
    const CARD_ROW = "Card debit,2025-06-01T10:00:00.000Z,-12.34,GBP,SAINSBURYS,RETAIL_STORES,CARD1";
    const CARD_CSV = `${CARD_HDR}\n${CARD_ROW}`;
    let downloadCount = 0;
    net(async (url: string) => {
        const u = String(url);
        if (u.includes("account/summary")) return jsonResponse({ id: 99, currency: "GBP" });
        if (u.includes("amazonaws.com")) {
          downloadCount++;
          return textResponse((downloadCount === 1 ? CARD_CSV : CARD_HDR));
        }
        if (u.includes("/exports")) return jsonResponse([FINISHED_REPORT]);
        return routeFetch(u);
      });

    const { ctx, importFn, accountsCreate, storage } = makeCtx({
      syncStates: { c1: { lastSync: null, importedRefs: [] } },
    });
    // Enable card extraction in the shared settings.
    storage.set("t212_settings", JSON.stringify({ env: "demo", extractCard: true }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.syncAll();
    });

    expect(result.current.error).toBeNull();
    // A CASH card account was created, deduped by the `${id}-card` providerAccountId.
    const createArgs = accountsCreate.mock.calls as unknown as Array<
      [{ providerAccountId?: string; accountType?: string }]
    >;
    const cardCreate = createArgs.map((c) => c[0]).find((a) => a?.providerAccountId === "99-card");
    expect(cardCreate).toBeTruthy();
    expect(cardCreate!.accountType).toBe("CASH");
    // The card row was imported to the card account (id "acc-new") with the mapped category.
    const imported = importFn.mock.calls.flatMap((c) => c[0]);
    const card = imported.find((a) => a.id === "t212-txn-CARD1");
    expect(card).toBeTruthy();
    expect(card!.accountId).toBe("acc-new");
    expect(card!.activityType).toBe("WITHDRAWAL");
    expect(card!.comment).toBe("SAINSBURYS · Shopping");
    // The connection now records its linked card account, and the card watermark is set.
    const conns = JSON.parse(storage.get("t212_connections")!);
    expect(conns[0].cardAccountId).toBe("acc-new");
    expect(JSON.parse(storage.get("t212_sync_c1")!).cardLastSync).toBeTruthy();
  });

  it("checkpoints each window and resumes (no lastSync) when interrupted mid-backfill", async () => {
    // Window 0 downloads data; window 1's download fails → backfill breaks after
    // importing window 0. lastSync must stay null and a checkpoint must be saved.
    let downloadCount = 0;
    net(async (url: string) => {
        const u = String(url);
        if (u.includes("amazonaws.com")) {
          downloadCount++;
          if (downloadCount === 1) {
            return textResponse(SAMPLE_CSV);
          }
          return textResponse("boom", 500);
        }
        if (u.includes("/exports")) return jsonResponse([FINISHED_REPORT]);
        return routeFetch(u);
      });

    const { ctx, importFn, storage } = makeCtx({
      syncStates: { c1: { lastSync: null, importedRefs: [] } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.syncAll();
    });

    // The backfill's start is kept for the resume, so its final watermark covers the gap.
    expect(JSON.parse(storage.get("t212_sync_c1")!).backfillStartedAt).toBeTruthy();

    // Window 0's single activity was imported and its refs persisted.
    expect(importFn).toHaveBeenCalledTimes(1);
    expect(result.current.results?.totals.imported).toBe(1);

    const state = JSON.parse(storage.get("t212_sync_c1")!);
    expect(state.lastSync).toBeNull(); // backfill incomplete → not finalized
    expect(state.backfillCheckpoint).toBeTruthy(); // resume point saved
    expect(state.importedRefs).toContain("t212-txn-DEP1");
  });

  it("a resumed backfill sets the watermark to when the backfill first started", async () => {
    net(async (url: string) => {
      if (url.includes("amazonaws.com")) return textResponse(CSV_HDR); // no older history
      if (url.includes("/exports")) return jsonResponse([FINISHED_REPORT]);
      return routeFetch(url);
    });
    const started = "2026-03-01T00:00:00.000Z";
    const { ctx, storage } = makeCtx({
      syncStates: {
        c1: {
          lastSync: null,
          importedRefs: [],
          backfillCheckpoint: "2025-03-01T00:00:00.000Z",
          backfillStartedAt: started,
        } as SyncStateMap[string],
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));
    await act(async () => {
      await result.current.syncAll();
    });
    const state = JSON.parse(storage.get("t212_sync_c1")!);
    expect(state.lastSync).toBe(started);
    expect(state.backfillCheckpoint).toBeNull();
    expect(state.backfillStartedAt).toBeNull();
  });

  it("recreates a deleted Wealthfolio account, re-links, and imports into the new id", async () => {
    let downloadCount = 0;
    net(async (url: string) => {
        const u = String(url);
        if (u.includes("account/summary")) return jsonResponse({ id: 99, currency: "GBP" });
        if (u.includes("amazonaws.com")) {
          downloadCount++;
          return textResponse((downloadCount === 1 ? SAMPLE_CSV : CSV_HDR));
        }
        if (u.includes("/exports")) return jsonResponse([FINISHED_REPORT]);
        return routeFetch(u);
      });

    // The linked account "acc-1" no longer exists in Wealthfolio.
    const { ctx, importFn, accountsCreate, storage } = makeCtx({
      existingAccounts: [],
      syncStates: { c1: { lastSync: "2026-01-01T00:00:00.000Z", importedRefs: [] } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.syncAll();
    });

    expect(result.current.error).toBeNull();
    expect(accountsCreate).toHaveBeenCalledTimes(1);
    // Imported into the freshly created account id, not the stale one.
    expect(importFn).toHaveBeenCalledTimes(1);
    expect(importFn.mock.calls[0][0][0].accountId).toBe("acc-new");
    // Connection was re-linked to the new account id.
    expect(JSON.parse(storage.get("t212_connections")!)[0].accountId).toBe("acc-new");
    const lg = result.current.results!.perAccount[0].log.join("\n");
    expect(lg).toContain("Linked Wealthfolio account not found");
  });

  it("falls back to JSON paging when the export fails", async () => {
    net(async (url: string, req: Req) => {
        const u = String(url);
        const method = (req.method ?? "GET").toUpperCase();

        if (u.includes("/exports") && method === "GET") {
          return jsonResponse([]); // no existing reports
        }
        if (u.includes("/exports") && method === "POST") {
          // Simulate export service error → runExport throws → fallback to JSON
          return textResponse("Error", 500);
        }
        return routeFetch(u); // JSON paging returns the ORDER fixture
      });

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

// --- HOLDINGS mode + tracking-mode drift --------------------------------

const POSITION = {
  instrument: { ticker: "AAPL_US_EQ", isin: "US0378331005", name: "Apple Inc", currency: "USD" },
  quantity: 3,
  averagePricePaid: 150,
};

function routeHoldingsFetch(url: string): Res {
  const u = String(url);
  if (u.includes("account/summary"))
    return jsonResponse({
      id: 1,
      currency: "GBP",
      cash: { availableToTrade: 250, reservedForOrders: 40, inPies: 10.5 },
    });
  if (u.includes("/positions")) return jsonResponse([POSITION]);
  return jsonResponse([]);
}

describe("useSync — HOLDINGS mode", () => {
  it("writes a positions/cash snapshot and skips activity import", async () => {
    net((url) => routeHoldingsFetch(url));

    const { ctx, importFn, snapshotsSave, storage } = makeCtx({
      connections: [
        { id: "c1", name: "Invest", accountId: "acc-1", trackingMode: "HOLDINGS" },
      ],
      existingAccounts: [{ id: "acc-1", trackingMode: "HOLDINGS" }],
      syncStates: { c1: { lastSync: null, importedRefs: [] } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.syncAll();
    });

    expect(result.current.error).toBeNull();
    expect(importFn).not.toHaveBeenCalled();
    expect(snapshotsSave).toHaveBeenCalledTimes(1);

    const [accountId, holdings, cash] = snapshotsSave.mock.calls[0];
    expect(accountId).toBe("acc-1");
    expect(holdings).toEqual([
      { symbol: "AAPL", quantity: "3", currency: "USD", averageCost: "150", name: "Apple Inc" },
    ]);
    // Free cash + cash reserved for pending orders + uninvested cash in pies.
    expect(cash).toEqual({ GBP: "300.5" });

    expect(result.current.results?.totals.imported).toBe(1);
    expect(JSON.parse(storage.get("t212_sync_c1")!).lastSync).toBeTruthy();
  });

  it("enriches a bare-ticker position from instruments metadata to pick the right currency", async () => {
    // /positions carries only a ticker (no instrument); /instruments supplies the
    // USD currency, which must steer the resolver away from the MXN cross-listing.
    net(async (url: string) => {
        const u = String(url);
        if (u.includes("account/summary"))
          return jsonResponse({ id: 1, currency: "EUR", cash: { availableToTrade: 0 } });
        if (u.includes("/positions")) return jsonResponse([{ ticker: "TSM_US_EQ", quantity: 2 }]);
        if (u.includes("/instruments"))
          return jsonResponse([
            { ticker: "TSM_US_EQ", isin: "US8740391003", name: "Taiwan Semiconductor", currencyCode: "USD" },
          ]);
        return jsonResponse([]);
      });

    const { ctx, snapshotsSave } = makeCtx({
      connections: [
        { id: "c1", name: "Invest", accountId: "acc-1", trackingMode: "HOLDINGS" },
      ],
      existingAccounts: [{ id: "acc-1", trackingMode: "HOLDINGS" }],
      syncStates: { c1: { lastSync: null, importedRefs: [] } },
      // ISIN search returns both listings; the USD currency must win over score.
      searchTicker: async () => [
        { symbol: "TSMN", score: 9, currency: "MXN" },
        { symbol: "TSM", score: 5, currency: "USD" },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.syncAll();
    });

    const [, holdings] = snapshotsSave.mock.calls[0];
    expect((holdings as { symbol: string }[])[0].symbol).toBe("TSM");
  });

  it("also extracts card transactions in HOLDINGS mode when enabled", async () => {
    const CARD_HDR = "Action,Time,Total,Currency (Total),Merchant name,Merchant category,ID";
    const CARD_ROW = "Card debit,2025-06-01T10:00:00.000Z,-12.34,GBP,SAINSBURYS,RETAIL_STORES,CARD1";
    let downloadCount = 0;
    net(async (url: string) => {
        const u = String(url);
        if (u.includes("account/summary"))
          return jsonResponse({ id: 1, currency: "GBP", cash: { availableToTrade: 250 } });
        if (u.includes("/positions")) return jsonResponse([POSITION]);
        if (u.includes("amazonaws.com")) {
          downloadCount++;
          return textResponse((downloadCount === 1 ? `${CARD_HDR}\n${CARD_ROW}` : CARD_HDR));
        }
        if (u.includes("/exports")) return jsonResponse([FINISHED_REPORT]);
        return jsonResponse([]);
      });

    const { ctx, importFn, snapshotsSave, accountsCreate, storage } = makeCtx({
      connections: [
        { id: "c1", name: "Invest", accountId: "acc-1", trackingMode: "HOLDINGS" },
      ],
      existingAccounts: [{ id: "acc-1", trackingMode: "HOLDINGS" }],
      syncStates: { c1: { lastSync: null, importedRefs: [] } },
    });
    storage.set("t212_settings", JSON.stringify({ env: "demo", extractCard: true }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.syncAll();
    });

    expect(result.current.error).toBeNull();
    // Snapshot still written for the investing account…
    expect(snapshotsSave).toHaveBeenCalledTimes(1);
    // …and the card row imported to the dedicated CASH card account.
    const createArgs = accountsCreate.mock.calls as unknown as Array<
      [{ providerAccountId?: string; accountType?: string }]
    >;
    expect(createArgs.map((c) => c[0]).find((a) => a?.providerAccountId === "1-card")?.accountType).toBe("CASH");
    const card = importFn.mock.calls.flatMap((c) => c[0]).find((a) => a.id === "t212-txn-CARD1");
    expect(card).toBeTruthy();
    expect(card!.accountId).toBe("acc-new");
    expect(card!.comment).toBe("SAINSBURYS · Shopping");
    expect(JSON.parse(storage.get("t212_sync_c1")!).cardLastSync).toBeTruthy();
    // HOLDINGS breakdown surfaces Holdings + Card so the Summary tab isn't greyed out.
    const r = result.current.results!.perAccount[0];
    expect(r.breakdown).toEqual({ Holdings: 1, Card: 1 });
  });

  it("skips card extraction entirely for an ISA connection", async () => {
    // ISA returns a snapshot but the export endpoint should never be hit, and no
    // "<name> Card" account should be created.
    let exportCalls = 0;
    net(async (url: string) => {
        const u = String(url);
        if (u.includes("/exports") || u.includes("amazonaws.com")) {
          exportCalls++;
          return jsonResponse([]);
        }
        return routeHoldingsFetch(u);
      });

    const { ctx, accountsCreate, storage } = makeCtx({
      connections: [
        { id: "c1", name: "ISA", accountId: "acc-1", trackingMode: "HOLDINGS", kind: "isa" },
      ],
      existingAccounts: [{ id: "acc-1", trackingMode: "HOLDINGS" }],
      syncStates: { c1: { lastSync: null, importedRefs: [] } },
    });
    storage.set("t212_settings", JSON.stringify({ env: "demo", extractCard: true }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.syncAll();
    });

    expect(result.current.error).toBeNull();
    expect(exportCalls).toBe(0);
    // No "*-card" account was created for the ISA.
    const createArgs = accountsCreate.mock.calls as unknown as Array<[{ providerAccountId?: string }]>;
    const cardCreate = createArgs.map((c) => c[0]).find((a) => a?.providerAccountId?.endsWith("-card"));
    expect(cardCreate).toBeUndefined();
    const lg = result.current.results!.perAccount[0].log.join("\n");
    expect(lg).toContain("ISA accounts don't have a card");
  });

  it("marks card history done when the backfill finds no rows, so it is not walked again", async () => {
    // An account with no card spending: every window is empty. Advancing the watermark stops
    // later syncs repeating the slow multi-year export walk; new rows are still fetched from it.
    net(async (url: string) => {
        const u = String(url);
        if (u.includes("account/summary"))
          return jsonResponse({ id: 1, currency: "GBP", cash: { availableToTrade: 0 } });
        if (u.includes("/positions")) return jsonResponse([]);
        if (u.includes("amazonaws.com")) {
          return textResponse(CSV_HDR); // header-only — zero rows every window
        }
        if (u.includes("/exports")) return jsonResponse([FINISHED_REPORT]);
        return jsonResponse([]);
      });

    const { ctx, storage } = makeCtx({
      connections: [
        { id: "c1", name: "Invest", accountId: "acc-1", trackingMode: "HOLDINGS" },
      ],
      existingAccounts: [{ id: "acc-1", trackingMode: "HOLDINGS" }],
      syncStates: { c1: { lastSync: null, importedRefs: [] } },
    });
    storage.set("t212_settings", JSON.stringify({ env: "demo", extractCard: true }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.syncAll();
    });

    expect(result.current.error).toBeNull();
    expect(JSON.parse(storage.get("t212_sync_c1")!).cardLastSync).toBeTruthy();

    // A sync straight after does not export card history again.
    const requests = (ctx.api.network.request as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      await result.current.syncAll();
    });
    const exportCalls = (ctx.api.network.request as ReturnType<typeof vi.fn>).mock.calls
      .slice(requests)
      .filter(([req]) => String(req.url).includes("/exports"));
    expect(exportCalls).toHaveLength(0);
    expect(result.current.results!.perAccount[0].log.join("\n")).toMatch(/Card history refreshed \d+ min ago/);
  });

  it("leaves card history open for a retry when an export fails", async () => {
    net(async (url: string) => {
      const u = String(url);
      if (u.includes("account/summary"))
        return jsonResponse({ id: 1, currency: "GBP", cash: { availableToTrade: 0 } });
      if (u.includes("/positions")) return jsonResponse([]);
      if (u.includes("amazonaws.com")) return textResponse("boom", 500);
      if (u.includes("/exports")) return jsonResponse([FINISHED_REPORT]);
      return jsonResponse([]);
    });
    const { ctx, storage } = makeCtx({
      connections: [{ id: "c1", name: "Invest", accountId: "acc-1", trackingMode: "HOLDINGS" }],
      existingAccounts: [{ id: "acc-1", trackingMode: "HOLDINGS" }],
      syncStates: { c1: { lastSync: null, importedRefs: [] } },
    });
    storage.set("t212_settings", JSON.stringify({ env: "demo", extractCard: true }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));
    await act(async () => {
      await result.current.syncAll();
    });
    expect(JSON.parse(storage.get("t212_sync_c1")!).cardLastSync).toBeFalsy();
    expect(result.current.results!.perAccount[0].log.join("\n")).toMatch(/retries it/);
  });

  it("recognises a v1 ISA connection by name and skips card extraction for it", async () => {
    net((url) => routeHoldingsFetch(url));
    const { ctx } = makeCtx({
      connections: [{ id: "c2", name: "Trading 212 (ISA)", accountId: "acc-2", trackingMode: "HOLDINGS" }],
      existingAccounts: [{ id: "acc-2", trackingMode: "HOLDINGS" }],
      syncStates: { c2: { lastSync: null, importedRefs: [] } },
    });
    (ctx.api.storage as { set: (k: string, v: string) => Promise<void> }).set(
      "t212_settings",
      JSON.stringify({ env: "demo", extractCard: true }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));
    await act(async () => {
      await result.current.syncAll();
    });
    expect(result.current.results!.perAccount[0].log.join("\n")).toMatch(/ISA accounts don't have a card/);
  });
});

describe("useSync — tracking-mode drift", () => {
  it("skips a drifted connection that has not been confirmed (no clearing)", async () => {
    net((url) => routeHoldingsFetch(url));

    // Connection recorded as TRANSACTIONS but the WF account is now HOLDINGS.
    const { ctx, snapshotsSave, activitiesSaveMany } = makeCtx({
      connections: [
        { id: "c1", name: "Invest", accountId: "acc-1", trackingMode: "TRANSACTIONS" },
      ],
      existingAccounts: [{ id: "acc-1", trackingMode: "HOLDINGS" }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.syncAll(); // empty confirmation set
    });

    const r = result.current.results!.perAccount[0];
    expect(r.error).toContain("Tracking mode changed");
    expect(activitiesSaveMany).not.toHaveBeenCalled();
    expect(snapshotsSave).not.toHaveBeenCalled();
  });

  it("clears old-mode data and re-syncs when the switch is confirmed", async () => {
    net((url) => routeHoldingsFetch(url));

    // Old mode TRANSACTIONS with two imported activities; account now HOLDINGS.
    const { ctx, snapshotsSave, activitiesSaveMany, storage } = makeCtx({
      connections: [
        { id: "c1", name: "Invest", accountId: "acc-1", trackingMode: "TRANSACTIONS" },
      ],
      existingAccounts: [{ id: "acc-1", trackingMode: "HOLDINGS" }],
      existingActivities: [{ id: "a1" }, { id: "a2" }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.syncAll(new Set(["c1"]));
    });

    expect(result.current.error).toBeNull();
    // Old TRANSACTIONS data cleared via saveMany({deleteIds}).
    expect(activitiesSaveMany).toHaveBeenCalledWith({ deleteIds: ["a1", "a2"] });
    // Re-synced in the new HOLDINGS mode.
    expect(snapshotsSave).toHaveBeenCalledTimes(1);
    // Connection's recorded mode updated to the new mode.
    expect(JSON.parse(storage.get("t212_connections")!)[0].trackingMode).toBe("HOLDINGS");
  });
});

describe("runSyncAll — onlyConnectionIds filter (background scheduler)", () => {
  beforeEach(() => {
    net((url) => routeFetch(url));
  });

  it("syncs only the requested connections, leaving the rest untouched", async () => {
    const { ctx, storage } = makeCtx({
      connections: [
        { id: "c1", name: "Invest", accountId: "acc-1" },
        { id: "c2", name: "ISA", accountId: "acc-2" },
      ],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runSyncAll(ctx as any, { onlyConnectionIds: new Set(["c1"]) });

    expect(result.perAccount.map((r) => r.connectionId)).toEqual(["c1"]);
    // c2 was skipped entirely — its watermark is unchanged from the seeded default.
    expect(JSON.parse(storage.get("t212_sync_c2")!).lastSync).toBe("2026-01-01T00:00:00.000Z");
    // c1 synced — its watermark advanced.
    expect(JSON.parse(storage.get("t212_sync_c1")!).lastSync).not.toBe("2026-01-01T00:00:00.000Z");
  });
});

// --- direct (brokered) calls: auth, credentials, 2 MB window splitting -----

describe("useSync — brokered Trading 212 calls", () => {
  it("authenticates every API call via the connection's secret and never sets Authorization", async () => {
    const seen: Req[] = [];
    let downloadCalls = 0;
    net(async (url: string, req: Req) => {
      seen.push(req);
      if (url.includes("amazonaws.com")) return textResponse(++downloadCalls === 1 ? SAMPLE_CSV : CSV_HDR);
      if (url.includes("history/exports")) return jsonResponse([FINISHED_REPORT]);
      return routeFetch(url);
    });
    const { ctx } = makeCtx({ syncStates: { c1: { lastSync: null, importedRefs: [] } } });

    await runSyncAll(ctx as never);

    const api = seen.filter((r) => r.url.startsWith("https://demo.trading212.com/api/v0/equity/"));
    expect(api.length).toBeGreaterThan(0);
    for (const r of api) {
      expect(r.auth).toEqual({ type: "basic", secretKey: "t212_auth_c1" });
      expect(Object.keys(r.headers ?? {}).map((h) => h.toLowerCase())).not.toContain("authorization");
    }
    // The signed export URL goes out with NO credentials at all.
    const downloads = seen.filter((r) => r.url.includes("amazonaws.com"));
    expect(downloads.length).toBeGreaterThan(0);
    expect(downloads.every((r) => !r.auth && !r.headers)).toBe(true);
  });

  it("uses the live host when settings say live", async () => {
    net((url) => routeFetch(url));
    const { ctx, storage, networkRequest } = makeCtx({});
    storage.set("t212_settings", JSON.stringify({ env: "live" }));

    await runSyncAll(ctx as never);

    const urls = networkRequest.mock.calls.map((c) => c[0].url);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("https://live.trading212.com/api/v0/equity/"))).toBe(true);
  });

  it("skips a connection that still needs credentials (no network calls) while others sync", async () => {
    net((url) => routeFetch(url));
    const { ctx, importFn, networkRequest } = makeCtx({
      connections: [
        { id: "c1", name: "Legacy", accountId: "acc-1", needsCredentials: true },
        { id: "c2", name: "ISA", accountId: "acc-2" },
      ],
    });

    const result = await runSyncAll(ctx as never);

    const [legacy, isa] = result.perAccount;
    expect(legacy.error).toMatch(/re-enter the API key ID and secret/i);
    expect(legacy.imported).toBe(0);
    expect(isa.error).toBeUndefined();
    expect(isa.imported).toBe(1);
    expect(importFn).toHaveBeenCalledTimes(1);
    expect(networkRequest.mock.calls.every((c) => !c[0].auth || c[0].auth.secretKey === "t212_auth_c2")).toBe(true);
  });

  it("splits an over-2 MB export window, keeps going, and still imports every row once", async () => {
    // Report 1 is "too large" to download; report 2 also covers every window and is small.
    // The first window therefore splits in half, both halves are served by report 2 (so the
    // CSV rows repeat), and the duplicates are collapsed by activity id before importing.
    const reports = [
      { ...FINISHED_REPORT, reportId: 1, downloadLink: "https://test.amazonaws.com/big.csv" },
      { ...FINISHED_REPORT, reportId: 2, downloadLink: "https://test.amazonaws.com/small.csv" },
    ];
    let smallDownloads = 0;
    const posted: string[] = [];
    net(async (url: string, req: Req) => {
      if (url.includes("big.csv")) throw new Error("Addon network response body is too large");
      if (url.includes("small.csv")) return textResponse(++smallDownloads <= 2 ? SAMPLE_CSV : CSV_HDR);
      if (url.includes("history/exports")) {
        if (req.method === "POST") posted.push(req.body ?? "");
        return jsonResponse(reports);
      }
      return routeFetch(url);
    });
    const { ctx, importFn } = makeCtx({ syncStates: { c1: { lastSync: null, importedRefs: [] } } });

    const result = await runSyncAll(ctx as never);

    const r = result.perAccount[0];
    expect(r.error).toBeUndefined();
    expect(r.log.join("\n")).toMatch(/exceeds the 2 MB response limit — splitting/);
    expect(r.imported).toBe(1);
    expect(importFn).toHaveBeenCalledTimes(1);
    expect(importFn.mock.calls[0][0].map((a) => a.id)).toEqual(["t212-txn-DEP1"]);
    expect(posted).toHaveLength(0); // halves were served from the existing small report
  });
});

describe("useSync — HOLDINGS instrument metadata", () => {
  it("does not fetch the (over-2 MB) instruments feed when positions already carry ISIN + currency", async () => {
    const urls: string[] = [];
    net((url) => {
      urls.push(url);
      return routeHoldingsFetch(url);
    });
    const { ctx } = makeCtx({
      connections: [{ id: "c1", name: "Invest", accountId: "acc-1", trackingMode: "HOLDINGS" }],
      existingAccounts: [{ id: "acc-1", trackingMode: "HOLDINGS" }],
      syncStates: { c1: { lastSync: null, importedRefs: [] } },
    });

    await runSyncAll(ctx as never);

    expect(urls.some((u) => u.includes("metadata/instruments"))).toBe(false);
  });

  it("logs (and carries on) when the instruments feed is rejected as too large", async () => {
    net((url) => {
      if (url.includes("metadata/instruments")) throw new Error("Addon network response body is too large");
      if (url.includes("/positions")) return jsonResponse([{ ticker: "TSM_US_EQ", quantity: 2 }]);
      return routeHoldingsFetch(url);
    });
    const { ctx, snapshotsSave } = makeCtx({
      connections: [{ id: "c1", name: "Invest", accountId: "acc-1", trackingMode: "HOLDINGS" }],
      existingAccounts: [{ id: "acc-1", trackingMode: "HOLDINGS" }],
      syncStates: { c1: { lastSync: null, importedRefs: [] } },
    });

    const result = await runSyncAll(ctx as never);

    expect(result.perAccount[0].error).toBeUndefined();
    expect(result.perAccount[0].log.join("\n")).toMatch(/Instrument metadata unavailable \(.*too large\)/);
    expect(snapshotsSave).toHaveBeenCalledTimes(1);
  });
});
