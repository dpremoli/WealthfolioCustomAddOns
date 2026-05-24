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

function makeCtx(overrides: {
  checkImport?: (a: ActivityImport[]) => Promise<ActivityImport[]>;
}) {
  const secrets = new Map<string, string>([
    [
      "t212_config",
      JSON.stringify({ proxyUrl: "http://proxy", env: "demo", apiKey: "k", apiSecret: "s" }),
    ],
    ["t212_account_id", "acc-1"],
  ]);

  const importFn = vi.fn(async (acts: ActivityImport[]) => ({
    summary: { imported: acts.length, skipped: 0, duplicates: 0 },
  }));

  return {
    ctx: {
      api: {
        secrets: {
          get: async (k: string) => secrets.get(k) ?? null,
          set: async (k: string, v: string) => void secrets.set(k, v),
          delete: async (k: string) => void secrets.delete(k),
        },
        market: { searchTicker: vi.fn(async () => [{ symbol: "AAPL", score: 1 }]) },
        activities: {
          checkImport:
            overrides.checkImport ?? (async (a: ActivityImport[]) => a),
          import: importFn,
        },
      },
    },
    secrets,
    importFn,
  };
}

// --- tests ---------------------------------------------------------------

describe("useSync", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => routeFetch(String(url))),
    );
  });

  it("imports new activities and records the watermark", async () => {
    const { ctx, secrets, importFn } = makeCtx({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.sync();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.lastResult).toEqual({ imported: 1, duplicates: 0, unresolved: 0 });
    expect(importFn).toHaveBeenCalledTimes(1);
    expect(secrets.get("t212_last_sync")).toBeTruthy();
    expect(secrets.get("t212_imported_refs")).toContain("t212-order-1");
  });

  it("skips duplicates flagged by checkImport without importing", async () => {
    const { ctx, importFn } = makeCtx({
      checkImport: async (a) => a.map((x) => ({ ...x, duplicateOfId: "existing" })),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { result } = renderHook(() => useSync(ctx as any));

    await act(async () => {
      await result.current.sync();
    });

    expect(result.current.lastResult).toEqual({ imported: 0, duplicates: 1, unresolved: 0 });
    expect(importFn).not.toHaveBeenCalled();
  });
});
