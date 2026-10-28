import type { ActivityImport } from "@wealthfolio/addon-sdk";
import type { MoveRow } from "@wf-addons/kit";
import type { Payslip } from "./model";
import { planPayroll } from "./payroll";
import type { SalaryMatch } from "./salary-match";

export interface PreviewRow {
  id: string;
  payDate: string;
  activityType: ActivityImport["activityType"];
  amount: number;
  comment: string;
  /** The Payroll account already holds this row (recording it again adds nothing). */
  alreadyRecorded: boolean;
}

export interface PayrollPreview {
  rows: PreviewRow[];
  /** "<payDate>: <first warning>" of the payslips left out. */
  skipped: string[];
  /** Bank deposits `recordPayroll` would turn into transfers and link to the payroll transfer. */
  conversions: { payDate: string; activity: MoveRow; alreadyTransfer: boolean }[];
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
  existingRefs: Set<string>,
): PayrollPreview {
  const rows: PreviewRow[] = [];
  const skipped: string[] = [];
  const conversions: PayrollPreview["conversions"] = [];
  const byDate = new Map(matches.map((m) => [m.payDate, m]));
  for (const p of payslips) {
    if (p.warnings.length > 0) {
      skipped.push(`${p.payDate}: ${p.warnings[0]}`);
      continue;
    }
    for (const r of planPayroll(p, accountId)) {
      rows.push({
        id: r.id ?? "",
        payDate: p.payDate,
        activityType: r.activityType,
        amount: Number(r.amount ?? 0),
        comment: r.comment ?? "",
        alreadyRecorded: existingRefs.has(r.id ?? ""),
      });
    }
    const match = byDate.get(p.payDate);
    if (match?.status === "matched" && match.activity) {
      conversions.push({ payDate: p.payDate, activity: match.activity, alreadyTransfer: match.activity.activityType === "TRANSFER_IN" });
    }
  }
  return { rows, skipped, conversions };
}
