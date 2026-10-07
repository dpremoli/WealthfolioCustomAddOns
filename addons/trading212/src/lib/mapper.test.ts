import { describe, it, expect } from "vitest";
import {
  accountPerActivityRate,
  chargesInActivityCurrency,
  mapDividendToActivity,
  mapOrderToActivity,
  mapPositionToHolding,
  mapTransactionToActivity,
  mergeHoldingsBySymbol,
} from "./mapper";
import type { DividendItem, HistoricalOrder, Position, TransactionItem } from "../types";

describe("mapOrderToActivity", () => {
  const baseOrder: HistoricalOrder = {
    order: {
      id: 555,
      side: "BUY",
      currency: "USD",
      instrument: { ticker: "AAPL_US_EQ", isin: "US0378331005", name: "Apple Inc" },
    },
    fill: {
      type: "TRADE",
      filledAt: "2026-04-01T10:00:00.000Z",
      price: 170.5,
      quantity: 3,
      // Account is GBP, the instrument trades in USD: 3 × 170.5 = 511.5 USD ≈ £402.8 at 1.27.
      walletImpact: {
        currency: "GBP",
        fxRate: 1.27,
        netValue: -403.3,
        taxes: [{ quantity: 0.5, currency: "GBP" }],
      },
    },
  };

  it("maps a buy order to a BUY activity", () => {
    const a = mapOrderToActivity(baseOrder, "acc-1", "AAPL")!;
    expect(a.activityType).toBe("BUY");
    expect(a.id).toBe("t212-order-555");
    expect(a.quantity).toBe(3);
    expect(a.unitPrice).toBe(170.5);
    expect(a.symbol).toBe("AAPL");
    expect(a.currency).toBe("USD");
    expect(a.date).toBe("2026-04-01T10:00:00.000Z");
    // Cross-currency (USD instrument, GBP account): Wealthfolio wants account-per-activity
    // (GBP per USD ≈ 0.787), and the GBP charge re-expressed in the activity currency.
    expect(a.fxRate).toBeCloseTo(1 / 1.27, 6);
    expect(a.fee).toBeCloseTo(0.635, 6);
  });

  it("omits `amount` on trades so Wealthfolio derives the final cash (qty × price ± fee)", () => {
    const buy = mapOrderToActivity(baseOrder, "acc-1", "AAPL")!;
    const sell = mapOrderToActivity(
      { ...baseOrder, order: { ...baseOrder.order!, side: "SELL" } },
      "acc-1",
      "AAPL",
    )!;
    expect("amount" in buy).toBe(false);
    expect("amount" in sell).toBe(false);
    expect(sell.fee).toBeCloseTo(0.635, 6);
  });

  it("same-currency trade: no fx rate, fee passed through unchanged", () => {
    const gbp: HistoricalOrder = {
      order: { ...baseOrder.order!, currency: "GBP" },
      fill: {
        ...baseOrder.fill!,
        walletImpact: { currency: "GBP", fxRate: 1, netValue: -512, taxes: [{ quantity: 1.5, currency: "GBP" }] },
      },
    };
    const a = mapOrderToActivity(gbp, "acc-1", "RR.L")!;
    expect(a.fxRate).toBeUndefined();
    expect(a.fee).toBe(1.5);
    expect("amount" in a).toBe(false);
  });

  it("does not trust the direction of Trading 212's rate: picks the one matching the cash total", () => {
    // Same trade, but the rate arrives pointing the other way (GBP per USD).
    const inverted: HistoricalOrder = {
      ...baseOrder,
      fill: { ...baseOrder.fill!, walletImpact: { ...baseOrder.fill!.walletImpact!, fxRate: 1 / 1.27 } },
    };
    expect(mapOrderToActivity(inverted, "acc-1", "AAPL")!.fxRate).toBeCloseTo(1 / 1.27, 6);
  });

  it("cross-currency without a cash total: leaves the trade in its own currency (no guessed rate)", () => {
    const noTotal: HistoricalOrder = {
      ...baseOrder,
      fill: { ...baseOrder.fill!, walletImpact: { currency: "GBP", fxRate: 1.27 } },
    };
    expect(mapOrderToActivity(noTotal, "acc-1", "AAPL")!.fxRate).toBeUndefined();
  });

  it("maps a sell order to a SELL activity", () => {
    const sell: HistoricalOrder = { ...baseOrder, order: { ...baseOrder.order!, side: "SELL" } };
    expect(mapOrderToActivity(sell, "acc-1", "AAPL")!.activityType).toBe("SELL");
  });

  it("skips non-trade fills (e.g. stock splits)", () => {
    const split: HistoricalOrder = { ...baseOrder, fill: { ...baseOrder.fill!, type: "STOCK_SPLIT" } };
    expect(mapOrderToActivity(split, "acc-1", "AAPL")).toBeNull();
  });

  it("skips orders without a price or quantity", () => {
    const bad: HistoricalOrder = { ...baseOrder, fill: { ...baseOrder.fill!, price: undefined } };
    expect(mapOrderToActivity(bad, "acc-1", "AAPL")).toBeNull();
  });
});

describe("mapDividendToActivity", () => {
  const div: DividendItem = {
    ticker: "AAPL_US_EQ",
    reference: "DIV123",
    type: "ORDINARY",
    amount: 12.34,
    currency: "GBP",
    paidOn: "2026-03-15T00:00:00.000Z",
  };

  it("maps an ordinary dividend to a DIVIDEND activity", () => {
    const a = mapDividendToActivity(div, "acc-1", "AAPL");
    expect(a.activityType).toBe("DIVIDEND");
    expect(a.id).toBe("t212-div-DIV123");
    expect(a.amount).toBe(12.34);
    expect(a.symbol).toBe("AAPL");
    expect(a.currency).toBe("GBP");
    expect(a.comment).toBe("Ordinary");
    expect("fee" in a).toBe(false);
  });

  it("dividend/interest amount is the final cash and is rounded to cents", () => {
    expect(mapDividendToActivity({ ...div, amount: 10.005 }, "acc-1", "AAPL").amount).toBe(10.01);
    expect(mapDividendToActivity({ ...div, amount: -3 }, "acc-1", "AAPL").amount).toBe(3);
  });

  it("maps interest to an INTEREST activity with a $CASH symbol", () => {
    const a = mapDividendToActivity({ ...div, type: "INTEREST", reference: "INT1" }, "acc-1", null);
    expect(a.activityType).toBe("INTEREST");
    expect(a.symbol).toBe("$CASH-GBP");
    expect(a.amount).toBe(12.34);
  });

  it("uses the kit's cash symbol (currency upper-cased)", () => {
    const a = mapDividendToActivity({ ...div, type: "INTEREST", reference: "INT2", currency: "eur" }, "acc-1", null);
    expect(a.symbol).toBe("$CASH-EUR");
  });
});

describe("mapTransactionToActivity", () => {
  const base: TransactionItem = {
    type: "DEPOSIT",
    amount: 1000,
    currency: "GBP",
    dateTime: "2026-01-02T08:00:00.000Z",
    reference: "TXN1",
  };

  it("maps a deposit", () => {
    const a = mapTransactionToActivity(base, "acc-1");
    expect(a.activityType).toBe("DEPOSIT");
    expect(a.amount).toBe(1000);
    expect(a.id).toBe("t212-txn-TXN1");
    expect(a.symbol).toBe("$CASH-GBP");
  });

  it("maps a withdrawal (WITHDRAW) with a positive amount", () => {
    const a = mapTransactionToActivity({ ...base, type: "WITHDRAW", amount: -500 }, "acc-1");
    expect(a.activityType).toBe("WITHDRAWAL");
    expect(a.amount).toBe(500);
  });

  it("plain cash rows carry the ledger in `amount` and never a separate fee", () => {
    for (const type of ["DEPOSIT", "WITHDRAW", "FEE", "TRANSFER"] as const) {
      const a = mapTransactionToActivity({ ...base, type, amount: type === "WITHDRAW" ? -25.5 : 25.5 }, "acc-1");
      expect(a.amount).toBe(25.5);
      expect("fee" in a).toBe(false);
      expect(a.symbol).toBe("$CASH-GBP");
    }
  });

  it("maps a fee", () => {
    expect(mapTransactionToActivity({ ...base, type: "FEE" }, "acc-1").activityType).toBe("FEE");
  });

  it("maps transfers by sign", () => {
    expect(
      mapTransactionToActivity({ ...base, type: "TRANSFER", amount: 50 }, "acc-1").activityType,
    ).toBe("TRANSFER_IN");
    expect(
      mapTransactionToActivity({ ...base, type: "TRANSFER", amount: -50 }, "acc-1").activityType,
    ).toBe("TRANSFER_OUT");
  });
});

describe("mapPositionToHolding", () => {
  const base: Position = {
    instrument: { ticker: "AAPL_US_EQ", isin: "US0378331005", name: "Apple Inc", currency: "USD" },
    quantity: 3.5,
    averagePricePaid: 170.25,
  };

  it("maps quantity, currency, averageCost and name as strings", () => {
    const h = mapPositionToHolding(base, "AAPL", "GBP");
    expect(h).toEqual({
      symbol: "AAPL",
      quantity: "3.5",
      currency: "USD",
      averageCost: "170.25",
      name: "Apple Inc",
    });
  });

  it("falls back to the account currency when the instrument has none", () => {
    const pos: Position = { ...base, instrument: { ticker: "X", name: "X" } };
    expect(mapPositionToHolding(pos, "X", "GBP").currency).toBe("GBP");
  });

  it("omits averageCost when averagePricePaid is missing", () => {
    const pos: Position = { instrument: { ticker: "X" }, quantity: 1 };
    expect(mapPositionToHolding(pos, "X", "GBP").averageCost).toBeUndefined();
  });

  it("includes the exchange MIC when the resolver returned one", () => {
    // Without this, Wealthfolio creates an exchangeless asset and ticker
    // collisions like RR resolve to whichever company Yahoo defaults to.
    const h = mapPositionToHolding(base, "RR.L", "GBP", "XLON");
    expect(h.exchangeMic).toBe("XLON");
  });

  it("leaves exchangeMic undefined when none was resolved", () => {
    const h = mapPositionToHolding(base, "AAPL", "GBP");
    expect(h.exchangeMic).toBeUndefined();
  });
});

describe("mergeHoldingsBySymbol", () => {
  it("passes distinct symbols through untouched, preserving order", () => {
    const holdings = [
      { symbol: "AAPL", quantity: "3", currency: "USD" },
      { symbol: "MSFT", quantity: "1", currency: "USD" },
    ];
    expect(mergeHoldingsBySymbol(holdings)).toEqual(holdings);
  });

  it("sums quantity and quantity-weights the average cost on a collision", () => {
    // Two NVIDIA legs (US + Xetra) that both collapsed onto NVDA: keep the value.
    const merged = mergeHoldingsBySymbol([
      { symbol: "NVDA", quantity: "5", currency: "USD", averageCost: "100" },
      { symbol: "NVDA", quantity: "15", currency: "USD", averageCost: "140" },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].quantity).toBe("20");
    // (5*100 + 15*140) / 20 = 130
    expect(merged[0].averageCost).toBe("130");
  });

  it("drops the average cost when either leg lacks one", () => {
    const merged = mergeHoldingsBySymbol([
      { symbol: "NVDA", quantity: "5", currency: "USD", averageCost: "100" },
      { symbol: "NVDA", quantity: "15", currency: "USD" },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].quantity).toBe("20");
    expect(merged[0].averageCost).toBeUndefined();
  });
});

describe("accountPerActivityRate / chargesInActivityCurrency", () => {
  it("returns undefined for a missing, unit or invalid rate, or when no implied rate is available", () => {
    expect(accountPerActivityRate(undefined, 0.8)).toBeUndefined();
    expect(accountPerActivityRate(1, 1)).toBeUndefined();
    expect(accountPerActivityRate(-2, 0.5)).toBeUndefined();
    expect(accountPerActivityRate(1.27, undefined)).toBeUndefined();
  });

  it("chooses whichever of rate / 1-over-rate matches the implied rate", () => {
    expect(accountPerActivityRate(1.27, 0.79)).toBeCloseTo(1 / 1.27, 8);
    expect(accountPerActivityRate(0.7874, 0.79)).toBeCloseTo(0.7874, 8);
  });

  it("converts only foreign-currency charges and rounds sensibly", () => {
    // 2 GBP charge on a USD trade at 0.8 GBP/USD → 2.5 USD; a USD charge is untouched.
    expect(
      chargesInActivityCurrency(
        [
          { amount: 2, currency: "GBP" },
          { amount: 1, currency: "USD" },
        ],
        "USD",
        0.8,
      ),
    ).toBe(3.5);
    // Without a rate the sum is just rounded to cents.
    expect(chargesInActivityCurrency([{ amount: 0.1 }, { amount: 0.2 }], "GBP", undefined)).toBe(0.3);
  });
});
