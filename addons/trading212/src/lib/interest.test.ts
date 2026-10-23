import { describe, expect, it } from "vitest";
import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { MONTHLY_INTEREST_COMMENT, foldMonthlyInterest } from "./interest";

const interest = (day: string, amount: number, extra: Partial<ActivityImport> = {}): ActivityImport => ({
  id: `t212-txn-${day}`,
  accountId: "inv",
  activityType: "INTEREST",
  date: `${day}T06:00:00Z`,
  symbol: "$CASH-EUR",
  amount,
  currency: "EUR",
  isValid: true,
  isDraft: false,
  ...extra,
});
const buy: ActivityImport = { ...interest("2025-01-05", 0), id: "t212-order-1", activityType: "BUY", symbol: "AAPL" };

const fold = (rows: ActivityImport[], enabled: boolean, existing: Parameters<typeof foldMonthlyInterest>[1]["existing"] = []) =>
  foldMonthlyInterest(rows, { enabled, accountId: "inv", before: new Date("2025-03-15T00:00:00Z"), windowKey: "2024-03-15", existing });

describe("foldMonthlyInterest", () => {
  const rows = [
    interest("2025-01-01", 0.1),
    interest("2025-01-02", 0.2),
    interest("2025-02-01", 0.3),
    interest("2025-03-01", 0.4), // the backfill's own month: stays daily
    buy,
  ];

  it("folds each finished month into one row dated on its last payment, keeping everything else", () => {
    const out = fold(rows, true);
    expect(out.map((a) => [a.id, a.activityType, a.amount, a.date, a.comment])).toEqual([
      ["t212-txn-2025-03-01", "INTEREST", 0.4, "2025-03-01T06:00:00Z", undefined],
      ["t212-order-1", "BUY", 0, "2025-01-05T06:00:00Z", undefined],
      ["t212-interest-2025-01-EUR-2024-03-15", "INTEREST", 0.3, "2025-01-02T06:00:00Z", `${MONTHLY_INTEREST_COMMENT} (2 payments)`],
      ["t212-interest-2025-02-EUR-2024-03-15", "INTEREST", 0.3, "2025-02-01T06:00:00Z", `${MONTHLY_INTEREST_COMMENT} (1 payment)`],
    ]);
  });

  it("leaves rows alone when off, and card cashback or other accounts' rows always", () => {
    expect(fold(rows, false)).toEqual(rows);
    const cashback = interest("2025-01-03", 1, { accountId: "card" });
    expect(fold([cashback], true)).toEqual([cashback]);
  });

  it("never counts a month twice when the setting is switched after an import", () => {
    // Daily rows already imported for January: January stays daily (so they are recognised).
    const dailyJan = [{ activityType: "INTEREST", date: new Date("2025-01-01T06:00:00Z"), amount: "0.1", currency: "EUR", assetSymbol: "$CASH-EUR" }];
    expect(fold(rows, true, dailyJan).filter((a) => a.activityType === "INTEREST" && String(a.date).startsWith("2025-01")).map((a) => a.id)).toEqual([
      "t212-txn-2025-01-01",
      "t212-txn-2025-01-02",
    ]);
    // A monthly total already imported for February: with the setting off, February's daily rows are left out.
    const monthlyFeb = [
      { activityType: "INTEREST", date: new Date("2025-02-01T06:00:00Z"), amount: "0.3", currency: "EUR", comment: `${MONTHLY_INTEREST_COMMENT} (1 payment)` },
    ];
    expect(fold(rows, false, monthlyFeb).map((a) => a.id)).not.toContain("t212-txn-2025-02-01");
  });
});
