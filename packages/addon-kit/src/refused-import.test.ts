import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { describe, expect, it } from "vitest";
import { importStoredRows, withoutUnsaved } from "./host-import";
import { emptyRefused, loadRefused, refusedError, saveRefused, type RefusedRows } from "./refused-rows";
import { pendingRows, recordRefused } from "./refused-import";
import { reconcileWithLedger, type ImportLedger } from "./reconcile";
import { FakeWealthfolio } from "./testing";

const cash = (id: string, amount: number, comment = id): ActivityImport => ({
  id,
  accountId: "acc",
  activityType: "DEPOSIT",
  date: "2026-03-01T10:00:00.000Z",
  amount,
  currency: "GBP",
  symbol: "$CASH-GBP",
  comment,
  isValid: true,
  isDraft: false,
  forceImport: true,
});

describe("pendingRows", () => {
  const refused = recordRefused(emptyRefused(), [], [
    { activity: cash("b", 2), reason: "no" },
    { activity: { ...cash("x", 9), accountId: "other" }, reason: "no" },
  ]);

  it("puts this account's refused rows first and leaves other accounts' alone", () => {
    expect(pendingRows(refused, "acc", [cash("d", 4)]).map((a) => a.id)).toEqual(["b", "d"]);
  });

  it("takes the fresh row, once, when the source serves a refused row again", () => {
    const fresh = { ...cash("b", 2), comment: "b (renamed)" };
    const rows = pendingRows(refused, "acc", [cash("d", 4), fresh]);
    expect(rows.map((a) => a.id)).toEqual(["b", "d"]);
    expect(rows[0].comment).toBe("b (renamed)");
  });
});

describe("recordRefused", () => {
  it("settles the rows that were stored or already there, and counts another attempt for one refused again", () => {
    let refused = recordRefused(emptyRefused(), [], [
      { activity: cash("a", 1), reason: "first" },
      { activity: cash("b", 2), reason: "first" },
    ]);
    refused = recordRefused(refused, [cash("a", 1)], [{ activity: cash("b", 2), reason: "second" }]);
    expect(refused.entries.map((e) => [e.id, e.attempts, e.reason])).toEqual([["b", 2, "second"]]);
  });
});

describe("a row Wealthfolio refuses on every call", () => {
  const KEY = "refused";
  const host = () => new FakeWealthfolio([{ id: "acc", name: "Cash", currency: "GBP" }]);

  /** What an importer does: retry the refused rows with the new ones, reconcile, import, record. */
  async function sync(h: FakeWealthfolio, ledger: ImportLedger, desired: ActivityImport[]) {
    const refused = await loadRefused(h.ctx.api.storage, KEY);
    const rec = reconcileWithLedger(pendingRows(refused, "acc", desired), await h.ctx.api.activities.getAll("acc"), ledger, "acc");
    const out = await importStoredRows((rows) => h.ctx.api.activities.import(rows), rec.toImport);
    const next: RefusedRows = await saveRefused(h.ctx.api.storage, KEY, recordRefused(refused, [...rec.present, ...out.stored, ...out.duplicates], out.unsaved));
    return { ledger: withoutUnsaved(rec.ledger, out.unsaved), refused: next, sent: h.importCalls.at(-1)?.sentIds };
  }

  it("is kept in its own list and sent again on every sync, alone, while the error stays; once accepted it is stored once and the list empties", async () => {
    const h = host();
    h.policy = (a) => (a.comment === "b" ? "Preparation failed" : null);

    const first = await sync(h, {}, [cash("a", 1), cash("b", 2), cash("c", 3)]);
    expect(first.refused.entries.map((e) => [e.id, e.attempts])).toEqual([["b", 1]]);
    expect(refusedError(first.refused)).toContain("Preparation failed");

    // The source no longer serves a, b or c: only the list brings b back.
    const second = await sync(h, first.ledger, [cash("d", 4)]);
    expect(second.sent).toEqual(["b", "d"]);
    expect(second.refused.entries.map((e) => [e.id, e.attempts])).toEqual([["b", 2]]);

    const third = await sync(h, second.ledger, []);
    expect(third.sent).toEqual(["b"]);
    expect(third.refused.entries[0].attempts).toBe(3);
    expect(refusedError(third.refused)).toBeDefined();

    h.policy = () => null;
    const fourth = await sync(h, third.ledger, []);
    expect(fourth.sent).toEqual(["b"]);
    expect(fourth.refused.entries).toEqual([]);
    expect(refusedError(fourth.refused)).toBeUndefined();
    expect(h.rows("acc").map((r) => r.comment).sort()).toEqual(["a", "b", "c", "d"]);
    expect(await h.ctx.api.storage.get(KEY)).toBeNull(); // the key is gone

    const fifth = await sync(h, fourth.ledger, []);
    expect(h.importCalls).toHaveLength(4); // nothing left to send
    expect(fifth.refused.entries).toEqual([]);
  });

  it("is sent once, with one more attempt, when the source serves it again", async () => {
    const h = host();
    h.policy = (a) => (a.comment === "b" ? "Preparation failed" : null);
    const first = await sync(h, {}, [cash("a", 1), cash("b", 2)]);
    const second = await sync(h, first.ledger, [cash("a", 1), cash("b", 2)]);
    expect(second.sent).toEqual(["b"]);
    expect(second.refused.entries.map((e) => e.attempts)).toEqual([2]);
  });

  it("is not sent again when the account already holds it (its answer was not trusted, the row was stored)", async () => {
    const h = host();
    const first = await sync(h, {}, [cash("a", 1), cash("b", 2)]);
    // A row recorded as refused although it is in the account: nothing is sent, the entry settles.
    const refused = recordRefused(emptyRefused(), [], [{ activity: cash("b", 2), reason: "Wealthfolio reported 1 of 2 rows stored but marked 2" }]);
    await saveRefused(h.ctx.api.storage, KEY, refused);
    const calls = h.importCalls.length;
    const second = await sync(h, withoutUnsaved(first.ledger, [{ activity: cash("b", 2), reason: "" }]), []);
    expect(h.importCalls).toHaveLength(calls);
    expect(second.refused.entries).toEqual([]);
    expect(h.rows("acc")).toHaveLength(2);
  });
});
