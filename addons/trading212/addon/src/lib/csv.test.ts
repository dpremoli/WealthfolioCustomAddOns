import { describe, it, expect } from "vitest";
import { parseCsv, mapCsvRow } from "./csv";
import type { SymbolResolver } from "./symbol-resolver";

// Minimal stub: resolves only known tickers, returns null for unknown ones.
function makeResolver(map: Record<string, string> = {}): SymbolResolver {
  return {
    resolve: async (ticker: string) => map[ticker] ?? null,
  } as unknown as SymbolResolver;
}

const RESOLVER = makeResolver({ AAPL_US_EQ: "AAPL" });
const ACC = "acc-1";

// Full header matching real T212 CSV exports.
const HDR =
  "Action,Time,ISIN,Ticker,Name,No. of shares,Price / share,Currency (Price / share)," +
  "Exchange rate,Total,Currency (Total),Withholding tax,Currency (Withholding tax)," +
  "Charge amount,Currency (Charge amount),Notes,ID," +
  "Currency conversion fee,Currency (Currency conversion fee)";

// Builds a default row for buy/sell tests; caller can override fields.
function tradeRow(action: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Action: action,
    Time: "2025-01-15T10:00:00.000Z",
    ISIN: "US0378331005",
    Ticker: "AAPL_US_EQ",
    Name: "Apple Inc",
    "No. of shares": "2",
    "Price / share": "170.5",
    "Currency (Price / share)": "USD",
    "Exchange rate": "1.27",
    Total: "268.50",
    "Currency (Total)": "GBP",
    "Withholding tax": "0",
    "Currency (Withholding tax)": "GBP",
    "Charge amount": "0",
    "Currency (Charge amount)": "GBP",
    Notes: "",
    ID: "ORDER1",
    "Currency conversion fee": "0",
    "Currency (Currency conversion fee)": "GBP",
    ...extra,
  };
}

// Builds a cash row (deposit / withdrawal / interest) without trade fields.
function cashRow(action: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Action: action,
    Time: "2025-01-01T08:00:00.000Z",
    ISIN: "",
    Ticker: "",
    Name: "",
    "No. of shares": "",
    "Price / share": "",
    "Currency (Price / share)": "",
    "Exchange rate": "",
    Total: "1000",
    "Currency (Total)": "GBP",
    "Withholding tax": "0",
    "Currency (Withholding tax)": "GBP",
    "Charge amount": "0",
    "Currency (Charge amount)": "GBP",
    Notes: "",
    ID: "CASH1",
    "Currency conversion fee": "0",
    "Currency (Currency conversion fee)": "GBP",
    ...extra,
  };
}

// ── parseCsv ──────────────────────────────────────────────────────────────────

describe("parseCsv", () => {
  it("parses a single data row", () => {
    const rows = parseCsv(
      `${HDR}\nMarket buy,2025-01-15T10:00:00.000Z,US0378331005,AAPL_US_EQ,Apple Inc,2,170.5,USD,1.27,268.50,GBP,0,GBP,0,GBP,,ORDER1,0,GBP`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]["Action"]).toBe("Market buy");
    expect(rows[0]["Ticker"]).toBe("AAPL_US_EQ");
    expect(rows[0]["ID"]).toBe("ORDER1");
  });

  it("handles CRLF line endings", () => {
    const rows = parseCsv(
      `${HDR}\r\nDeposit,2025-01-01T08:00:00.000Z,,,,,,,,1000,GBP,0,GBP,0,GBP,,DEP1,0,GBP\r\n`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]["Action"]).toBe("Deposit");
    expect(rows[0]["ID"]).toBe("DEP1");
  });

  it("handles quoted fields containing commas", () => {
    const rows = parseCsv(
      `${HDR}\nMarket buy,2025-01-15T10:00:00.000Z,US0378,"AAPL_US_EQ","Apple, Inc",2,170.5,USD,1.27,268.50,GBP,0,GBP,0,GBP,,ORDER2,0,GBP`,
    );
    expect(rows[0]["Name"]).toBe("Apple, Inc");
    expect(rows[0]["Ticker"]).toBe("AAPL_US_EQ");
  });

  it("handles escaped double-quotes inside quoted fields", () => {
    const rows = parseCsv(`${HDR}\nDeposit,2025-01-01T08:00:00Z,,,,,,,,1000,GBP,0,GBP,0,GBP,"note ""x""",DEP2,0,GBP`);
    expect(rows[0]["Notes"]).toBe('note "x"');
  });

  it("skips empty lines", () => {
    const rows = parseCsv(`${HDR}\n\nDeposit,2025-01-01T08:00:00Z,,,,,,,,1000,GBP,0,GBP,0,GBP,,DEP3,0,GBP\n`);
    expect(rows).toHaveLength(1);
  });

  it("returns empty array for header-only input", () => {
    expect(parseCsv(HDR)).toHaveLength(0);
  });
});

// ── mapCsvRow ─────────────────────────────────────────────────────────────────

describe("mapCsvRow", () => {
  describe("BUY", () => {
    it("maps a market buy", async () => {
      const act = await mapCsvRow(tradeRow("Market buy"), ACC, RESOLVER);
      expect(act).not.toBeNull();
      expect(act!.activityType).toBe("BUY");
      expect(act!.id).toBe("t212-order-ORDER1");
      expect(act!.quantity).toBe(2);
      expect(act!.unitPrice).toBe(170.5);
      expect(act!.symbol).toBe("AAPL");
      expect(act!.currency).toBe("USD");
      expect(act!.fxRate).toBe(1.27);
      expect(act!.date).toBe("2025-01-15T10:00:00.000Z");
      expect(act!.accountId).toBe(ACC);
    });

    it("maps a limit buy", async () => {
      const act = await mapCsvRow(tradeRow("Limit buy", { ID: "O2" }), ACC, RESOLVER);
      expect(act!.activityType).toBe("BUY");
      expect(act!.id).toBe("t212-order-O2");
    });

    it("maps a stop buy", async () => {
      expect((await mapCsvRow(tradeRow("Stop buy", { ID: "O3" }), ACC, RESOLVER))!.activityType).toBe("BUY");
    });

    it("includes charge fee", async () => {
      const act = await mapCsvRow(
        tradeRow("Market buy", { "Charge amount": "0.50", ID: "O4" }),
        ACC,
        RESOLVER,
      );
      expect(act!.fee).toBe(0.5);
    });

    it("omits fee when both charge columns are zero", async () => {
      const act = await mapCsvRow(tradeRow("Market buy"), ACC, RESOLVER);
      expect(act!.fee).toBeUndefined();
    });

    it("omits fxRate when exchange rate is 1", async () => {
      const act = await mapCsvRow(tradeRow("Market buy", { "Exchange rate": "1" }), ACC, RESOLVER);
      expect(act!.fxRate).toBeUndefined();
    });

    it("returns null for an unresolved ticker", async () => {
      const act = await mapCsvRow(
        tradeRow("Market buy", { Ticker: "UNKNOWN_EQ" }),
        ACC,
        makeResolver(),
      );
      expect(act).toBeNull();
    });

    it("returns null when quantity is zero", async () => {
      expect(
        await mapCsvRow(tradeRow("Market buy", { "No. of shares": "0" }), ACC, RESOLVER),
      ).toBeNull();
    });
  });

  describe("SELL", () => {
    it("maps a market sell", async () => {
      const act = await mapCsvRow(
        tradeRow("Market sell", { ID: "S1", Total: "340" }),
        ACC,
        RESOLVER,
      );
      expect(act!.activityType).toBe("SELL");
      expect(act!.id).toBe("t212-order-S1");
    });

    it("maps a limit sell", async () => {
      expect(
        (await mapCsvRow(tradeRow("Limit sell", { ID: "S2" }), ACC, RESOLVER))!.activityType,
      ).toBe("SELL");
    });
  });

  describe("DIVIDEND", () => {
    it("maps an ordinary dividend", async () => {
      const row = {
        ...cashRow("Dividend (Ordinary)", { Total: "12.34", ID: "DIV1" }),
        Ticker: "AAPL_US_EQ",
        ISIN: "US0378331005",
        Name: "Apple Inc",
      };
      const act = await mapCsvRow(row, ACC, RESOLVER);
      expect(act!.activityType).toBe("DIVIDEND");
      expect(act!.id).toBe("t212-div-DIV1");
      expect(act!.amount).toBe(12.34);
      expect(act!.symbol).toBe("AAPL");
      expect(act!.currency).toBe("GBP");
    });

    it("generates a stable ID when the CSV ID column is empty (real T212 behaviour)", async () => {
      // T212 exports consistently omit the ID field for dividends.
      const row = {
        Action: "Dividend (Dividend)",
        Time: "2026-04-28 13:51:46",
        ISIN: "CA0641491075",
        Ticker: "AAPL_US_EQ",
        Name: "Apple",
        Notes: "",
        ID: "",
        "No. of shares": "2.9906080000",
        "Price / share": "0.685554",
        "Currency (Price / share)": "USD",
        "Exchange rate": "0.85428500",
        Result: "",
        "Currency (Result)": "",
        Total: "1.75",
        "Currency (Total)": "EUR",
        "Withholding tax": "0.36",
        "Currency (Withholding tax)": "USD",
      };
      const act = await mapCsvRow(row, ACC, RESOLVER);
      expect(act).not.toBeNull();
      expect(act!.activityType).toBe("DIVIDEND");
      expect(act!.id).toMatch(/^t212-div-/);
      expect(act!.amount).toBe(1.75);
      expect(act!.currency).toBe("EUR");
    });

    it("returns null for unresolved ticker", async () => {
      const row = {
        ...cashRow("Dividend (Ordinary)", { Total: "5", ID: "DIV2" }),
        Ticker: "UNKNOWN_EQ",
      };
      expect(await mapCsvRow(row, ACC, makeResolver())).toBeNull();
    });
  });

  describe("INTEREST", () => {
    it("maps interest on cash with a $CASH symbol", async () => {
      const act = await mapCsvRow(cashRow("Interest on cash", { Total: "5.00", ID: "INT1" }), ACC, makeResolver());
      expect(act!.activityType).toBe("INTEREST");
      expect(act!.id).toBe("t212-txn-INT1");
      expect(act!.amount).toBe(5);
      expect(act!.symbol).toBe("$CASH-GBP");
    });

    it("maps lending interest", async () => {
      const act = await mapCsvRow(cashRow("Lending interest", { Total: "2.50", ID: "INT2" }), ACC, makeResolver());
      expect(act!.activityType).toBe("INTEREST");
    });
  });

  describe("DEPOSIT", () => {
    it("maps a deposit", async () => {
      const act = await mapCsvRow(cashRow("Deposit", { Total: "1000", ID: "DEP1" }), ACC, makeResolver());
      expect(act!.activityType).toBe("DEPOSIT");
      expect(act!.amount).toBe(1000);
      expect(act!.id).toBe("t212-txn-DEP1");
      expect(act!.currency).toBe("GBP");
      expect(act!.symbol).toBe("$CASH-GBP");
    });
  });

  describe("WITHDRAWAL", () => {
    it("maps a withdrawal", async () => {
      const act = await mapCsvRow(cashRow("Withdrawal", { Total: "500", ID: "WD1" }), ACC, makeResolver());
      expect(act!.activityType).toBe("WITHDRAWAL");
      expect(act!.amount).toBe(500);
      expect(act!.symbol).toBe("$CASH-GBP");
    });
  });

  describe("date normalisation", () => {
    it("converts T212 space-separated UTC time to ISO 8601", async () => {
      const act = await mapCsvRow(
        tradeRow("Market buy", { Time: "2025-01-15 10:00:00", ID: "D1" }),
        ACC,
        RESOLVER,
      );
      expect(act!.date).toBe("2025-01-15T10:00:00Z");
    });

    it("preserves a fractional-seconds time", async () => {
      const act = await mapCsvRow(
        tradeRow("Market buy", { Time: "2025-01-15 10:00:00.123", ID: "D2" }),
        ACC,
        RESOLVER,
      );
      expect(act!.date).toBe("2025-01-15T10:00:00.123Z");
    });

    it("passes through an already-ISO time", async () => {
      const act = await mapCsvRow(
        tradeRow("Market buy", { Time: "2025-01-15T10:00:00.000Z", ID: "D3" }),
        ACC,
        RESOLVER,
      );
      expect(act!.date).toBe("2025-01-15T10:00:00.000Z");
    });
  });

  describe("skipped rows", () => {
    it("returns null for stock split", async () => {
      expect(await mapCsvRow(tradeRow("Stock split", { ID: "SPLIT1" }), ACC, RESOLVER)).toBeNull();
    });

    it("returns null for spin-off", async () => {
      expect(await mapCsvRow(tradeRow("Spin-off", { ID: "SPO1" }), ACC, RESOLVER)).toBeNull();
    });

    it("returns null for missing ID", async () => {
      expect(await mapCsvRow(tradeRow("Market buy", { ID: "" }), ACC, RESOLVER)).toBeNull();
    });

    it("returns null for missing Time", async () => {
      expect(await mapCsvRow(tradeRow("Market buy", { Time: "" }), ACC, RESOLVER)).toBeNull();
    });
  });
});
