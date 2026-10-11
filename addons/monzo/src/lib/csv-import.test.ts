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
  ];

  it("always drops Flex repayments and pot transfers; transfers and savings only when asked", () => {
    expect(filterCsvTransactions(rows, true).map((t) => t.description)).toEqual(["Coffee"]);
    expect(filterCsvTransactions(rows, false).map((t) => t.description)).toEqual([
      "Coffee",
      "Bank transfer",
      "Investments",
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
