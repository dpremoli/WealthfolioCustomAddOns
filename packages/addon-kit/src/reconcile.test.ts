import type { ActivityImport } from "@wealthfolio/addon-sdk";
import {
  adoptUntrackedRows,
  contentKey,
  ledgerAccountId,
  ledgerEntry,
  locateLedgerRows,
  reconcileWithLedger,
  selectNewActivities,
  sourceRefOf,
  withSourceRef,
  type ExistingActivityLike,
} from "./reconcile";

const cash = (amount: number, comment: string, date = "2026-03-01T10:00:00.000Z"): ActivityImport => ({
  accountId: "acc",
  activityType: "WITHDRAWAL",
  date,
  amount,
  currency: "GBP",
  symbol: "$CASH-GBP",
  comment,
  isValid: true,
  isDraft: false,
});

const stored = (a: ActivityImport): ExistingActivityLike => ({
  activityType: a.activityType,
  date: new Date(String(a.date)),
  amount: String(a.amount),
  quantity: "0",
  unitPrice: "1",
  currency: a.currency,
  comment: a.comment,
  assetSymbol: "$CASH-GBP",
});

describe("selectNewActivities", () => {
  it("keeps genuine same-day repeats and forces them in", () => {
    const desired = [cash(3, "Coffee"), cash(3, "Coffee")];
    const out = selectNewActivities(desired, []);
    expect(out).toHaveLength(2);
    expect(out.every((a) => a.forceImport)).toBe(true);
  });

  it("re-importing the same rows adds nothing", () => {
    const desired = [cash(3, "Coffee"), cash(3, "Coffee"), cash(9.5, "Lunch")];
    expect(selectNewActivities(desired, desired.map(stored))).toHaveLength(0);
  });

  it("an overlapping import adds only the surplus", () => {
    const first = [cash(3, "Coffee")];
    const second = [cash(3, "Coffee"), cash(3, "Coffee"), cash(1, "Bus", "2026-03-02T08:00:00.000Z")];
    const out = selectNewActivities(second, first.map(stored));
    expect(out.map((a) => a.comment)).toEqual(["Coffee", "Bus"]);
  });

  it("ignores time of day and comment whitespace", () => {
    const a = cash(3, "Coffee  Shop", "2026-03-01T23:59:00.000Z");
    const b = { ...stored(cash(3, "Coffee Shop", "2026-03-01T00:00:00.000Z")) };
    expect(selectNewActivities([a], [b])).toHaveLength(0);
  });
});

describe("source refs", () => {
  it("round-trips a ref through the comment", () => {
    expect(withSourceRef("Tesco | Groceries", "tx_1")).toBe("Tesco | Groceries [ref:tx_1]");
    expect(withSourceRef(undefined, "tx_1")).toBe("[ref:tx_1]");
    expect(withSourceRef("Tesco [ref:tx_old]", "tx_1")).toBe("Tesco [ref:tx_1]");
    expect(sourceRefOf("Tesco [ref:tx_1]")).toBe("tx_1");
    expect(sourceRefOf("Tesco")).toBeUndefined();
  });

  it("matches a tagged row by ref even when its comment changed", () => {
    const before = cash(3, withSourceRef("Coffee", "tx_1"));
    const after = cash(3, withSourceRef("Coffee | Note: with Sam", "tx_1"));
    expect(selectNewActivities([after], [stored(before)])).toHaveLength(0);
  });

  it("keeps tagged genuine repeats and drops a ref repeated in one batch", () => {
    const a = cash(3, withSourceRef("Coffee", "tx_1"));
    const b = cash(3, withSourceRef("Coffee", "tx_2"));
    expect(selectNewActivities([a, b, a], [])).toHaveLength(2);
    expect(selectNewActivities([a, b], [stored(a)]).map((x) => x.comment)).toEqual([b.comment]);
  });

  it("tagged rows reconcile against untagged legacy rows by content", () => {
    const legacy = [cash(3, "Coffee"), cash(3, "Coffee")].map(stored);
    const desired = [
      cash(3, withSourceRef("Coffee", "tx_1")),
      cash(3, withSourceRef("Coffee", "tx_2")),
      cash(3, withSourceRef("Coffee", "tx_3")),
    ];
    expect(selectNewActivities(desired, legacy).map((x) => sourceRefOf(x.comment))).toEqual(["tx_3"]);
  });

  it("a tagged existing row is not matched by content to a different ref", () => {
    const existing = [stored(cash(3, withSourceRef("Coffee", "tx_1")))];
    expect(selectNewActivities([cash(3, withSourceRef("Coffee", "tx_2"))], existing)).toHaveLength(1);
  });
});

describe("contentKey", () => {
  it("compares trades on quantity/price, not amount", () => {
    const trade: ActivityImport = {
      accountId: "acc",
      activityType: "BUY",
      date: "2026-03-01",
      symbol: "AAPL",
      quantity: 2,
      unitPrice: 100,
      currency: "USD",
      isValid: true,
      isDraft: false,
    };
    const existing: ExistingActivityLike = {
      activityType: "BUY",
      date: "2026-03-01T15:00:00Z",
      assetSymbol: "AAPL",
      quantity: "2.000000",
      unitPrice: "100",
      amount: "201.5",
      currency: "USD",
    } as ExistingActivityLike;
    expect(contentKey(trade)).toBe(contentKey(existing));
  });
});

describe("ledgerAccountId", () => {
  it("reads back the account a ledger entry was written for", () => {
    expect(ledgerAccountId(ledgerEntry("acc:with-colon", cash(5, "x")))).toBe("acc:with-colon");
  });
});

describe("reconcileWithLedger", () => {
  const withId = (id: string, a: ActivityImport): ActivityImport => ({ ...a, id });

  it("imports a second identical transaction after the first was imported earlier that day", () => {
    const first = withId("tx_1", cash(3, "Coffee"));
    const r1 = reconcileWithLedger([first], [], {}, "acc");
    expect(r1.toImport).toHaveLength(1);
    // Next sync only fetches the new, identical coffee (the first is before the watermark).
    const second = withId("tx_2", cash(3, "Coffee"));
    const r2 = reconcileWithLedger([second], [stored(first)], r1.ledger, "acc");
    expect(r2.toImport.map((a) => a.id)).toEqual(["tx_2"]);
    expect(r2.toImport[0].forceImport).toBe(true);
  });

  it("recognises an imported id even when its comment changed since", () => {
    const before = withId("tx_1", cash(3, "Coffee"));
    const { ledger } = reconcileWithLedger([before], [], {}, "acc");
    const after = withId("tx_1", cash(3, "Coffee | Note: with Sam"));
    const r = reconcileWithLedger([after], [stored(before)], ledger, "acc");
    expect(r.toImport).toHaveLength(0);
    expect(r.present).toHaveLength(1);
  });

  it("matches rows imported before the ledger existed by content and count, and records them", () => {
    const legacy = [cash(3, "Coffee"), cash(3, "Coffee")].map(stored);
    const desired = ["tx_1", "tx_2", "tx_3"].map((id) => withId(id, cash(3, "Coffee")));
    const r = reconcileWithLedger(desired, legacy, {}, "acc");
    expect(r.toImport.map((a) => a.id)).toEqual(["tx_3"]);
    expect(Object.keys(r.ledger).sort()).toEqual(["tx_1", "tx_2", "tx_3"]);
  });

  it("treats a legacy [ref:…] comment tag as imported", () => {
    const tagged = stored(cash(3, withSourceRef("Coffee", "tx_9")));
    const r = reconcileWithLedger([withId("tx_9", cash(3, "Coffee | Note: x"))], [tagged], {}, "acc");
    expect(r.toImport).toHaveLength(0);
    expect(r.ledger.tx_9).toMatch(/^acc:/);
  });

  it("reports an imported row whose details changed as stale, with the row to rewrite", () => {
    const before = withId("tx_1", cash(3, "Dennis | Personal Care"));
    const { ledger } = reconcileWithLedger([before], [], {}, "acc");
    const row = { ...stored(before), id: "act-1" };
    const after = withId("tx_1", cash(3, "Volleyball Club | Personal Care"));
    const r = reconcileWithLedger([after], [row], ledger, "acc");
    expect(r.toImport).toHaveLength(0);
    expect(r.stale).toEqual([{ row, activity: after }]);
  });

  it("matches an older comment format through `legacy`, and reports it as stale", () => {
    const row = { ...stored(cash(3, "Dennis | Personal Care")), id: "act-1" };
    const now = withId("tx_1", cash(3, "Volleyball Club | Personal Care"));
    const legacy = (a: ActivityImport) => ({ ...a, comment: "Dennis | Personal Care" });
    const r = reconcileWithLedger([now], [row], {}, "acc", { legacy });
    expect(r.toImport).toHaveLength(0);
    expect(r.stale).toEqual([{ row, activity: now }]);
    // Without the legacy form it would have been imported again.
    expect(reconcileWithLedger([now], [row], {}, "acc").toImport).toHaveLength(1);
  });

  it("imports again into a different account (e.g. the old one was deleted and recreated)", () => {
    const a = withId("tx_1", cash(3, "Coffee"));
    const { ledger } = reconcileWithLedger([a], [], {}, "old-acc");
    const r = reconcileWithLedger([a], [], ledger, "new-acc");
    expect(r.toImport.map((x) => x.id)).toEqual(["tx_1"]);
    expect(r.ledger.tx_1).toMatch(/^new-acc:/);
  });

  it("imports one row per id when the same id appears twice in a batch", () => {
    const a = withId("tx_1", cash(3, "Coffee"));
    expect(reconcileWithLedger([a, a], [], {}, "acc").toImport).toHaveLength(1);
  });
});

describe("locateLedgerRows", () => {
  const withId = (id: string, a: ActivityImport): ActivityImport => ({ ...a, id });

  it("finds the account row each imported id became, via the ledger", () => {
    const a = withId("tx_1", cash(3, "Coffee"));
    const b = withId("tx_2", cash(7, "Lunch"));
    const { ledger } = reconcileWithLedger([a, b], [], {}, "acc");
    const rowA = { ...stored(a), id: "act-1" };
    const rowB = { ...stored(b), id: "act-2" };
    const found = locateLedgerRows([rowB, rowA], ledger, "acc", ["tx_1", "tx_2"]);
    expect(found.get("tx_1")).toBe(rowA);
    expect(found.get("tx_2")).toBe(rowB);
  });

  it("gives identical rows to different ids, and omits ids it cannot place", () => {
    const a = withId("tx_1", cash(3, "Coffee"));
    const b = withId("tx_2", cash(3, "Coffee"));
    const { ledger } = reconcileWithLedger([a, b], [], {}, "acc");
    const rows = [{ ...stored(a), id: "act-1" }, { ...stored(a), id: "act-2" }];
    const found = locateLedgerRows(rows, ledger, "acc", ["tx_1", "tx_2", "tx_unknown"]);
    expect([found.get("tx_1")?.id, found.get("tx_2")?.id].sort()).toEqual(["act-1", "act-2"]);
    expect(found.has("tx_unknown")).toBe(false);
    // An id recorded for another account is not found here.
    expect(locateLedgerRows(rows, ledger, "other", ["tx_1"]).size).toBe(0);
  });

  it("does not hand a row that belongs to an earlier id to a later, identical one", () => {
    const a = withId("tx_1", cash(3, "Coffee"));
    const b = withId("tx_2", cash(3, "Coffee"));
    const { ledger } = reconcileWithLedger([a, b], [], {}, "acc");
    const rows = [{ ...stored(a), id: "act-1" }, { ...stored(a), id: "act-2" }];
    // Asking only for tx_2 must not return the row tx_1 already stands for.
    expect(locateLedgerRows(rows, ledger, "acc", ["tx_2"]).get("tx_2")?.id).toBe("act-2");
    expect(locateLedgerRows(rows, ledger, "acc", ["tx_1"]).get("tx_1")?.id).toBe("act-1");
  });
});

describe("adoptUntrackedRows", () => {
  const incoming = (id: string, type: string, amount: number, date: string, comment = "Trading 212 | Savings") => ({
    ...cash(amount, comment, date),
    id,
    activityType: type as ActivityImport["activityType"],
  });
  const hand = (type: string, amount: number, date: string) => ({
    ...stored(incoming("x", type, amount, date, "moved by hand")),
    id: "act-1",
  });
  const opts = { equivalents: { DEPOSIT: ["TRANSFER_IN"], WITHDRAWAL: ["TRANSFER_OUT"] } };

  it("takes a hand-made transfer for the same move instead of importing it again", () => {
    const desired = incoming("tx_1", "DEPOSIT", 300, "2026-10-04T10:00:00.000Z");
    const row = hand("TRANSFER_IN", 300, "2026-10-04T00:00:00.000Z");
    const r = reconcileWithLedger([desired], [row], {}, "acc");
    expect(r.toImport).toHaveLength(1);
    const out = adoptUntrackedRows(r.toImport, [row], r.ledger, "acc", opts);
    expect(out.toImport).toEqual([]);
    expect(out.adopted.map((a) => a.id)).toEqual(["tx_1"]);
  });

  it("uses each hand-made row once, and only for a matching direction, amount and date", () => {
    const row = hand("TRANSFER_OUT", 300, "2026-10-04T00:00:00.000Z");
    const a = incoming("tx_1", "WITHDRAWAL", 300, "2026-10-04T10:00:00.000Z");
    const b = incoming("tx_2", "WITHDRAWAL", 300, "2026-10-04T11:00:00.000Z");
    const wrongAmount = incoming("tx_3", "WITHDRAWAL", 301, "2026-10-04T10:00:00.000Z");
    const wrongDay = incoming("tx_4", "WITHDRAWAL", 300, "2026-10-09T10:00:00.000Z");
    const wrongWay = incoming("tx_5", "DEPOSIT", 300, "2026-10-04T10:00:00.000Z");
    const out = adoptUntrackedRows([a, b, wrongAmount, wrongDay, wrongWay], [row], {}, "acc", opts);
    expect(out.adopted.map((x) => x.id)).toEqual(["tx_1"]);
    expect(out.toImport.map((x) => x.id)).toEqual(["tx_2", "tx_3", "tx_4", "tx_5"]);
  });

  it("only adopts rows the caller allows, and never a row the ledger already accounts for", () => {
    const row = hand("TRANSFER_IN", 300, "2026-10-04T00:00:00.000Z");
    const coffee = incoming("tx_1", "DEPOSIT", 300, "2026-10-04T10:00:00.000Z", "Refund | Shopping");
    const only = (a: ActivityImport) => a.id !== "tx_1";
    expect(adoptUntrackedRows([coffee], [row], {}, "acc", { ...opts, eligible: only }).toImport).toHaveLength(1);

    const first = incoming("tx_2", "DEPOSIT", 300, "2026-10-04T10:00:00.000Z");
    const { ledger } = reconcileWithLedger([first], [], {}, "acc");
    const tracked = { ...stored({ ...first, activityType: "TRANSFER_IN" as ActivityImport["activityType"] }), id: "act-2" };
    // The ledger holds tx_2 as a DEPOSIT row; this TRANSFER_IN row is not that row, so a hand edit.
    const second = incoming("tx_3", "DEPOSIT", 300, "2026-10-04T11:00:00.000Z");
    const r = reconcileWithLedger([second], [tracked], ledger, "acc");
    expect(adoptUntrackedRows(r.toImport, [tracked], r.ledger, "acc", opts).adopted).toHaveLength(1);
    const sameRow = { ...stored(first), id: "act-3" };
    const r2 = reconcileWithLedger([second], [sameRow], ledger, "acc");
    expect(adoptUntrackedRows(r2.toImport, [sameRow], r2.ledger, "acc", opts).adopted).toEqual([]);
  });
});
