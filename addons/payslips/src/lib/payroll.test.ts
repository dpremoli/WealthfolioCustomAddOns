import { sourceRefOf } from "@wf-addons/kit";
import { FakeWealthfolio, type StoredActivity } from "@wf-addons/kit/testing";
import { describe, expect, it } from "vitest";
import { samplePayslipLines } from "../test-utils";
import type { Payslip } from "./model";
import { parsePayslipLines } from "./payslip-parser";
import { PAYROLL_ACCOUNT_NAME, PAYROLL_REFUSED_KEY, planPayroll, recordPayroll } from "./payroll";
import { loadCandidateRows, matchSalaries, type SalaryMatch } from "./salary-match";

const payslip = (over: Parameters<typeof samplePayslipLines>[0] = {}, warnings: string[] = []): Payslip => ({
  ...parsePayslipLines(samplePayslipLines(over)),
  warnings,
  importedAt: "2026-11-02T09:00:00.000Z",
});

const SIGN: Record<string, number> = { DEPOSIT: 1 };
const signedSum = (rows: { activityType: string; amount?: unknown }[]) =>
  Math.round(rows.reduce((s, r) => s + (SIGN[r.activityType] ?? -1) * Number(r.amount), 0) * 100) / 100;

describe("planPayroll", () => {
  it("plans a deposit, income tax, NI and the net pay transfer, summing to zero", () => {
    const rows = planPayroll(payslip(), "acc-1");
    expect(rows.map((r) => [r.activityType, r.amount])).toEqual([
      ["DEPOSIT", 2817],
      ["TAX", 380],
      ["TAX", 150],
      ["TRANSFER_OUT", 2287],
    ]);
    expect(signedSum(rows)).toBe(0);
    for (const r of rows) {
      expect(r).toMatchObject({ accountId: "acc-1", currency: "GBP", symbol: "$CASH-GBP", isValid: true, isDraft: false });
      expect(r.comment).toContain("[ref:payslip:2026-10-31:");
      expect(sourceRefOf(r.comment)).toBe(r.id);
    }
    expect(rows[0]!.comment).toMatch(/^Gross pay 2026-10-31, after USS salary sacrifice £183\.00/);
    expect(rows[1]!.comment).toMatch(/^Income tax 2026-10-31/);
    expect(rows[2]!.comment).toMatch(/^Employee NI 2026-10-31/);
    expect(rows[3]!.comment).toMatch(/^Net pay 2026-10-31/);
    expect(new Set(rows.map((r) => r.id)).size).toBe(4);
    expect(rows[0]!.id).toBe("payslip:2026-10-31:0");
  });

  it("adds a withdrawal for every other deduction and still sums to zero", () => {
    const p = payslip({ deductions: ["Tax paid 380.00", "Employee NIC 150.00", "Student Loan 45.00", "Cycle scheme 20.00"] });
    const rows = planPayroll(p, "acc-1");
    expect(rows.map((r) => [r.activityType, r.amount, (r.comment ?? "").split(" [ref")[0]])).toEqual([
      ["DEPOSIT", 2817, "Gross pay 2026-10-31, after USS salary sacrifice £183.00"],
      ["TAX", 380, "Income tax 2026-10-31"],
      ["TAX", 150, "Employee NI 2026-10-31"],
      ["WITHDRAWAL", 45, "Student Loan 2026-10-31"],
      ["WITHDRAWAL", 20, "Cycle scheme 2026-10-31"],
      ["TRANSFER_OUT", 2222, "Net pay 2026-10-31"],
    ]);
    expect(signedSum(rows)).toBe(0);
    expect(new Set(rows.map((r) => r.id)).size).toBe(6);
  });

  it("leaves out the tax and NI rows when there are none, and the sacrifice note without a sacrifice", () => {
    const p = payslip({ payments: ["Salary 3000.00"], deductions: ["Student Loan 45.00"] });
    const rows = planPayroll(p, "acc-1");
    expect(rows.map((r) => r.activityType)).toEqual(["DEPOSIT", "WITHDRAWAL", "TRANSFER_OUT"]);
    expect(rows[0]!.comment).toMatch(/^Gross pay 2026-10-31 \[ref:/);
    expect(signedSum(rows)).toBe(0);
  });
});

describe("recordPayroll", () => {
  const bankRow = (): StoredActivity => ({
    id: "salary",
    accountId: "bank",
    activityType: "DEPOSIT",
    date: new Date("2026-10-31T00:00:00.000Z"),
    assetSymbol: null,
    exchangeMic: null,
    quantity: null,
    unitPrice: null,
    amount: 2287,
    fee: null,
    currency: "GBP",
    comment: "ACME LTD SALARY",
  });
  const newHost = () => {
    const host = new FakeWealthfolio([{ id: "bank", name: "Bank", currency: "GBP", accountType: "CASH" }]);
    host.stored.set("bank", [bankRow()]);
    return host;
  };
  const matchesFor = async (host: FakeWealthfolio, payslips: Payslip[]): Promise<SalaryMatch[]> =>
    matchSalaries(payslips, await loadCandidateRows(host.ctx, ["bank"]), 4, {});
  const payrollRows = (host: FakeWealthfolio) => {
    const acc = host.accounts.find((a) => a.name === PAYROLL_ACCOUNT_NAME);
    return acc ? host.rows(acc.id) : [];
  };

  it("creates the Payroll account, stores the rows and links the bank deposit", async () => {
    const host = newHost();
    const p = payslip();
    const out = await recordPayroll(host.ctx, [p], await matchesFor(host, [p]));
    expect(out).toMatchObject({ stored: 4, unsaved: [], linked: 1, linkFailed: [], skipped: [] });
    expect(out.refusedError).toBeUndefined();

    const account = host.accounts.find((a) => a.name === "Payroll")!;
    expect(account).toMatchObject({ currency: "GBP", accountType: "CASH", provider: "payslips-addon", providerAccountId: "payroll", trackingMode: "TRANSACTIONS" });
    const rows = payrollRows(host);
    expect(rows.map((r) => r.activityType).sort()).toEqual(["DEPOSIT", "TAX", "TAX", "TRANSFER_OUT"]);
    expect(host.cash(account.id)).toBe(0);

    expect(host.links).toHaveLength(1);
    const payrollOut = rows.find((r) => r.activityType === "TRANSFER_OUT")!;
    expect(host.links[0]).toEqual([payrollOut.id, "salary"]);
    expect(host.rows("bank")[0]!.activityType).toBe("TRANSFER_IN");
  });

  it("recording twice adds nothing", async () => {
    const host = newHost();
    const p = payslip();
    const matches = await matchesFor(host, [p]);
    await recordPayroll(host.ctx, [p], matches);
    const calls = host.importCalls.length;
    const again = await recordPayroll(host.ctx, [p], matches);
    expect(again).toMatchObject({ stored: 0, unsaved: [], linked: 0, linkFailed: [] });
    expect(payrollRows(host)).toHaveLength(4);
    expect(host.links).toHaveLength(1);
    expect(host.accounts.filter((a) => a.name === "Payroll")).toHaveLength(1);
    expect(host.importCalls.length).toBe(calls);
  });

  it("keeps a row the host refuses, imports the others, and stores it once the host accepts", async () => {
    const host = newHost();
    host.validation = (a) => (a.activityType === "TAX" ? "nope" : null);
    const p = payslip();
    const matches = await matchesFor(host, [p]);
    const first = await recordPayroll(host.ctx, [p], matches);
    expect(first.stored).toBe(2);
    expect(first.unsaved.map((u) => u.activity.activityType)).toEqual(["TAX", "TAX"]);
    expect(first.unsaved[0]!.reason).toContain("nope");
    expect(first.refusedError).toMatch(/refused/i);
    expect(payrollRows(host).map((r) => r.activityType).sort()).toEqual(["DEPOSIT", "TRANSFER_OUT"]);
    expect(JSON.parse(host.storage.get(PAYROLL_REFUSED_KEY)!).entries).toHaveLength(2);
    expect(first.linked).toBe(1);

    host.validation = () => null;
    // The refused rows are retried even when the caller offers no new payslip.
    const second = await recordPayroll(host.ctx, [p], matches);
    expect(second).toMatchObject({ stored: 2, unsaved: [], linked: 0 });
    expect(second.refusedError).toBeUndefined();
    expect(host.storage.has(PAYROLL_REFUSED_KEY)).toBe(false);
    expect(payrollRows(host)).toHaveLength(4);
  });

  it("skips a payslip with warnings and writes nothing for it", async () => {
    const host = newHost();
    const bad = payslip({}, ["Net pay 2000.00 differs from payments minus deductions 2287.00"]);
    const out = await recordPayroll(host.ctx, [bad], await matchesFor(host, [bad]));
    expect(out.skipped).toEqual(["2026-10-31: Net pay 2000.00 differs from payments minus deductions 2287.00"]);
    expect(out).toMatchObject({ stored: 0, linked: 0 });
    expect(host.accounts.some((a) => a.name === "Payroll")).toBe(false);
    expect(host.links).toHaveLength(0);
    expect(host.importCalls).toHaveLength(0);
  });

  it("stores the rows and links nothing when no deposit matched", async () => {
    const host = newHost();
    host.stored.set("bank", []);
    const p = payslip();
    const matches = await matchesFor(host, [p]);
    expect(matches[0]!.status).toBe("missing");
    const out = await recordPayroll(host.ctx, [p], matches);
    expect(out).toMatchObject({ stored: 4, linked: 0, linkFailed: [] });
    expect(host.links).toHaveLength(0);
  });

  it("records one payslip with a match and one without", async () => {
    const host = newHost();
    const oct = payslip();
    const sep = payslip({ payDate: "30.09.2026", period: "06/2026" });
    const matches = await matchesFor(host, [sep, oct]);
    const out = await recordPayroll(host.ctx, [sep, oct], matches);
    expect(out).toMatchObject({ stored: 8, linked: 1 });
    expect(host.links).toHaveLength(1);
  });

  it("accepts a match list that is not in payslip order", async () => {
    const host = newHost();
    const p = payslip();
    const matches = (await matchesFor(host, [p])) as SalaryMatch[];
    const out = await recordPayroll(host.ctx, [p], [{ payDate: "2000-01-01", status: "missing", candidates: [] }, ...matches]);
    expect(out.linked).toBe(1);
  });
});
