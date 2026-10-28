import type { AddonContext } from "@wealthfolio/addon-sdk";
import type { Payslip } from "./model";
import { parsePayslipPdf } from "./payslip-parser";
import { loadPdf } from "./pdf-store";
import { loadPayslips, savePayslips } from "./store";

export interface RefreshResult {
  /** Payslips whose figures, lines or warnings changed when re-read from their stored PDF. */
  reparsed: number;
  /** Payslips whose stored PDF reads exactly as the stored payslip. */
  unchanged: number;
  /** Payslips left as they were because their PDF could not be re-read or is for another payslip. */
  failed: { payDate: string; reason: string }[];
  /** Pay dates with no stored PDF: left as they are. */
  withoutPdf: string[];
}

/** JSON with sorted keys, so two payslips compare equal whatever order their fields were written in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

const sameFigures = (a: Payslip, b: Payslip) => canonical({ ...a, importedAt: "" }) === canonical({ ...b, importedAt: "" });

/**
 * Re-reads every stored payslip from its stored PDF with the current parser. A payslip with no
 * stored PDF, or whose PDF cannot be re-read or belongs to another pay date, stays as it is.
 * Nothing is deleted and links are not touched; the original `importedAt` is kept.
 */
export async function refreshPayslips(ctx: AddonContext, now = new Date()): Promise<RefreshResult> {
  const result: RefreshResult = { reparsed: 0, unchanged: 0, failed: [], withoutPdf: [] };
  for (const stored of await loadPayslips(ctx)) {
    const fail = (reason: string) => result.failed.push({ payDate: stored.payDate, reason });
    try {
      const bytes = await loadPdf(ctx, stored.payDate);
      if (!bytes) {
        result.withoutPdf.push(stored.payDate);
        continue;
      }
      const read = await parsePayslipPdf(bytes, now);
      if (read.payDate !== stored.payDate) {
        fail(`the stored PDF is for ${read.payDate}`);
        continue;
      }
      if (read.taxYear !== stored.taxYear) {
        fail(`the stored PDF is for tax year ${read.taxYear}, not ${stored.taxYear}`);
        continue;
      }
      const fresh: Payslip = { ...read, importedAt: stored.importedAt };
      if (sameFigures(stored, fresh)) {
        result.unchanged++;
        continue;
      }
      await savePayslips(ctx, [fresh]);
      result.reparsed++;
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }
  return result;
}
