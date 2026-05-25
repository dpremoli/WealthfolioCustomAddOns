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

function makeCtx(opts: {
  connections?: Conn[];
  checkImport?: (a: ActivityImport[]) => Promise<ActivityImport[]>;
  searchTicker?: () => Promise<unknown[]>;
}) {
  const connections = opts.connections ?? [
    { id: "c1", name: "Trading 212 (Invest)", apiKey: "k", apiSecret: "s", accountId: "acc-1" },
  ];
  const secrets = new Map<string, string>([
    ["t212_settings", JSON.stringify({ proxyUrl: "http://proxy", env: "demo" })],
    ["t212_connections", JSON.stringify(connections)],
  ]);

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

describe("useSync", () => {
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
