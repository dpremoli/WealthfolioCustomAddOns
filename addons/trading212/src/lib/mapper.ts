import type { ActivityImport, SnapshotHoldingInput } from "@wealthfolio/addon-sdk";
import { cashSymbol, round2 } from "@wf-addons/kit";
import type { DividendItem, HistoricalOrder, Position, TransactionItem } from "../types";

type ActivityType = ActivityImport["activityType"];
const BUY = "BUY" as ActivityType;
const SELL = "SELL" as ActivityType;
const DIVIDEND = "DIVIDEND" as ActivityType;
const INTEREST = "INTEREST" as ActivityType;
const DEPOSIT = "DEPOSIT" as ActivityType;
const WITHDRAWAL = "WITHDRAWAL" as ActivityType;
const FEE = "FEE" as ActivityType;
const TRANSFER_IN = "TRANSFER_IN" as ActivityType;
const TRANSFER_OUT = "TRANSFER_OUT" as ActivityType;

/** Rounds to `dp` decimal places (fee conversions need more than cents to avoid drift). */
function roundTo(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/**
 * Wealthfolio's `fx_rate` is account-currency units per ONE activity-currency unit (it
 * settles BUY/SELL cash in the account currency as `amount × fx_rate`). Trading 212 reports
 * its exchange rate between the instrument and account currencies, and the two exports we
 * have seen disagree on which way round it points, so we do not trust the direction: given
 * the trade's rough implied rate (`|account-currency total| / (quantity × price)`, which
 * only needs to be roughly right because it merely picks a direction) we choose whichever of
 * `rate` / `1/rate` is closer. Without an implied rate we cannot tell, so we return
 * undefined and the trade stays in its own currency rather than risk a wrong conversion.
 */
export function accountPerActivityRate(
  t212Rate: number | undefined,
  implied: number | undefined,
): number | undefined {
  if (!t212Rate || !Number.isFinite(t212Rate) || t212Rate <= 0 || t212Rate === 1) return undefined;
  if (!implied || !Number.isFinite(implied) || implied <= 0) return undefined;
  const inverse = 1 / t212Rate;
  const direct = Math.abs(Math.log(t212Rate / implied));
  const inverted = Math.abs(Math.log(inverse / implied));
  return roundTo(direct < inverted ? t212Rate : inverse, 10);
}

/**
 * Sums trade charges in the ACTIVITY currency (Wealthfolio 3.8+: every monetary field of an
 * activity is denominated in the activity currency). Trading 212 reports charges in the
 * account (wallet) currency, so a charge in another currency is divided by the
 * account-per-activity `fxRate` when we have one.
 */
export function chargesInActivityCurrency(
  charges: { amount: number; currency?: string }[],
  activityCurrency: string,
  fxRate: number | undefined,
): number {
  const ccy = activityCurrency.toUpperCase();
  const total = charges.reduce((acc, c) => {
    // Charges are costs whatever sign Trading 212 reports them with.
    const amount = Math.abs(c.amount);
    if (!c.currency || c.currency.toUpperCase() === ccy) return acc + amount;
    // A charge in another currency can only be converted with a rate; without one,
    // leave it out rather than add e.g. GBP pence to a USD fee.
    return fxRate !== undefined ? acc + amount / fxRate : acc;
  }, 0);
  return fxRate !== undefined ? roundTo(total, 6) : round2(total);
}

/**
 * Maps a filled Trading 212 order to a BUY/SELL activity.
 * Returns null for non-trade fills (e.g. stock splits) or incomplete data.
 *
 * Wealthfolio 3.8+ treats `amount` as the saved FINAL cash (fees and taxes included) and
 * never re-derives it at read time. For trades we deliberately OMIT `amount`: the import
 * writer derives it as quantity × unitPrice ± charges (+ for BUY, − for SELL) from the
 * `fee` we supply, which is exactly the final cash and avoids us double-counting charges.
 * `fee` is expressed in the activity currency and `fxRate` (account per activity unit) is
 * only supplied for a genuinely cross-currency trade — see {@link accountPerActivityRate}.
 */
export function mapOrderToActivity(
  order: HistoricalOrder,
  accountId: string,
  symbol: string,
): ActivityImport | null {
  const o = order.order;
  const fill = order.fill;
  if (!o || o.id === undefined) return null;
  if (fill?.type && fill.type !== "TRADE") return null; // skip splits/distributions
  if (o.side !== "BUY" && o.side !== "SELL") return null;

  // Trading 212 signs sell quantities negative when placing orders; accept either sign.
  const rawQuantity = fill?.quantity ?? o.filledQuantity;
  const quantity = rawQuantity === undefined ? undefined : Math.abs(rawQuantity);
  const unitPrice = fill?.price;
  if (!quantity || unitPrice === undefined) return null;

  const wallet = fill?.walletImpact;
  const currency = o.currency || o.instrument?.currency || wallet?.currency || "GBP";
  const date = fill?.filledAt || o.createdAt;
  if (!date) return null;

  const crossCurrency = !!wallet?.currency && wallet.currency.toUpperCase() !== currency.toUpperCase();
  const implied =
    wallet?.netValue !== undefined && wallet.netValue !== null
      ? Math.abs(wallet.netValue) / (quantity * unitPrice)
      : undefined;
  const fxRate = crossCurrency ? accountPerActivityRate(wallet?.fxRate, implied) : undefined;

  const fee = chargesInActivityCurrency(
    (wallet?.taxes ?? []).map((t) => ({ amount: t.quantity ?? 0, currency: t.currency ?? wallet?.currency })),
    currency,
    fxRate,
  );

  return {
    id: `t212-order-${o.id}`,
    accountId,
    activityType: o.side === "BUY" ? BUY : SELL,
    date,
    symbol,
    quantity,
    unitPrice,
    fee: fee > 0 ? fee : undefined,
    currency,
    fxRate,
    isValid: true,
    isDraft: false,
    comment: o.instrument?.name || undefined,
  };
}

/**
 * Maps a Trading 212 dividend (or interest) payout to a DIVIDEND/INTEREST activity.
 * `amount` is what Trading 212 actually paid into the account (already net of any
 * withholding tax), i.e. the final cash.
 */
export function mapDividendToActivity(
  div: DividendItem,
  accountId: string,
  symbol: string | null,
): ActivityImport {
  const isInterest = div.type === "INTEREST";
  const currency = div.currency || div.tickerCurrency || "GBP";

  return {
    id: `t212-div-${div.reference}`,
    accountId,
    activityType: isInterest ? INTEREST : DIVIDEND,
    date: div.paidOn,
    symbol: isInterest ? cashSymbol(currency) : symbol || undefined,
    amount: round2(Math.abs(div.amount)),
    currency,
    isValid: true,
    isDraft: false,
    comment: div.type ? formatDividendType(div.type) : undefined,
  };
}

/** Maps a Trading 212 cash transaction to a deposit/withdrawal/fee/transfer activity. */
export function mapTransactionToActivity(
  txn: TransactionItem,
  accountId: string,
): ActivityImport {
  let activityType: ActivityType;
  switch (txn.type) {
    case "DEPOSIT":
      activityType = DEPOSIT;
      break;
    case "WITHDRAW":
      activityType = WITHDRAWAL;
      break;
    case "FEE":
      activityType = FEE;
      break;
    case "INTEREST_ON_FREE_CASH":
    case "LENDING_INTEREST":
      activityType = INTEREST;
      break;
    case "TRANSFER":
    default:
      activityType = txn.amount >= 0 ? TRANSFER_IN : TRANSFER_OUT;
      break;
  }

  const currency = txn.currency || "GBP";
  return {
    id: `t212-txn-${txn.reference}`,
    accountId,
    activityType,
    date: txn.dateTime,
    symbol: cashSymbol(currency),
    // Plain cash: the amount IS the ledger (3.8+) — no separate `fee` is emitted.
    amount: round2(Math.abs(txn.amount)),
    currency,
    isValid: true,
    isDraft: false,
    comment:
      txn.type === "INTEREST_ON_FREE_CASH"
        ? "Interest on cash"
        : txn.type === "LENDING_INTEREST"
          ? "Share lending interest"
          : undefined,
  };
}

/**
 * Maps a Trading 212 position to a holdings-snapshot entry. `symbol` is the
 * Wealthfolio symbol already resolved from the position's ticker/ISIN. The
 * snapshot API takes string-encoded numbers; `accountCurrency` is the fallback
 * when the instrument doesn't carry its own currency. `exchangeMic` (when known)
 * pins the asset Wealthfolio creates to the right listing — without it, ticker
 * collisions like `RR` resolve to whichever company Yahoo defaults to.
 */
export function mapPositionToHolding(
  pos: Position,
  symbol: string,
  accountCurrency: string,
  exchangeMic?: string,
): SnapshotHoldingInput {
  return {
    symbol,
    quantity: String(pos.quantity),
    currency: pos.instrument?.currency || accountCurrency,
    averageCost: pos.averagePricePaid != null ? String(pos.averagePricePaid) : undefined,
    name: pos.instrument?.name,
    exchangeMic,
  };
}

/**
 * Merges holdings that resolved to the same Wealthfolio symbol. A snapshot keeps
 * at most one holding per symbol, so when two Trading 212 positions collapse onto
 * one symbol — e.g. a same-ISIN cross-listing (US `NVDA` + Xetra leg) that the
 * resolver couldn't keep distinct — pushing both would let one silently overwrite
 * the other and that leg's value would vanish. Summing quantity (and taking a
 * quantity-weighted average cost) preserves the total value instead. Holdings
 * with distinct symbols pass through untouched and keep their order.
 */
export function mergeHoldingsBySymbol(holdings: SnapshotHoldingInput[]): SnapshotHoldingInput[] {
  const bySymbol = new Map<string, SnapshotHoldingInput>();
  for (const h of holdings) {
    const prev = bySymbol.get(h.symbol);
    if (!prev) {
      bySymbol.set(h.symbol, h);
      continue;
    }
    const q1 = Number(prev.quantity) || 0;
    const q2 = Number(h.quantity) || 0;
    const total = q1 + q2;
    let averageCost = prev.averageCost;
    if (prev.averageCost != null && h.averageCost != null && total > 0) {
      averageCost = String((q1 * Number(prev.averageCost) + q2 * Number(h.averageCost)) / total);
    } else if (prev.averageCost == null || h.averageCost == null) {
      averageCost = undefined; // can't blend a meaningful cost if either side lacks one
    }
    bySymbol.set(h.symbol, { ...prev, quantity: String(total), averageCost });
  }
  return [...bySymbol.values()];
}

function formatDividendType(type: string): string {
  return type
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
