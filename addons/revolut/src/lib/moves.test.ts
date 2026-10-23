import { describe, expect, it } from "vitest";
import { makeCtx } from "../test-utils";
import { isSavingsMove, isTrading212Account, linkSavingsMoves, linkTrading212Moves } from "./moves";

describe("isSavingsMove", () => {
  it("recognises Revolut's savings-pot descriptions", () => {
    expect(isSavingsMove("Depositing savings")).toBe(true);
    expect(isSavingsMove("withdrawing SAVINGS")).toBe(true);
    expect(isSavingsMove("Savings bond")).toBe(false);
    expect(isSavingsMove(null)).toBe(false);
  });
});

describe("isTrading212Account", () => {
  it("takes the Trading 212 add-on's Invest, ISA and Cash ISA accounts, not its card accounts", () => {
    expect(isTrading212Account({ provider: "trading212-addon", providerAccountId: "4098937" })).toBe(true);
    expect(isTrading212Account({ provider: "trading212-addon", providerAccountId: "t212-cash-isa" })).toBe(true);
    expect(isTrading212Account({ provider: "trading212-addon", providerAccountId: "4098937-card" })).toBe(false);
    expect(isTrading212Account({ provider: "monzo-addon", providerAccountId: "4098937" })).toBe(false);
  });
});

describe("linkTrading212Moves", () => {
  it("links a Revolut transfer quoting a Trading 212 account number, not other moves", async () => {
    const t = makeCtx({
      wfAccounts: [
        { id: "R", name: "Revolut GBP" },
        { id: "T", name: "Stocks ISA", provider: "trading212-addon", providerAccountId: "31764668" },
      ],
    });
    const date = "2024-03-11T09:00:00.000Z";
    const out = t.addRow({ accountId: "R", activityType: "TRANSFER_OUT", amount: 100, currency: "GBP", date, comment: "To John Smith ref 31764668" });
    t.addRow({ accountId: "R", activityType: "WITHDRAWAL", amount: 100, currency: "GBP", date, comment: "Gym" });
    const inn = t.addRow({ accountId: "T", activityType: "DEPOSIT", amount: 100, currency: "GBP", date, comment: "Deposit" });
    expect(await linkTrading212Moves(t.ctx, ["R"])).toEqual({ linked: 1, ambiguous: [], failed: [] });
    expect(t.links).toEqual([[out.id, inn.id]]);
  });
});

describe("linkSavingsMoves", () => {
  it("does nothing without a savings account", async () => {
    const t = makeCtx();
    expect(await linkSavingsMoves(t.ctx, ["R"], undefined)).toEqual({ linked: 0, ambiguous: [], failed: [] });
  });

  it("links the savings account's rows only, never the savings account with itself", async () => {
    const t = makeCtx({
      wfAccounts: [
        { id: "R", name: "Revolut GBP" },
        { id: "S", name: "Revolut Savings" },
        { id: "M", name: "Monzo" },
      ],
    });
    const date = "2024-03-12T09:00:00.000Z";
    const out = t.addRow({ accountId: "R", activityType: "WITHDRAWAL", amount: 200, currency: "GBP", date, comment: "Depositing savings" });
    t.addRow({ accountId: "M", activityType: "DEPOSIT", amount: 200, currency: "GBP", date, comment: "From Revolut" });
    const inn = t.addRow({ accountId: "S", activityType: "DEPOSIT", amount: 200, currency: "GBP", date, comment: "Deposit" });
    expect(await linkSavingsMoves(t.ctx, ["R", "S"], "S")).toEqual({ linked: 1, ambiguous: [], failed: [] });
    expect(t.links).toEqual([[out.id, inn.id]]);
  });
});
