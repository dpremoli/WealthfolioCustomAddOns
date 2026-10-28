import type { Payslip } from "./model";
import { taxYearLabel } from "./tax-year";

/**
 * What the Payslips and Tax pages look at: one UK tax year (6 April to 5 April), one calendar year,
 * or any custom range of pay dates (both ends included; an empty end is open).
 */
export type Period =
  | { kind: "tax"; year: number }
  | { kind: "calendar"; year: number }
  | { kind: "range"; from: string; to: string };

export type PeriodKind = Period["kind"];

type Dated = Pick<Payslip, "payDate" | "taxYear">;

/** First and last pay date (YYYY-MM-DD, both included) of a period; "" is an open end of a range. */
export function periodBounds(p: Period): { from: string; to: string } {
  switch (p.kind) {
    case "tax":
      return { from: `${p.year}-04-06`, to: `${p.year + 1}-04-05` };
    case "calendar":
      return { from: `${p.year}-01-01`, to: `${p.year}-12-31` };
    case "range":
      return { from: p.from, to: p.to };
  }
}

/** Whether a pay date (YYYY-MM-DD) falls in the period, both ends included. */
export function inPeriod(payDate: string, p: Period): boolean {
  const { from, to } = periodBounds(p);
  return (from === "" || payDate >= from) && (to === "" || payDate <= to);
}

/** A payslip is in a tax year by its tax period (`taxYear`); in a calendar year or a range, by its pay date. */
export function payslipInPeriod(p: Dated, period: Period): boolean {
  return period.kind === "tax" ? p.taxYear === period.year : inPeriod(p.payDate, period);
}

/** "2026/27", "2026" or "2026-02-10 to 2026-09-30". */
export function periodLabel(p: Period): string {
  switch (p.kind) {
    case "tax":
      return taxYearLabel(p.year);
    case "calendar":
      return String(p.year);
    case "range":
      if (p.from && p.to) return `${p.from} to ${p.to}`;
      if (p.from) return `${p.from} onwards`;
      if (p.to) return `up to ${p.to}`;
      return "all dates";
  }
}

/** The years of that kind that have payslips, oldest first. */
export function periodYears(payslips: Dated[], kind: "tax" | "calendar"): number[] {
  const years = payslips.map((p) => (kind === "tax" ? p.taxYear : Number(p.payDate.slice(0, 4))));
  return [...new Set(years)].sort((a, b) => a - b);
}

const latestYear = (payslips: Dated[], kind: "tax" | "calendar"): number | undefined => periodYears(payslips, kind).at(-1);

/**
 * The period to show: the chosen one, with a year that has no payslips replaced by the latest year
 * of its kind, and the latest tax year when nothing is chosen. Undefined without payslips.
 */
export function resolvePeriod(chosen: Period | null, payslips: Dated[]): Period | undefined {
  if (payslips.length === 0) return undefined;
  if (chosen?.kind === "range") return chosen;
  const kind = chosen?.kind ?? "tax";
  const years = periodYears(payslips, kind);
  const year = chosen && years.includes(chosen.year) ? chosen.year : years[years.length - 1]!;
  return { kind, year };
}

/** The period after switching the mode: the latest year of a year kind, the current dates for a range. */
export function periodOfKind(kind: PeriodKind, current: Period, payslips: Dated[]): Period {
  if (current.kind === kind) return current;
  if (kind === "range") return { kind, ...periodBounds(current) };
  return { kind, year: latestYear(payslips, kind) ?? (current.kind === "range" ? new Date().getFullYear() : current.year) };
}
