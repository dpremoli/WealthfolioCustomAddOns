import { describe, it, expect, vi } from "vitest";
import type { SymbolSearchResult } from "@wealthfolio/addon-sdk";
import {
  SymbolResolver,
  marketCurrency,
  normalizeCurrency,
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

  it("filters out wrong-currency cross-listings when currency hint matches at least one", () => {
    // ISIN search for TSM returns the NYSE ADR (USD) and the Mexican listing (MXN).
    // Without the currency filter the MXN result wins on score → wrong import.
    const best = pickBestSymbol(
      [
        result({ symbol: "TSMN.MX", score: 9, currency: "MXN" }),
        result({ symbol: "TSM", score: 5, currency: "USD" }),
      ],
      { currency: "USD" },
    );
    expect(best).toBe("TSM");
  });

  it("ignores the currency hint when no candidate matches", () => {
    // Don't drop everything if Wealthfolio simply has no USD listing — fall back
    // to the best non-currency-matched hit so the position still resolves.
    const best = pickBestSymbol(
      [
        result({ symbol: "FOO.L", score: 5, currency: "GBP" }),
        result({ symbol: "FOO.DE", score: 3, currency: "EUR" }),
      ],
      { currency: "USD" },
    );
    expect(best).toBe("FOO.L");
  });

  it("drops ISIN-shaped symbols even when isExisting boosts them", () => {
    // A prior bad import created an asset under the ISIN; the search returns it
    // first with isExisting:true. The real ticker must still win.
    const best = pickBestSymbol([
      result({ symbol: "US02079K3059", score: 9, currency: "USD", isExisting: true }),
      result({ symbol: "GOOGL", score: 5, currency: "USD" }),
    ]);
    expect(best).toBe("GOOGL");
  });

  it("returns null when every candidate is ISIN-shaped (no real ticker available)", () => {
    const best = pickBestSymbol([
      result({ symbol: "US02079K3059", score: 9, currency: "USD" }),
    ]);
    expect(best).toBeNull();
  });
});

describe("marketCurrency", () => {
  it("maps the T212 ticker market segment to a currency", () => {
    expect(marketCurrency("TSM_US_EQ")).toBe("USD");
    expect(marketCurrency("RR_GB_EQ")).toBe("GBP");
    expect(marketCurrency("BMO_CA_EQ")).toBe("CAD");
    expect(marketCurrency("SAP_DE_EQ")).toBe("EUR");
  });

  it("returns undefined for unknown or missing segments", () => {
    expect(marketCurrency("VUAA")).toBeUndefined();
    expect(marketCurrency("FOO_ZZ_EQ")).toBeUndefined();
  });
});

describe("normalizeCurrency", () => {
  it("treats pence (GBX/GBp) and pounds (GBP) as the same", () => {
    expect(normalizeCurrency("GBX")).toBe("GBP");
    expect(normalizeCurrency("GBp")).toBe("GBP");
    expect(normalizeCurrency("GBP")).toBe("GBP");
  });
});

describe("resolveTickerSymbol", () => {
  it("uses the ticker market segment as a currency fallback to disambiguate", async () => {
    // No instrument currency given, but RR_GB_EQ → GBP should pick the London
    // Rolls-Royce over the higher-scoring US Richtech (RR/USD).
    const search = vi.fn(async (q: string) =>
      q === "RR"
        ? [
            result({ symbol: "RR", score: 9, currency: "USD" }), // Richtech (US)
            result({ symbol: "RR.L", score: 4, currency: "GBp" }), // Rolls-Royce (London)
          ]
        : [],
    );
    const sym = await resolveTickerSymbol(search, "RR_GB_EQ");
    expect(sym).toBe("RR.L");
  });


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
