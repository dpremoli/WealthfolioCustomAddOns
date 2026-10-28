import type { Account } from "@wealthfolio/addon-sdk";
import type { MoveRow } from "@wf-addons/kit";
import { FakeWealthfolio, type StoredActivity } from "@wf-addons/kit/testing";
import { describe, expect, it } from "vitest";
import { samplePayslipLines } from "../test-utils";
import type { Link, Payslip } from "./model";
import { parsePayslipLines } from "./payslip-parser";
import { PAYROLL_PROVIDER } from "./payroll";
import { defaultAccountIds, isSalaryCandidate, loadCandidateRows, matchSalaries, tagDeposit } from "./salary-match";

const payslip = (payDate = "31.10.2026", period = "07/2026"): Payslip => ({
  ...parsePayslipLines(samplePayslipLines({ payDate, period })),
  warnings: [],
  importedAt: "2026-11-02T09:00:00.000Z",
});

const oct = payslip();
const sep = payslip("30.09.2026", "06/2026");

const dep = (id: string, date: string, over: Partial<MoveRow> = {}): MoveRow => ({
  id,
  accountId: "bank",
  activityType: "DEPOSIT",
  date,
  amount: "2287.00",
  currency: "GBP",
  ...over,
});

describe("matchSalaries", () => {
  it("matches a deposit within the window and a penny of the net pay", () => {
    const [m] = matchSalaries([oct], [dep("a", "2026-10-30T00:00:00.000Z")], 4, {});
    expect(m).toMatchObject({ payDate: "2026-10-31", status: "matched", chosen: "auto" });
    expect(m!.activity?.id).toBe("a");
    expect(isSalaryCandidate(oct, dep("b", "2026-10-30", { amount: 2287.004 }), 4)).toBe(true);
    // A penny either way still matches (rounding on the bank side).
    expect(isSalaryCandidate(oct, dep("b", "2026-10-30", { amount: 2287.01 }), 4)).toBe(true);
    expect(isSalaryCandidate(oct, dep("b", "2026-10-30", { amount: 2286.99 }), 4)).toBe(true);
  });

  it("does not match outside the window", () => {
    const [m] = matchSalaries([oct], [dep("a", "2026-11-06T00:00:00.000Z")], 4, {});
    expect(m!.status).toBe("missing");
    expect(m!.candidates).toEqual([]);
  });

  it("counts a deposit late on the last day of the window", () => {
    const [m] = matchSalaries([oct], [dep("a", "2026-11-04T23:30:00.000Z")], 4, {});
    expect(m!.status).toBe("matched");
  });

  it("does not match an amount off by 0.02", () => {
    const [m] = matchSalaries([oct], [dep("a", "2026-10-31T00:00:00.000Z", { amount: 2287.02 })], 4, {});
    expect(m!.status).toBe("missing");
  });

  it("is ambiguous when two deposits are equally near, and lists both", () => {
    const rows = [dep("a", "2026-10-30T12:00:00.000Z"), dep("b", "2026-11-01T12:00:00.000Z")];
    const [m] = matchSalaries([oct], rows, 4, {});
    expect(m!.status).toBe("ambiguous");
    expect(m!.activity).toBeUndefined();
    expect(m!.candidates.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("same net pay in consecutive months matches each month", () => {
    const rows = [dep("oct", "2026-10-31T00:00:00.000Z"), dep("sep", "2026-09-30T00:00:00.000Z")];
    const res = matchSalaries([sep, oct], rows, 4, {});
    expect(res.map((m) => [m.payDate, m.status, m.activity?.id])).toEqual([
      ["2026-09-30", "matched", "sep"],
      ["2026-10-31", "matched", "oct"],
    ]);
  });

  it("lets a manual link win over a closer auto match, and keeps its row from the others", () => {
    const rows = [dep("near", "2026-10-31T00:00:00.000Z"), dep("far", "2026-11-03T00:00:00.000Z")];
    const links: Record<string, Link> = { "2026-10-31": { activityId: "far", accountId: "bank", chosen: "manual" } };
    const [m] = matchSalaries([oct], rows, 4, links);
    expect(m).toMatchObject({ status: "matched", chosen: "manual" });
    expect(m!.activity?.id).toBe("far");

    // The linked row is taken out of the pool: the other payslip cannot claim it.
    const sepClose = dep("sepclose", "2026-10-01T00:00:00.000Z");
    const res = matchSalaries([sep, oct], [...rows, sepClose], 4, {
      "2026-10-31": { activityId: "sepclose", accountId: "bank", chosen: "manual" },
    });
    expect(res[0]!.status).toBe("missing");
    expect(res[1]!.activity?.id).toBe("sepclose");
  });

  it("falls back to auto when the linked row is gone", () => {
    const links: Record<string, Link> = { "2026-10-31": { activityId: "gone", accountId: "bank", chosen: "manual" } };
    const [m] = matchSalaries([oct], [dep("a", "2026-10-31T00:00:00.000Z")], 4, links);
    expect(m).toMatchObject({ status: "matched", chosen: "auto" });
    expect(m!.activity?.id).toBe("a");
  });

  it("never matches a withdrawal, and takes a TRANSFER_IN (a linked payroll transfer)", () => {
    const rows = [dep("w", "2026-10-31T00:00:00.000Z", { activityType: "WITHDRAWAL" })];
    expect(matchSalaries([oct], rows, 4, {})[0]!.status).toBe("missing");
    const t = [dep("t", "2026-10-31T00:00:00.000Z", { activityType: "TRANSFER_IN" })];
    expect(matchSalaries([oct], t, 4, {})[0]!.activity?.id).toBe("t");
  });

  it("ignores deposits in another currency", () => {
    const [m] = matchSalaries([oct], [dep("u", "2026-10-31T00:00:00.000Z", { currency: "USD" })], 4, {});
    expect(m!.status).toBe("missing");
    expect(isSalaryCandidate(oct, dep("g", "2026-10-31", { currency: "gbp" }), 4)).toBe(true);
  });
});

describe("defaultAccountIds", () => {
  const acc = (over: Partial<Account>): Account =>
    ({ id: "x", name: "x", accountType: "CASH", currency: "GBP", isActive: true, isArchived: false, ...over }) as Account;

  it("keeps active, unarchived GBP cash accounts that are not the payroll account", () => {
    const ids = defaultAccountIds([
      acc({ id: "ok" }),
      acc({ id: "inactive", isActive: false }),
      acc({ id: "archived", isArchived: true }),
      acc({ id: "securities", accountType: "SECURITIES" as Account["accountType"] }),
      acc({ id: "usd", currency: "USD" }),
      acc({ id: "payroll", provider: PAYROLL_PROVIDER, providerAccountId: "payroll" }),
    ]);
    expect(ids).toEqual(["ok"]);
  });
});

describe("on the fake host", () => {
  const stored = (over: Partial<StoredActivity>): StoredActivity => ({
    id: "r",
    accountId: "bank",
    activityType: "DEPOSIT",
    date: new Date("2026-10-30T00:00:00.000Z"),
    assetSymbol: null,
    exchangeMic: null,
    quantity: null,
    unitPrice: null,
    amount: 2287,
    fee: null,
    currency: "GBP",
    comment: "ACME LTD",
    ...over,
  });
  const newHost = () => {
    const host = new FakeWealthfolio([{ id: "bank", name: "Bank", currency: "GBP", accountType: "CASH" }]);
    host.stored.set("bank", [
      stored({ id: "dep" }),
      stored({ id: "tin", activityType: "TRANSFER_IN" }),
      stored({ id: "out", activityType: "WITHDRAWAL" }),
      stored({ id: "usd", currency: "USD" }),
    ]);
    return host;
  };

  it("loadCandidateRows reads only GBP deposits and transfers in", async () => {
    const rows = await loadCandidateRows(newHost().ctx, ["bank"]);
    expect(rows.map((r) => r.id).sort()).toEqual(["dep", "tin"]);
    expect(rows[0]).toMatchObject({ accountId: "bank", currency: "GBP", amount: 2287 });
  });

  it("tagDeposit writes the payslip ref onto the comment", async () => {
    const host = newHost();
    const [row] = await loadCandidateRows(host.ctx, ["bank"]);
    await tagDeposit(host.ctx, row!, "2026-10-31");
    const after = host.rows("bank").find((r) => r.id === row!.id)!;
    expect(after.comment).toBe("ACME LTD [ref:payslip:2026-10-31]");
    expect(after.activityType).toBe("DEPOSIT");
  });

  it("tagDeposit throws when the host reports errors", async () => {
    const host = newHost();
    await expect(tagDeposit(host.ctx, { id: "nope", accountId: "bank", activityType: "DEPOSIT", date: "2026-10-30" }, "2026-10-31")).rejects.toThrow(
      /not found/i,
    );
  });
});
