import { describe, expect, it } from "vitest";
import { exchangeLabel, maskedKeyId, parseSymbolMap } from "./format";

describe("parseSymbolMap", () => {
  it("parses bare symbols, MIC-suffixed symbols, and known misses", () => {
    const out = parseSymbolMap({
      AAPL_US_EQ: "AAPL",
      RR_GB_EQ: "RR.L|XLON",
      MISSING_EQ: "",
    });
    expect(out).toEqual([
      { ticker: "AAPL_US_EQ", symbol: "AAPL" },
      { ticker: "RR_GB_EQ", symbol: "RR.L", exchangeMic: "XLON" },
      { ticker: "MISSING_EQ", symbol: null },
    ]);
  });
});

describe("exchangeLabel", () => {
  it("maps common MICs to friendly names; falls back to raw", () => {
    expect(exchangeLabel("XLON")).toBe("LSE");
    expect(exchangeLabel("XNAS")).toBe("NASDAQ");
    expect(exchangeLabel("ZZZZ")).toBe("ZZZZ");
    expect(exchangeLabel(undefined)).toBeUndefined();
  });
});

describe("maskedKeyId", () => {
  it("shows the stored last 4, or a bare mask when unknown", () => {
    expect(maskedKeyId("ghij")).toBe("••••ghij");
    expect(maskedKeyId(undefined)).toBe("••••");
  });
});
