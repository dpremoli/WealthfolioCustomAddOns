import { describe, expect, it, vi } from "vitest";
import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import { ActivityImporter, describeRejected } from "./importer";

const cash = (id: string, amount: number, extra: Partial<ActivityImport> = {}): ActivityImport => ({
  id,
  accountId: "inv",
  activityType: "DEPOSIT",
  date: "2026-03-01T10:00:00.000Z",
  symbol: "$CASH-EUR",
  amount,
  currency: "EUR",
  isValid: true,
  isDraft: false,
  comment: id,
  ...extra,
});

function setup(opts: {
  existing?: Record<string, Partial<ActivityImport>[]>;
  checkImport?: (rows: ActivityImport[]) => Promise<ActivityImport[]>;
  importLimit?: number;
  refuse?: string[];
} = {}) {
  const calls: ActivityImport[][] = [];
  const getAll = vi.fn(async (accountId: string) => opts.existing?.[accountId] ?? []);
  const importFn = vi.fn(async (rows: ActivityImport[]) => {
    if (opts.importLimit && rows.length > opts.importLimit) throw new Error("payload too large");
    if (rows.some((r) => opts.refuse?.includes(r.id!))) throw new Error("bad row");
    calls.push(rows);
    return { summary: { imported: rows.length, skipped: 0 } };
  });
  const ctx = {
    api: { activities: { getAll, import: importFn, checkImport: opts.checkImport ?? (async (r: ActivityImport[]) => r) } },
  } as unknown as AddonContext;
  return { ctx, calls, getAll, importFn };
}

describe("ActivityImporter", () => {
  it("imports in large chunks, force-imported, and reads each account once across calls", async () => {
    const t = setup();
    const imp = new ActivityImporter(t.ctx, 1000);
    const rows = Array.from({ length: 1500 }, (_, i) => [cash(`r${i}`, i + 1)]);
    const a = await imp.import(rows.slice(0, 1200));
    const b = await imp.import(rows.slice(1200));
    expect(a.imported + b.imported).toBe(1500);
    expect(t.calls.map((c) => c.length)).toEqual([1000, 200, 300]);
    expect(t.calls[0].every((r) => r.forceImport)).toBe(true);
    expect(t.getAll).toHaveBeenCalledTimes(1);
  });

  it("leaves out rows the account already holds, including ones it imported earlier in the sync", async () => {
    const t = setup({ existing: { inv: [{ ...cash("old", 5), date: new Date("2026-03-01T10:00:00Z") }] } });
    const imp = new ActivityImporter(t.ctx);
    const first = await imp.import([[cash("old", 5)], [cash("new", 6)]]);
    expect(first).toMatchObject({ imported: 1, duplicates: 1 });
    expect(first.accounted.sort()).toEqual(["new", "old"]);
    // A second window repeating the same row (an overlap) adds nothing.
    expect(await imp.import([[cash("new", 6)]])).toMatchObject({ imported: 0, duplicates: 1 });
  });

  it("halves a call the host refuses and reports the one bad row instead of failing", async () => {
    const t = setup({ refuse: ["r3"] });
    const out = await new ActivityImporter(t.ctx).import(Array.from({ length: 8 }, (_, i) => [cash(`r${i}`, i + 1)]));
    expect(out.imported).toBe(7);
    expect(out.rejected.map((r) => r.activity.id)).toEqual(["r3"]);
    expect(out.rejected[0].reason).toMatch(/import refused it: bad row/);
  });

  it("reports invalid rows with Wealthfolio's reason, and keeps a unit's rows together", async () => {
    const t = setup({
      checkImport: async (rows) =>
        rows.map((r) =>
          r.id === "buy" || r.id === "leg-out"
            ? { ...r, isValid: false, errors: { symbol: ["Could not find 'XYZ' in market data"] } }
            : r,
        ),
    });
    const out = await new ActivityImporter(t.ctx).import([
      [cash("buy", 1, { activityType: "BUY", symbol: "XYZ" })],
      [cash("leg-out", 9, { activityType: "TRANSFER_OUT" }), cash("leg-in", 9, { activityType: "TRANSFER_IN", accountId: "card" })],
      [cash("fine", 2)],
    ]);
    expect(out.imported).toBe(1);
    expect(t.calls.flat().map((r) => r.id)).toEqual(["fine"]);
    expect(out.rejected.map((r) => [r.activity.id, r.reason])).toEqual([
      ["buy", "Could not find 'XYZ' in market data"],
      ["leg-out", "Could not find 'XYZ' in market data"],
      ["leg-in", "left out with the row it belongs to (Could not find 'XYZ' in market data)"],
    ]);
  });

  it("never splits a unit across import calls", async () => {
    const t = setup();
    const pair = [cash("a", 1, { activityType: "TRANSFER_OUT" }), cash("b", 1, { activityType: "TRANSFER_IN", accountId: "card" })];
    await new ActivityImporter(t.ctx, 3).import([[cash("x", 5)], [cash("y", 6)], pair]);
    expect(t.calls.map((c) => c.map((r) => r.id))).toEqual([["x", "y"], ["a", "b"]]);
  });
});

describe("describeRejected", () => {
  it("says what the row was and why it was left out", () => {
    expect(
      describeRejected({
        activity: cash("t212-order-9", 0, {
          activityType: "BUY",
          symbol: "CRWD",
          exchangeMic: "XNAS",
          quantity: 0.5,
          amount: undefined,
          currency: "USD",
        }),
        reason: "Symbol is required",
      }),
    ).toBe("Not imported: BUY 2026-03-01 CRWD@XNAS qty 0.5 (t212-order-9): Symbol is required");
  });
});
