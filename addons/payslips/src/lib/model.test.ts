import { describe, expect, it } from "vitest";
import { samplePayslipLines } from "../test-utils";
import {
  employeeNi,
  grossBeforeSacrifice,
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
