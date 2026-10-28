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
import { periodLabel, periodOfDate, taxYearLabel, taxYearOf } from "./tax-year";

/** One tax month (1 = April … 12 = March); every figure is 0 when no payslip falls in it. */
export interface MonthBucket {
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

export interface YearSummary {
  taxYear: number;
  label: string;
  /** Payslips in the tax year. */
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
  /** Tax months with no payslip, counted only up to the current month in the current tax year. */
  missingMonths: number[];
  /** "To date" figures of the latest payslip of the year. */
  ytd?: { payDate: string; grossPay: number; taxablePay: number; tax: number; eeNic: number };
}

const sum = (list: Payslip[], f: (p: Payslip) => number): number => round2(list.reduce((s, p) => s + f(p), 0));

/** Totals, effective rates, 12 monthly buckets and missing months for one UK tax year. */
export function summariseYear(payslips: Payslip[], taxYear: number, today: string): YearSummary {
  const list = payslips.filter((p) => p.taxYear === taxYear);
  const gross = sum(list, grossBeforeSacrifice);
  const tax = sum(list, incomeTax);
  const ni = sum(list, employeeNi);
  const share = (n: number) => (gross > 0 ? n / gross : 0);

  const months: MonthBucket[] = Array.from({ length: 12 }, (_, i) => {
    const inMonth = list.filter((p) => p.period === i + 1);
    return {
      month: i + 1,
      label: periodLabel(i + 1),
      hasPayslip: inMonth.length > 0,
      net: sum(inMonth, (p) => p.netPay),
      netFromPay: sum(inMonth, (p) => p.netPay - expenseRefunds(p)),
      expenseRefunds: sum(inMonth, expenseRefunds),
      tax: sum(inMonth, incomeTax),
      ni: sum(inMonth, employeeNi),
      studentLoan: sum(inMonth, studentLoan),
      other: sum(inMonth, otherDeductions),
      uss: sum(inMonth, ussSacrifice),
    };
  });

  const current = taxYearOf(today);
  const upTo = taxYear < current ? 12 : taxYear === current ? periodOfDate(today) : 0;
  const missingMonths = months.filter((m) => m.month <= upTo && !m.hasPayslip).map((m) => m.month);

  const latest = list.reduce<Payslip | undefined>((best, p) => (!best || p.payDate > best.payDate ? p : best), undefined);

  return {
    taxYear,
    label: taxYearLabel(taxYear),
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
    missingMonths,
    ytd: latest && { payDate: latest.payDate, ...latest.toDate },
  };
}
