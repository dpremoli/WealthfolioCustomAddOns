// Small UI-only formatting helpers specific to Trading 212. No SDK or React deps so
// they are cheap to import from any component and trivially unit-testable.
// (Generic helpers like relativeTime / maskKey live in @wf-addons/kit.)

/** Friendly exchange label for a MIC. Falls back to the raw MIC. */
const MIC_NAMES: Record<string, string> = {
  XNAS: "NASDAQ", XNYS: "NYSE", ARCX: "NYSE Arca", BATS: "Cboe BZX", XASE: "NYSE American",
  OTCM: "OTC", IEXG: "IEX", XLON: "LSE", XTSE: "TSX", XTSX: "TSXV", XMEX: "BMV",
  XJPX: "JPX", XTKS: "TSE", XETR: "Xetra", XFRA: "Frankfurt", XBER: "Berlin",
  XDUS: "Düsseldorf", XHAM: "Hamburg", XMUN: "Munich", XSTU: "Stuttgart",
  XPAR: "Euronext Paris", XAMS: "Euronext Amsterdam", XMIL: "Borsa Italiana",
  XMAD: "BME", XDUB: "Euronext Dublin", XSWX: "SIX", XCSE: "Nasdaq Copenhagen",
  XSTO: "Nasdaq Stockholm", XOSL: "Oslo Børs", XWAR: "Warsaw", XASX: "ASX",
  XHKG: "HKEX", XSES: "SGX", XBRU: "Euronext Brussels", XWBO: "Vienna",
  XHEL: "Nasdaq Helsinki", XLIS: "Euronext Lisbon", XLUX: "Luxembourg",
  CXE: "Cboe Europe (CXE)", DXE: "Cboe Europe (DXE)", BXE: "Cboe Europe (BXE)",
};
export function exchangeLabel(mic?: string | null): string | undefined {
  if (!mic) return undefined;
  return MIC_NAMES[mic.toUpperCase()] ?? mic;
}

/** Parsed symbol-map entry: `"AAPL"` / `"AAPL|XNAS"` / `""` (known miss). */
export interface SymbolMapEntry {
  ticker: string;
  symbol: string | null; // null = known unresolved
  exchangeMic?: string;
}
export function parseSymbolMap(map: Record<string, string>): SymbolMapEntry[] {
  return Object.entries(map).map(([ticker, value]) => {
    if (!value) return { ticker, symbol: null };
    const pipe = value.indexOf("|");
    if (pipe < 0) return { ticker, symbol: value };
    return { ticker, symbol: value.slice(0, pipe), exchangeMic: value.slice(pipe + 1) || undefined };
  });
}

/**
 * Masked API key ID for display ("••••XXXX"). Only the last 4 characters of the key ID
 * are kept (the key itself is never stored in add-on state), so this takes that suffix.
 */
export function maskedKeyId(last4?: string | null): string {
  return last4 ? `••••${last4}` : "••••";
}
