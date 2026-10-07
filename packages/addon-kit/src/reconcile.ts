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
  return stripSourceRef(v).split(/\s+/).filter(Boolean).join(" ");
}

// `[ref:<id>]` at the end of a comment: the source system's own id for the row.
const REF_RE = /\s*\[ref:([^\]\s]+)\]\s*$/;

/**
 * Appends the source system's record id (e.g. a Monzo transaction id) to a comment as
 * `[ref:<id>]`. Wealthfolio's import has no field for it, and the comment is the only
 * free text that survives into `activities.getAll`, so this is what lets
 * {@link selectNewActivities} recognise a row whose other details have since changed.
 */
export function withSourceRef(comment: string | null | undefined, ref: string): string {
  const base = stripSourceRef(comment).trim();
  return base ? `${base} [ref:${ref}]` : `[ref:${ref}]`;
}

/** The id stored by {@link withSourceRef}, if any. */
export function sourceRefOf(comment: string | null | undefined): string | undefined {
  return (comment ?? "").match(REF_RE)?.[1];
}

function stripSourceRef(comment: string | null | undefined): string {
  return (comment ?? "").replace(REF_RE, "");
}

/** Cash rows carry `$CASH-…` (or nothing); compare them as "no asset". */
function asset(symbol: string | null | undefined): string {
  return !symbol || symbol.startsWith("$CASH") ? "" : symbol.toUpperCase();
}

/**
 * Content key mirroring the fields Wealthfolio hashes into an activity's
 * idempotency key: day, type, asset, quantity, unit price, amount, currency and
 * the (whitespace-normalised) comment, without any `[ref:…]` tag.
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
 * here instead:
 *
 * - A row tagged with {@link withSourceRef} is skipped when an existing row carries the
 *   same ref, whatever else changed (notes, category labels, merchant details).
 * - Otherwise it is matched by **count** per content key: if the account already holds
 *   N rows for a key, the first N desired rows for that key are skipped and the rest
 *   kept. Tagged rows only count against untagged existing ones here (rows imported
 *   before refs were added); a tagged existing row is only ever matched by its ref.
 *
 * Re-importing the same data therefore adds nothing, an overlapping import adds only
 * the surplus, and genuine repeats all land.
 */
export function selectNewActivities(
  desired: ActivityImport[],
  existing: ExistingActivityLike[],
): ActivityImport[] {
  const refs = new Set<string>();
  const have = new Map<string, number>();
  const haveUntagged = new Map<string, number>();
  for (const e of existing) {
    const k = contentKey(e);
    have.set(k, (have.get(k) ?? 0) + 1);
    const ref = sourceRefOf(e.comment);
    if (ref) refs.add(ref);
    else haveUntagged.set(k, (haveUntagged.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const out: ActivityImport[] = [];
  for (const a of desired) {
    const ref = sourceRefOf(a.comment);
    if (ref) {
      if (refs.has(ref)) continue;
      refs.add(ref); // the same record twice in one batch lands once
    }
    const k = contentKey(a);
    const idx = seen.get(k) ?? 0;
    seen.set(k, idx + 1);
    if (idx >= ((ref ? haveUntagged : have).get(k) ?? 0)) out.push({ ...a, forceImport: true });
  }
  return out;
}
