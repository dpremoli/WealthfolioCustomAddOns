import { describe, expect, it } from "vitest";
import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { FakeWealthfolio } from "@wf-addons/kit/testing";
import { ActivityImporter } from "./importer";
import { healPennyRates, pennyRateTrades, type StoredTrade } from "./minor-units";

const RATES = [{ fromCurrency: "GBP", toCurrency: "EUR", rate: 1.17 }];
const trade = (fxRate: number, extra: Partial<StoredTrade> = {}): StoredTrade => ({
  id: `t-${fxRate}`,
  activityType: "BUY",
  date: "2024-10-15T10:00:00.000Z",
  currency: "GBP",
  fxRate,
  ...extra,
});

describe("pennyRateTrades", () => {
  it("finds the trades in pounds whose rate is per penny, with the rate per pound", () => {
    const { fixes, unchecked } = pennyRateTrades([trade(0.0119762), trade(1.19762), trade(0.0119762, { activityType: "DIVIDEND" })], "EUR", RATES);
    expect(fixes.map((f) => [f.row.id, f.fxRate])).toEqual([["t-0.0119762", 1.19762]]);
    expect(unchecked).toEqual([]);
  });

  it("leaves trades in the account's own currency, in other currencies, and without a rate", () => {
    // CHF has no minor unit Wealthfolio converts, so its rate is never one per centime.
    const rows = [trade(0.0119762, { currency: "EUR" }), trade(0.0105, { currency: "CHF" }), trade(0, {})];
    expect(pennyRateTrades(rows, "EUR", [...RATES, { fromCurrency: "CHF", toCurrency: "EUR", rate: 1.05 }]).fixes).toEqual([]);
    // USD is the major of USX: a USD trade at a normal rate is not taken for one per cent.
    expect(pennyRateTrades([trade(0.92, { currency: "USD" })], "EUR", [{ fromCurrency: "EUR", toCurrency: "USD", rate: 1.087 }]).fixes).toEqual([]);
  });

  it("does not guess without a current rate", () => {
    const { fixes, unchecked } = pennyRateTrades([trade(0.0119762)], "EUR", []);
    expect(fixes).toEqual([]);
    expect(unchecked).toHaveLength(1);
  });
});

describe("healPennyRates against the fake host", () => {
  it("puts the rate of a trade 2.6.4 stored per penny right, and the euros it cost come back", async () => {
    const wf = new FakeWealthfolio([{ id: "inv", name: "Invest", currency: "EUR" }]);
    wf.rates = RATES;
    // As 2.6.4 sent it: pence, at euros per penny. Wealthfolio makes the price pounds, keeps the rate.
    const rr: ActivityImport = {
      id: "t212-order-RR1", accountId: "inv", activityType: "BUY" as ActivityImport["activityType"], date: "2024-10-15T10:00:00.000Z",
      symbol: "RR", exchangeMic: "XLON", instrumentType: "EQUITY", quantity: 19.0384, unitPrice: 540.2, currency: "GBX", fxRate: 0.0119762,
      isValid: true, isDraft: false,
    };
    await new ActivityImporter(wf.ctx).importRows([[rr]]);
    expect(wf.cash("inv")).toBeCloseTo(-1.23, 2);

    const log: string[] = [];
    expect(await healPennyRates(wf.ctx, wf.rows("inv"), "inv", "EUR", log)).toBe(1);
    expect(wf.cash("inv")).toBeCloseTo(-123.17, 1);
    expect(log.join("\n")).toMatch(/Fixed the exchange rate of 1 trade priced in pence/);
    // Done once: nothing left to fix.
    expect(await healPennyRates(wf.ctx, wf.rows("inv"), "inv", "EUR", [])).toBe(0);
  });
});
