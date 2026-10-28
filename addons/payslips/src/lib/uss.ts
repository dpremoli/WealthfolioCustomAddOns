import { round2 } from "@wf-addons/kit";
import { ussSacrifice, type Line, type Payslip, type UssStatement } from "./model";

/** A payslip line that belongs to the USS pension ("USS(CRB) 16 SS"). */
export const isUssLine = (l: Line): boolean => /^USS\b/i.test(l.description);

/** Salary sacrificed into USS, per tax year (ascending) and in total. */
export function ussContributions(payslips: Payslip[]): { byYear: { taxYear: number; amount: number }[]; total: number } {
  const years = new Map<number, number>();
  for (const p of payslips) years.set(p.taxYear, (years.get(p.taxYear) ?? 0) + ussSacrifice(p));
  const byYear = [...years]
    .map(([taxYear, amount]) => ({ taxYear, amount: round2(amount) }))
    .sort((a, b) => a.taxYear - b.taxYear);
  return { byYear, total: round2(byYear.reduce((s, y) => s + y.amount, 0)) };
}

export function latestStatement(list: UssStatement[]): UssStatement | undefined {
  return list.reduce<UssStatement | undefined>((best, s) => (!best || s.date > best.date ? s : best), undefined);
}

/**
 * Capital value of the defined-benefit pension: annual pension x 20 plus the lump sum.
 * Illustrative only: it is never written to Wealthfolio and is not part of net worth.
 */
export const DB_CAPITAL_FACTOR = 20;

export const dbCapitalEstimate = (s: UssStatement): number => round2(s.dbPension * DB_CAPITAL_FACTOR + s.dbLumpSum);
