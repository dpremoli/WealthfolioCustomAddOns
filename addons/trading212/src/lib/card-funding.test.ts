import { describe, expect, it } from "vitest";
import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { CARD_FUNDING_COMMENT, fundingForExisting, isFundingId, withCardFunding } from "./card-funding";

const card = (activityType: string, amount: number): ActivityImport => ({
  id: "t212-txn-C1",
  accountId: "card",
  activityType: activityType as ActivityImport["activityType"],
  date: "2026-02-03T12:00:00Z",
  symbol: "$CASH-EUR",
  amount,
  currency: "EUR",
  isValid: true,
  isDraft: false,
  comment: "TESCO · Groceries",
});

const legs = (unit: ActivityImport[]) =>
  unit.slice(1).map((a) => [a.id, a.accountId, a.activityType, a.amount, a.currency, a.date, a.symbol, a.comment]);

describe("withCardFunding", () => {
  it("funds a purchase with a transfer from the investing account to the card account", () => {
    const unit = withCardFunding(card("WITHDRAWAL", 12.5), "inv");
    expect(unit[0]).toEqual(card("WITHDRAWAL", 12.5)); // the purchase stays spending
    expect(legs(unit)).toEqual([
      ["t212-txn-C1-fund-out", "inv", "TRANSFER_OUT", 12.5, "EUR", "2026-02-03T12:00:00Z", "$CASH-EUR", CARD_FUNDING_COMMENT],
      ["t212-txn-C1-fund-in", "card", "TRANSFER_IN", 12.5, "EUR", "2026-02-03T12:00:00Z", "$CASH-EUR", CARD_FUNDING_COMMENT],
    ]);
  });

  it("sends refunds and cashback back to the investing account", () => {
    for (const type of ["DEPOSIT", "INTEREST"]) {
      const [, out, inn] = withCardFunding(card(type, 3), "inv");
      expect([out.accountId, out.activityType, inn.accountId, inn.activityType]).toEqual([
        "card",
        "TRANSFER_OUT",
        "inv",
        "TRANSFER_IN",
      ]);
    }
  });

  it("marks its legs so they can be told apart from activity", () => {
    const unit = withCardFunding(card("WITHDRAWAL", 1), "inv");
    expect(unit.map((a) => isFundingId(a.id!))).toEqual([false, true, true]);
  });
});

describe("fundingForExisting", () => {
  it("funds earlier card rows, skipping the funding transfers themselves", () => {
    const units = fundingForExisting(
      [
        { id: "wf1", activityType: "WITHDRAWAL", date: new Date("2025-05-01T09:00:00Z"), amount: "20", currency: "EUR" },
        { id: "wf2", activityType: "DEPOSIT", date: new Date("2025-05-02T09:00:00Z"), amount: "4", currency: "EUR" },
        { id: "wf3", activityType: "TRANSFER_IN", date: new Date("2025-05-01T09:00:00Z"), amount: "20", currency: "EUR", comment: CARD_FUNDING_COMMENT },
      ],
      "card",
      "inv",
    );
    expect(units.map((u) => u.map((a) => [a.accountId, a.activityType, a.amount, a.date]))).toEqual([
      [
        ["inv", "TRANSFER_OUT", 20, "2025-05-01T09:00:00.000Z"],
        ["card", "TRANSFER_IN", 20, "2025-05-01T09:00:00.000Z"],
      ],
      [
        ["card", "TRANSFER_OUT", 4, "2025-05-02T09:00:00.000Z"],
        ["inv", "TRANSFER_IN", 4, "2025-05-02T09:00:00.000Z"],
      ],
    ]);
  });
});
