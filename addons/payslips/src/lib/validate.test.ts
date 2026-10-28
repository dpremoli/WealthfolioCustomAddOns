import { describe, expect, it } from "vitest";
import { samplePayslipLines } from "../test-utils";
import type { Payslip } from "./model";
import { parsePayslipLines } from "./payslip-parser";
import { validatePayslip } from "./validate";

const base = (): Payslip => ({
  ...parsePayslipLines(samplePayslipLines()),
  warnings: [],
  importedAt: "2026-11-02T09:00:00.000Z",
});

describe("validatePayslip", () => {
  it("has no warnings on the sample", () => {
    expect(validatePayslip(base())).toEqual([]);
  });

  it("warns when payments do not sum to Total Payments", () => {
    const w = validatePayslip({ ...base(), totalPayments: 2900 });
    expect(w.some((m) => /payments/i.test(m) && m.includes("2817.00") && m.includes("2900.00"))).toBe(true);
  });

  it("warns when deductions do not sum to Total Deductions", () => {
    const w = validatePayslip({ ...base(), totalDeductions: 600 });
    expect(w.some((m) => /deductions/i.test(m) && m.includes("530.00") && m.includes("600.00"))).toBe(true);
  });

  it("warns when payments - deductions differ from Net Pay", () => {
    const w = validatePayslip({ ...base(), netPay: 2000 });
    expect(w.some((m) => /net pay/i.test(m) && m.includes("2287.00") && m.includes("2000.00"))).toBe(true);
  });

  it("warns when This Period tax differs from the Tax lines", () => {
    const p = base();
    const w = validatePayslip({ ...p, thisPeriod: { ...p.thisPeriod, tax: 400 } });
    expect(w.some((m) => /tax/i.test(m) && m.includes("400.00") && m.includes("380.00"))).toBe(true);
  });

  it("warns when This Period NIC differs from the NIC lines", () => {
    const p = base();
    const w = validatePayslip({ ...p, thisPeriod: { ...p.thisPeriod, eeNic: 160 } });
    expect(w.some((m) => /NI/.test(m) && m.includes("160.00") && m.includes("150.00"))).toBe(true);
  });

  it("tolerates sub-penny float noise", () => {
    expect(validatePayslip({ ...base(), netPay: 2287.004 })).toEqual([]);
  });

  it("validates a payslip with extra lines", () => {
    const p = parsePayslipLines(
      samplePayslipLines({
        payments: ["Salary 3000.00", "Overtime 120.00", "USS(CRB) 16 SS 183.00-"],
        deductions: ["Tax paid 380.00", "Employee NIC 150.00", "Student Loan 45.00"],
      }),
    );
    expect(validatePayslip({ ...p, warnings: [], importedAt: "" })).toEqual([]);
  });

  it("has no warning when expense lines explain what Total Payments has over Gross Pay", () => {
    const p = parsePayslipLines(
      samplePayslipLines({ payments: ["Salary 3000.00", "USS(CRB) 16 SS 183.00-", "Gen Trav & Sub 45.50", "Telephone Costs 20.00"] }),
    );
    expect(p.totalPayments).toBe(2882.5);
    expect(validatePayslip({ ...p, warnings: [], importedAt: "" })).toEqual([]);
  });

  it("warns when Total Payments is more than Gross Pay and no expense line explains it", () => {
    const p = parsePayslipLines(samplePayslipLines({ payments: ["Salary 3000.00", "USS(CRB) 16 SS 183.00-", "Bonus 83.00"] }));
    // Bonus is taxable: its Gross Pay should have included it. Here it does not.
    const w = validatePayslip({ ...p, thisPeriod: { ...p.thisPeriod, grossPay: 2817 }, warnings: [], importedAt: "" });
    expect(w).toEqual(["Total Payments is £83.00 more than Gross Pay, but no expense line explains it."]);
  });
});
