// Small UI-only formatting helpers. No SDK or React deps so they're cheap to import
// from any component and trivially unit-testable.

/** "2h ago" / "3 days ago" / "just now". Falls back to absolute on bad input. */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "Never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "Never";
  const diffMs = now.getTime() - t;
  if (diffMs < 0) return new Date(iso).toLocaleString();
  const s = Math.floor(diffMs / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

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

/** Masked API key for display: "••••XXXX". */
export function maskKey(key: string): string {
  return key.length <= 4 ? "••••" : `••••${key.slice(-4)}`;
}
