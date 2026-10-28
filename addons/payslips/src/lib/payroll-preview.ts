import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { sourceRefOf, type MoveRow } from "@wf-addons/kit";
import type { Payslip } from "./model";
import { comparePayslip, planPayroll, type PayslipStatus, type RecordedRow } from "./payroll";
import type { SalaryMatch } from "./salary-match";

export interface PreviewRow {
  id: string;
  payDate: string;
  activityType: ActivityImport["activityType"];
  amount: number;
  comment: string;
  /** The Payroll account already holds this row and the payslip is unchanged (recording it again adds nothing). */
  alreadyRecorded: boolean;
}

export interface PayslipPreview {
  payDate: string;
  status: PayslipStatus;
  /** Rows the Payroll account has for this pay date that recording would delete (status `changed`). */
  replaces: number;
  /** Rows recording would add. */
  adds: number;
}

/** "new", "unchanged (already recorded)" or "changed — N rows will be replaced". */
export function payslipStatusLabel(p: PayslipPreview): string {
  if (p.status === "new") return "new";
  if (p.status === "unchanged") return "unchanged (already recorded)";
  if (p.status === "partial") return `partly recorded — ${p.adds} ${p.adds === 1 ? "row" : "rows"} will be added`;
  return `changed — ${p.replaces} ${p.replaces === 1 ? "row" : "rows"} will be replaced`;
}

export interface PayrollPreview {
  rows: PreviewRow[];
  /** One entry per payslip that would be recorded. */
  payslips: PayslipPreview[];
  /** "<payDate>: <first warning>" of the payslips left out. */
  skipped: string[];
  /** Bank deposits `recordPayroll` would turn into transfers and link to the payroll transfer. */
  conversions: {
    payDate: string;
    activity: MoveRow;
    alreadyTransfer: boolean;
    /** The deposit is a penny off the net pay: it matches, but is not converted or linked. */
    pennyOff: boolean;
  }[];
}

/**
 * What `recordPayroll` would do, without writing anything: the rows of every payslip without
 * warnings (`accountId` is a placeholder while the Payroll account does not exist yet) and the
 * matched bank deposits that would be converted to TRANSFER_IN and linked.
 */
export function previewPayroll(
  payslips: Payslip[],
  matches: SalaryMatch[],
  accountId: string,
  existing: RecordedRow[],
): PayrollPreview {
  const rows: PreviewRow[] = [];
  const statuses: PayslipPreview[] = [];
  const skipped: string[] = [];
  const conversions: PayrollPreview["conversions"] = [];
  const byDate = new Map(matches.map((m) => [m.payDate, m]));
  for (const p of payslips) {
    if (p.warnings.length > 0) {
      skipped.push(`${p.payDate}: ${p.warnings[0]}`);
      continue;
    }
    const planned = planPayroll(p, accountId);
    const { status, recorded, missing } = comparePayslip(planned, existing, p.payDate);
    statuses.push({ payDate: p.payDate, status, replaces: status === "changed" ? recorded.length : 0, adds: missing.length });
    const have = new Set(recorded.map((r) => sourceRefOf(r.comment)));
    for (const r of planned) {
      rows.push({
        id: r.id ?? "",
        payDate: p.payDate,
        activityType: r.activityType,
        amount: Number(r.amount ?? 0),
        comment: r.comment ?? "",
        alreadyRecorded: status !== "changed" && have.has(r.id),
      });
    }
    const match = byDate.get(p.payDate);
    if (match?.status === "matched" && match.activity) {
      conversions.push({
        payDate: p.payDate,
        activity: match.activity,
        alreadyTransfer: match.activity.activityType === "TRANSFER_IN",
        pennyOff: !(Math.abs(Number(match.activity.amount) - p.netPay) < 0.005),
      });
    }
  }
  return { rows, payslips: statuses, skipped, conversions };
}
