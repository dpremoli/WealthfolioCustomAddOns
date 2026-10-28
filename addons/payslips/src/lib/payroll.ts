import type { Account, ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import {
  cashSymbol,
  convertAndLinkMoves,
  importStoredRows,
  loadRefused,
  pendingRows,
  recordRefused,
  refusedError,
  round2,
  saveRefused,
  selectNewActivities,
  sourceRefOf,
  withSourceRef,
  type MoveRow,
  type UnsavedRow,
} from "@wf-addons/kit";
import { gbp as pounds, isoDay } from "./format";
import { employeeNi, incomeTax, isNi, isTax, ussSacrifice, type Link, type Payslip } from "./model";
import type { SalaryMatch } from "./salary-match";
import { loadLinks, loadSettings, saveLink } from "./store";
import { taxYearOf } from "./tax-year";

export const PAYROLL_PROVIDER = "payslips-addon";
export const PAYROLL_PROVIDER_ACCOUNT_ID = "payroll";
export const PAYROLL_ACCOUNT_NAME = "Payroll";
export const PAYROLL_REFUSED_KEY = "payroll-refused";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A salary matched within `windowDays` calendar days can be nearly a day further away in time. */
const linkWindowMs = (windowDays: number) => (windowDays + 1) * DAY_MS;

const gbp = (n: number) => `£${n.toFixed(2)}`;

const slugOf = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";

/**
 * The rows that record one payslip in the payroll account: gross pay in, income tax, employee NI,
 * each other deduction, and the net pay out as a transfer (the bank side of it is the salary
 * deposit). A row's id is its role, also the `[ref:…]` of its comment: `payslip:<payDate>:gross`,
 * `:tax`, `:ni`, `:net` and `:ded:<description slug>` (`-2`, `-3` for a repeat on one payslip), so
 * it does not move when a line is added to a corrected payslip. Deposits minus everything else is
 * 0 for a payslip that validates.
 */
export function planPayroll(p: Payslip, accountId: string): ActivityImport[] {
  const date = `${p.payDate}T12:00:00.000Z`;
  const row = (role: string, activityType: ActivityImport["activityType"], amount: number, text: string): ActivityImport => {
    const id = `payslip:${p.payDate}:${role}`;
    return {
      id,
      accountId,
      activityType,
      date,
      amount: round2(amount),
      currency: "GBP",
      symbol: cashSymbol("GBP"),
      comment: withSourceRef(text, id),
      isValid: true,
      isDraft: false,
    };
  };
  const sacrifice = ussSacrifice(p);
  const rows: ActivityImport[] = [
    row("gross", "DEPOSIT", p.totalPayments, `Gross pay ${p.payDate}${sacrifice > 0 ? `, after USS salary sacrifice ${gbp(sacrifice)}` : ""}`),
  ];
  const tax = incomeTax(p);
  if (tax !== 0) rows.push(row("tax", "TAX", tax, `Income tax ${p.payDate}`));
  const ni = employeeNi(p);
  if (ni !== 0) rows.push(row("ni", "TAX", ni, `Employee NI ${p.payDate}`));
  const seen = new Map<string, number>();
  for (const l of p.deductions) {
    if (isTax(l.description) || isNi(l.description) || l.amount === 0) continue;
    const slug = slugOf(l.description);
    const nth = (seen.get(slug) ?? 0) + 1;
    seen.set(slug, nth);
    rows.push(row(`ded:${nth > 1 ? `${slug}-${nth}` : slug}`, "WITHDRAWAL", l.amount, `${l.description} ${p.payDate}`));
  }
  rows.push(row("net", "TRANSFER_OUT", p.netPay, `Net pay ${p.payDate}`));
  return rows;
}

/** The fields of a stored activity (`activities.getAll`) needed to compare it with a planned row. */
export interface RecordedRow {
  id?: string;
  activityType: string;
  amount?: number | string | null;
  comment?: string | null;
}

/**
 * `new`: the account has no row for the pay date. `unchanged`: it has exactly the planned rows.
 * `partial`: it has some of them, each as planned (the host refused the rest), so the others are
 * simply added. `changed`: a row is not in the plan, or differs in type or amount, so the rows of
 * the pay date are replaced.
 */
export type PayslipStatus = "new" | "unchanged" | "partial" | "changed";

/** The rows of `existing` that record the payslip of `payDate` (old positional ids included). */
export function recordedRowsFor<E extends RecordedRow>(existing: E[], payDate: string): E[] {
  const prefix = `payslip:${payDate}:`;
  return existing.filter((r) => sourceRefOf(r.comment)?.startsWith(prefix));
}

/**
 * How a payslip's planned rows stand against the rows the account already has for its pay date.
 * `recorded` are the account's rows for the date; `missing` the planned rows it does not have.
 */
export function comparePayslip<E extends RecordedRow>(
  planned: ActivityImport[],
  existing: E[],
  payDate: string,
): { status: PayslipStatus; recorded: E[]; missing: ActivityImport[] } {
  const recorded = recordedRowsFor(existing, payDate);
  if (recorded.length === 0) return { status: "new", recorded, missing: planned };
  const have = new Map(recorded.map((r) => [sourceRefOf(r.comment), r]));
  const plan = new Map(planned.map((p) => [p.id, p]));
  const asPlanned =
    have.size === recorded.length &&
    recorded.every((r) => {
      const p = plan.get(sourceRefOf(r.comment));
      return !!p && r.activityType === p.activityType && Math.abs(Number(r.amount) - Number(p.amount)) < 0.005;
    });
  const missing = planned.filter((p) => !have.has(p.id));
  if (!asPlanned) return { status: "changed", recorded, missing: planned };
  return { status: missing.length === 0 ? "unchanged" : "partial", recorded, missing };
}

export function findPayrollAccount(accounts: Account[]): Account | undefined {
  return accounts.find((a) => a.provider === PAYROLL_PROVIDER && a.providerAccountId === PAYROLL_PROVIDER_ACCOUNT_ID);
}

/** The payroll account, created (once) on first use. */
export async function ensurePayrollAccount(ctx: AddonContext): Promise<Account> {
  const found = findPayrollAccount(await ctx.api.accounts.getAll());
  if (found) return found;
  return ctx.api.accounts.create({
    name: PAYROLL_ACCOUNT_NAME,
    accountType: "CASH",
    currency: "GBP",
    isDefault: false,
    isActive: true,
    trackingMode: "TRANSACTIONS",
    provider: PAYROLL_PROVIDER,
    providerAccountId: PAYROLL_PROVIDER_ACCOUNT_ID,
  });
}

export interface PayrollOutcome {
  /** Rows the host stored in this call. */
  stored: number;
  /** Rows the host did not store, with its reason; they wait in the refused store and are retried. */
  unsaved: UnsavedRow[];
  /** Set while the refused store is not empty. */
  refusedError?: string;
  /** Payslips whose rows were deleted and recorded again because they had changed. */
  replaced: number;
  /** Payroll transfers linked to a bank deposit. */
  linked: number;
  linkFailed: string[];
  /** Payslips left out, as "<payDate>: <first warning>". */
  skipped: string[];
}

/**
 * Records payslips in the payroll account (explicit button only) and links each net-pay transfer
 * with the bank deposit it was matched to. Idempotent: every row carries its ref, so a payslip
 * already recorded adds nothing and a linked pair is skipped.
 */
export async function recordPayroll(
  ctx: AddonContext,
  payslips: Payslip[],
  matches: SalaryMatch[],
  /** The match window `matches` were made with (the saved setting when omitted). */
  windowDays?: number,
): Promise<PayrollOutcome> {
  const out: PayrollOutcome = { stored: 0, unsaved: [], replaced: 0, linked: 0, linkFailed: [], skipped: [] };
  let recordable: Payslip[] = [];
  for (const p of payslips) {
    if (p.warnings.length > 0) out.skipped.push(`${p.payDate}: ${p.warnings[0]}`);
    else recordable.push(p);
  }
  const refused = await loadRefused(ctx.api.storage, PAYROLL_REFUSED_KEY);
  // Nothing to record and nothing to retry: do not even create the account.
  if (recordable.length === 0 && refused.entries.length === 0) return out;

  const account = await ensurePayrollAccount(ctx);
  let existing = await ctx.api.activities.getAll(account.id);

  // A payslip whose rows differ from what the account has is replaced: its old rows go first.
  const stay: Payslip[] = [];
  for (const p of recordable) {
    const { status, recorded } = comparePayslip(planPayroll(p, account.id), existing, p.payDate);
    if (status !== "changed") {
      stay.push(p);
      continue;
    }
    const gone = new Set(recorded.flatMap((r) => (r.id ? [r.id] : [])));
    try {
      const res = await ctx.api.activities.saveMany({ deleteIds: [...gone] });
      if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join("; "));
    } catch (err) {
      // Importing the new rows beside the old ones would leave the account out of balance.
      out.skipped.push(`${p.payDate}: could not replace the recorded rows (${(err as Error).message})`);
      existing = await ctx.api.activities.getAll(account.id);
      continue;
    }
    existing = existing.filter((r) => !gone.has(r.id));
    out.replaced++;
    stay.push(p);
  }
  recordable = stay;

  const desired = recordable.flatMap((p) => planPayroll(p, account.id));
  const rows = pendingRows(refused, account.id, desired);
  const toImport = selectNewActivities(rows, existing);
  const sending = new Set(toImport.map((r) => r.id));
  const result = await importStoredRows((batch) => ctx.api.activities.import(batch), toImport);
  const accounted = [...result.stored, ...result.duplicates, ...rows.filter((r) => !sending.has(r.id))];
  const now = recordRefused(refused, accounted, result.unsaved);
  const kept = await saveRefused(ctx.api.storage, PAYROLL_REFUSED_KEY, now);
  out.stored = result.stored.length;
  out.unsaved = result.unsaved;
  out.refusedError = refusedError(kept);

  // Link each recorded payslip's net-pay transfer with its matched bank deposit.
  const days = windowDays ?? (await loadSettings(ctx)).windowDays;
  const byDate = new Map(matches.map((m) => [m.payDate, m]));
  const stored = await ctx.api.activities.getAll(account.id);
  const linksByYear = new Map<number, Record<string, Link>>();
  const chosenOf = async (payDate: string): Promise<"auto" | "manual"> => {
    const year = taxYearOf(payDate);
    if (!linksByYear.has(year)) linksByYear.set(year, await loadLinks(ctx, year));
    return linksByYear.get(year)![payDate]?.chosen ?? "auto";
  };
  for (const p of recordable) {
    const match = byDate.get(p.payDate);
    if (match?.status !== "matched" || !match.activity) continue;
    const outId = planPayroll(p, account.id).find((r) => r.activityType === "TRANSFER_OUT")?.id;
    const transfer = stored.find((r) => r.activityType === "TRANSFER_OUT" && sourceRefOf(r.comment) === outId);
    if (!transfer) continue; // refused by the host: retried (and linked) on a later run
    const bank = match.activity;
    const pin = (row: { id: string; accountId?: string }, chosen: "auto" | "manual") =>
      saveLink(ctx, p.payDate, { activityId: row.id, accountId: row.accountId ?? bank.accountId ?? "", chosen });

    // Already linked: to the matched deposit (fine), or to another row (kept, and said so).
    const pair = await ctx.api.activities.getTransferPair(transfer.id).catch(() => null);
    if (pair) {
      const to = pair.transferIn.id === transfer.id ? pair.transferOut : pair.transferIn;
      if (to.id === bank.id) {
        await pin(bank, await chosenOf(p.payDate));
      } else {
        out.linkFailed.push(
          `${p.payDate}: net pay is linked to ${isoDay(dateOf(to))} ${pounds(Number(to.amount))}, not the matched deposit; kept the existing link`,
        );
        await pin(to, "auto");
      }
      continue;
    }

    const bankAmount = Number(bank.amount);
    if (!(Math.abs(bankAmount - p.netPay) < 0.005)) {
      out.linkFailed.push(
        `${p.payDate}: deposit of ${pounds(bankAmount)} differs from net pay ${pounds(p.netPay)} by a penny; not linked`,
      );
      continue;
    }
    const res = await convertAndLinkMoves(ctx, [transfer as unknown as MoveRow], [bank], linkWindowMs(days));
    out.linkFailed.push(...res.failed);
    out.linked += res.linked;
    if (await isLinkedTo(ctx, transfer.id, bank.id)) {
      await pin(bank, await chosenOf(p.payDate));
    } else if ((await ctx.api.activities.getTransferPair(bank.id).catch(() => null)) != null) {
      out.linkFailed.push(`${p.payDate}: bank row already linked to another transfer`);
    } else if (res.failed.length === 0) {
      out.linkFailed.push(`${p.payDate}: net pay was not linked to the matched deposit`);
    }
  }
  return out;
}

/** The date of an activity: the host's `activityDate` (the fake host keeps `date`). */
const dateOf = (a: object): string | Date | undefined => (a as { activityDate?: string }).activityDate ?? (a as { date?: Date }).date;

async function isLinkedTo(ctx: AddonContext, id: string, otherId: string): Promise<boolean> {
  const pair = await ctx.api.activities.getTransferPair(id).catch(() => null);
  return !!pair && (pair.transferOut.id === otherId || pair.transferIn.id === otherId);
}
