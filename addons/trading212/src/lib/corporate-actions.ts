import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { cashSymbol, majorCurrency, round2 } from "@wf-addons/kit";
import { col, parseAmount, toIsoDate } from "./csv";
import type { ImportUnit } from "./importer";
import { importAssetFields, type Resolution } from "./symbol-resolver";

type Row = Record<string, string>;
type ActivityType = ActivityImport["activityType"];

const SPLIT_ACTION = /^stock split (open|close)$/i;

/**
 * Sets apart the export rows that describe one event across several rows: "Stock split close" +
 * "Stock split open" (the old shares come out, the new ones go in) and "Currency conversion".
 */
export function splitCorporateRows(rows: Row[]): { rest: Row[]; splitRows: Row[]; conversionRows: Row[] } {
  const rest: Row[] = [];
  const splitRows: Row[] = [];
  const conversionRows: Row[] = [];
  for (const row of rows) {
    const action = (row["Action"] ?? "").trim();
    if (SPLIT_ACTION.test(action)) splitRows.push(row);
    else if (action.toLowerCase() === "currency conversion") conversionRows.push(row);
    else rest.push(row);
  }
  return { rest, splitRows, conversionRows };
}

/**
 * A split ratio as Wealthfolio wants it (new shares per old share). Trading 212 gives the share
 * counts before and after to a fixed number of decimals, so the quotient is snapped to a whole
 * ratio (4, 15) or its reciprocal (1/15) when it is within that rounding of one, else rounded to
 * 8 decimals (0.96). `tolerance` is the relative rounding error of the quotient: tiny holdings
 * (0.00001495 shares) carry a much larger one than ordinary ones.
 */
export function snapRatio(ratio: number, tolerance = 1e-6): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return ratio;
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(tolerance, 1e-6) * Math.max(a, b);
  const whole = Math.round(ratio);
  if (whole >= 2 && near(ratio, whole)) return whole;
  const inverse = Math.round(1 / ratio);
  if (inverse >= 2 && near(1 / ratio, inverse)) return Number((1 / inverse).toFixed(10));
  // Else the shortest decimal (0.96, 1.5) within the rounding, so 0.95999999 reads as 0.96.
  for (let decimals = 0; decimals <= 6; decimals++) {
    const rounded = Number(ratio.toFixed(decimals));
    if (rounded > 0 && near(ratio, rounded)) return rounded;
  }
  return Number(ratio.toFixed(8));
}

export interface StockSplit {
  id: string;
  ticker: string;
  isin?: string;
  name?: string;
  /** ISO timestamp of the split rows. */
  time: string;
  closeShares: number;
  openShares: number;
  ratio: number;
  /** The instrument's currency (Currency (Price / share)). */
  currency: string;
}

const PAIR_WINDOW_MS = 10 * 60 * 1000;

/**
 * Pairs each "Stock split close" with the "Stock split open" of the same instrument at the same
 * time (a few minutes apart at most) into one split: ratio = shares after ÷ shares before. A close
 * and an open whose ticker or ISIN differ are a swap into another security, not a split, and a
 * row with no partner has nothing to compute a ratio from; both come back as `unpaired`.
 */
export function pairStockSplits(rows: Row[]): { splits: StockSplit[]; unpaired: Row[] } {
  const info = (row: Row) => {
    const ticker = row["Ticker"]?.trim() ?? "";
    const isin = row["ISIN"]?.trim() || undefined;
    return {
      row,
      ticker,
      isin,
      key: isin ?? ticker,
      side: /open$/i.test(row["Action"] ?? "") ? ("open" as const) : ("close" as const),
      time: toIsoDate(col(row, "Time", "Time (UTC)")),
      shares: parseAmount(row["No. of shares"]),
    };
  };
  const all = rows.map(info).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const used = new Set<unknown>();
  const splits: StockSplit[] = [];
  for (const close of all.filter((r) => r.side === "close")) {
    const open = all.find(
      (o) =>
        o.side === "open" &&
        !used.has(o) &&
        o.key === close.key &&
        o.ticker === close.ticker &&
        Math.abs(Date.parse(o.time) - Date.parse(close.time)) <= PAIR_WINDOW_MS,
    );
    if (!open || close.shares <= 0 || open.shares <= 0 || Number.isNaN(Date.parse(close.time))) continue;
    used.add(open).add(close);
    splits.push({
      id: `t212-split-${close.key}-${close.time.replace(/\D/g, "").slice(0, 12)}`,
      ticker: close.ticker,
      isin: close.isin,
      name: close.row["Name"]?.trim() || undefined,
      time: close.time,
      closeShares: close.shares,
      openShares: open.shares,
      ratio: snapRatio(
        open.shares / close.shares,
        roundingError(open.row["No. of shares"], open.shares) + roundingError(close.row["No. of shares"], close.shares),
      ),
      currency: col(close.row, "Currency (Price / share)") || col(close.row, "Currency (Total)") || "GBP",
    });
  }
  return { splits, unpaired: all.filter((r) => !used.has(r)).map((r) => r.row) };
}

/** Half a unit in the last decimal place of a share count, relative to the count itself. */
function roundingError(text: string | undefined, value: number): number {
  const decimals = (text ?? "").split(".")[1]?.trim().length ?? 0;
  return value > 0 ? (0.5 * 10 ** -decimals) / value : 0;
}

/**
 * The `SPLIT` activity for a pair. Wealthfolio multiplies the lots bought before that day by
 * `amount`. A London listing quotes in pence (GBX), and Wealthfolio divides the `amount` of a GBX
 * row by 100, ratio or not (Reckitt's consolidation landed as a hundredth of the shares), so the
 * row goes in pounds.
 */
export function mapStockSplit(split: StockSplit, accountId: string, resolved: Resolution): ActivityImport {
  return {
    id: split.id,
    accountId,
    activityType: "SPLIT" as ActivityType,
    date: split.time,
    ...importAssetFields(resolved),
    amount: split.ratio,
    currency: majorCurrency(split.currency),
    isValid: true,
    isDraft: false,
    comment: `Stock split: ${split.closeShares} → ${split.openShares} shares`,
  };
}

/** "10000.00 EUR -> 8665.30 GBP" in the Notes of a currency conversion. */
const CONVERSION_NOTE = /([\d,]+(?:\.\d+)?)\s*([A-Z]{3})\s*->\s*([\d,]+(?:\.\d+)?)\s*([A-Z]{3})/;

/** The comment Wealthfolio recognises as a currency exchange, which lets it link the two legs. */
export const FX_COMMENT = "Currency exchange";

/**
 * A "Currency conversion" row is cash changing currency inside the account: the first currency
 * goes out, the second comes in (both from the Notes), and the Total is the fee, charged in the
 * currency it was converted to. The two legs go in as one unit marked internal, which Wealthfolio
 * links as a same-account exchange (it is neither a contribution nor a withdrawal); the fee is a
 * separate row. Returns no units, with the reason, when the Notes don't give the amounts.
 */
export function mapCurrencyConversion(row: Row, accountId: string): { units: ImportUnit[]; problem?: string } {
  const notes = row["Notes"] ?? "";
  const m = CONVERSION_NOTE.exec(notes);
  if (!m) return { units: [], problem: `no amounts in its Notes ("${notes}")` };
  const [, fromRaw, from, toRaw, to] = m;
  const time = col(row, "Time", "Time (UTC)");
  if (!time) return { units: [], problem: "no time" };
  const date = toIsoDate(time);
  const fromAmount = round2(parseAmount(fromRaw));
  const toAmount = round2(parseAmount(toRaw));
  if (from === to || fromAmount <= 0 || toAmount <= 0) return { units: [], problem: `unusable amounts ("${notes}")` };
  const base = `t212-fx-${row["ID"]?.trim() || `${date.replace(/\D/g, "")}-${fromRaw}-${from}`}`;
  const leg = (id: string, activityType: string, currency: string, amount: number): ActivityImport => ({
    id,
    accountId,
    activityType: activityType as ActivityType,
    date,
    symbol: cashSymbol(currency),
    amount,
    currency,
    isExternal: false,
    isValid: true,
    isDraft: false,
    comment: FX_COMMENT,
  });
  const units: ImportUnit[] = [[leg(`${base}-out`, "TRANSFER_OUT", from, fromAmount), leg(`${base}-in`, "TRANSFER_IN", to, toAmount)]];
  const fee = Math.abs(parseAmount(col(row, "Total", "Result")));
  if (fee > 0) {
    const currency = col(row, "Currency (Total)", "Currency (Currency conversion fee)") || to;
    units.push([
      {
        id: `${base}-fee`,
        accountId,
        activityType: "FEE" as ActivityType,
        date,
        symbol: cashSymbol(currency),
        amount: round2(fee),
        currency,
        isValid: true,
        isDraft: false,
        comment: "Currency conversion fee",
      },
    ]);
  }
  return { units };
}

/** A row's identity for log lines. */
export function describeRow(row: Row): string {
  const t = col(row, "Time", "Time (UTC)");
  const who = row["Ticker"]?.trim() || row["ISIN"]?.trim() || "";
  return `${row["Action"] ?? "?"} ${t}${who ? ` ${who}` : ""}${row["No. of shares"] ? ` (${row["No. of shares"]} shares)` : ""}`;
}
