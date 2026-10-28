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

/**
 * The column that separates the payments half of the table from the deductions half: midway between
 * the end of the first "Amount" header and the start of the second "Description" header. Without
 * those it is read off the "Deductions" title, which sits 8.5 columns right of it.
 */
function columnBoundary(header: string, titles: string): number {
  const firstDescription = header.indexOf("Description");
  const secondDescription = header.indexOf("Description", firstDescription + 1);
  const amount = header.indexOf("Amount");
  const amountEnd = amount >= 0 ? amount + "Amount".length : -1;
  if (secondDescription > 0 && amountEnd > 0 && amountEnd < secondDescription) return (amountEnd + secondDescription) / 2;
  if (secondDescription > 0) return secondDescription - 3.5;
  const deductions = titles.search(/Deductions/);
  return deductions >= 0 ? deductions - 8.5 : header.length / 2;
}

/**
 * Where the payments "Amount" column ends (the end of the first "Amount" header), or undefined when
 * the header has no such label.
 */
function paymentAmountEnd(header: string): number | undefined {
  const amount = header.indexOf("Amount");
  return amount >= 0 ? amount + "Amount".length : undefined;
}

/** How far left of the "Amount" header's end a number may end and still be a payment amount. */
const AMOUNT_COLUMN_SLACK = 3;

/**
 * One table row as its payments half and its deductions half. The payments half is the text up to
 * and including the last number that ends at or before `boundary` (a Units value before it stays in
 * the text); the deductions half is the rest, or the whole row when no number ends that early.
 * When `amountEnd` is known, a last number that ends further left than the Amount column is a Units
 * value, not a payment: the payments half is then empty and the number is dropped.
 */
function splitRow(row: string, boundary: number, amountEnd?: number): [string, string] {
  let cut = 0;
  for (const m of row.matchAll(AMOUNTS)) {
    const end = m.index + m[0].length;
    if (end <= boundary) cut = end;
  }
  if (cut > 0 && amountEnd !== undefined && cut < amountEnd - AMOUNT_COLUMN_SLACK) return ["", row.slice(cut)];
  return [row.slice(0, cut), row.slice(cut)];
}

/** The figures header's labels, in print order, each with the pattern that finds it. */
const FIGURE_LABELS: [keyof Ytd, RegExp][] = [
  ["grossPay", /Gross Pay/],
  ["taxablePay", /Taxable Pay/],
  ["tax", /\bTax\b/],
  ["eeNic", /EE's NIC/],
];

/** The end column of each figure's label on the figures header line; undefined when a label is missing. */
function figureColumns(header: string | undefined): number[] | undefined {
  if (!header) return undefined;
  const ends: number[] = [];
  for (const [, label] of FIGURE_LABELS) {
    const m = label.exec(header);
    if (!m) return undefined;
    ends.push(m.index + m[0].length);
  }
  return ends;
}

/**
 * The four figures of a "This Period" / "To date" line. By column when the header's label ends are
 * known: each amount goes to the label whose end is nearest the amount's end (amounts are
 * right-aligned under their label), so a blank Tax column leaves tax 0 and does not push the NIC
 * amount into it. Otherwise, or when two amounts claim one label, in order of appearance.
 */
function figures(line: string | undefined, columns?: number[]): Ytd {
  const out: Ytd = { grossPay: 0, taxablePay: 0, tax: 0, eeNic: 0 };
  if (!line) return out;
  if (columns) {
    const taken = new Set<number>();
    const byColumn = { ...out };
    for (const m of line.matchAll(AMOUNTS)) {
      const end = m.index + m[0].length;
      let nearest = 0;
      columns.forEach((col, i) => {
        if (Math.abs(col - end) < Math.abs(columns[nearest]! - end)) nearest = i;
      });
      if (taken.has(nearest)) return orderFigures(line);
      taken.add(nearest);
      byColumn[FIGURE_LABELS[nearest]![0]] = toNumber(m[1]!, m[2]!, m[3]!);
    }
    return byColumn;
  }
  return orderFigures(line);
}

function orderFigures(line: string): Ytd {
  const [grossPay = 0, taxablePay = 0, tax = 0, eeNic = 0] = allAmounts(line);
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

  // Table: between the "Description … Amount" header and the totals line, each row split into its
  // payments and deductions halves by where its amounts end.
  const payDedIdx = lines.findIndex((l) => /\bPayments\b/.test(l) && /\bDeductions\b/.test(l));
  const payments: Line[] = [];
  const deductions: Line[] = [];
  if (payDedIdx >= 0 && payDedIdx < totalsText) {
    const headerIdx = lines.findIndex((l, i) => i > payDedIdx && /\bDescription\b/.test(l));
    if (headerIdx >= 0 && headerIdx < totalsText) {
      const boundary = columnBoundary(lines[headerIdx]!, lines[payDedIdx]!);
      const amountEnd = paymentAmountEnd(lines[headerIdx]!);
      for (const row of lines.slice(headerIdx + 1, totalsText)) {
        const [left, right] = splitRow(row, boundary, amountEnd);
        const payment = parseRow(left);
        const deduction = parseRow(right);
        if (payment) payments.push(payment);
        if (deduction) deductions.push(deduction);
      }
    }
  }

  const figuresIdx = lines.findIndex((l) => /Gross Pay/.test(l) && /Taxable Pay/.test(l) && /EE's NIC/.test(l));
  const columns = figureColumns(lines[figuresIdx]);
  const thisPeriod = figures(lines.find((l) => /^\s*This Period\b/.test(l)), columns);
  const toDate = figures(lines.find((l) => /^\s*To date\b/i.test(l)), columns);

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
