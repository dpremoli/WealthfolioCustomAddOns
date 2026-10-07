import { describe, expect, it } from "vitest";
import { exchangeLabel, maskKey, parseSymbolMap, relativeTime } from "./format";

describe("relativeTime", () => {
  const now = new Date("2026-06-09T12:00:00.000Z");

  it("returns 'Never' for null/undefined/empty", () => {
    expect(relativeTime(null, now)).toBe("Never");
    expect(relativeTime(undefined, now)).toBe("Never");
  });

  it("returns 'just now' for very recent timestamps", () => {
    expect(relativeTime("2026-06-09T11:59:30.000Z", now)).toBe("just now");
  });

  it("formats minutes, hours, days", () => {
    expect(relativeTime("2026-06-09T11:30:00.000Z", now)).toBe("30 mins ago");
    expect(relativeTime("2026-06-09T11:00:00.000Z", now)).toBe("1 hour ago");
    expect(relativeTime("2026-06-08T12:00:00.000Z", now)).toBe("1 day ago");
    expect(relativeTime("2026-06-04T12:00:00.000Z", now)).toBe("5 days ago");
  });

  it("falls back to absolute for far past or invalid", () => {
    expect(relativeTime("not-a-date", now)).toBe("Never");
  });
});

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

describe("maskKey", () => {
  it("masks long keys, keeps the trailing 4", () => {
    expect(maskKey("abcdefghij")).toBe("••••ghij");
    expect(maskKey("xy")).toBe("••••");
  });
});
