import type { Account, AddonContext } from "@wealthfolio/addon-sdk";
import { matchNearest, withSourceRef, type MoveRow } from "@wf-addons/kit";
import type { Link, Payslip } from "./model";
import { PAYROLL_PROVIDER } from "./payroll";

export type MatchStatus = "matched" | "ambiguous" | "missing";

export interface SalaryMatch {
  payDate: string;
  status: MatchStatus;
  /** The bank row the payslip's net pay arrived as (status `matched` only). */
  activity?: MoveRow;
  /** Every row that fits the payslip, nearest date first. */
  candidates: MoveRow[];
  chosen?: "auto" | "manual";
}

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (d: Date | string | null | undefined): number => {
  const t = new Date(d ?? NaN).getTime();
  return Math.floor(t / DAY_MS);
};
const payDay = (p: Payslip): number => dayOf(`${p.payDate}T12:00:00.000Z`);

/** Whole calendar days (UTC) between the row and the pay date. */
const gap = (p: Payslip, r: MoveRow): number => Math.abs(dayOf(r.date) - payDay(p));

/**
 * Whether `r` could be the bank side of `p`'s net pay: a GBP deposit (or transfer in, which is
 * what a linked payroll transfer turns the deposit into) of the net pay to the penny, dated
 * within `windowDays` calendar days of the pay date.
 */
export function isSalaryCandidate(p: Payslip, r: MoveRow, windowDays: number): boolean {
  if (r.activityType !== "DEPOSIT" && r.activityType !== "TRANSFER_IN") return false;
  if ((r.currency ?? "").toUpperCase() !== "GBP") return false;
  const amount = Number(r.amount);
  if (!Number.isFinite(amount) || Math.abs(amount - p.netPay) > 0.01 + 1e-9) return false;
  return gap(p, r) <= windowDays;
}

/**
 * One result per payslip, in input order. A stored link whose row still exists wins (and the row
 * is not offered to the other payslips); the rest are matched by the kit's `matchNearest`: the
 * closest date wins, a tie, or a row wanted equally by two payslips, is ambiguous.
 */
export function matchSalaries(
  payslips: Payslip[],
  rows: MoveRow[],
  windowDays: number,
  links: Record<string, Link>,
): SalaryMatch[] {
  const fitting = (p: Payslip) =>
    rows
      .filter((r) => isSalaryCandidate(p, r, windowDays))
      .map((r) => ({ r, g: gap(p, r) }))
      .sort((a, b) => a.g - b.g)
      .map((x) => x.r);

  const linked = new Map<string, SalaryMatch>();
  const taken = new Set<string>();
  for (const p of payslips) {
    const link = links[p.payDate];
    const row = link && !taken.has(link.activityId) ? rows.find((r) => r.id === link.activityId) : undefined;
    if (!link || !row) continue;
    taken.add(row.id);
    const candidates = fitting(p);
    linked.set(p.payDate, {
      payDate: p.payDate,
      status: "matched",
      activity: row,
      candidates: candidates.some((c) => c.id === row.id) ? candidates : [row, ...candidates],
      chosen: link.chosen,
    });
  }

  const open = payslips.filter((p) => !linked.has(p.payDate));
  const pool = rows.filter((r) => !taken.has(r.id));
  const { pairs, ambiguous } = matchNearest(
    open,
    pool,
    (p, r) => isSalaryCandidate(p, r, windowDays),
    gap,
  );
  const paired = new Map(pairs.map((x) => [x.key, x.match]));
  const unclear = new Set(ambiguous);

  return payslips.map((p): SalaryMatch => {
    const hit = linked.get(p.payDate);
    if (hit) return hit;
    const candidates = fitting(p).filter((r) => !taken.has(r.id));
    const match = paired.get(p);
    if (match) return { payDate: p.payDate, status: "matched", activity: match, candidates, chosen: "auto" };
    return { payDate: p.payDate, status: unclear.has(p) ? "ambiguous" : "missing", candidates };
  });
}

/** Active, unarchived GBP cash accounts, except the add-on's own payroll account. */
export function defaultAccountIds(accounts: Account[]): string[] {
  return accounts
    .filter(
      (a) =>
        a.isActive !== false &&
        !a.isArchived &&
        a.accountType === "CASH" &&
        (a.currency ?? "").toUpperCase() === "GBP" &&
        a.provider !== PAYROLL_PROVIDER,
    )
    .map((a) => a.id);
}

/** The GBP deposits and transfers in of the accounts, as rows to match payslips against. */
export async function loadCandidateRows(ctx: AddonContext, accountIds: string[]): Promise<MoveRow[]> {
  const out: MoveRow[] = [];
  for (const id of accountIds) {
    for (const a of await ctx.api.activities.getAll(id)) {
      if (a.activityType !== "DEPOSIT" && a.activityType !== "TRANSFER_IN") continue;
      if ((a.currency ?? "").toUpperCase() !== "GBP") continue;
      const row = a as unknown as MoveRow & { activityDate?: Date | string };
      out.push({
        id: a.id,
        accountId: a.accountId || id,
        activityType: a.activityType,
        date: row.activityDate ?? a.date,
        amount: a.amount,
        currency: a.currency,
        comment: a.comment,
        subtype: a.subtype,
      });
    }
  }
  return out;
}

/** Writes `[ref:payslip:<payDate>]` onto the deposit's comment (an explicit button only). */
export async function tagDeposit(ctx: AddonContext, row: MoveRow, payDate: string): Promise<void> {
  const res = await ctx.api.activities.saveMany({
    updates: [
      {
        id: row.id,
        accountId: row.accountId ?? "",
        activityType: row.activityType,
        subtype: row.subtype ?? null,
        activityDate: row.date ?? new Date(0),
        amount: row.amount ?? null,
        currency: row.currency ?? undefined,
        comment: withSourceRef(row.comment, `payslip:${payDate}`),
      },
    ],
  });
  if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join("; "));
}
