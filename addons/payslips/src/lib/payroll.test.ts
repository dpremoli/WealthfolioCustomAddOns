import { sourceRefOf } from "@wf-addons/kit";
import { FakeWealthfolio, type StoredActivity } from "@wf-addons/kit/testing";
import { describe, expect, it } from "vitest";
import { samplePayslipLines } from "../test-utils";
import type { Payslip } from "./model";
import { parsePayslipLines } from "./payslip-parser";
import { PAYROLL_ACCOUNT_NAME, PAYROLL_REFUSED_KEY, ensurePayrollAccount, planPayroll, recordPayroll } from "./payroll";
import { loadCandidateRows, matchSalaries, type SalaryMatch } from "./salary-match";
import { loadLinks, saveLink } from "./store";

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
    expect(rows.map((r) => r.id)).toEqual([
      "payslip:2026-10-31:gross",
      "payslip:2026-10-31:tax",
      "payslip:2026-10-31:ni",
      "payslip:2026-10-31:net",
    ]);
  });

  it("gives every row an id by its role, not its position: other deductions by description, repeats numbered", () => {
    const p = payslip({
      deductions: ["Tax paid 380.00", "Employee NIC 150.00", "Student Loan 45.00", "Cycle scheme 20.00", "Cycle scheme 5.00"],
    });
    expect(planPayroll(p, "acc-1").map((r) => r.id)).toEqual([
      "payslip:2026-10-31:gross",
      "payslip:2026-10-31:tax",
      "payslip:2026-10-31:ni",
      "payslip:2026-10-31:ded:student-loan",
      "payslip:2026-10-31:ded:cycle-scheme",
      "payslip:2026-10-31:ded:cycle-scheme-2",
      "payslip:2026-10-31:net",
    ]);
    // An added line leaves the other rows' ids alone.
    const without = planPayroll(payslip({ deductions: ["Tax paid 380.00", "Employee NIC 150.00", "Cycle scheme 20.00"] }), "acc-1");
    expect(without.map((r) => r.id)).toContain("payslip:2026-10-31:net");
    expect(without.map((r) => r.id)).toContain("payslip:2026-10-31:ded:cycle-scheme");
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

const EXPENSE_PAYMENTS = ["Salary 3000.00", "USS(CRB) 16 SS 183.00-", "Gen Trav & Sub 45.50", "Telephone Costs 20.00"];

describe("planPayroll with expense refunds", () => {
  const expensePayslip = (over: Parameters<typeof samplePayslipLines>[0] = {}) => payslip({ payments: EXPENSE_PAYMENTS, ...over });

  it("deposits the taxable Gross Pay, then each expense line, and still sums to zero", () => {
    const rows = planPayroll(expensePayslip(), "acc-1");
    expect(rows.map((r) => [r.id, r.activityType, r.amount])).toEqual([
      ["payslip:2026-10-31:gross", "DEPOSIT", 2817],
      ["payslip:2026-10-31:exp:gen-trav-sub", "DEPOSIT", 45.5],
      ["payslip:2026-10-31:exp:telephone-costs", "DEPOSIT", 20],
      ["payslip:2026-10-31:tax", "TAX", 380],
      ["payslip:2026-10-31:ni", "TAX", 150],
      ["payslip:2026-10-31:net", "TRANSFER_OUT", 2352.5],
    ]);
    expect(signedSum(rows)).toBe(0);
    expect(rows[0]!.comment).toMatch(/^Gross pay 2026-10-31, after USS salary sacrifice £183\.00/);
    expect(rows[1]!.comment).toMatch(/^Gen Trav & Sub 2026-10-31 \(expense refund\) \[ref:payslip:2026-10-31:exp:gen-trav-sub\]$/);
    for (const r of rows) expect(sourceRefOf(r.comment)).toBe(r.id);
  });

  it("numbers a repeated expense description like a repeated deduction", () => {
    const rows = planPayroll(expensePayslip({ payments: [...EXPENSE_PAYMENTS, "Telephone Costs 5.00"] }), "acc-1");
    expect(rows.map((r) => r.id).filter((id) => id?.includes(":exp:"))).toEqual([
      "payslip:2026-10-31:exp:gen-trav-sub",
      "payslip:2026-10-31:exp:telephone-costs",
      "payslip:2026-10-31:exp:telephone-costs-2",
    ]);
    expect(signedSum(rows)).toBe(0);
  });

  it("records an unexplained refund as one deposit, so the rows still sum to zero", () => {
    const p = payslip({ payments: ["Salary 3000.00", "USS(CRB) 16 SS 183.00-", "Bonus 83.00"], thisPeriod: ["2817.00", "2817.00", "380.00", "150.00"] });
    const rows = planPayroll(p, "acc-1");
    expect(rows.map((r) => [r.id, r.activityType, r.amount])).toEqual([
      ["payslip:2026-10-31:gross", "DEPOSIT", 2817],
      ["payslip:2026-10-31:exp", "DEPOSIT", 83],
      ["payslip:2026-10-31:tax", "TAX", 380],
      ["payslip:2026-10-31:ni", "TAX", 150],
      ["payslip:2026-10-31:net", "TRANSFER_OUT", 2370],
    ]);
    expect(rows[1]!.comment).toMatch(/^Expense refunds 2026-10-31 \[ref:/);
    expect(signedSum(rows)).toBe(0);
  });

  it("falls back to Total Payments less the expense lines when Gross Pay is not printed", () => {
    const rows = planPayroll(expensePayslip({ thisPeriod: ["0.00", "0.00", "380.00", "150.00"] }), "acc-1");
    expect(rows[0]).toMatchObject({ id: "payslip:2026-10-31:gross", amount: 2817 });
    expect(signedSum(rows)).toBe(0);
  });

  it("keeps a taxable allowance in gross pay when Gross Pay already counts it", () => {
    const rows = planPayroll(
      payslip({ payments: ["Salary 3000.00", "Telephone Allowance 30.00"], thisPeriod: ["3030.00", "3030.00", "380.00", "150.00"] }),
      "acc-1",
    );
    expect(rows.map((r) => r.id)).toEqual([
      "payslip:2026-10-31:gross",
      "payslip:2026-10-31:tax",
      "payslip:2026-10-31:ni",
      "payslip:2026-10-31:net",
    ]);
    expect(rows[0]).toMatchObject({ amount: 3030 });
    expect(signedSum(rows)).toBe(0);
  });

  it("leaves a payslip without expenses with exactly the same rows as before", () => {
    expect(planPayroll(payslip(), "acc-1").map((r) => r.id)).toEqual([
      "payslip:2026-10-31:gross",
      "payslip:2026-10-31:tax",
      "payslip:2026-10-31:ni",
      "payslip:2026-10-31:net",
    ]);
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
  const matchesFor = async (host: FakeWealthfolio, payslips: Payslip[], windowDays = 4): Promise<SalaryMatch[]> =>
    matchSalaries(payslips, await loadCandidateRows(host.ctx, ["bank"]), windowDays, {});
  const payrollRows = (host: FakeWealthfolio) => {
    const acc = host.accounts.find((a) => a.name === PAYROLL_ACCOUNT_NAME);
    return acc ? host.rows(acc.id) : [];
  };

  it("records an expense payslip: gross, one deposit per expense line, tax, NI and the net transfer, balanced and linked", async () => {
    const host = newHost();
    host.stored.set("bank", [{ ...bankRow(), amount: 2352.5 }]);
    const p = payslip({ payments: EXPENSE_PAYMENTS });
    const out = await recordPayroll(host.ctx, [p], await matchesFor(host, [p]));
    expect(out).toMatchObject({ stored: 6, unsaved: [], linked: 1, linkFailed: [], skipped: [] });
    const account = host.accounts.find((a) => a.name === PAYROLL_ACCOUNT_NAME)!;
    expect(payrollRows(host).map((r) => r.activityType).sort()).toEqual(["DEPOSIT", "DEPOSIT", "DEPOSIT", "TAX", "TAX", "TRANSFER_OUT"]);
    expect(host.cash(account.id)).toBe(0);
    const again = await recordPayroll(host.ctx, [p], await matchesFor(host, [p]));
    expect(again).toMatchObject({ stored: 0, replaced: 0 });
    expect(payrollRows(host)).toHaveLength(6);
  });

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

  describe("a payslip recorded again", () => {
    // Same net pay (2287), but a different tax figure and a new student loan line.
    const corrected = () => payslip({ deductions: ["Tax paid 330.00", "Employee NIC 150.00", "Student Loan 50.00"] });

    it("replaces the rows of a corrected payslip: one transfer, a balanced account, the bank row still linked", async () => {
      const host = newHost();
      const original = payslip();
      await recordPayroll(host.ctx, [original], await matchesFor(host, [original]));
      const account = host.accounts.find((a) => a.name === PAYROLL_ACCOUNT_NAME)!;

      const fixed = corrected();
      const out = await recordPayroll(host.ctx, [fixed], await matchesFor(host, [fixed]));

      const rows = payrollRows(host);
      expect(rows.filter((r) => r.activityType === "TRANSFER_OUT")).toHaveLength(1);
      expect(rows.map((r) => sourceRefOf(r.comment)).sort()).toEqual(
        ["gross", "tax", "ni", "ded:student-loan", "net"].map((k) => `payslip:2026-10-31:${k}`).sort(),
      );
      expect(rows.find((r) => sourceRefOf(r.comment) === "payslip:2026-10-31:tax")!.amount).toBe(330);
      expect(signedSum(rows)).toBe(0);
      expect(host.cash(account.id)).toBe(0);
      expect(out).toMatchObject({ stored: 5, replaced: 1, linked: 1, linkFailed: [], unsaved: [] });

      const transfer = rows.find((r) => r.activityType === "TRANSFER_OUT")!;
      expect(host.links).toEqual([[transfer.id, "salary"]]);
      expect(host.rows("bank")[0]!.activityType).toBe("TRANSFER_IN");
    });

    it("leaves an unchanged payslip alone: nothing deleted, nothing imported", async () => {
      const host = newHost();
      const p = payslip();
      const matches = await matchesFor(host, [p]);
      await recordPayroll(host.ctx, [p], matches);
      const ids = payrollRows(host).map((r) => r.id);
      const calls = host.importCalls.length;
      const out = await recordPayroll(host.ctx, [payslip()], await matchesFor(host, [p]));
      expect(out).toMatchObject({ stored: 0, replaced: 0, linked: 0, linkFailed: [] });
      expect(host.importCalls).toHaveLength(calls);
      expect(payrollRows(host).map((r) => r.id)).toEqual(ids);
    });

    it("replaces a payslip whose amounts changed but whose rows did not", async () => {
      const host = newHost();
      const original = payslip();
      await recordPayroll(host.ctx, [original], await matchesFor(host, [original]));
      const raised = payslip({ payments: ["Salary 3100.00", "USS(CRB) 16 SS 183.00-"], deductions: ["Tax paid 480.00", "Employee NIC 150.00"] });
      const out = await recordPayroll(host.ctx, [raised], await matchesFor(host, [raised]));
      expect(out).toMatchObject({ stored: 4, replaced: 1 });
      expect(payrollRows(host)).toHaveLength(4);
      expect(payrollRows(host).find((r) => r.activityType === "DEPOSIT")!.amount).toBe(2917);
      expect(signedSum(payrollRows(host))).toBe(0);
    });

    it("replaces rows recorded under the old positional ids", async () => {
      const host = newHost();
      const p = payslip();
      const account = await ensurePayrollAccount(host.ctx);
      const legacy: [string, string, number][] = [
        ["0", "DEPOSIT", 2817],
        ["1", "TAX", 380],
        ["2", "TAX", 150],
        ["3", "TRANSFER_OUT", 2287],
      ];
      host.stored.set(
        account.id,
        legacy.map(([n, type, amount]) => ({
          ...bankRow(),
          id: `old-${n}`,
          accountId: account.id,
          activityType: type,
          amount,
          comment: `Old ${n} [ref:payslip:2026-10-31:${n}]`,
        })),
      );
      const out = await recordPayroll(host.ctx, [p], await matchesFor(host, [p]));
      expect(out).toMatchObject({ stored: 4, replaced: 1 });
      expect(payrollRows(host).map((r) => sourceRefOf(r.comment)).sort()).toEqual(
        ["gross", "tax", "ni", "net"].map((k) => `payslip:2026-10-31:${k}`).sort(),
      );
      expect(payrollRows(host).some((r) => r.id.startsWith("old-"))).toBe(false);
    });

    it("does not touch another pay date's rows", async () => {
      const host = newHost();
      const sep = payslip({ payDate: "30.09.2026", period: "06/2026" });
      const oct = payslip();
      await recordPayroll(host.ctx, [sep, oct], await matchesFor(host, [sep, oct]));
      const sepIds = payrollRows(host).filter((r) => (r.comment ?? "").includes("payslip:2026-09-30:")).map((r) => r.id);
      expect(sepIds).toHaveLength(4);
      const fixed = corrected();
      await recordPayroll(host.ctx, [sep, fixed], await matchesFor(host, [sep, fixed]));
      expect(payrollRows(host).filter((r) => (r.comment ?? "").includes("payslip:2026-09-30:")).map((r) => r.id)).toEqual(sepIds);
    });

    it("does not import a replacement when the old rows could not be deleted", async () => {
      const host = newHost();
      const original = payslip();
      await recordPayroll(host.ctx, [original], await matchesFor(host, [original]));
      const saveMany = host.ctx.api.activities.saveMany;
      host.ctx.api.activities.saveMany = async (req) => (req.deleteIds ? ({ deleted: [], errors: [{ action: "delete", message: "locked" }] } as never) : saveMany(req));
      const calls = host.importCalls.length;
      const fixed = corrected();
      const out = await recordPayroll(host.ctx, [fixed], await matchesFor(host, [fixed]));
      expect(host.importCalls).toHaveLength(calls);
      expect(out.replaced).toBe(0);
      expect(out.skipped).toEqual([expect.stringContaining("2026-10-31: could not replace the recorded rows")]);
      expect(payrollRows(host)).toHaveLength(4);
    });
  });

  describe("linking the net pay to the matched deposit", () => {
    const setBank = (host: FakeWealthfolio, rows: Partial<StoredActivity>[]) =>
      host.stored.set("bank", rows.map((r) => ({ ...bankRow(), ...r })));

    it("links a deposit that arrived late on the last day of the match window", async () => {
      const host = newHost();
      setBank(host, [{ date: new Date("2026-11-10T23:30:00.000Z") }]); // 10 calendar days after the pay date
      const p = payslip();
      const matches = await matchesFor(host, [p], 10);
      expect(matches[0]!.status).toBe("matched");
      const out = await recordPayroll(host.ctx, [p], matches, 10);
      expect(out).toMatchObject({ linked: 1, linkFailed: [] });
      expect(host.links).toHaveLength(1);
    });

    it("links a deposit late on day 7 of a 7 day window", async () => {
      const host = newHost();
      setBank(host, [{ date: new Date("2026-11-07T23:30:00.000Z") }]);
      const p = payslip();
      const out = await recordPayroll(host.ctx, [p], await matchesFor(host, [p], 7), 7);
      expect(out).toMatchObject({ linked: 1, linkFailed: [] });
    });

    it("says so when the matched deposit is a penny off the net pay, and leaves it a deposit", async () => {
      const host = newHost();
      setBank(host, [{ amount: 2287.01 }]);
      const p = payslip();
      const matches = await matchesFor(host, [p]);
      expect(matches[0]!.status).toBe("matched");
      const out = await recordPayroll(host.ctx, [p], matches, 4);
      expect(out.linked).toBe(0);
      expect(out.linkFailed).toEqual(["2026-10-31: deposit of £2,287.01 differs from net pay £2,287.00 by a penny; not linked"]);
      expect(host.links).toHaveLength(0);
      expect(host.rows("bank")[0]!.activityType).toBe("DEPOSIT");
    });

    it("says so when the matched bank row is already linked to another transfer", async () => {
      const host = newHost();
      host.accounts.push({ id: "savings", name: "Savings", currency: "GBP", accountType: "CASH" });
      host.stored.set("savings", [{ ...bankRow(), id: "other-out", accountId: "savings", activityType: "TRANSFER_OUT", comment: "To current" }]);
      setBank(host, [{ activityType: "TRANSFER_IN" }]);
      host.links.push(["other-out", "salary"]);
      const p = payslip();
      const matches = await matchesFor(host, [p]);
      expect(matches[0]).toMatchObject({ status: "matched" });
      const out = await recordPayroll(host.ctx, [p], matches, 4);
      expect(out.linked).toBe(0);
      expect(out.linkFailed).toEqual(["2026-10-31: bank row already linked to another transfer"]);
      expect(host.links).toEqual([["other-out", "salary"]]);
    });

    it("pins the match it linked, keeping a manual pick manual", async () => {
      const host = newHost();
      const p = payslip();
      await recordPayroll(host.ctx, [p], await matchesFor(host, [p]), 4);
      expect(await loadLinks(host.ctx, 2026)).toEqual({ "2026-10-31": { activityId: "salary", accountId: "bank", chosen: "auto" } });

      const other = newHost();
      await saveLink(other.ctx, "2026-10-31", { activityId: "salary", accountId: "bank", chosen: "manual" });
      await recordPayroll(other.ctx, [p], await matchesFor(other, [p]), 4);
      expect((await loadLinks(other.ctx, 2026))["2026-10-31"]).toMatchObject({ activityId: "salary", chosen: "manual" });
    });

    it("keeps a transfer's existing link when the match has moved to another deposit, and says so", async () => {
      const host = newHost();
      setBank(host, [{ id: "d1", date: new Date("2026-10-29T10:00:00.000Z") }]);
      const p = payslip();
      await recordPayroll(host.ctx, [p], await matchesFor(host, [p]), 4);
      expect(host.links).toEqual([[expect.any(String), "d1"]]);

      // A later deposit of the same amount, nearer the pay date, wins the (unpinned) match.
      host.stored.set("bank", [...host.rows("bank"), { ...bankRow(), id: "d2", date: new Date("2026-10-31T10:00:00.000Z") }]);
      const matches = await matchesFor(host, [p]);
      expect(matches[0]!.activity!.id).toBe("d2");
      const out = await recordPayroll(host.ctx, [p], matches, 4);

      expect(out.linked).toBe(0);
      expect(out.linkFailed).toEqual([
        "2026-10-31: net pay is linked to 2026-10-29 £2,287.00, not the matched deposit; kept the existing link",
      ]);
      expect(host.links).toHaveLength(1);
      expect(host.rows("bank").find((r) => r.id === "d2")!.activityType).toBe("DEPOSIT");
      expect(await loadLinks(host.ctx, 2026)).toEqual({ "2026-10-31": { activityId: "d1", accountId: "bank", chosen: "auto" } });
    });
  });

  it("accepts a match list that is not in payslip order", async () => {
    const host = newHost();
    const p = payslip();
    const matches = (await matchesFor(host, [p])) as SalaryMatch[];
    const out = await recordPayroll(host.ctx, [p], [{ payDate: "2000-01-01", status: "missing", candidates: [] }, ...matches]);
    expect(out.linked).toBe(1);
  });
});
