import { describe, expect, it } from "vitest";
import { samplePayslipLines } from "../test-utils";
import {
  employeeNi,
  expenseLines,
  expenseRefunds,
  grossBeforeSacrifice,
  isExpenseLine,
  incomeTax,
  otherDeductions,
  studentLoan,
  ussSacrifice,
  type Payslip,
} from "./model";
import { parsePayslipLines } from "./payslip-parser";

const make = (over?: Parameters<typeof samplePayslipLines>[0]): Payslip => ({
  ...parsePayslipLines(samplePayslipLines(over)),
  warnings: [],
  importedAt: "2026-11-02T09:00:00.000Z",
});

describe("derived figures", () => {
  const p = make();
  it("computes them for the sample", () => {
    expect(ussSacrifice(p)).toBe(183);
    expect(grossBeforeSacrifice(p)).toBe(3000);
    expect(incomeTax(p)).toBe(380);
    expect(employeeNi(p)).toBe(150);
    expect(studentLoan(p)).toBe(0);
    expect(otherDeductions(p)).toBe(0);
  });

  it("separates student loan and other deductions", () => {
    const q = make({ deductions: ["Tax paid 380.00", "Employee NIC 150.00", "Student Loan 45.00", "Cycle scheme 20.50"] });
    expect(studentLoan(q)).toBe(45);
    expect(otherDeductions(q)).toBe(20.5);
    expect(incomeTax(q)).toBe(380);
  });

  it("does not count a positive USS line as sacrifice", () => {
    expect(ussSacrifice(make({ payments: ["Salary 3000.00", "USS(CRB) refund 10.00"] }))).toBe(0);
  });

  it("does not count NI-related tax words as income tax", () => {
    expect(incomeTax(make({ deductions: ["Tax paid 380.00", "NI Tax adj 5.00"] }))).toBe(380);
  });
});

describe("expense refunds", () => {
  const GROSS = ["2817.00", "2817.00", "380.00", "150.00"] as [string, string, string, string];
  const EXPENSES = ["Gen Trav & Sub 45.50", "Telephone Costs 20.00"];
  const withExpenses = (over: Parameters<typeof samplePayslipLines>[0] = {}) =>
    make({ payments: ["Salary 3000.00", "USS(CRB) 16 SS 183.00-", ...EXPENSES], thisPeriod: GROSS, ...over });

  it("recognises positive reimbursement lines by their description", () => {
    const line = (description: string, amount = 10) => isExpenseLine({ description, amount });
    for (const d of ["Gen Trav & Sub", "Telephone Costs", "Travel", "Subsistence", "Mileage", "Expenses", "Reimbursement", "Claim 4"]) {
      expect(line(d), d).toBe(true);
    }
    for (const d of ["Salary", "USS(CRB) 16 SS", "Overtime", "Bonus"]) expect(line(d), d).toBe(false);
    expect(line("Gen Trav & Sub", -10)).toBe(false);
  });

  it("is the difference between Total Payments and This Period Gross Pay, explained by the expense lines", () => {
    const p = withExpenses();
    expect(p.totalPayments).toBe(2882.5);
    expect(expenseRefunds(p)).toBe(65.5);
    expect(expenseLines(p).map((l) => l.description)).toEqual(["Gen Trav & Sub", "Telephone Costs"]);
    expect(grossBeforeSacrifice(p)).toBe(3000);
  });

  it("is nothing for a payslip without them", () => {
    const p = make();
    expect(expenseRefunds(p)).toBe(0);
    expect(expenseLines(p)).toEqual([]);
  });

  it("leaves a difference that no expense line explains as unexplained", () => {
    const p = make({ payments: ["Salary 3000.00", "USS(CRB) 16 SS 183.00-", "Bonus 83.00"], thisPeriod: GROSS });
    expect(expenseRefunds(p)).toBe(83);
    expect(expenseLines(p)).toEqual([]);
    // Only part of it explained is not explained.
    const part = make({ payments: ["Salary 3000.00", "USS(CRB) 16 SS 183.00-", "Telephone Costs 20.00", "Bonus 63.00"], thisPeriod: GROSS });
    expect(expenseRefunds(part)).toBe(83);
    expect(expenseLines(part)).toEqual([]);
  });

  it("falls back to the expense lines when This Period Gross Pay is not there", () => {
    const p = withExpenses({ thisPeriod: ["0.00", "0.00", "380.00", "150.00"] });
    expect(expenseRefunds(p)).toBe(65.5);
    expect(expenseLines(p)).toHaveLength(2);
    expect(grossBeforeSacrifice(p)).toBe(3000);
    expect(expenseRefunds(make({ thisPeriod: ["0.00", "0.00", "380.00", "150.00"] }))).toBe(0);
  });
});
