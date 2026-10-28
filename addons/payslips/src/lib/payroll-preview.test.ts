import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { describe, expect, it } from "vitest";
import { samplePayslipLines } from "../test-utils";
import type { Payslip } from "./model";
import { planPayroll } from "./payroll";
import { payslipStatusLabel, previewPayroll } from "./payroll-preview";
import { parsePayslipLines } from "./payslip-parser";
import type { SalaryMatch } from "./salary-match";

const slip = (over: Parameters<typeof samplePayslipLines>[0] = {}, warnings: string[] = []): Payslip => ({
  ...parsePayslipLines(samplePayslipLines(over)),
  warnings,
  importedAt: "2026-11-02T09:00:00.000Z",
});

/** What `activities.getAll` would answer for rows already recorded. */
const recorded = (rows: ActivityImport[]) => rows.map((r) => ({ activityType: r.activityType, amount: r.amount, comment: r.comment }));

const good = slip();
const bad = slip({ payDate: "30.11.2026", period: "08/2026" }, ["Payments do not add up to Total Payments"]);
const deposit = { id: "dep-1", accountId: "acc-1", activityType: "DEPOSIT", date: "2026-10-31", amount: 2287, currency: "GBP" };
const matched: SalaryMatch = { payDate: "2026-10-31", status: "matched", activity: deposit, candidates: [deposit] };

describe("previewPayroll", () => {
  it("lists the rows planPayroll would write for payslips without warnings, and skips the others", () => {
    const p = previewPayroll([good, bad], [matched], "payroll-new", []);
    expect(p.rows.map((r) => r.id)).toEqual(planPayroll(good, "payroll-new").map((r) => r.id));
    expect(p.rows.every((r) => r.payDate === "2026-10-31" && !r.alreadyRecorded)).toBe(true);
    expect(p.rows.reduce((n, r) => n + (r.activityType === "DEPOSIT" ? r.amount : -r.amount), 0)).toBeCloseTo(0, 2);
    expect(p.skipped).toEqual(["2026-11-30: Payments do not add up to Total Payments"]);
  });

  it("calls a payslip new, unchanged or changed by comparing its rows with the Payroll account's", () => {
    const fresh = previewPayroll([good], [], "acc-p", []);
    expect(fresh.payslips).toEqual([{ payDate: "2026-10-31", status: "new", replaces: 0, adds: 4 }]);
    expect(fresh.rows.every((r) => !r.alreadyRecorded)).toBe(true);

    const same = previewPayroll([good], [], "acc-p", recorded(planPayroll(good, "acc-p")));
    expect(same.payslips).toEqual([{ payDate: "2026-10-31", status: "unchanged", replaces: 0, adds: 0 }]);
    expect(same.rows.every((r) => r.alreadyRecorded)).toBe(true);

    const corrected = slip({ deductions: ["Tax paid 330.00", "Employee NIC 150.00", "Student Loan 50.00"] });
    const changed = previewPayroll([corrected], [], "acc-p", recorded(planPayroll(good, "acc-p")));
    expect(changed.payslips).toEqual([{ payDate: "2026-10-31", status: "changed", replaces: 4, adds: 5 }]);
    expect(changed.rows.every((r) => !r.alreadyRecorded)).toBe(true);
    expect(payslipStatusLabel(changed.payslips[0]!)).toBe("changed — 4 rows will be replaced");
    expect(payslipStatusLabel(same.payslips[0]!)).toBe("unchanged (already recorded)");
    expect(payslipStatusLabel(fresh.payslips[0]!)).toBe("new");
  });

  it("calls a payslip changed when only an amount differs, and when old positional rows exist", () => {
    const planned = planPayroll(good, "acc-p");
    const amountOff = recorded(planned).map((r) => (r.activityType === "TAX" ? { ...r, amount: 1 } : r));
    expect(previewPayroll([good], [], "acc-p", amountOff).payslips[0]).toMatchObject({ status: "changed", replaces: 4 });
    const legacy = recorded(planned).map((r, i) => ({ ...r, comment: `x [ref:payslip:2026-10-31:${i}]` }));
    expect(previewPayroll([good], [], "acc-p", legacy).payslips[0]).toMatchObject({ status: "changed", replaces: 4 });
  });

  it("calls a payslip partly recorded, not changed, when the account has only some of its rows (the host refused the rest)", () => {
    const some = recorded(planPayroll(good, "acc-p")).filter((r) => r.activityType !== "TAX");
    const p = previewPayroll([good], [], "acc-p", some);
    expect(p.payslips).toEqual([{ payDate: "2026-10-31", status: "partial", replaces: 0, adds: 2 }]);
    expect(payslipStatusLabel(p.payslips[0]!)).toBe("partly recorded — 2 rows will be added");
    expect(p.rows.filter((r) => r.alreadyRecorded).map((r) => r.activityType).sort()).toEqual(["DEPOSIT", "TRANSFER_OUT"]);
  });

  it("marks a matched deposit a penny off the net pay as one that will not be linked", () => {
    const penny = { ...matched, activity: { ...deposit, amount: 2287.01 } };
    expect(previewPayroll([good], [penny], "p", []).conversions).toEqual([
      { payDate: "2026-10-31", activity: penny.activity, alreadyTransfer: false, pennyOff: true },
    ]);
  });

  it("ignores rows of other pay dates when judging a payslip", () => {
    const other = recorded(planPayroll(slip({ payDate: "30.09.2026", period: "06/2026" }), "acc-p"));
    expect(previewPayroll([good], [], "acc-p", other).payslips[0]).toMatchObject({ status: "new", replaces: 0 });
  });

  it("lists the bank deposits that would become transfers, only for matched payslips that will be recorded", () => {
    const ambiguous: SalaryMatch = { payDate: "2026-10-31", status: "ambiguous", candidates: [deposit] };
    expect(previewPayroll([good], [matched], "p", []).conversions).toEqual([
      { payDate: "2026-10-31", activity: deposit, alreadyTransfer: false, pennyOff: false },
    ]);
    expect(previewPayroll([good], [ambiguous], "p", []).conversions).toEqual([]);
    const badMatch: SalaryMatch = { ...matched, payDate: "2026-11-30" };
    expect(previewPayroll([bad], [badMatch], "p", []).conversions).toEqual([]);
    const already = { ...matched, activity: { ...deposit, activityType: "TRANSFER_IN" } };
    expect(previewPayroll([good], [already], "p", []).conversions[0]?.alreadyTransfer).toBe(true);
  });
});
