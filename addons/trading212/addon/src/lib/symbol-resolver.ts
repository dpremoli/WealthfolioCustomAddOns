import type { SymbolSearchResult } from "@wealthfolio/addon-sdk";

export type SearchFn = (query: string) => Promise<SymbolSearchResult[]>;

/** Hints from the Trading 212 instrument used to disambiguate cross-listings. */
export interface SymbolHints {
  isin?: string;
  name?: string;
  /** Instrument currency (ISO 4217). Used to filter out wrong-currency cross-listings. */
  currency?: string;
}

/** Resolved symbol + exchange MIC (when the search hit carried one). */
export interface Resolution {
  symbol: string;
  exchangeMic?: string;
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

// Trading 212 market segment → expected exchange MIC(s). Used to prefer the
// listing on the right exchange when the search returns ticker collisions —
// e.g. RR_GB_EQ should resolve to RR.L (XLON, Rolls-Royce), not RR (XNAS,
// Richtech Robotics). When at least one candidate matches, only those are kept;
// otherwise the MIC filter is skipped (so unmapped markets aren't punished).
const MARKET_MICS: Record<string, string[]> = {
  US: ["XNAS", "XNYS", "ARCX", "BATS", "XASE", "OTCM", "IEXG"],
  GB: ["XLON"],
  CA: ["XTSE", "XTSX"],
  MX: ["XMEX"],
  JP: ["XJPX", "XTKS"],
  DE: ["XETR", "XFRA", "XBER", "XDUS", "XHAM", "XMUN", "XSTU"],
  FR: ["XPAR"],
  NL: ["XAMS"],
  IT: ["XMIL"],
  ES: ["XMAD"],
  IE: ["XDUB"],
  CH: ["XSWX"],
  DK: ["XCSE"],
  SE: ["XSTO"],
  NO: ["XOSL"],
  PL: ["XWAR"],
  AU: ["XASX"],
  HK: ["XHKG"],
  SG: ["XSES"],
  BE: ["XBRU"],
  AT: ["XWBO"],
  FI: ["XHEL"],
  PT: ["XLIS"],
  LU: ["XLUX"],
};

/** Currency implied by the T212 ticker's market segment, or undefined if unknown. */
export function marketCurrency(ticker: string): string | undefined {
  const seg = ticker.split("_")[1];
  return seg ? MARKET_CURRENCY[seg.toUpperCase()] : undefined;
}

/** Expected exchange MIC(s) for the T212 ticker's market segment, or undefined. */
export function marketMics(ticker: string): string[] | undefined {
  const seg = ticker.split("_")[1];
  return seg ? MARKET_MICS[seg.toUpperCase()] : undefined;
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

/**
 * True when `symbol` is (or starts with) an ISIN — not a real Yahoo-style ticker.
 * Matches the leading 12 chars uppercased so both bare ISINs (`IE00BFMXXD54`)
 * and Yahoo-suffixed variants (`IE00BFMXXD54.SG`) are caught.
 */
export function isIsinLike(symbol: string): boolean {
  if (!symbol) return false;
  const head = symbol.trim().toUpperCase().slice(0, 12);
  return ISIN_RE.test(head);
}

/**
 * Picks the best search hit. Filters run in order before scoring:
 *  1. Currency match. If the caller knows the instrument currency and at least
 *     one hit matches, ignore all other-currency hits — this stops a NYSE ADR
 *     (`TSM`, USD) being silently replaced by a cross-listing on another
 *     exchange (`TSMN.MX`, MXN) just because the latter scored higher.
 *  2. Exchange MIC match. When the T212 ticker tells us the market (e.g.
 *     `RR_GB_EQ` → XLON), prefer candidates listed on that exchange — this
 *     stops `RR` (Richtech, XNAS) winning over `RR.L` (Rolls-Royce, XLON).
 *  3. ISIN-shaped symbols are dropped. Real tickers never look like an ISIN; an
 *     ISIN coming back as a `symbol` is an artefact of a prior bad import
 *     (Wealthfolio stored the asset under its ISIN, then `isExisting:true`
 *     boosts that record above the genuine ticker — e.g. GOOGL replaced with
 *     `US02079K3059`). If every surviving candidate is ISIN-shaped, treat as
 *     unresolved so the position is flagged rather than silently mis-imported.
 *  4. Base-ticker exact match. Within the survivors, prefer one whose symbol
 *     equals the base ticker (or `baseTicker.SUFFIX`) — deterministic tiebreaker
 *     for ticker collisions on the same exchange (e.g. TSM beats TSMN at XNYS).
 * Final ranking: prefer one that already exists in Wealthfolio, then score.
 */
export function pickBest(
  results: SymbolSearchResult[],
  hints?: { currency?: string; expectedMics?: string[]; baseTicker?: string },
): SymbolSearchResult | null {
  if (!results || results.length === 0) return null;

  let candidates = results;

  const wantCurrency = normalizeCurrency(hints?.currency);
  if (wantCurrency) {
    const matches = candidates.filter((r) => normalizeCurrency(r.currency) === wantCurrency);
    if (matches.length > 0) candidates = matches;
  }

  if (hints?.expectedMics && hints.expectedMics.length > 0) {
    const wanted = new Set(hints.expectedMics);
    const matches = candidates.filter((r) => r.exchangeMic && wanted.has(r.exchangeMic));
    if (matches.length > 0) candidates = matches;
  }

  candidates = candidates.filter((r) => r.symbol && !isIsinLike(r.symbol));
  if (candidates.length === 0) return null;

  if (hints?.baseTicker) {
    const base = hints.baseTicker.toUpperCase();
    const exact = candidates.filter((r) => {
      const s = r.symbol.toUpperCase();
      return s === base || s.startsWith(base + ".");
    });
    if (exact.length > 0) candidates = exact;
  }

  const sorted = [...candidates].sort((a, b) => {
    if (!!b.isExisting !== !!a.isExisting) return b.isExisting ? 1 : -1;
    return (b.score ?? 0) - (a.score ?? 0);
  });
  return sorted[0] ?? null;
}

/** Convenience: just the symbol string (or null). */
export function pickBestSymbol(
  results: SymbolSearchResult[],
  hints?: { currency?: string; expectedMics?: string[]; baseTicker?: string },
): string | null {
  return pickBest(results, hints)?.symbol ?? null;
}

/** Hints passed to `pickBest` / `isConfident`. */
type Hints = { currency?: string; expectedMics?: string[]; baseTicker?: string };

/** Diagnostic record emitted per live resolution (cache miss) for sync logging. */
export interface ResolveDiag {
  ticker: string;
  chosen: Resolution | null;
  candidates: SymbolSearchResult[];
}
export type DiagFn = (d: ResolveDiag) => void;

/**
 * True when `r` is a confident enough match to stop querying early: its symbol
 * IS the base ticker (or `baseTicker.SUFFIX`) and nothing about it contradicts
 * the expected currency / exchange. Anything weaker — a wrong-currency cross-
 * listing (`BMO.TO`/CAD for a `_US_EQ` ticker), a same-name different company —
 * keeps the search going so a later query can surface the right listing before
 * we commit. Without this, a wrong first hit would be accepted prematurely.
 */
function isConfident(r: SymbolSearchResult, hints: Hints): boolean {
  const base = hints.baseTicker?.toUpperCase();
  if (!base || !r.symbol) return false;
  const s = r.symbol.toUpperCase();
  if (s !== base && !s.startsWith(base + ".")) return false;
  const wantCcy = normalizeCurrency(hints.currency);
  const haveCcy = normalizeCurrency(r.currency);
  if (wantCcy && haveCcy && wantCcy !== haveCcy) return false;
  if (hints.expectedMics?.length && r.exchangeMic && !hints.expectedMics.includes(r.exchangeMic))
    return false;
  return true;
}

/**
 * Resolves a Trading 212 ticker to a Wealthfolio symbol + (when known) exchange
 * MIC using Wealthfolio's own market-data search. Queries by ISIN, base ticker,
 * then instrument name, *accumulating* the candidates from every query into one
 * pool before picking — so a wrong-listing hit from the ISIN query (the MXN-
 * quoted TSMN, BioNTech's Hamburg 22UA, a Canadian bank's TSX listing) can't win
 * just because it came back first. The search short-circuits as soon as a query
 * yields a confident match (right base ticker, no currency/MIC contradiction);
 * otherwise it pools all queries and lets the currency + MIC filters choose. The
 * instrument's currency and the T212 ticker's market segment steer the pick.
 * `onDiag`, when supplied, receives the candidate pool + chosen result.
 */
export async function resolveTicker(
  search: SearchFn,
  ticker: string,
  instrument?: SymbolHints,
  onDiag?: DiagFn,
): Promise<Resolution | null> {
  const queries = [instrument?.isin, parseBaseSymbol(ticker), instrument?.name].filter(
    (q): q is string => !!q,
  );
  const hints: Hints = {
    currency: instrument?.currency ?? marketCurrency(ticker),
    expectedMics: marketMics(ticker),
    baseTicker: parseBaseSymbol(ticker),
  };

  const seen = new Set<string>();
  const pool: SymbolSearchResult[] = [];
  let chosen: Resolution | null = null;

  for (const q of queries) {
    for (const r of await search(q)) {
      const key = `${(r.symbol ?? "").toUpperCase()}|${r.exchangeMic ?? ""}`;
      if (r.symbol && !seen.has(key)) {
        seen.add(key);
        pool.push(r);
      }
    }
    const best = pickBest(pool, hints);
    if (best && isConfident(best, hints)) {
      chosen = { symbol: best.symbol, exchangeMic: best.exchangeMic };
      break;
    }
  }

  if (!chosen) {
    const best = pickBest(pool, hints);
    chosen = best?.symbol ? { symbol: best.symbol, exchangeMic: best.exchangeMic } : null;
  }

  onDiag?.({ ticker, chosen, candidates: pool });
  return chosen;
}

/** Back-compat wrapper returning just the symbol. */
export async function resolveTickerSymbol(
  search: SearchFn,
  ticker: string,
  instrument?: SymbolHints,
): Promise<string | null> {
  return (await resolveTicker(search, ticker, instrument))?.symbol ?? null;
}

/**
 * Caches ticker → resolution across a sync (and persists between syncs).
 *
 * Persisted as a flat `Record<string,string>` so the blob stays human-inspectable.
 * Per-ticker value encoding:
 *  - `""`           : known-unresolved (don't re-query)
 *  - `"SYMBOL"`     : resolved to a bare symbol, exchange MIC unknown
 *  - `"SYMBOL|MIC"` : resolved to a symbol on a specific exchange MIC
 */
export class SymbolResolver {
  private dirty = false;

  constructor(
    private readonly search: SearchFn,
    private readonly cache: Record<string, string> = {},
  ) {}

  /**
   * Returns `{ symbol, exchangeMic? }` so the caller can record the MIC too.
   * `onDiag` (only fired on a cache miss, i.e. a real query) lets the caller log
   * the raw search candidates — useful for verifying cross-listing resolution.
   */
  async resolveDetailed(
    ticker: string,
    instrument?: SymbolHints,
    onDiag?: DiagFn,
  ): Promise<Resolution | null> {
    if (Object.prototype.hasOwnProperty.call(this.cache, ticker)) {
      return parseCacheValue(this.cache[ticker]);
    }
    const resolved = await resolveTicker(this.search, ticker, instrument, onDiag);
    this.cache[ticker] = formatCacheValue(resolved);
    this.dirty = true;
    return resolved;
  }

  /** Just the symbol (back-compat for activity-import callers). */
  async resolve(ticker: string, instrument?: SymbolHints): Promise<string | null> {
    return (await this.resolveDetailed(ticker, instrument))?.symbol ?? null;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  snapshot(): Record<string, string> {
    return this.cache;
  }
}

function formatCacheValue(r: Resolution | null): string {
  if (!r?.symbol) return "";
  return r.exchangeMic ? `${r.symbol}|${r.exchangeMic}` : r.symbol;
}

function parseCacheValue(v: string): Resolution | null {
  if (!v) return null;
  const pipe = v.indexOf("|");
  if (pipe < 0) return { symbol: v };
  return { symbol: v.slice(0, pipe), exchangeMic: v.slice(pipe + 1) || undefined };
}
