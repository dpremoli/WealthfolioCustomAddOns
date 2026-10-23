import { describe, expect, it } from "vitest";
import {
  FX_COMMENT,
  mapCurrencyConversion,
  mapStockSplit,
  pairStockSplits,
  snapRatio,
  splitCorporateRows,
} from "./corporate-actions";

// Rows shaped like the real Invest export ("Time (UTC)" with an offset, values from the findings).
const row = (action: string, extra: Record<string, string>): Record<string, string> => ({
  Action: action,
  "Time (UTC)": "2026-07-02 07:28:15+00:00",
  ISIN: "",
  Ticker: "",
  Name: "",
  Notes: "",
  ID: "",
  "No. of shares": "",
  "Currency (Price / share)": "",
  Total: "",
  "Currency (Total)": "EUR",
  ...extra,
});
const close = (extra: Record<string, string>) => row("Stock split close", extra);
const open = (extra: Record<string, string>) => row("Stock split open", extra);

describe("snapRatio", () => {
  it("snaps to whole ratios and their reciprocals, keeps other ratios to 8 decimals", () => {
    expect(snapRatio(0.68950984 / 0.17237746)).toBe(4);
    expect(snapRatio(0.0003738 / 0.005607)).toBe(Number((1 / 15).toFixed(10)));
    expect(snapRatio(0.95189142 / 0.99155357)).toBe(0.96);
    expect(snapRatio(1.5)).toBe(1.5);
  });

  it("allows for the rounding of the share counts: a 0.00001495-share holding is a 25:1 reverse split, not 24.997:1", () => {
    const ratio = 0.00001495 / 0.0003738; // 0.0399946…
    expect(snapRatio(ratio)).toBe(0.03999465); // at the default 1e-6 tolerance it is just a number
    expect(snapRatio(ratio, 5e-9 / 1.495e-5 + 5e-11 / 3.738e-4)).toBe(0.04);
  });
});

describe("splitCorporateRows", () => {
  it("sets apart split rows and currency conversions, leaving everything else", () => {
    const rows = [
      close({}),
      row("Market buy", {}),
      open({}),
      row("Currency conversion", {}),
      row("Deposit", {}),
    ];
    const out = splitCorporateRows(rows);
    expect(out.splitRows).toHaveLength(2);
    expect(out.conversionRows).toHaveLength(1);
    expect(out.rest.map((r) => r["Action"])).toEqual(["Market buy", "Deposit"]);
  });
});

describe("pairStockSplits", () => {
  const crwd = (side: (e: Record<string, string>) => Record<string, string>, shares: string) =>
    side({
      ISIN: "US22788C1053",
      Ticker: "CRWD",
      Name: "CrowdStrike",
      "No. of shares": shares,
      "Currency (Price / share)": "USD",
      Total: "69.89",
    });

  it("turns the close/open pair of the CrowdStrike 4:1 split into a ratio of 4", () => {
    const { splits, unpaired } = pairStockSplits([crwd(open, "0.68950984"), crwd(close, "0.17237746")]);
    expect(unpaired).toEqual([]);
    expect(splits).toEqual([
      {
        id: "t212-split-US22788C1053-202607020728",
        ticker: "CRWD",
        isin: "US22788C1053",
        name: "CrowdStrike",
        time: "2026-07-02T07:28:15.000Z",
        closeShares: 0.17237746,
        openShares: 0.68950984,
        ratio: 4,
        currency: "USD",
      },
    ]);
  });

  it("handles a consolidation and two reverse splits of the same instrument at different times", () => {
    const rkt = (side: (e: Record<string, string>) => Record<string, string>, shares: string) =>
      side({ ISIN: "GB00BSZBP530", Ticker: "RKT", "No. of shares": shares, "Currency (Price / share)": "GBX", "Time (UTC)": "2026-02-02 07:41:00+00:00" });
    const erna = (side: (e: Record<string, string>) => Record<string, string>, shares: string, t: string) =>
      side({ ISIN: "US1140824079", Ticker: "ERNA", "No. of shares": shares, "Currency (Price / share)": "USD", "Time (UTC)": t });
    const { splits } = pairStockSplits([
      rkt(close, "0.99155357"),
      rkt(open, "0.95189142"),
      erna(close, "0.0056070", "2025-06-12 06:35:00+00:00"),
      erna(open, "0.0003738", "2025-06-12 06:35:00+00:00"),
      erna(close, "0.0003738", "2026-05-04 07:03:00+00:00"),
      erna(open, "0.00001495", "2026-05-04 07:03:00+00:00"),
    ]);
    expect(splits.map((s) => [s.ticker, s.time.slice(0, 10), s.ratio, s.currency])).toEqual([
      ["ERNA", "2025-06-12", Number((1 / 15).toFixed(10)), "USD"],
      ["RKT", "2026-02-02", 0.96, "GBX"],
      ["ERNA", "2026-05-04", Number((1 / 25).toFixed(10)), "USD"],
    ]);
  });

  it("does not pair a swap into a different security, or a row with no partner", () => {
    const { splits, unpaired } = pairStockSplits([
      close({ ISIN: "US0000000001", Ticker: "OLD", "No. of shares": "2" }),
      open({ ISIN: "US0000000002", Ticker: "NEW", "No. of shares": "2" }),
      close({ ISIN: "US0000000003", Ticker: "LONE", "No. of shares": "1" }),
    ]);
    expect(splits).toEqual([]);
    expect(unpaired.map((r) => r["Ticker"]).sort()).toEqual(["LONE", "NEW", "OLD"]);
  });
});

describe("mapStockSplit", () => {
  it("carries the ratio in amount, with the listing and the instrument's currency", () => {
    const act = mapStockSplit(
      {
        id: "t212-split-X-1",
        ticker: "CRWD",
        time: "2026-07-02T07:28:15.000Z",
        closeShares: 0.17237746,
        openShares: 0.68950984,
        ratio: 4,
        currency: "USD",
      },
      "acc",
      { symbol: "CRWD", exchangeMic: "XNAS" },
    );
    expect(act).toMatchObject({
      id: "t212-split-X-1",
      accountId: "acc",
      activityType: "SPLIT",
      date: "2026-07-02T07:28:15.000Z",
      symbol: "CRWD",
      exchangeMic: "XNAS",
      instrumentType: "EQUITY",
      amount: 4,
      currency: "USD",
    });
  });
});

describe("mapCurrencyConversion", () => {
  const conversion = row("Currency conversion", {
    "Time (UTC)": "2025-09-04 13:06:05",
    Notes: "10000.00 EUR -> 8665.30 GBP",
    Total: "-13.00",
    "Currency (Total)": "GBP",
    ID: "FX1",
  });

  it("is an internal exchange pair in the same account, plus the fee", () => {
    const { units, problem } = mapCurrencyConversion(conversion, "inv");
    expect(problem).toBeUndefined();
    expect(units).toHaveLength(2);
    expect(units[0].map((a) => [a.id, a.activityType, a.amount, a.currency, a.symbol, a.accountId, a.isExternal, a.comment])).toEqual([
      ["t212-fx-FX1-out", "TRANSFER_OUT", 10000, "EUR", "$CASH-EUR", "inv", false, FX_COMMENT],
      ["t212-fx-FX1-in", "TRANSFER_IN", 8665.3, "GBP", "$CASH-GBP", "inv", false, FX_COMMENT],
    ]);
    expect(units[0][0].date).toBe("2025-09-04T13:06:05Z");
    expect(units[1].map((a) => [a.id, a.activityType, a.amount, a.currency])).toEqual([
      ["t212-fx-FX1-fee", "FEE", 13, "GBP"],
    ]);
  });

  it("has no fee unit when there is no fee, and reads thousands separators", () => {
    const { units } = mapCurrencyConversion({ ...conversion, Total: "0", Notes: "1,000.50 USD -> 800.25 EUR" }, "inv");
    expect(units).toHaveLength(1);
    expect(units[0].map((a) => a.amount)).toEqual([1000.5, 800.25]);
  });

  it("builds an id from the row when it has none, and explains a row it cannot read", () => {
    expect(mapCurrencyConversion({ ...conversion, ID: "" }, "inv").units[0][0].id).toBe("t212-fx-20250904130605-10000.00-EUR-out");
    expect(mapCurrencyConversion({ ...conversion, Notes: "" }, "inv")).toEqual({ units: [], problem: 'no amounts in its Notes ("")' });
  });
});
