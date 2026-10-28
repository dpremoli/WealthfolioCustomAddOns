import { round2 } from "@wf-addons/kit";
import type { Line, Payslip, Ytd } from "./model";
import { extractPdfLines } from "./pdf-text";
import { parseTaxPeriod } from "./tax-year";
import { validatePayslip } from "./validate";

export class PayslipFormatError extends Error {}

const AMOUNT = /(-?)(\d[\d,]*\.\d{2})(-?)/;
const AMOUNTS = new RegExp(AMOUNT.source, "g");

function toNumber(sign: string, digits: string, trailing: string): number {
  const n = Number(digits.replace(/,/g, ""));
  return round2(sign === "-" || trailing === "-" ? -n : n);
}

/** First amount in `text` (trailing '-' = negative), or undefined. */
function firstAmount(text: string): number | undefined {
  const m = AMOUNT.exec(text);
  return m ? toNumber(m[1]!, m[2]!, m[3]!) : undefined;
}

function allAmounts(text: string): number[] {
  return [...text.matchAll(AMOUNTS)].map((m) => toNumber(m[1]!, m[2]!, m[3]!));
}

/** `description [units] amount` from one half of a table row; null when it carries no amount. */
function parseRow(text: string): Line | null {
  const m = /^(.*?)\s+(\d[\d,]*\.\d{2})(-?)$/.exec(text.trim());
  if (!m) return null;
  let description = m[1]!.replace(/\s+/g, " ").trim();
  const amount = toNumber("", m[2]!, m[3]!);
  const u = /^(.*?)\s+(\d[\d,]*\.\d+)$/.exec(description);
  if (u && u[1]) {
    description = u[1];
    return { description, units: Number(u[2]!.replace(/,/g, "")), amount };
  }
  return description ? { description, amount } : null;
}

function figures(line: string | undefined): Ytd {
  const [grossPay = 0, taxablePay = 0, tax = 0, eeNic = 0] = line ? allAmounts(line) : [];
  return { grossPay, taxablePay, tax, eeNic };
}

/** Value of a labelled field, up to the next "Label:" on the same line. */
function field(lines: string[], label: RegExp): string | undefined {
  const re = new RegExp(`${label.source}\\s*:\\s*(.*?)(?=\\s{2,}[A-Za-z][A-Za-z/ ]*:|\\s*$)`);
  for (const line of lines) {
    const m = re.exec(line);
    if (m) return m[1]!.replace(/\s+/g, " ").trim();
  }
  return undefined;
}

/** A UK tax code with an optional week 1 / month 1 basis, at the start of a value. */
const TAX_CODE = /^(?:[SC])?(?:\d{1,4}[LMNTP]|K\d{1,4}|BR|D[0-2]|NT|0T)(?:\s+(?:0|1|M1|W1|X))?\b/;

function lineAfterLabel(lines: string[], label: RegExp): string | undefined {
  for (const line of lines) {
    const m = label.exec(line);
    if (m) return line.slice(m.index + m[0].length);
  }
  return undefined;
}

/**
 * Reads a SAP payslip from the text lines of its PDF, by label. The employee name, number, NI
 * number, tax reference and tax office are never read: only the right-hand fields on those header
 * lines are, each by its own label.
 */
export function parsePayslipLines(lines: string[]): Omit<Payslip, "warnings" | "importedAt"> {
  const missing = (what: string) => new PayslipFormatError(`Not a recognised SAP payslip: missing ${what}.`);

  const dateText = field(lines, /Pay Date/);
  const dm = dateText ? /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(dateText) : null;
  if (!dm) throw missing("Pay Date");
  const payDate = `${dm[3]}-${dm[2]}-${dm[1]}`;

  const periodText = field(lines, /Tax Period/);
  if (!periodText) throw missing("Tax Period");
  let period: { month: number; taxYear: number };
  try {
    period = parseTaxPeriod(periodText);
  } catch {
    throw missing("Tax Period");
  }
  // Only a value shaped like a tax code is kept: the field can run on into "Tax Office: …".
  const taxCode = TAX_CODE.exec(field(lines, /Tax Code\/Basis/) ?? "")?.[0] ?? "";

  const totalsText = lines.findIndex((l) => /\bTotal Payments\b/.test(l));
  if (totalsText < 0) throw missing("Total Payments");
  const totalPayments = firstAmount(lineAfterLabel([lines[totalsText]!], /Total Payments/) ?? "");
  if (totalPayments === undefined) throw missing("Total Payments");
  const totalDeductions = firstAmount(lineAfterLabel([lines[totalsText]!], /Total Deductions/) ?? "");
  if (totalDeductions === undefined) throw missing("Total Deductions");

  let netPay: number | undefined;
  for (const line of [...lines].reverse()) {
    netPay = firstAmount(lineAfterLabel([line], /\bNet Pay\b/) ?? "");
    if (netPay !== undefined) break;
  }
  if (netPay === undefined) throw missing("Net Pay");

  // Table: between the "Description … Amount" header and the totals line, split at the column
  // where the deductions half begins.
  const payDedIdx = lines.findIndex((l) => /\bPayments\b/.test(l) && /\bDeductions\b/.test(l));
  const payments: Line[] = [];
  const deductions: Line[] = [];
  if (payDedIdx >= 0 && payDedIdx < totalsText) {
    const headerIdx = lines.findIndex((l, i) => i > payDedIdx && /\bDescription\b/.test(l));
    if (headerIdx >= 0 && headerIdx < totalsText) {
      const header = lines[headerIdx]!;
      const first = header.indexOf("Description");
      const second = header.indexOf("Description", first + 1);
      const split =
        second > 0 ? second - 1 : Math.max(0, lines[payDedIdx]!.search(/Deductions/) - 9);
      for (const row of lines.slice(headerIdx + 1, totalsText)) {
        const left = parseRow(row.slice(0, split));
        const right = parseRow(row.slice(split));
        if (left) payments.push(left);
        if (right) deductions.push(right);
      }
    }
  }

  const thisPeriod = figures(lines.find((l) => /^\s*This Period\b/.test(l)));
  const toDate = figures(lines.find((l) => /^\s*To date\b/i.test(l)));

  return {
    payDate,
    taxYear: period.taxYear,
    period: period.month,
    taxCode,
    payments,
    deductions,
    totalPayments,
    totalDeductions,
    netPay,
    thisPeriod,
    toDate,
  };
}

/** Extracts the text of a payslip PDF, parses it and checks its figures. */
export async function parsePayslipPdf(bytes: Uint8Array, now = new Date()): Promise<Payslip> {
  const parsed = parsePayslipLines(await extractPdfLines(bytes));
  const payslip: Payslip = { ...parsed, warnings: [], importedAt: now.toISOString() };
  return { ...payslip, warnings: validatePayslip(payslip) };
}
