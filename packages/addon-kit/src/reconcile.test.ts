import type { ActivityImport } from "@wealthfolio/addon-sdk";
import {
  contentKey,
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
