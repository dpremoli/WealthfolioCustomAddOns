import { round2 } from "@wf-addons/kit";

export type Line = { description: string; units?: number; amount: number };

/** The four figures SAP prints for "This Period" and "To date". */
export type Ytd = { grossPay: number; taxablePay: number; tax: number; eeNic: number };

export type Payslip = {
  /** YYYY-MM-DD */
  payDate: string;
  /** Calendar year the UK tax year starts in. */
  taxYear: number;
  /** Tax month, 1 = April … 12 = March. */
  period: number;
  taxCode: string;
  payments: Line[];
  deductions: Line[];
  totalPayments: number;
  totalDeductions: number;
  netPay: number;
  thisPeriod: Ytd;
  toDate: Ytd;
  warnings: string[];
  importedAt: string;
};

export type UssStatement = {
  date: string;
  dbPension: number;
  dbLumpSum: number;
  dcPot?: number;
  employerContribution?: number;
};

export type Link = {
  activityId: string;
  accountId: string;
  chosen: "auto" | "manual";
  tagged?: boolean;
};

export type Settings = {
  accountIds?: string[];
  windowDays: number;
  payroll: { enabled: boolean; accountId?: string };
};

const sum = (lines: Line[], test: (l: Line) => boolean): number =>
  round2(lines.filter(test).reduce((s, l) => s + l.amount, 0));

/** A payslip line that belongs to the USS pension ("USS(CRB) 16 SS", "USS(CRB) 16"). */
export const USS_RE = /^USS\b/i;

/** USS salary sacrifice as a positive number: the negative "USS…" payment lines, negated. */
export const ussSacrifice = (p: Payslip): number =>
  round2(-sum(p.payments, (l) => USS_RE.test(l.description) && l.amount < 0));

/**
 * USS contribution taken as a deduction (not sacrificed): the "USS…" deduction lines. It is an
 * ordinary deduction out of gross pay, so it changes neither gross nor `otherDeductions`.
 */
export const ussDeducted = (p: Payslip): number => sum(p.deductions, (l) => USS_RE.test(l.description));

/** The employee's USS contribution, however it is paid: sacrificed from pay, or deducted. */
export const ussContribution = (p: Payslip): number => round2(ussSacrifice(p) + ussDeducted(p));

/** Descriptions of expense refunds: "Gen Trav & Sub", "Telephone Costs", mileage, claims. */
export const EXPENSE_RE = /trav|subsist|\bsub\b|telephone|phone|mileage|expense|reimburs|\bclaim/i;

/** A positive payment line that reimburses an expense: paid out, but not taxable pay. */
export const isExpenseLine = (l: Line): boolean => l.amount > 0 && EXPENSE_RE.test(l.description);

/**
 * Expense refunds in Total Payments: whatever Total Payments has over This Period Gross Pay (the
 * taxable figure) when that is printed, never guessed from descriptions (a "Telephone Allowance"
 * that Gross Pay counts is taxable pay). Only without Gross Pay: the sum of the expense lines.
 */
export function expenseRefunds(p: Payslip): number {
  if (p.thisPeriod.grossPay > 0) return Math.max(0, round2(p.totalPayments - p.thisPeriod.grossPay));
  return sum(p.payments, isExpenseLine);
}

/** The expense lines when they add up to `expenseRefunds`; none when the refund is unexplained. */
export function expenseLines(p: Payslip): Line[] {
  const refunds = expenseRefunds(p);
  if (refunds <= 0.005) return [];
  const lines = p.payments.filter(isExpenseLine);
  return Math.abs(round2(lines.reduce((s, l) => s + l.amount, 0)) - refunds) <= 0.005 ? lines : [];
}

/** Taxable pay before the USS sacrifice was taken off (expense refunds left out). */
export const grossBeforeSacrifice = (p: Payslip): number =>
  round2((p.thisPeriod.grossPay > 0 ? p.thisPeriod.grossPay : p.totalPayments - expenseRefunds(p)) + ussSacrifice(p));

export const isNi = (d: string) => /\bNIC?\b|national insurance/i.test(d);
export const isTax = (d: string) => /\btax\b/i.test(d) && !isNi(d) && !/insurance/i.test(d);
const isStudentLoan = (d: string) => /student loan|\bSLC\b|\bPGL\b|postgrad/i.test(d);

export const incomeTax = (p: Payslip): number => sum(p.deductions, (l) => isTax(l.description));
export const employeeNi = (p: Payslip): number => sum(p.deductions, (l) => isNi(l.description));
export const studentLoan = (p: Payslip): number => sum(p.deductions, (l) => isStudentLoan(l.description));
export const otherDeductions = (p: Payslip): number =>
  round2(p.totalDeductions - incomeTax(p) - employeeNi(p) - studentLoan(p));
