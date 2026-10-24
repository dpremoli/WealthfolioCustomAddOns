import type { ActivityImport, ImportActivitiesResult } from "@wealthfolio/addon-sdk";
import { describe, expect, it } from "vitest";
import {
  describeUnsaved,
  importStoredRows,
  readImportResult,
  unsavedMessage,
  withoutUnsaved,
} from "./host-import";
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

const newHost = () => new FakeWealthfolio([{ id: "acc", name: "Cash", currency: "GBP" }]);
const importer = (host: FakeWealthfolio) => (rows: ActivityImport[]) => host.ctx.api.activities.import(rows);

/** A hand-built host answer, for the shapes the fake host does not produce. */
const answer = (rows: Partial<ActivityImport>[], summary: Partial<ImportActivitiesResult["summary"]>): ImportActivitiesResult => ({
  activities: rows as ActivityImport[],
  importRunId: summary.imported ? "run" : "",
  summary: { total: rows.length, imported: 0, skipped: 0, duplicates: 0, assetsCreated: 0, success: true, ...summary },
});

describe("readImportResult", () => {
  const sent = [cash("a", 1), cash("b", 2), cash("c", 3)];

  it("takes every row as stored when the host marks none invalid and the count matches", () => {
    const read = readImportResult(sent, answer(sent, { imported: 3 }));
    expect(read.stored).toEqual(sent);
    expect(read.unsaved).toEqual([]);
  });

  it("leaves out a row the host marked invalid, with the host's reason", () => {
    const rows = [{ isValid: true }, { isValid: false, errors: { general: ["Preparation failed: no price"] } }, { isValid: true }];
    const read = readImportResult(sent, answer(rows, { imported: 2 }));
    expect(read.stored.map((a) => a.id)).toEqual(["a", "c"]);
    expect(read.unsaved).toEqual([{ activity: sent[1], reason: "Preparation failed: no price" }]);
  });

  it("does not count a row the host reports as a duplicate as stored, nor as unsaved", () => {
    const rows = [{ isValid: true }, { isValid: true, duplicateOfId: "old" }, { isValid: true }];
    const read = readImportResult(sent, answer(rows, { imported: 2, duplicates: 1 }));
    expect(read.stored.map((a) => a.id)).toEqual(["a", "c"]);
    expect(read.duplicates.map((a) => a.id)).toEqual(["b"]);
    expect(read.unsaved).toEqual([]);
  });

  it("trusts no row when the host's count and its rows disagree", () => {
    const read = readImportResult(sent, answer(sent, { imported: 2 }));
    expect(read.stored).toEqual([]);
    expect(read.unsaved).toHaveLength(3);
    expect(read.unsaved[0].reason).toMatch(/2 of 3/);
  });

  it("without a row-by-row answer, trusts only a count equal to what was sent", () => {
    expect(readImportResult(sent, answer([], { imported: 3 })).stored).toEqual(sent);
    const partial = readImportResult(sent, answer([], { imported: 2 }));
    expect(partial.stored).toEqual([]);
    expect(partial.unsaved).toHaveLength(3);
  });

  it("reports a call that stored nothing, with the invalid rows named", () => {
    const rows = [{ isValid: true }, { isValid: false, errors: { activityDate: ["Invalid date"] } }, { isValid: true }];
    const read = readImportResult(sent, answer(rows, { success: false, imported: 0 }));
    expect(read.stored).toEqual([]);
    expect(read.refused).toEqual([1]);
  });
});

describe("importStoredRows against the fake host", () => {
  it("stores every row and says so", async () => {
    const host = newHost();
    const out = await importStoredRows(importer(host), [cash("a", 1), cash("b", 2)]);
    expect(out.stored.map((a) => a.id)).toEqual(["a", "b"]);
    expect(out.unsaved).toEqual([]);
    expect(host.rows("acc")).toHaveLength(2);
  });

  it("a call refused as a whole: the failing row is rejected with the host's reason and the rest are retried and stored", async () => {
    const host = newHost();
    host.importValidation = (a) => (a.comment === "bad" ? "Invalid date" : null);
    const out = await importStoredRows(importer(host), [cash("a", 1), cash("bad", 2), cash("c", 3)]);

    expect(out.stored.map((a) => a.id)).toEqual(["a", "c"]);
    expect(out.unsaved.map((u) => [u.activity.id, u.reason])).toEqual([["bad", "Invalid date"]]);
    expect(host.rows("acc").map((r) => r.comment)).toEqual(["a", "c"]);
    expect(host.importCalls.map((c) => c.stored)).toEqual([0, 2]); // the refused call, then the retry
  });

  it("a row the writer policy refuses is rejected while the rest are stored in the same call", async () => {
    const host = newHost();
    host.policy = (a) => (a.comment === "nope" ? "Preparation failed" : null);
    const out = await importStoredRows(importer(host), [cash("a", 1), cash("nope", 2), cash("c", 3)]);

    expect(out.stored.map((a) => a.id)).toEqual(["a", "c"]);
    expect(out.unsaved.map((u) => [u.activity.id, u.reason])).toEqual([["nope", "Preparation failed"]]);
    expect(host.importCalls).toHaveLength(1);
  });

  it("a 200 that stored nothing and gave no reason is never taken for success", async () => {
    const host = newHost();
    host.storeNothing = true;
    const out = await importStoredRows(importer(host), [cash("a", 1), cash("b", 2)]);

    expect(out.stored).toEqual([]);
    expect(out.unsaved.map((u) => u.activity.id)).toEqual(["a", "b"]);
    expect(out.unsaved[0].reason).toMatch(/saved nothing/i);
    expect(host.importCalls).toHaveLength(1); // no reason to retry
  });

  it("a call that throws leaves every row unsaved, with the error as the reason", async () => {
    const out = await importStoredRows(
      async () => {
        throw new Error("host went away");
      },
      [cash("a", 1)],
    );
    expect(out.stored).toEqual([]);
    expect(out.unsaved[0].reason).toContain("host went away");
  });

  it("every row ends up stored, a duplicate or unsaved", async () => {
    const host = newHost();
    host.importValidation = (a) => (a.comment === "bad1" || a.comment === "bad2" ? "Invalid date" : null);
    host.policy = (a) => (a.comment === "nope" ? "Preparation failed" : null);
    const rows = [cash("a", 1), cash("bad1", 2), cash("nope", 3), cash("bad2", 4), cash("e", 5)];
    const out = await importStoredRows(importer(host), rows);
    expect(out.stored.length + out.duplicates.length + out.unsaved.length).toBe(rows.length);
    expect(out.stored.map((a) => a.id)).toEqual(["a", "e"]);
    expect(out.unsaved.map((u) => u.activity.id).sort()).toEqual(["bad1", "bad2", "nope"]);
  });

  it("sends nothing for no rows", async () => {
    const host = newHost();
    const out = await importStoredRows(importer(host), []);
    expect(out).toEqual({ stored: [], duplicates: [], unsaved: [] });
    expect(host.importCalls).toHaveLength(0);
  });
});

describe("the ledger keeps only rows the host stored", () => {
  /** What an importer does: reconcile, import, drop the unsaved rows' entries, remember the ledger. */
  async function sync(host: FakeWealthfolio, ledger: ImportLedger, desired: ActivityImport[]) {
    const rec = reconcileWithLedger(desired, await host.ctx.api.activities.getAll("acc"), ledger, "acc");
    const out = await importStoredRows(importer(host), rec.toImport);
    return { ledger: withoutUnsaved(rec.ledger, out.unsaved), out };
  }

  const desired = () => [cash("a", 1), cash("b", 2), cash("c", 3)];

  it.each([
    ["a call refused as a whole", (h: FakeWealthfolio) => (h.importValidation = (a) => (a.comment === "b" ? "Invalid date" : null))],
    ["a policy-refused row", (h: FakeWealthfolio) => (h.policy = (a) => (a.comment === "b" ? "Preparation failed" : null))],
  ])("%s: the refused row is not in the ledger and the next sync imports it once the host accepts it", async (_name, refuse) => {
    const host = newHost();
    refuse(host);
    const first = await sync(host, {}, desired());
    expect(Object.keys(first.ledger).sort()).toEqual(["a", "c"]);
    expect(first.out.unsaved.map((u) => u.activity.id)).toEqual(["b"]);

    host.importValidation = () => null;
    host.policy = () => null;
    const second = await sync(host, first.ledger, desired());
    expect(second.out.stored.map((a) => a.id)).toEqual(["b"]);
    expect(Object.keys(second.ledger).sort()).toEqual(["a", "b", "c"]);
    expect(host.rows("acc")).toHaveLength(3);

    const third = await sync(host, second.ledger, desired());
    expect(third.out.stored).toEqual([]);
    expect(host.rows("acc")).toHaveLength(3); // nothing imported twice
  });

  it("a 200 that stored nothing leaves the ledger empty, and the next sync imports everything", async () => {
    const host = newHost();
    host.storeNothing = true;
    const first = await sync(host, {}, desired());
    expect(first.ledger).toEqual({});
    expect(host.rows("acc")).toHaveLength(0);

    host.storeNothing = false;
    const second = await sync(host, first.ledger, desired());
    expect(second.out.stored).toHaveLength(3);
    expect(Object.keys(second.ledger).sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps entries the ledger held before for other rows", () => {
    const ledger = { old: "acc:1", b: "acc:2" };
    expect(withoutUnsaved(ledger, [{ activity: cash("b", 2), reason: "x" }])).toEqual({ old: "acc:1" });
    expect(ledger).toEqual({ old: "acc:1", b: "acc:2" }); // the input is not changed
  });
});

describe("describing unsaved rows", () => {
  const unsaved = [
    { activity: cash("a", 12.5, "Rent"), reason: "Invalid date" },
    { activity: cash("b", 3), reason: "Preparation failed" },
  ];

  it("names the row and the host's reason", () => {
    expect(describeUnsaved(unsaved[0])).toBe("DEPOSIT 2026-03-01 12.5 GBP (Rent): Invalid date");
  });

  it("gives one message with the count, the first reason and what happens next", () => {
    const msg = unsavedMessage(unsaved)!;
    expect(msg).toMatch(/2 rows were not saved by Wealthfolio/);
    expect(msg).toContain("Invalid date");
    expect(msg).toMatch(/next sync|import again|tried again/i);
    expect(unsavedMessage([])).toBeUndefined();
  });
});
