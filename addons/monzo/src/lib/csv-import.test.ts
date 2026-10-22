import { describe, expect, it, vi } from "vitest";
import { BUSY_MESSAGE, isBusy } from "./busy";
import { filterCsvTransactions, importCsvFiles } from "./csv-import";
import { makeCtx, tx } from "../test-utils";

const setup = () =>
  makeCtx({
    wfAccounts: [
      { id: "wf-1", name: "Current" },
      { id: "wf-2", name: "Flex" },
    ],
  });

describe("filterCsvTransactions", () => {
  const rows = [
    tx({ description: "Coffee" }),
    tx({ category: "transfers", description: "Bank transfer" }),
    tx({ category: "savings", description: "Investments" }),
    tx({ category: "transfers", description: "Monzo Flex", amount: -5000 }),
    tx({ metadata: { pot_id: "pot_1" }, description: "Holiday" }),
    tx({ category: "shopping", description: "Refunded (Flex)", amount: 1999 }),
  ];

  it("always drops pot transfers; transfers and savings only when asked", () => {
    expect(filterCsvTransactions(rows, true, true).map((t) => t.description)).toEqual([
      "Coffee",
      "Monzo Flex",
      "Refunded (Flex)",
    ]);
    expect(filterCsvTransactions(rows, false, true).map((t) => t.description)).toEqual([
      "Coffee",
      "Bank transfer",
      "Investments",
      "Monzo Flex",
      "Refunded (Flex)",
    ]);
  });

  it("drops Flex repayments (but keeps the refund legs) when there is no Flex account to credit", () => {
    expect(filterCsvTransactions(rows, true, false).map((t) => t.description)).toEqual([
      "Coffee",
      "Refunded (Flex)",
    ]);
  });
});

describe("importCsvFiles", () => {
  it("imports each file into its own account", async () => {
    const t = setup();
    const outcomes = await importCsvFiles(t.ctx, [
      { name: "current.csv", accountId: "wf-1", transactions: [tx(), tx()] },
      { name: "flex.csv", accountId: "wf-2", transactions: [tx()] },
    ]);
    expect(outcomes).toEqual([
      { name: "current.csv", imported: 2, updated: 0, duplicates: 0 },
      { name: "flex.csv", imported: 1, updated: 0, duplicates: 0 },
    ]);
    expect(t.importCalls.map((c) => [c[0].accountId, c.length])).toEqual([
      ["wf-1", 2],
      ["wf-2", 1],
    ]);
  });

  it("does not duplicate rows that overlap an earlier file for the same account", async () => {
    const t = setup();
    const [a, b, c] = [tx(), tx(), tx()];
    const outcomes = await importCsvFiles(t.ctx, [
      { name: "jan-feb.csv", accountId: "wf-1", transactions: [a, b] },
      { name: "feb-mar.csv", accountId: "wf-1", transactions: [b, c] },
    ]);
    expect(outcomes).toEqual([
      { name: "jan-feb.csv", imported: 2, updated: 0, duplicates: 0 },
      { name: "feb-mar.csv", imported: 1, updated: 0, duplicates: 1 },
    ]);
    expect(t.activities.get("wf-1")).toHaveLength(3);
  });

  it("imports files one at a time", async () => {
    const t = setup();
    let running = 0;
    let peak = 0;
    const real = t.ctx.api.activities.import;
    t.ctx.api.activities.import = async (batch) => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return real(batch);
    };
    await importCsvFiles(t.ctx, [
      { name: "a.csv", accountId: "wf-1", transactions: [tx()] },
      { name: "b.csv", accountId: "wf-2", transactions: [tx()] },
    ]);
    expect(peak).toBe(1);
  });

  it("reports a failing file's error and still imports the next one", async () => {
    const t = setup();
    const real = t.ctx.api.activities.import;
    t.ctx.api.activities.import = async (batch) => {
      if (batch[0].accountId === "wf-1") throw new Error("boom");
      return real(batch);
    };
    const outcomes = await importCsvFiles(t.ctx, [
      { name: "bad.csv", accountId: "wf-1", transactions: [tx()] },
      { name: "good.csv", accountId: "wf-2", transactions: [tx()] },
    ]);
    expect(outcomes).toEqual([
      { name: "bad.csv", imported: 0, updated: 0, duplicates: 0, error: "boom" },
      { name: "good.csv", imported: 1, updated: 0, duplicates: 0 },
    ]);
  });

  it("skips files without an account or without transactions", async () => {
    const t = setup();
    const progress = vi.fn();
    const outcomes = await importCsvFiles(
      t.ctx,
      [
        { name: "no-account.csv", accountId: "", transactions: [tx()] },
        { name: "empty.csv", accountId: "wf-1", transactions: [] },
        { name: "ok.csv", accountId: "wf-1", transactions: [tx()] },
      ],
      {},
      progress,
    );
    expect(outcomes).toEqual([{ name: "ok.csv", imported: 1, updated: 0, duplicates: 0 }]);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith("ok.csv", 0, 1);
    expect(t.importCalls).toHaveLength(1);
  });
  it("carries the number of rewritten rows through as `updated`", async () => {
    const t = setup();
    const before = tx({ id: "tx_same", notes: "" });
    await importCsvFiles(t.ctx, [{ name: "a.csv", accountId: "wf-1", transactions: [before] }]);
    const outcomes = await importCsvFiles(t.ctx, [
      { name: "b.csv", accountId: "wf-1", transactions: [{ ...before, notes: "split with Sam" }] },
    ]);
    expect(outcomes).toEqual([{ name: "b.csv", imported: 0, updated: 1, duplicates: 0 }]);
    expect(t.activities.get("wf-1")).toHaveLength(1);
  });

  it("rejects a second import started while one runs, and clears the flag afterwards", async () => {
    const t = setup();
    const real = t.ctx.api.activities.import;
    let unblock!: () => void;
    const hold = new Promise<void>((r) => (unblock = r));
    t.ctx.api.activities.import = async (batch) => {
      await hold;
      return real(batch);
    };
    const files = [{ name: "a.csv", accountId: "wf-1", transactions: [tx()] }];
    const first = importCsvFiles(t.ctx, files);
    await new Promise((r) => setTimeout(r, 10));
    expect(isBusy()).toBe(true);
    await expect(importCsvFiles(t.ctx, files)).rejects.toThrow(BUSY_MESSAGE);
    unblock();
    expect((await first)[0].imported).toBe(1);
    expect(t.activities.get("wf-1")).toHaveLength(1);
    expect(isBusy()).toBe(false);
    // A failure does not leave the flag set either.
    t.ctx.api.activities.import = async () => {
      throw new Error("boom");
    };
    expect((await importCsvFiles(t.ctx, [{ name: "b.csv", accountId: "wf-2", transactions: [tx()] }]))[0].error).toBe("boom");
    expect(isBusy()).toBe(false);
  });
});

describe("importCsvFiles Flex transfers", () => {
  const repayment = () => tx({ category: "transfers", description: "Monzo Flex", amount: -5000 });

  it("imports a repayment as TRANSFER_OUT here and TRANSFER_IN on the Flex account, then links them", async () => {
    const t = setup();
    const notes: string[] = [];
    const outcomes = await importCsvFiles(
      t.ctx,
      [{ name: "current.csv", accountId: "wf-1", transactions: [tx(), repayment()] }],
      {},
      () => {},
      { flexAccountId: "wf-2", onNote: (n) => notes.push(n) },
    );
    expect(outcomes).toEqual([{ name: "current.csv", imported: 2, updated: 0, duplicates: 0 }]);
    expect(t.activities.get("wf-1")!.map((r) => r.activityType)).toEqual(["WITHDRAWAL", "TRANSFER_OUT"]);
    expect(t.activities.get("wf-2")!.map((r) => [r.activityType, r.amount])).toEqual([["TRANSFER_IN", "50"]]);
    expect(t.links).toHaveLength(1);
    expect(notes.join(" ")).toMatch(/Flex transfers: 1 linked/);
  });

  it("is idempotent across re-imports", async () => {
    const t = setup();
    const file = [{ name: "current.csv", accountId: "wf-1", transactions: [repayment()] }];
    const opts = { flexAccountId: "wf-2" };
    await importCsvFiles(t.ctx, file, {}, () => {}, opts);
    const again = await importCsvFiles(t.ctx, file, {}, () => {}, opts);
    expect(again[0]).toMatchObject({ imported: 0, duplicates: 1 });
    expect(t.activities.get("wf-2")).toHaveLength(1);
    expect(t.links).toHaveLength(1);
  });

  it("links refund legs that come in separate files", async () => {
    const t = setup();
    const base = { description: "Refunded (Flex)", category: "shopping" };
    await importCsvFiles(t.ctx, [
      { name: "current.csv", accountId: "wf-1", transactions: [tx({ ...base, amount: 1999 })] },
      { name: "flex.csv", accountId: "wf-2", transactions: [tx({ ...base, amount: -1999 })] },
    ]);
    expect(t.activities.get("wf-1")![0].activityType).toBe("TRANSFER_IN");
    expect(t.activities.get("wf-2")![0].activityType).toBe("TRANSFER_OUT");
    expect(t.links).toHaveLength(1);
  });

  it("does not write a Flex credit for a repayment row found in the Flex account's own file", async () => {
    const t = setup();
    await importCsvFiles(
      t.ctx,
      [{ name: "flex.csv", accountId: "wf-2", transactions: [tx(), repayment()] }],
      {},
      () => {},
      { flexAccountId: "wf-2" },
    );
    expect(t.activities.get("wf-2")!.map((r) => r.activityType)).toEqual(["WITHDRAWAL"]);
    expect(t.links).toEqual([]);
  });
});
