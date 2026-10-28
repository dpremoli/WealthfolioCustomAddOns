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
import { employeeNi, incomeTax, isNi, isTax, ussSacrifice, type Payslip } from "./model";
import type { SalaryMatch } from "./salary-match";

export const PAYROLL_PROVIDER = "payslips-addon";
export const PAYROLL_PROVIDER_ACCOUNT_ID = "payroll";
export const PAYROLL_ACCOUNT_NAME = "Payroll";
export const PAYROLL_REFUSED_KEY = "payroll-refused";

/** How far apart the payroll transfer and the bank deposit may be dated when linking them. */
const LINK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const gbp = (n: number) => `£${n.toFixed(2)}`;

/**
 * The rows that record one payslip in the payroll account: gross pay in, income tax, employee NI,
 * each other deduction, and the net pay out as a transfer (the bank side of it is the salary
 * deposit). Ids are `payslip:<payDate>:<n>`, also the `[ref:…]` of the comment, so recording a
 * payslip again adds nothing. Deposits minus everything else is 0 for a payslip that validates.
 */
export function planPayroll(p: Payslip, accountId: string): ActivityImport[] {
  const date = `${p.payDate}T12:00:00.000Z`;
  const row = (n: number, activityType: ActivityImport["activityType"], amount: number, text: string): ActivityImport => {
    const id = `payslip:${p.payDate}:${n}`;
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
    row(0, "DEPOSIT", p.totalPayments, `Gross pay ${p.payDate}${sacrifice > 0 ? `, after USS salary sacrifice ${gbp(sacrifice)}` : ""}`),
  ];
  const tax = incomeTax(p);
  if (tax !== 0) rows.push(row(1, "TAX", tax, `Income tax ${p.payDate}`));
  const ni = employeeNi(p);
  if (ni !== 0) rows.push(row(2, "TAX", ni, `Employee NI ${p.payDate}`));
  let n = 3;
  for (const l of p.deductions) {
    if (isTax(l.description) || isNi(l.description) || l.amount === 0) continue;
    rows.push(row(n++, "WITHDRAWAL", l.amount, `${l.description} ${p.payDate}`));
  }
  rows.push(row(n, "TRANSFER_OUT", p.netPay, `Net pay ${p.payDate}`));
  return rows;
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
): Promise<PayrollOutcome> {
  const out: PayrollOutcome = { stored: 0, unsaved: [], linked: 0, linkFailed: [], skipped: [] };
  const recordable: Payslip[] = [];
  for (const p of payslips) {
    if (p.warnings.length > 0) out.skipped.push(`${p.payDate}: ${p.warnings[0]}`);
    else recordable.push(p);
  }
  const refused = await loadRefused(ctx.api.storage, PAYROLL_REFUSED_KEY);
  // Nothing to record and nothing to retry: do not even create the account.
  if (recordable.length === 0 && refused.entries.length === 0) return out;

  const account = await ensurePayrollAccount(ctx);
  const desired = recordable.flatMap((p) => planPayroll(p, account.id));
  const rows = pendingRows(refused, account.id, desired);
  const existing = await ctx.api.activities.getAll(account.id);
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
  const byDate = new Map(matches.map((m) => [m.payDate, m]));
  const stored = await ctx.api.activities.getAll(account.id);
  for (const p of recordable) {
    const match = byDate.get(p.payDate);
    if (match?.status !== "matched" || !match.activity) continue;
    const outId = planPayroll(p, account.id).find((r) => r.activityType === "TRANSFER_OUT")?.id;
    const transfer = stored.find((r) => r.activityType === "TRANSFER_OUT" && sourceRefOf(r.comment) === outId);
    if (!transfer) continue; // refused by the host: retried (and linked) on a later run
    const res = await convertAndLinkMoves(ctx, [transfer as unknown as MoveRow], [match.activity], LINK_WINDOW_MS);
    out.linked += res.linked;
    out.linkFailed.push(...res.failed);
  }
  return out;
}
