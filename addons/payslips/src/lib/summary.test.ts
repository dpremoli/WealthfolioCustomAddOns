import { describe, expect, it } from "vitest";
import { samplePayslipLines } from "../test-utils";
import type { Payslip } from "./model";
import { parsePayslipLines } from "./payslip-parser";
import { summarise, summariseYear } from "./summary";

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
    const stacked = s.months.reduce((n, m) => n + m.netFromPay + m.expenseRefunds + m.tax + m.ni + m.studentLoan + m.uss + m.other, 0);
    expect(stacked).toBeCloseTo(s.grossBeforeUss, 2);
    expect(s.expenseRefunds).toBe(0);
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

  describe("expense refunds", () => {
    const EXPENSES = ["Salary 3000.00", "USS(CRB) 16 SS 183.00-", "Gen Trav & Sub 45.50", "Telephone Costs 20.00"];
    // Total Payments 2882.50 = Gross Pay 2817.00 + refunds 65.50; net 2352.50.
    const jun = slip("30.06.2026", "03/2026", { payments: EXPENSES });

    it("totals them per year and month, leaving gross before USS and the rates to taxable pay", () => {
      const s = summariseYear([apr, jun], 2026, "2026-07-10");
      expect(s.expenseRefunds).toBe(65.5);
      expect(s.months[0]!.expenseRefunds).toBe(0);
      expect(s.months[2]).toMatchObject({ expenseRefunds: 65.5, net: 2352.5, netFromPay: 2287 });
      expect(s.grossBeforeUss).toBe(6000);
      expect(s.net).toBe(2287 + 2352.5);
      expect(s.rates.incomeTax).toBeCloseTo(760 / 6000, 6);
      expect(s.rates.deductions).toBeCloseTo(1060 / 6000, 6);
    });

    it("keeps the monthly stack adding up: net from pay and the refunds, with the rest, are gross plus refunds", () => {
      const s = summariseYear([apr, jun], 2026, "2026-07-10");
      const stacked = s.months.reduce((n, m) => n + m.netFromPay + m.expenseRefunds + m.tax + m.ni + m.studentLoan + m.uss + m.other, 0);
      expect(stacked).toBeCloseTo(s.grossBeforeUss + s.expenseRefunds, 2);
      expect(s.months.reduce((n, m) => n + m.netFromPay + m.expenseRefunds, 0)).toBeCloseTo(s.net, 2);
    });
  });
});

describe("summarise", () => {
  const dec = slip("31.12.2025", "09/2025");
  const jan = slip("30.01.2026", "10/2025");
  const feb = slip("27.02.2026", "11/2025");
  const next = slip("29.01.2027", "10/2026");
  const all = [dec, jan, feb, old, apr, may, next];

  describe("a tax year", () => {
    it("gives what summariseYear gives, with the month keys and the missing months by tax month", () => {
      const s = summarise([apr, may, old], { kind: "tax", year: 2026 }, "2026-06-10");
      expect(s).toMatchObject({ taxYear: 2026, label: "2026/27", count: 2, grossBeforeUss: 6000, net: 4534, missingMonths: [3] });
      expect(s.period).toEqual({ kind: "tax", year: 2026 });
      expect(s.months.map((m) => m.key)).toEqual(
        ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"],
      );
      expect(s.missing).toEqual([{ key: "2026-06", month: 3, label: "Jun" }]);
      expect(s.ytd).toEqual({ payDate: "2026-05-29", grossPay: 5634, taxablePay: 5634, tax: 760, eeNic: 300 });
    });

    it("is what summariseYear returns", () => {
      expect(summariseYear(all, 2026, "2026-06-10")).toEqual(summarise(all, { kind: "tax", year: 2026 }, "2026-06-10"));
    });
  });

  describe("a calendar year", () => {
    it("takes payslips of two tax years and nothing outside the year", () => {
      const s = summarise(all, { kind: "calendar", year: 2026 }, "2026-06-10");
      expect(s.label).toBe("2026");
      expect(s.taxYear).toBeUndefined();
      expect(s.count).toBe(5); // Jan, Feb, Mar (tax year 2025) and Apr, May (2026)
      expect(s.grossBeforeUss).toBe(15000);
      expect(s.ussSacrifice).toBe(915);
      expect(s.incomeTax).toBe(1900);
      expect(s.employeeNi).toBe(750);
      expect(s.studentLoan).toBe(40);
      expect(s.net).toBe(4 * 2287 + 2247);
      expect(s.rates.incomeTax).toBeCloseTo(1900 / 15000, 6);
    });

    it("buckets by calendar month, January first", () => {
      const s = summarise(all, { kind: "calendar", year: 2026 }, "2026-06-10");
      expect(s.months).toHaveLength(12);
      expect(s.months.map((m) => m.key)).toEqual(Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`));
      expect(s.months.map((m) => m.label).slice(0, 5)).toEqual(["Jan", "Feb", "Mar", "Apr", "May"]);
      expect(s.months[0]).toMatchObject({ hasPayslip: true, net: 2287, tax: 380, uss: 183 });
      expect(s.months[4]).toMatchObject({ hasPayslip: true, net: 2247, studentLoan: 40 });
      expect(s.months[5]).toMatchObject({ hasPayslip: false, net: 0 });
      const stacked = s.months.reduce((n, m) => n + m.netFromPay + m.expenseRefunds + m.tax + m.ni + m.studentLoan + m.uss + m.other, 0);
      expect(stacked).toBeCloseTo(s.grossBeforeUss, 2);
    });

    it("lists the months with no payslip up to the current month, and has no year to date", () => {
      const s = summarise(all, { kind: "calendar", year: 2026 }, "2026-06-10");
      expect(s.missing).toEqual([{ key: "2026-06", month: 6, label: "Jun 2026" }]);
      expect(s.missingMonths).toEqual([6]);
      expect(s.ytd).toBeUndefined();
    });

    it("lists every month of a past year without a payslip, and none of a future year", () => {
      expect(summarise(all, { kind: "calendar", year: 2025 }, "2026-06-10").missingMonths).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(summarise(all, { kind: "calendar", year: 2027 }, "2026-06-10").missing).toEqual([]);
    });
  });

  describe("a custom range", () => {
    const range = (from: string, to: string) => ({ kind: "range", from, to }) as const;

    it("takes the payslips from the first date to the last, both included", () => {
      expect(summarise(all, range("2026-02-27", "2026-04-30"), "2026-06-10").count).toBe(3); // Feb, Mar, Apr
      expect(summarise(all, range("2026-02-28", "2026-04-29"), "2026-06-10").count).toBe(1); // Mar
      const s = summarise(all, range("2026-02-27", "2026-04-30"), "2026-06-10");
      expect(s.label).toBe("2026-02-27 to 2026-04-30");
      expect(s.grossBeforeUss).toBe(9000);
      expect(s.net).toBe(3 * 2287);
      expect(s.taxYear).toBeUndefined();
      expect(s.ytd).toBeUndefined();
    });

    it("buckets by calendar month over the range, labelled with the year", () => {
      const s = summarise(all, range("2026-02-10", "2026-05-31"), "2026-06-10");
      expect(s.months.map((m) => [m.key, m.label, m.hasPayslip])).toEqual([
        ["2026-02", "Feb 26", true],
        ["2026-03", "Mar 26", true],
        ["2026-04", "Apr 26", true],
        ["2026-05", "May 26", true],
      ]);
      expect(s.months[3]).toMatchObject({ net: 2247, studentLoan: 40 });
    });

    it("runs a range across years month by month", () => {
      const s = summarise(all, range("2025-12-01", "2026-01-31"), "2026-06-10");
      expect(s.months.map((m) => m.key)).toEqual(["2025-12", "2026-01"]);
      expect(s.months.map((m) => m.label)).toEqual(["Dec 25", "Jan 26"]);
      expect(s.count).toBe(2);
    });

    it("counts a month as missing only when the range covers it whole and it has begun", () => {
      // February starts on the 10th, so it is not judged; March and May are whole and have no payslip.
      expect(summarise([apr], range("2026-02-10", "2026-05-31"), "2026-06-10").missing.map((m) => m.key)).toEqual(["2026-03", "2026-05"]);
      // Whole months, up to the month of today (June), none paid in June.
      const s = summarise([apr, may], range("2026-04-01", "2026-12-31"), "2026-06-10");
      expect(s.missing.map((m) => m.key)).toEqual(["2026-06"]);
      expect(s.missing[0]!.label).toBe("Jun 2026");
    });

    it("spans the payslips for an open end", () => {
      const s = summarise([apr, may], range("", ""), "2026-06-10");
      expect(s.months.map((m) => m.key)).toEqual(["2026-04", "2026-05"]);
      expect(s.count).toBe(2);
      expect(summarise([apr, may], range("2026-05-01", ""), "2026-06-10").count).toBe(1);
    });

    it("is empty for a range that ends before it starts", () => {
      const s = summarise(all, range("2026-06-01", "2026-05-01"), "2026-06-10");
      expect(s.count).toBe(0);
      expect(s.months).toEqual([]);
      expect(s.missing).toEqual([]);
      expect(s.rates).toEqual({ incomeTax: 0, employeeNi: 0, deductions: 0 });
    });
  });
});
