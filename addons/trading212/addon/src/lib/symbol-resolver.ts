import type { SymbolSearchResult } from "@wealthfolio/addon-sdk";

export type SearchFn = (query: string) => Promise<SymbolSearchResult[]>;

/** Trading 212 tickers look like `AAPL_US_EQ` — the base symbol is the first segment. */
export function parseBaseSymbol(ticker: string): string {
  return ticker.split("_")[0] || ticker;
}

/** Prefers a symbol that already exists in Wealthfolio, then the highest search score. */
export function pickBestSymbol(results: SymbolSearchResult[]): string | null {
  if (!results || results.length === 0) return null;
  const sorted = [...results].sort((a, b) => {
    if (!!b.isExisting !== !!a.isExisting) return b.isExisting ? 1 : -1;
    return (b.score ?? 0) - (a.score ?? 0);
  });
  return sorted[0]?.symbol ?? null;
}

/**
 * Resolves a Trading 212 ticker to a Wealthfolio (Yahoo-style) symbol using
 * Wealthfolio's own market-data search. Tries ISIN, then the base ticker, then
 * the instrument name.
 */
export async function resolveTickerSymbol(
  search: SearchFn,
  ticker: string,
  instrument?: { isin?: string; name?: string },
): Promise<string | null> {
  const queries = [instrument?.isin, parseBaseSymbol(ticker), instrument?.name].filter(
    (q): q is string => !!q,
  );
  for (const q of queries) {
    const best = pickBestSymbol(await search(q));
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
    instrument?: { isin?: string; name?: string },
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
