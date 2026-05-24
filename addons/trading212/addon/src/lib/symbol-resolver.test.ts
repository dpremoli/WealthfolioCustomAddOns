import { describe, it, expect, vi } from "vitest";
import type { SymbolSearchResult } from "@wealthfolio/addon-sdk";
import {
  SymbolResolver,
  parseBaseSymbol,
  pickBestSymbol,
  resolveTickerSymbol,
} from "./symbol-resolver";

function result(partial: Partial<SymbolSearchResult>): SymbolSearchResult {
  return {
    symbol: "X",
    shortName: "",
    longName: "",
    exchange: "",
    quoteType: "EQUITY",
    index: "",
    score: 0,
    typeDisplay: "",
    ...partial,
  } as SymbolSearchResult;
}

describe("parseBaseSymbol", () => {
  it("extracts the first segment of a T212 ticker", () => {
    expect(parseBaseSymbol("AAPL_US_EQ")).toBe("AAPL");
    expect(parseBaseSymbol("VUSA")).toBe("VUSA");
  });
});

describe("pickBestSymbol", () => {
  it("returns null for no results", () => {
    expect(pickBestSymbol([])).toBeNull();
  });

  it("prefers an existing symbol over a higher score", () => {
    const best = pickBestSymbol([
      result({ symbol: "HIGH", score: 9, isExisting: false }),
      result({ symbol: "EXIST", score: 1, isExisting: true }),
    ]);
    expect(best).toBe("EXIST");
  });

  it("falls back to highest score when none exist", () => {
    const best = pickBestSymbol([
      result({ symbol: "LOW", score: 1 }),
      result({ symbol: "HIGH", score: 5 }),
    ]);
    expect(best).toBe("HIGH");
  });
});

describe("resolveTickerSymbol", () => {
  it("tries ISIN first and stops on the first match", async () => {
    const search = vi.fn(async (q: string) =>
      q === "US0378331005" ? [result({ symbol: "AAPL" })] : [],
    );
    const sym = await resolveTickerSymbol(search, "AAPL_US_EQ", {
      isin: "US0378331005",
      name: "Apple Inc",
    });
    expect(sym).toBe("AAPL");
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("US0378331005");
  });

  it("falls back to the base ticker when ISIN misses", async () => {
    const search = vi.fn(async (q: string) =>
      q === "AAPL" ? [result({ symbol: "AAPL" })] : [],
    );
    const sym = await resolveTickerSymbol(search, "AAPL_US_EQ", { isin: "BAD" });
    expect(sym).toBe("AAPL");
    expect(search).toHaveBeenCalledWith("AAPL");
  });

  it("returns null when nothing matches", async () => {
    const search = vi.fn(async () => []);
    expect(await resolveTickerSymbol(search, "ZZZ_US_EQ")).toBeNull();
  });
});

describe("SymbolResolver caching", () => {
  it("caches positive resolutions and does not re-query", async () => {
    const search = vi.fn(async () => [result({ symbol: "AAPL" })]);
    const r = new SymbolResolver(search);
    expect(await r.resolve("AAPL_US_EQ")).toBe("AAPL");
    expect(await r.resolve("AAPL_US_EQ")).toBe("AAPL");
    expect(search).toHaveBeenCalledTimes(1);
    expect(r.isDirty).toBe(true);
  });

  it("caches negative resolutions to avoid repeat queries", async () => {
    const search = vi.fn(async () => []);
    const r = new SymbolResolver(search);
    expect(await r.resolve("ZZZ_US_EQ")).toBeNull();
    expect(await r.resolve("ZZZ_US_EQ")).toBeNull();
    // one query per attempted query string in a single resolve, none on the second resolve
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("seeds from an existing cache without querying", async () => {
    const search = vi.fn(async () => [result({ symbol: "NEW" })]);
    const r = new SymbolResolver(search, { AAPL_US_EQ: "AAPL" });
    expect(await r.resolve("AAPL_US_EQ")).toBe("AAPL");
    expect(search).not.toHaveBeenCalled();
    expect(r.isDirty).toBe(false);
  });
});
