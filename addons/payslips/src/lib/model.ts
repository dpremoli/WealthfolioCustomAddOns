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

/** USS salary sacrifice as a positive number: the negative "USS…" payment lines, negated. */
export const ussSacrifice = (p: Payslip): number =>
  round2(-sum(p.payments, (l) => /^USS\b/i.test(l.description) && l.amount < 0));

/** Pay before the USS sacrifice was taken off. */
export const grossBeforeSacrifice = (p: Payslip): number => round2(p.totalPayments + ussSacrifice(p));

const isNi = (d: string) => /\bNIC?\b|national insurance/i.test(d);
const isTax = (d: string) => /\btax\b/i.test(d) && !isNi(d) && !/insurance/i.test(d);
const isStudentLoan = (d: string) => /student loan|\bSLC\b|\bPGL\b|postgrad/i.test(d);

export const incomeTax = (p: Payslip): number => sum(p.deductions, (l) => isTax(l.description));
export const employeeNi = (p: Payslip): number => sum(p.deductions, (l) => isNi(l.description));
export const studentLoan = (p: Payslip): number => sum(p.deductions, (l) => isStudentLoan(l.description));
export const otherDeductions = (p: Payslip): number =>
  round2(p.totalDeductions - incomeTax(p) - employeeNi(p) - studentLoan(p));
