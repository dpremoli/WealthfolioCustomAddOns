import { describe, expect, it } from "vitest";
import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { CARD_FUNDING_COMMENT, fundingForExisting, isFundingId, orphanFundingLegs, withCardFunding } from "./card-funding";

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

describe("orphanFundingLegs", () => {
  const leg = (id: string, accountId: string, activityType: string, day: string, amount: number) => ({
    id, accountId, activityType, date: new Date(`${day}T12:00:00Z`), amount: String(amount), currency: "GBP", comment: CARD_FUNDING_COMMENT,
  });

  it("finds the legs whose other half is gone, in the connection's two accounts only", () => {
    const legs = [
      leg("c1", "card", "TRANSFER_IN", "2026-01-02", 5), leg("i1", "inv", "TRANSFER_OUT", "2026-01-02", 5), // a pair
      leg("c2", "card", "TRANSFER_IN", "2026-01-03", 7), // its investing leg was deleted with the account
      leg("c3", "card", "TRANSFER_OUT", "2026-01-04", 2), leg("i3", "inv", "TRANSFER_IN", "2026-01-04", 2), // a refund pair
      leg("i4", "inv", "TRANSFER_OUT", "2026-01-05", 9), // its card leg is gone
      leg("x5", "elsewhere", "TRANSFER_IN", "2026-01-06", 3), // another account's: not ours to touch
    ];
    expect(orphanFundingLegs(legs, ["card", "inv"]).map((l) => l.id).sort()).toEqual(["c2", "i4"]);
  });

  it("keeps a leg whose partner sits in another account (an older card account)", () => {
    const legs = [leg("i1", "inv", "TRANSFER_OUT", "2026-01-02", 5), leg("old", "old-card", "TRANSFER_IN", "2026-01-02", 5)];
    expect(orphanFundingLegs(legs, ["new-card", "inv"])).toEqual([]);
  });

  it("pairs by count: two equal spends on a day need two pairs", () => {
    const legs = [
      leg("c1", "card", "TRANSFER_IN", "2026-01-02", 5), leg("c2", "card", "TRANSFER_IN", "2026-01-02", 5),
      leg("i1", "inv", "TRANSFER_OUT", "2026-01-02", 5),
    ];
    expect(orphanFundingLegs(legs, ["card", "inv"])).toHaveLength(1);
  });

  it("ignores transfers that are not card funding", () => {
    expect(orphanFundingLegs([{ ...leg("t", "card", "TRANSFER_IN", "2026-01-02", 5), comment: "Moved" }], ["card", "inv"])).toEqual([]);
  });
});
