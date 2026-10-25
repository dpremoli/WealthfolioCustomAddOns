import type { AddonContext } from "@wealthfolio/addon-sdk";
import { minorUnit } from "@wf-addons/kit";
import { convertRate, type RateLike } from "./verify";

/** A stored trade as `activities.getAll` returns it (the fields the repair needs). */
export interface StoredTrade {
  id?: string;
  accountId?: string;
  activityType: string;
  date: Date | string;
  currency?: string | null;
  fxRate?: number | string | null;
}

// The major currencies of the minor units Wealthfolio converts, with their size (GBP: 100 pence).
const FACTORS: Record<string, number> = Object.fromEntries(
  ["GBX", "KWF", "ZAC", "ILA", "USX"].map((c) => [minorUnit(c)!.major, minorUnit(c)!.factor]),
);

const day = (d: Date | string) => (d instanceof Date ? d.toISOString() : String(d));

/**
 * The trades whose rate is per minor unit (per penny) although Wealthfolio stored them in the major
 * unit: sent in GBX before 2.6.5, Wealthfolio made the price pounds but kept the rate per penny, so
 * the trade settled at a hundredth. A rate is taken for one per penny when, times 100, it is nearer
 * Wealthfolio's current rate than as it stands (rates move by far less than 100× over the years).
 * Each comes with the rate it should have. Trades without a current rate to compare with are
 * returned in `unchecked`.
 */
export function pennyRateTrades(
  rows: StoredTrade[],
  accountCurrency: string,
  rates: RateLike[],
): { fixes: { row: StoredTrade; fxRate: number }[]; unchecked: StoredTrade[] } {
  const fixes: { row: StoredTrade; fxRate: number }[] = [];
  const unchecked: StoredTrade[] = [];
  const account = accountCurrency.toUpperCase();
  for (const row of rows) {
    const type = String(row.activityType);
    const ccy = (row.currency ?? "").toUpperCase();
    const fx = Number(row.fxRate);
    const factor = FACTORS[ccy];
    if ((type !== "BUY" && type !== "SELL") || !factor || ccy === account || !(fx > 0)) continue;
    const now = convertRate(rates, ccy, account);
    if (now === null || !(now > 0)) {
      unchecked.push(row);
      continue;
    }
    if (Math.abs(Math.log((fx * factor) / now)) < Math.abs(Math.log(fx / now))) {
      fixes.push({ row, fxRate: Number((fx * factor).toFixed(10)) });
    }
  }
  return { fixes, unchecked };
}

/**
 * Puts right the trades stored with a rate per penny (see {@link pennyRateTrades}): updates each
 * one's rate in place (`saveMany` patches only the fields it is given), so its cash and cost come
 * to what Trading 212 took. Returns how many were fixed. Never throws.
 */
export async function healPennyRates(
  ctx: AddonContext,
  rows: StoredTrade[],
  accountId: string,
  accountCurrency: string,
  log: string[],
): Promise<number> {
  try {
    let rates: RateLike[] = [];
    try {
      rates = (await ctx.api.exchangeRates.getAll()) as RateLike[];
    } catch {
      // Without rates nothing can be judged; said below.
    }
    const { fixes, unchecked } = pennyRateTrades(rows, accountCurrency, rates);
    if (unchecked.length > 0 && fixes.length === 0) {
      const ccys = [...new Set(unchecked.map((r) => r.currency))].join(", ");
      log.push(`Could not check the exchange rate of ${unchecked.length} trade(s) in ${ccys}: Wealthfolio has no rate to ${accountCurrency}.`);
    }
    let fixed = 0;
    const CHUNK = 100;
    for (let i = 0; i < fixes.length; i += CHUNK) {
      const part = fixes.slice(i, i + CHUNK).filter((f) => f.row.id);
      const res = (await ctx.api.activities.saveMany({
        updates: part.map(({ row, fxRate }) => ({
          id: row.id!,
          accountId,
          activityType: String(row.activityType),
          activityDate: day(row.date),
          currency: String(row.currency),
          fxRate,
        })),
      })) as { errors?: { id?: string; message: string }[] } | undefined;
      const failed = new Set((res?.errors ?? []).map((e) => e.id));
      for (const e of res?.errors ?? []) log.push(`Could not fix the rate of trade ${e.id ?? "?"}: ${e.message}`);
      for (const f of part) {
        if (failed.has(f.row.id)) continue;
        f.row.fxRate = f.fxRate;
        fixed++;
      }
    }
    if (fixed > 0) {
      log.push(
        `Fixed the exchange rate of ${fixed} trade${fixed === 1 ? "" : "s"} priced in pence: Wealthfolio kept the rate per penny ` +
          `while it made the price pounds, so each had cost a hundredth of what Trading 212 took.`,
      );
    }
    return fixed;
  } catch (e) {
    log.push(`Could not check trades priced in pence: ${(e as Error).message}`);
    return 0;
  }
}
