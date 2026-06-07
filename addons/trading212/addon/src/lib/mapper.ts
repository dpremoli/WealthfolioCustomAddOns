import type { ActivityImport, SnapshotHoldingInput } from "@wealthfolio/addon-sdk";
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sumTaxes(order: HistoricalOrder): number {
  const taxes = order.fill?.walletImpact?.taxes ?? [];
  return taxes.reduce((acc, t) => acc + (t.quantity ?? 0), 0);
}

/**
 * Maps a filled Trading 212 order to a BUY/SELL activity.
 * Returns null for non-trade fills (e.g. stock splits) or incomplete data.
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

  const quantity = fill?.quantity ?? o.filledQuantity;
  const unitPrice = fill?.price;
  if (quantity === undefined || quantity <= 0 || unitPrice === undefined) return null;

  const currency =
    o.currency || o.instrument?.currency || fill?.walletImpact?.currency || "GBP";
  const date = fill?.filledAt || o.createdAt;
  if (!date) return null;

  const fee = round2(sumTaxes(order));

  return {
    id: `t212-order-${o.id}`,
    accountId,
    activityType: o.side === "BUY" ? BUY : SELL,
    date,
    symbol,
    quantity: Math.abs(quantity),
    unitPrice,
    fee: fee > 0 ? fee : undefined,
    currency,
    fxRate: fill?.walletImpact?.fxRate,
    isValid: true,
    isDraft: false,
    comment: o.instrument?.name || undefined,
  };
}

/** Maps a Trading 212 dividend (or interest) payout to a DIVIDEND/INTEREST activity. */
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
    symbol: isInterest ? `$CASH-${currency}` : symbol || undefined,
    amount: round2(Math.abs(div.amount)),
    currency,
    isValid: true,
    isDraft: false,
    comment: formatDividendType(div.type),
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
    symbol: `$CASH-${currency}`,
    amount: round2(Math.abs(txn.amount)),
    currency,
    isValid: true,
    isDraft: false,
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

function formatDividendType(type: string): string {
  return type
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
