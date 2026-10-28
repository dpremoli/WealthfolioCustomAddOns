import { round2 } from "@wf-addons/kit";
import {
  employeeNi,
  expenseRefunds,
  grossBeforeSacrifice,
  incomeTax,
  otherDeductions,
  studentLoan,
  ussSacrifice,
  type Payslip,
} from "./model";
import { payslipInPeriod, periodLabel as labelOfPeriod, type Period } from "./period";
import { periodLabel, periodOfDate, taxYearOf } from "./tax-year";

/**
 * One month of the chart; every figure is 0 when no payslip falls in it. For a tax year the buckets
 * are the 12 tax months (1 = April … 12 = March, by the payslip's tax period); otherwise they are
 * calendar months (1 = January … 12 = December, by pay date).
 */
export interface MonthBucket {
  /** The calendar month (YYYY-MM) the bucket is in; a tax month is keyed by the month it starts in. */
  key: string;
  month: number;
  label: string;
  hasPayslip: boolean;
  /** Net Pay, expense refunds included. */
  net: number;
  /** Net Pay less the expense refunds: what is left of the taxable pay. */
  netFromPay: number;
  /** Non-taxable expense refunds paid with the salary. */
  expenseRefunds: number;
  tax: number;
  ni: number;
  studentLoan: number;
  /** Deductions that are neither tax, NI nor student loan. */
  other: number;
  /** USS salary sacrifice. */
  uss: number;
}

/** A month the period covers that has no payslip. */
export interface MissingMonth {
  key: string;
  /** Tax month for a tax year, calendar month otherwise. */
  month: number;
  /** "Jun" for a tax month, "Jun 2026" otherwise. */
  label: string;
}

export interface PeriodSummary {
  period: Period;
  /** The tax year, for a tax-year period only. */
  taxYear?: number;
  label: string;
  /** Payslips in the period. */
  count: number;
  grossBeforeUss: number;
  ussSacrifice: number;
  /** Sum of the payslips' "This Period" taxable pay. */
  taxablePay: number;
  incomeTax: number;
  employeeNi: number;
  studentLoan: number;
  otherDeductions: number;
  /** Non-taxable expense refunds in Total Payments (not part of gross before USS). */
  expenseRefunds: number;
  /** Sum of the payslips' Net Pay (expense refunds included). */
  net: number;
  /** Shares (0..1) of gross before USS; 0 when there is no gross pay. */
  rates: { incomeTax: number; employeeNi: number; deductions: number };
  months: MonthBucket[];
  /** Months with no payslip, counted only up to the current month (and, for a custom range, only months it covers whole). */
  missing: MissingMonth[];
  /** The `month` of each of `missing`: tax months for a tax year. */
  missingMonths: number[];
  /** "To date" figures of the latest payslip; for a single tax year only. */
  ytd?: { payDate: string; grossPay: number; taxablePay: number; tax: number; eeNic: number };
}

const sum = (list: Payslip[], f: (p: Payslip) => number): number => round2(list.reduce((s, p) => s + f(p), 0));

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** More than this many monthly buckets is a typo in a date (year 0001), not a period to chart. */
const MAX_MONTHS = 1200;

const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (y: number, m: number) => `${y}-${pad(m)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The calendar months (year, 1..12) from the month of `from` to the month of `to`, both YYYY-MM-DD. */
function calendarMonths(from: string, to: string): { y: number; m: number }[] {
  const out: { y: number; m: number }[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while ((y < endY || (y === endY && m <= endM)) && out.length < MAX_MONTHS) {
    out.push({ y, m });
    if (++m > 12) [y, m] = [y + 1, 1];
  }
  return out;
}

/** The figures of one bucket's payslips. */
const bucketOf = (inMonth: Payslip[]) => ({
  hasPayslip: inMonth.length > 0,
  net: sum(inMonth, (p) => p.netPay),
  netFromPay: sum(inMonth, (p) => p.netPay - expenseRefunds(p)),
  expenseRefunds: sum(inMonth, expenseRefunds),
  tax: sum(inMonth, incomeTax),
  ni: sum(inMonth, employeeNi),
  studentLoan: sum(inMonth, studentLoan),
  other: sum(inMonth, otherDeductions),
  uss: sum(inMonth, ussSacrifice),
});

/** The 12 tax months of a tax year, April first, with the payslips of each by tax period. */
function taxYearMonths(list: Payslip[], taxYear: number, today: string) {
  const months: MonthBucket[] = Array.from({ length: 12 }, (_, i) => {
    const month = i + 1;
    const calendar = ((month + 2) % 12) + 1; // tax month 1 starts in April
    return {
      key: keyOf(calendar >= 4 ? taxYear : taxYear + 1, calendar),
      month,
      label: periodLabel(month),
      ...bucketOf(list.filter((p) => p.period === month)),
    };
  });
  const current = taxYearOf(today);
  const upTo = taxYear < current ? 12 : taxYear === current ? periodOfDate(today) : 0;
  const missing = months.filter((m) => m.month <= upTo && !m.hasPayslip).map(({ key, month, label }) => ({ key, month, label }));
  return { months, missing };
}

/** Calendar-month buckets (by pay date) over the period; a range is judged for missing months on whole months only. */
function calendarPeriodMonths(list: Payslip[], period: Period, today: string) {
  const dates = list.map((p) => p.payDate).sort();
  const bounds =
    period.kind === "calendar"
      ? { from: `${period.year}-01-01`, to: `${period.year}-12-31` }
      : { from: period.kind === "range" && period.from ? period.from : (dates[0] ?? ""), to: period.kind === "range" && period.to ? period.to : (dates.at(-1) ?? "") };
  const span = bounds.from && bounds.to ? calendarMonths(bounds.from, bounds.to) : [];
  const wholeRange = period.kind === "range" ? { from: period.from, to: period.to } : undefined;

  const months: MonthBucket[] = span.map(({ y, m }) => ({
    key: keyOf(y, m),
    month: m,
    label: period.kind === "calendar" ? SHORT_MONTHS[m - 1]! : `${SHORT_MONTHS[m - 1]} ${pad(y % 100)}`,
    ...bucketOf(list.filter((p) => p.payDate.startsWith(keyOf(y, m)))),
  }));
  const missing = span
    .filter(({ y, m }) => {
      const covered =
        !wholeRange ||
        ((wholeRange.from === "" || `${keyOf(y, m)}-01` >= wholeRange.from) && (wholeRange.to === "" || `${keyOf(y, m)}-${pad(lastDay(y, m))}` <= wholeRange.to));
      return covered && keyOf(y, m) <= today.slice(0, 7);
    })
    .filter(({ y, m }) => !months.find((b) => b.key === keyOf(y, m))!.hasPayslip)
    .map(({ y, m }) => ({ key: keyOf(y, m), month: m, label: `${SHORT_MONTHS[m - 1]} ${y}` }));
  return { months, missing };
}

/**
 * Totals, effective rates, monthly buckets and missing months over the payslips whose pay date is in
 * the period: one UK tax year, one calendar year or a custom range. `today` (YYYY-MM-DD) bounds the
 * months that can be missing.
 */
export function summarise(payslips: Payslip[], period: Period, today: string): PeriodSummary {
  const list = payslips.filter((p) => payslipInPeriod(p, period));
  const gross = sum(list, grossBeforeSacrifice);
  const tax = sum(list, incomeTax);
  const ni = sum(list, employeeNi);
  const share = (n: number) => (gross > 0 ? n / gross : 0);

  const { months, missing } =
    period.kind === "tax" ? taxYearMonths(list, period.year, today) : calendarPeriodMonths(list, period, today);

  const latest = list.reduce<Payslip | undefined>((best, p) => (!best || p.payDate > best.payDate ? p : best), undefined);

  return {
    period,
    ...(period.kind === "tax" ? { taxYear: period.year } : {}),
    label: labelOfPeriod(period),
    count: list.length,
    grossBeforeUss: gross,
    ussSacrifice: sum(list, ussSacrifice),
    taxablePay: sum(list, (p) => p.thisPeriod.taxablePay),
    incomeTax: tax,
    employeeNi: ni,
    studentLoan: sum(list, studentLoan),
    otherDeductions: sum(list, otherDeductions),
    expenseRefunds: sum(list, expenseRefunds),
    net: sum(list, (p) => p.netPay),
    rates: {
      incomeTax: share(tax),
      employeeNi: share(ni),
      deductions: share(sum(list, (p) => p.totalDeductions)),
    },
    months,
    missing,
    missingMonths: missing.map((m) => m.month),
    ytd: period.kind === "tax" && latest ? { payDate: latest.payDate, ...latest.toDate } : undefined,
  };
}

/** Totals, effective rates, 12 monthly buckets and missing months for one UK tax year. */
export const summariseYear = (payslips: Payslip[], taxYear: number, today: string): PeriodSummary =>
  summarise(payslips, { kind: "tax", year: taxYear }, today);
