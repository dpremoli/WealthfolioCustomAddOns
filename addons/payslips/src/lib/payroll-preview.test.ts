import { describe, expect, it } from "vitest";
import { samplePayslipLines } from "../test-utils";
import type { Payslip } from "./model";
import { planPayroll } from "./payroll";
import { previewPayroll } from "./payroll-preview";
import { parsePayslipLines } from "./payslip-parser";
import type { SalaryMatch } from "./salary-match";

const slip = (over: Parameters<typeof samplePayslipLines>[0] = {}, warnings: string[] = []): Payslip => ({
  ...parsePayslipLines(samplePayslipLines(over)),
  warnings,
  importedAt: "2026-11-02T09:00:00.000Z",
});

const good = slip();
const bad = slip({ payDate: "30.11.2026", period: "08/2026" }, ["Payments do not add up to Total Payments"]);
const deposit = { id: "dep-1", accountId: "acc-1", activityType: "DEPOSIT", date: "2026-10-31", amount: 2287, currency: "GBP" };
const matched: SalaryMatch = { payDate: "2026-10-31", status: "matched", activity: deposit, candidates: [deposit] };

describe("previewPayroll", () => {
  it("lists the rows planPayroll would write for payslips without warnings, and skips the others", () => {
    const p = previewPayroll([good, bad], [matched], "payroll-new", new Set());
    expect(p.rows.map((r) => r.id)).toEqual(planPayroll(good, "payroll-new").map((r) => r.id));
    expect(p.rows.every((r) => r.payDate === "2026-10-31" && !r.alreadyRecorded)).toBe(true);
    expect(p.rows.reduce((n, r) => n + (r.activityType === "DEPOSIT" ? r.amount : -r.amount), 0)).toBeCloseTo(0, 2);
    expect(p.skipped).toEqual(["2026-11-30: Payments do not add up to Total Payments"]);
  });

  it("marks rows the Payroll account already has", () => {
    const first = planPayroll(good, "x")[0]!.id!;
    const p = previewPayroll([good], [], "acc-p", new Set([first]));
    expect(p.rows.filter((r) => r.alreadyRecorded).map((r) => r.id)).toEqual([first]);
  });

  it("lists the bank deposits that would become transfers, only for matched payslips that will be recorded", () => {
    const ambiguous: SalaryMatch = { payDate: "2026-10-31", status: "ambiguous", candidates: [deposit] };
    expect(previewPayroll([good], [matched], "p", new Set()).conversions).toEqual([
      { payDate: "2026-10-31", activity: deposit, alreadyTransfer: false },
    ]);
    expect(previewPayroll([good], [ambiguous], "p", new Set()).conversions).toEqual([]);
    const badMatch: SalaryMatch = { ...matched, payDate: "2026-11-30" };
    expect(previewPayroll([bad], [badMatch], "p", new Set()).conversions).toEqual([]);
    const already = { ...matched, activity: { ...deposit, activityType: "TRANSFER_IN" } };
    expect(previewPayroll([good], [already], "p", new Set()).conversions[0]?.alreadyTransfer).toBe(true);
  });
});
