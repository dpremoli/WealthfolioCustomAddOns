import { describe, it, expect, vi } from "vitest";
import type { SymbolSearchResult } from "@wealthfolio/addon-sdk";
import {
  SymbolResolver,
  isIsinLike,
  marketCurrency,
  marketMics,
  normalizeCurrency,
  parseBaseSymbol,
  pickBestSymbol,
  resolveTicker,
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

  it("filters by expected exchange MIC when the market segment is known", () => {
    // RR is shared by Richtech (XNAS, USD) and Rolls-Royce (XLON, GBp). The
    // GB market segment narrows the choice to the XLON listing even though
    // Richtech's currency could match a missing-currency hint.
    const best = pickBestSymbol(
      [
        result({ symbol: "RR", score: 9, currency: "USD", exchangeMic: "XNAS" }),
        result({ symbol: "RR.L", score: 4, currency: "GBp", exchangeMic: "XLON" }),
      ],
      { expectedMics: ["XLON"] },
    );
    expect(best).toBe("RR.L");
  });

  it("falls back when no candidate matches the expected MIC", () => {
    // If Wealthfolio simply hasn't indexed an XLON listing, don't drop everything.
    const best = pickBestSymbol(
      [
        result({ symbol: "RR", score: 9, currency: "USD", exchangeMic: "XNAS" }),
      ],
      { expectedMics: ["XLON"] },
    );
    expect(best).toBe("RR");
  });

  it("prefers an exact base-ticker match within survivors (TSM beats TSMN)", () => {
    // Both are USD-listed on NYSE/NASDAQ — currency and MIC filters pass both.
    // The base-ticker tiebreaker picks the symbol that equals the T212 ticker.
    const best = pickBestSymbol(
      [
        result({ symbol: "TSMN", score: 9, currency: "USD", exchangeMic: "XNAS" }),
        result({ symbol: "TSM", score: 5, currency: "USD", exchangeMic: "XNYS" }),
      ],
      { currency: "USD", expectedMics: ["XNAS", "XNYS"], baseTicker: "TSM" },
    );
    expect(best).toBe("TSM");
  });

  it("allows baseTicker.SUFFIX as an exact match (RR.L for base RR)", () => {
    const best = pickBestSymbol(
      [
        result({ symbol: "RR.L", score: 4, currency: "GBp", exchangeMic: "XLON" }),
        result({ symbol: "RRX", score: 9, currency: "GBP" }),
      ],
      { baseTicker: "RR" },
    );
    expect(best).toBe("RR.L");
  });
});

describe("isIsinLike", () => {
  it("matches a bare 12-char ISIN", () => {
    expect(isIsinLike("US0378331005")).toBe(true);
    expect(isIsinLike("IE00BFMXXD54")).toBe(true);
  });

  it("matches a Yahoo-suffixed ISIN like IE00BFMXXD54.SG", () => {
    // Yahoo Finance sometimes indexes a German listing's symbol as
    // `<ISIN>.<suffix>`. The strict 12-char regex would miss it.
    expect(isIsinLike("IE00BFMXXD54.SG")).toBe(true);
    expect(isIsinLike("US0378331005.DU")).toBe(true);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(isIsinLike(" ie00bfmxxd54 ")).toBe(true);
  });

  it("does not match real tickers", () => {
    expect(isIsinLike("AAPL")).toBe(false);
    expect(isIsinLike("RR.L")).toBe(false);
    expect(isIsinLike("VUAA.MI")).toBe(false);
    expect(isIsinLike("")).toBe(false);
  });
});

describe("marketMics", () => {
  it("maps the T212 ticker market segment to expected exchange MICs", () => {
    expect(marketMics("TSM_US_EQ")).toContain("XNYS");
    expect(marketMics("RR_GB_EQ")).toEqual(["XLON"]);
    expect(marketMics("SAP_DE_EQ")).toContain("XETR");
    expect(marketMics("VUAA_IT_EQ")).toEqual(["XMIL"]);
  });

  it("returns undefined for unknown or missing segments", () => {
    expect(marketMics("VUAA")).toBeUndefined();
    expect(marketMics("FOO_ZZ_EQ")).toBeUndefined();
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

describe("resolveTicker (detailed)", () => {
  it("returns the symbol and the resolved exchange MIC", async () => {
    const search = vi.fn(async () => [
      result({ symbol: "RR.L", score: 4, currency: "GBp", exchangeMic: "XLON" }),
      result({ symbol: "RR", score: 9, currency: "USD", exchangeMic: "XNAS" }),
    ]);
    const r = await resolveTicker(search, "RR_GB_EQ");
    expect(r).toEqual({ symbol: "RR.L", exchangeMic: "XLON" });
  });

  it("returns the symbol without a MIC when the search hit omits one", async () => {
    const search = vi.fn(async () => [result({ symbol: "AAPL", score: 9, currency: "USD" })]);
    const r = await resolveTicker(search, "AAPL_US_EQ");
    expect(r).toEqual({ symbol: "AAPL" });
  });

  it("drops VUAA's ISIN-shaped hit (including Yahoo-suffixed variant)", async () => {
    // The German listing of VUAA is indexed by Yahoo as `IE00BFMXXD54.SG`.
    // The strict 12-char ISIN regex would miss the suffix, so the resolver
    // would have picked it. The slice-12 ISIN check catches it.
    const search = vi.fn(async (q: string) =>
      q === "VUAA"
        ? [
            result({ symbol: "IE00BFMXXD54.SG", score: 9, currency: "EUR", exchangeMic: "XSTU", isExisting: true }),
            result({ symbol: "VUAA.MI", score: 4, currency: "EUR", exchangeMic: "XMIL" }),
          ]
        : [],
    );
    const r = await resolveTicker(search, "VUAA", { currency: "EUR" });
    expect(r?.symbol).toBe("VUAA.MI");
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

  it("persists the resolved exchange MIC in the cache (SYMBOL|MIC encoding)", async () => {
    const search = vi.fn(async () => [
      result({ symbol: "RR.L", score: 4, currency: "GBp", exchangeMic: "XLON" }),
    ]);
    const r = new SymbolResolver(search);
    expect(await r.resolveDetailed("RR_GB_EQ")).toEqual({ symbol: "RR.L", exchangeMic: "XLON" });
    expect(r.snapshot()["RR_GB_EQ"]).toBe("RR.L|XLON");
  });

  it("reads SYMBOL|MIC encoded cache entries back into the detailed shape", async () => {
    const search = vi.fn(async () => []);
    const r = new SymbolResolver(search, { RR_GB_EQ: "RR.L|XLON", AAPL_US_EQ: "AAPL" });
    expect(await r.resolveDetailed("RR_GB_EQ")).toEqual({ symbol: "RR.L", exchangeMic: "XLON" });
    // A pre-v1.7.2 entry (just the symbol) still decodes — MIC is undefined.
    expect(await r.resolveDetailed("AAPL_US_EQ")).toEqual({ symbol: "AAPL" });
    expect(search).not.toHaveBeenCalled();
  });
});
