import { describe, expect, it } from "vitest";
import { samplePayslipLines } from "../test-utils";
import type { Payslip } from "./model";
import { parsePayslipLines } from "./payslip-parser";
import { summariseYear } from "./summary";

/** Default sample: salary 3000, USS sacrifice 183 → payments 2817, tax 380 + NI 150, net 2287. */
const slip = (payDate: string, period: string, over: Parameters<typeof samplePayslipLines>[0] = {}): Payslip => ({
  ...parsePayslipLines(samplePayslipLines({ payDate, period, ...over })),
  warnings: [],
  importedAt: "2026-11-02T09:00:00.000Z",
});

const apr = slip("30.04.2026", "01/2026", { toDate: ["2817.00", "2817.00", "380.00", "150.00"] });
const may = slip("29.05.2026", "02/2026", {
  deductions: ["Tax paid 380.00", "Employee NIC 150.00", "Student Loan 40.00"],
  toDate: ["5634.00", "5634.00", "760.00", "300.00"],
});
const old = slip("31.03.2026", "12/2025");

describe("summariseYear", () => {
  it("totals the year's payslips and ignores other tax years", () => {
    const s = summariseYear([apr, may, old], 2026, "2026-06-10");
    expect(s.taxYear).toBe(2026);
    expect(s.label).toBe("2026/27");
    expect(s.count).toBe(2);
    expect(s.grossBeforeUss).toBe(6000);
    expect(s.ussSacrifice).toBe(366);
    expect(s.taxablePay).toBe(5634);
    expect(s.incomeTax).toBe(760);
    expect(s.employeeNi).toBe(300);
    expect(s.studentLoan).toBe(40);
    expect(s.net).toBe(4534);
  });

  it("computes effective rates as shares of gross before USS", () => {
    const s = summariseYear([apr, may], 2026, "2026-06-10");
    expect(s.rates.incomeTax).toBeCloseTo(760 / 6000, 6);
    expect(s.rates.employeeNi).toBeCloseTo(300 / 6000, 6);
    expect(s.rates.deductions).toBeCloseTo((530 + 570) / 6000, 6);
  });

  it("guards the rates against a year with no gross pay", () => {
    const s = summariseYear([], 2026, "2026-06-10");
    expect(s.count).toBe(0);
    expect(s.rates).toEqual({ incomeTax: 0, employeeNi: 0, deductions: 0 });
    expect(s.ytd).toBeUndefined();
  });

  it("has twelve monthly buckets, April first, that add back up to the gross", () => {
    const s = summariseYear([apr, may], 2026, "2026-06-10");
    expect(s.months).toHaveLength(12);
    expect(s.months.map((m) => m.label)).toEqual(["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"]);
    expect(s.months[0]).toMatchObject({ month: 1, hasPayslip: true, net: 2287, tax: 380, ni: 150, studentLoan: 0, uss: 183, other: 0 });
    expect(s.months[1]).toMatchObject({ month: 2, net: 2247, studentLoan: 40 });
    expect(s.months[2]).toMatchObject({ month: 3, hasPayslip: false, net: 0, tax: 0 });
    const stacked = s.months.reduce((n, m) => n + m.net + m.tax + m.ni + m.studentLoan + m.uss + m.other, 0);
    expect(stacked).toBeCloseTo(s.grossBeforeUss, 2);
  });

  it("adds two payslips of one tax month into one bucket", () => {
    const bonus = slip("15.04.2026", "01/2026", { payments: ["Bonus 500.00"], deductions: ["Tax paid 100.00", "Employee NIC 40.00"] });
    const s = summariseYear([apr, bonus], 2026, "2026-06-10");
    expect(s.count).toBe(2);
    expect(s.months[0]).toMatchObject({ net: 2287 + 360, tax: 480, ni: 190 });
  });

  it("lists the months with no payslip up to the current month in the current tax year", () => {
    // 10 June 2026 is tax month 3: April and May are in, June not yet.
    const s = summariseYear([apr, may], 2026, "2026-06-10");
    expect(s.missingMonths).toEqual([3]);
    expect(summariseYear([apr], 2026, "2026-06-10").missingMonths).toEqual([2, 3]);
    // 3 June is still tax month 2 (the month runs 6 May - 5 June).
    expect(summariseYear([apr], 2026, "2026-06-03").missingMonths).toEqual([2]);
  });

  it("lists every month without a payslip for a past tax year, and none for a future one", () => {
    const s = summariseYear([old], 2025, "2026-06-10");
    expect(s.missingMonths).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(summariseYear([], 2024, "2026-06-10").missingMonths).toHaveLength(12);
    expect(summariseYear([], 2027, "2026-06-10").missingMonths).toEqual([]);
  });

  it("takes the year-to-date figures from the latest payslip's To date", () => {
    const s = summariseYear([may, apr], 2026, "2026-06-10");
    expect(s.ytd).toEqual({ payDate: "2026-05-29", grossPay: 5634, taxablePay: 5634, tax: 760, eeNic: 300 });
  });

  it("sums This Period taxable pay, not gross", () => {
    const s = summariseYear([slip("30.04.2026", "01/2026", { thisPeriod: ["2817.00", "2500.00", "380.00", "150.00"] })], 2026, "2026-06-10");
    expect(s.taxablePay).toBe(2500);
  });
});
