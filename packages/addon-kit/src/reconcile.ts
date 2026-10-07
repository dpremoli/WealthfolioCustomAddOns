import type { ActivityImport } from "@wealthfolio/addon-sdk";

/** The subset of an existing activity (`activities.getAll`) needed to reconcile. */
export interface ExistingActivityLike {
  activityType: string;
  date: Date | string;
  amount?: number | string | null;
  quantity?: number | string | null;
  unitPrice?: number | string | null;
  currency?: string | null;
  comment?: string | null;
  assetSymbol?: string | null;
}

function day(date: Date | string | undefined): string {
  if (!date) return "";
  return (date instanceof Date ? date.toISOString() : String(date)).slice(0, 10);
}

function num(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : "";
}

function text(v: string | null | undefined): string {
  return (v ?? "").split(/\s+/).filter(Boolean).join(" ");
}

/** Cash rows carry `$CASH-…` (or nothing); compare them as "no asset". */
function asset(symbol: string | null | undefined): string {
  return !symbol || symbol.startsWith("$CASH") ? "" : symbol.toUpperCase();
}

/**
 * Content key mirroring the fields Wealthfolio hashes into an activity's
 * idempotency key: day, type, asset, quantity, unit price, amount, currency and
 * the (whitespace-normalised) comment.
 *
 * Cash rows (no asset) compare on amount only, since Wealthfolio may store a
 * placeholder quantity/price for them. Asset rows (trades, dividends) compare on
 * quantity and unit price but not amount: importers usually omit it and Wealthfolio
 * stores the derived final cash, so including it would make every re-import look new.
 */
export function contentKey(a: ExistingActivityLike | ActivityImport): string {
  const symbol = asset("assetSymbol" in a ? a.assetSymbol : (a as ActivityImport).symbol);
  const isCash = symbol === "";
  return [
    day(a.date ?? undefined),
    a.activityType,
    symbol,
    isCash ? "" : num(a.quantity),
    isCash ? "" : num(a.unitPrice),
    isCash || !num(a.quantity) ? num(a.amount) : "",
    (a.currency ?? "").toUpperCase(),
    text(a.comment),
  ].join("|");
}

/**
 * Picks the activities not already in the account and marks them `forceImport`.
 *
 * Wealthfolio drops an imported row whose content (see {@link contentKey}) matches
 * an existing activity *or another row in the same batch*, so two genuinely
 * separate transactions — two identical coffees on one day — collapse into one and
 * real money disappears. Forcing every row bypasses that, so idempotency is handled
 * here instead, by **count** per content key: if the account already holds N rows
 * for a key, the first N desired rows for that key are skipped and the rest kept.
 * Re-importing the same data therefore adds nothing, an overlapping import adds only
 * the surplus, and genuine repeats all land.
 */
export function selectNewActivities(
  desired: ActivityImport[],
  existing: ExistingActivityLike[],
): ActivityImport[] {
  const have = new Map<string, number>();
  for (const e of existing) {
    const k = contentKey(e);
    have.set(k, (have.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const out: ActivityImport[] = [];
  for (const a of desired) {
    const k = contentKey(a);
    const idx = seen.get(k) ?? 0;
    seen.set(k, idx + 1);
    if (idx >= (have.get(k) ?? 0)) out.push({ ...a, forceImport: true });
  }
  return out;
}
