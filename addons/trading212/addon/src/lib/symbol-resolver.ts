import type { SymbolSearchResult } from "@wealthfolio/addon-sdk";

export type SearchFn = (query: string) => Promise<SymbolSearchResult[]>;

/** Hints from the Trading 212 instrument used to disambiguate cross-listings. */
export interface SymbolHints {
  isin?: string;
  name?: string;
  /** Instrument currency (ISO 4217). Used to filter out wrong-currency cross-listings. */
  currency?: string;
}

/** Trading 212 tickers look like `AAPL_US_EQ` — the base symbol is the first segment. */
export function parseBaseSymbol(ticker: string): string {
  return ticker.split("_")[0] || ticker;
}

// Trading 212 tickers encode the listing market in the second segment
// (TSM_US_EQ, RR_GB_EQ, BMO_CA_EQ). This maps that code to the market's trading
// currency, used as a disambiguation fallback when the instrument doesn't carry
// its own currency. Only well-known single-currency markets are listed; an
// unmapped segment yields no hint (so nothing is filtered).
const MARKET_CURRENCY: Record<string, string> = {
  US: "USD", GB: "GBP", CA: "CAD", MX: "MXN", JP: "JPY",
  DE: "EUR", FR: "EUR", NL: "EUR", IT: "EUR", ES: "EUR", IE: "EUR",
  BE: "EUR", AT: "EUR", FI: "EUR", PT: "EUR", LU: "EUR",
  CH: "CHF", DK: "DKK", SE: "SEK", NO: "NOK", PL: "PLN",
  AU: "AUD", HK: "HKD", SG: "SGD",
};

/** Currency implied by the T212 ticker's market segment, or undefined if unknown. */
export function marketCurrency(ticker: string): string | undefined {
  const seg = ticker.split("_")[1];
  return seg ? MARKET_CURRENCY[seg.toUpperCase()] : undefined;
}

/**
 * Normalises a currency code for comparison. London listings quote in pence
 * (GBX / GBp) while the instrument currency is pounds (GBP) — treat them as one
 * so a GBP instrument still matches a GBp-quoted search hit.
 */
export function normalizeCurrency(c?: string): string | undefined {
  if (!c) return undefined;
  const u = c.toUpperCase();
  return u === "GBX" ? "GBP" : u;
}

// ISIN format: 2 letters + 9 alphanumerics + 1 check digit.
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

/** True when `symbol` looks like an ISIN — not a real Yahoo-style ticker. */
export function isIsinLike(symbol: string): boolean {
  return ISIN_RE.test(symbol);
}

/**
 * Picks the best search hit. Two filters run before scoring:
 *  1. Currency match. If the caller knows the instrument currency and at least
 *     one hit matches, ignore all other-currency hits — this stops a NYSE ADR
 *     (`TSM`, USD) being silently replaced by a cross-listing on another
 *     exchange (`TSMN.MX`, MXN) just because the latter scored higher.
 *  2. ISIN-shaped symbols are dropped. Real tickers never look like an ISIN; an
 *     ISIN coming back as a `symbol` is an artefact of a prior bad import
 *     (Wealthfolio stored the asset under its ISIN, then `isExisting:true`
 *     boosts that record above the genuine ticker — e.g. GOOGL replaced with
 *     `US02079K3059`). If every surviving candidate is ISIN-shaped, treat as
 *     unresolved so the position is flagged rather than silently mis-imported.
 * Within the surviving candidates, prefer one that already exists in Wealthfolio,
 * then the highest search score.
 */
export function pickBestSymbol(
  results: SymbolSearchResult[],
  hints?: { currency?: string },
): string | null {
  if (!results || results.length === 0) return null;

  const wantCurrency = normalizeCurrency(hints?.currency);
  let candidates = results;
  if (wantCurrency) {
    const matches = results.filter((r) => normalizeCurrency(r.currency) === wantCurrency);
    if (matches.length > 0) candidates = matches;
  }

  candidates = candidates.filter((r) => r.symbol && !isIsinLike(r.symbol));
  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => {
    if (!!b.isExisting !== !!a.isExisting) return b.isExisting ? 1 : -1;
    return (b.score ?? 0) - (a.score ?? 0);
  });
  return sorted[0]?.symbol ?? null;
}

/**
 * Resolves a Trading 212 ticker to a Wealthfolio (Yahoo-style) symbol using
 * Wealthfolio's own market-data search. Tries ISIN, then the base ticker, then
 * the instrument name. When the instrument carries a currency, results in any
 * other currency are filtered out (see `pickBestSymbol`).
 */
export async function resolveTickerSymbol(
  search: SearchFn,
  ticker: string,
  instrument?: SymbolHints,
): Promise<string | null> {
  const queries = [instrument?.isin, parseBaseSymbol(ticker), instrument?.name].filter(
    (q): q is string => !!q,
  );
  // Prefer the instrument's own currency; fall back to the one implied by the
  // T212 ticker's market segment when the instrument doesn't carry one.
  const hints = { currency: instrument?.currency ?? marketCurrency(ticker) };
  for (const q of queries) {
    const best = pickBestSymbol(await search(q), hints);
    if (best) return best;
  }
  return null;
}

/**
 * Caches ticker -> symbol resolutions across a sync (and persists between syncs).
 * An empty-string entry records a known-unresolved ticker so we don't re-query it.
 */
export class SymbolResolver {
  private dirty = false;

  constructor(
    private readonly search: SearchFn,
    private readonly cache: Record<string, string> = {},
  ) {}

  async resolve(
    ticker: string,
    instrument?: SymbolHints,
  ): Promise<string | null> {
    if (Object.prototype.hasOwnProperty.call(this.cache, ticker)) {
      return this.cache[ticker] || null;
    }
    const symbol = await resolveTickerSymbol(this.search, ticker, instrument);
    this.cache[ticker] = symbol ?? "";
    this.dirty = true;
    return symbol;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  snapshot(): Record<string, string> {
    return this.cache;
  }
}
