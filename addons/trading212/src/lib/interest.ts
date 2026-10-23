import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { round2, type ExistingActivityLike } from "@wf-addons/kit";

/** Comment of a monthly interest total; also how one is recognised in the account. */
export const MONTHLY_INTEREST_COMMENT = "Interest on cash, monthly total";

const month = (d: Date | string | undefined) => new Date(d ?? 0).toISOString().slice(0, 7);

const isCashInterest = (a: { activityType: string; symbol?: string | null; assetSymbol?: string | null }) =>
  a.activityType === "INTEREST" && ((a.symbol ?? a.assetSymbol ?? "") === "" || (a.symbol ?? a.assetSymbol ?? "").startsWith("$CASH"));

/**
 * Trading 212 pays interest on cash daily, so a full history holds thousands of tiny INTEREST rows
 * (2,843 in one account). With `enabled`, a backfill window's interest on the investing account is
 * folded into one row per month and currency, dated on the month's last payment. Only months
 * before `before` (the month the backfill started) are folded: a month still running would lose
 * the payments that arrive after it was summed. A month split across two export windows gets a
 * total per window (the id carries the window), so a resumed backfill imports the same rows.
 *
 * Switching the setting never counts interest twice: a month the account already holds daily
 * rows for stays daily (they are then recognised as already imported), and with the setting off,
 * daily rows are left out for a month that already has a monthly total.
 */
export function foldMonthlyInterest(
  activities: ActivityImport[],
  opts: {
    enabled: boolean;
    accountId: string;
    before: Date;
    windowKey: string;
    existing: ExistingActivityLike[];
  },
): ActivityImport[] {
  const cutoff = month(opts.before);
  const foldable = (a: ActivityImport) =>
    a.accountId === opts.accountId && isCashInterest(a) && month(a.date) < cutoff;

  const existingMonths = { daily: new Set<string>(), monthly: new Set<string>() };
  for (const e of opts.existing) {
    if (!isCashInterest(e)) continue;
    const m = `${month(e.date)}|${(e.currency ?? "").toUpperCase()}`;
    if ((e.comment ?? "").startsWith(MONTHLY_INTEREST_COMMENT)) existingMonths.monthly.add(m);
    else existingMonths.daily.add(m);
  }
  const keyOf = (a: ActivityImport) => `${month(a.date)}|${(a.currency ?? "").toUpperCase()}`;

  if (!opts.enabled) {
    return activities.filter((a) => !(foldable(a) && existingMonths.monthly.has(keyOf(a))));
  }

  const groups = new Map<string, ActivityImport[]>();
  const out: ActivityImport[] = [];
  for (const a of activities) {
    if (!foldable(a) || existingMonths.daily.has(keyOf(a))) {
      out.push(a);
      continue;
    }
    groups.set(keyOf(a), [...(groups.get(keyOf(a)) ?? []), a]);
  }
  for (const [k, rows] of groups) {
    const [m, currency] = k.split("|");
    const last = rows.reduce((x, y) => (new Date(y.date ?? 0) > new Date(x.date ?? 0) ? y : x));
    out.push({
      ...last,
      id: `t212-interest-${m}-${currency}-${opts.windowKey}`,
      amount: round2(rows.reduce((s, r) => s + Number(r.amount ?? 0), 0)),
      comment: `${MONTHLY_INTEREST_COMMENT} (${rows.length} payment${rows.length === 1 ? "" : "s"})`,
    });
  }
  return out;
}
