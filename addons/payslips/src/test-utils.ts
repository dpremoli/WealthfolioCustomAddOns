import { deflateSync } from "node:zlib";
import { EXPENSE_RE } from "./lib/model";

/**
 * Test helpers: a tiny PDF 1.3 writer and a synthetic SAP payslip text builder.
 * Every value is fake (the repo is public).
 */

const FONT_SIZE = 8;
const CHAR_WIDTH = 0.6 * FONT_SIZE;
const LEFT_MARGIN = 20;
const TOP = 800;
const LINE_STEP = 10;

/** Columns the writer's left margin adds to every line once extracted (round(20 / 4.8)). */
export const PDF_MARGIN_COLS = Math.round(LEFT_MARGIN / CHAR_WIDTH);

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** windows-1252 hex for a text line: '£' is 0xA3, everything else its low byte. */
function hexOf(text: string): string {
  let hex = "";
  for (const ch of text) {
    const code = ch === "£" ? 0xa3 : ch.charCodeAt(0) & 0xff;
    hex += code.toString(16).padStart(2, "0");
  }
  return hex;
}

export interface RawPdfOptions {
  flate?: boolean;
  /** Write each stream's `/Length` as an indirect reference to an integer object. */
  indirectLength?: boolean;
  /** Line ending after the `stream` keyword (default `\n`). */
  streamEol?: "\n" | "\r\n";
  /** Line ending between the stream data and `endstream` (default `\n`). */
  endEol?: "\n" | "\r\n" | "\r" | "\n\n";
  /** Page layout: each entry lists the indexes of the `contents` that make up that page
   *  (one stream = `/Contents n 0 R`, several = `/Contents [a b]`). Default: one page per stream. */
  pages?: number[][];
}

/**
 * A valid PDF 1.3 (catalog, pages, a Type1 Courier `/F1` with WinAnsiEncoding, exact xref
 * offsets). By default one page per content stream; `opts.pages` groups streams into pages.
 * `contents` are raw content-stream texts, so tests can hand-write operators the line-based
 * `writePdf` never emits.
 */
export function rawPdf(contents: (string | Uint8Array)[], opts: RawPdfOptions = {}): Uint8Array {
  const pages = opts.pages ?? contents.map((_, i) => [i]);
  const pageCount = pages.length;
  const streamEol = opts.streamEol ?? "\n";
  const endEol = opts.endEol ?? "\n";
  // 1 catalog, 2 pages, 3 font, pages from 4, then the content streams, then /Length integers.
  const firstContent = 4 + pageCount;
  const firstLength = firstContent + contents.length;
  const objects: Uint8Array[] = [];
  const kids = pages.map((_, i) => `${4 + i} 0 R`).join(" ");
  objects.push(latin1("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.push(latin1(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`));
  objects.push(latin1("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"));
  for (const streams of pages) {
    const refs = streams.map((k) => `${firstContent + k} 0 R`);
    const ref = refs.length === 1 ? refs[0]! : `[${refs.join(" ")}]`;
    objects.push(
      latin1(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${ref} >>`,
      ),
    );
  }
  const lengths: number[] = [];
  contents.forEach((content, i) => {
    const raw = typeof content === "string" ? latin1(content) : content;
    const body = opts.flate ? new Uint8Array(deflateSync(raw)) : raw;
    lengths.push(body.length);
    const filter = opts.flate ? " /Filter /FlateDecode" : "";
    const length = opts.indirectLength ? `${firstLength + i} 0 R` : String(body.length);
    objects.push(
      concat([
        latin1(`<< /Length ${length}${filter} >>\nstream${streamEol}`),
        body,
        latin1(`${endEol}endstream`),
      ]),
    );
  });
  if (opts.indirectLength) for (const n of lengths) objects.push(latin1(String(n)));

  const chunks: Uint8Array[] = [latin1("%PDF-1.3\n%\xe2\xe3\xcf\xd3\n")];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(offset);
    const piece = concat([latin1(`${i + 1} 0 obj\n`), obj, latin1("\nendobj\n")]);
    chunks.push(piece);
    offset += piece.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(latin1(xref));
  return concat(chunks);
}

/**
 * PDF with one page per entry of `pages` and one `BT x y Td /F1 8 Tf <hex> Tj ET` block per
 * line. Leading spaces become an x offset of `spaces * 0.6 * 8` from a left margin of 20; y
 * starts at 800 and steps down 10.
 */
export function writePdf(pages: string[][], opts: RawPdfOptions = {}): Uint8Array {
  return rawPdf(pages.map((lines) => lineContent(lines)), opts);
}

/** The content-stream text `writePdf` writes for `lines`; `firstRow` offsets y for a stream that
 *  continues a page started in another stream. */
export function lineContent(lines: string[], firstRow = 0): string {
  return lines
    .map((line, i) => {
      const spaces = line.length - line.trimStart().length;
      const x = (LEFT_MARGIN + spaces * CHAR_WIDTH).toFixed(2);
      const y = TOP - (firstRow + i) * LINE_STEP;
      return `BT ${x} ${y} Td /F1 ${FONT_SIZE} Tf <${hexOf(line.trimStart())}> Tj ET`;
    })
    .join("\n");
}

export interface SampleOptions {
  /** `dd.mm.yyyy` */
  payDate?: string;
  /** `MM/YYYY` */
  period?: string;
  taxCode?: string;
  /** Rows as "Description amount" (amount last; a trailing `-` makes it negative). */
  payments?: string[];
  deductions?: string[];
  /** Default: the sum of the rows. */
  totalPayments?: string;
  totalDeductions?: string;
  netPay?: string;
  /** gross, taxable, tax, NIC (strings, as printed). */
  thisPeriod?: [string, string, string, string];
  toDate?: [string, string, string, string];
}

const PAY_COL = 6;
const PAY_AMOUNT_END = 46; // exclusive; a trailing '-' sits in the last column
const DED_COL = 48;
const DED_AMOUNT_END = 75;
const ADDRESS_COL = 64;

function parseRow(row: string): { desc: string; amount: string } {
  const m = /^(.*\S)\s+(\d[\d,]*\.\d{2}-?)$/.exec(row.trim());
  if (!m) throw new Error(`Bad sample row: ${row}`);
  return { desc: m[1]!, amount: m[2]! };
}

function signed(amount: string): number {
  const neg = amount.endsWith("-");
  const n = Number(amount.replace(/[,-]/g, ""));
  return neg ? -n : n;
}

function money(n: number): string {
  return n.toFixed(2);
}

function rightAt(text: string, end: number): string {
  return text.padStart(end);
}

/** Synthetic SAP payslip text, one string per line (all names and numbers are fake). */
export function samplePayslipLines(over: SampleOptions = {}): string[] {
  const payDate = over.payDate ?? "31.10.2026";
  const period = over.period ?? "07/2026";
  const taxCode = over.taxCode ?? "1257L  0";
  const payments = (over.payments ?? ["Salary 3000.00", "USS(CRB) 16 SS 183.00-"]).map(parseRow);
  const deductions = (over.deductions ?? ["Tax paid 380.00", "Employee NIC 150.00"]).map(parseRow);
  const sumP = payments.reduce((s, r) => s + signed(r.amount), 0);
  const sumD = deductions.reduce((s, r) => s + signed(r.amount), 0);
  const totalPayments = over.totalPayments ?? money(sumP);
  const totalDeductions = over.totalDeductions ?? money(sumD);
  const netPay = over.netPay ?? money(sumP - sumD);
  // Expense refunds are paid but are not taxable Gross Pay.
  const expenses = payments.filter((r) => EXPENSE_RE.test(r.desc) && signed(r.amount) > 0).reduce((s, r) => s + signed(r.amount), 0);
  const gross = money(Number(totalPayments.replace(/,/g, "")) - expenses);
  const thisPeriod = over.thisPeriod ?? [gross, gross, "380.00", "150.00"];
  const toDate = over.toDate ?? ["19719.00", "19719.00", "2660.00", "1050.00"];

  const lines: string[] = [];
  lines.push(`      Employee Name  : ZZNAME TESTPERSON          Pay Date  : ${payDate}`);
  lines.push(`      Employee Number: 99999999                   Tax Period: ${period}`);
  lines.push(`      NI Number      : QQ123456C                  Tax Ref   : 123/AB456`);
  lines.push(`      Tax Code/Basis : ${taxCode.padEnd(27)}Tax Office: Faketown`);
  // The employer's address, printed at the right of the page above the table.
  for (const part of ["Example House", "1 Sample Road", "Faketown", "ZZ1 1ZZ"]) lines.push(" ".repeat(ADDRESS_COL) + part);
  lines.push(`                      Payments                          Deductions`);
  // Column spans of the real layout: Description (10,21) Units (28,33) Amount (38,44), then
  // Description (51,62) Amount (68,74).
  lines.push(
    " ".repeat(10) + "Description" + " ".repeat(7) + "Units" + " ".repeat(5) + "Amount" +
      " ".repeat(7) + "Description" + " ".repeat(6) + "Amount",
  );

  const rows = Math.max(payments.length, deductions.length);
  for (let i = 0; i < rows; i++) {
    let line = "";
    const p = payments[i];
    if (p) {
      const amount = p.amount.endsWith("-") ? p.amount : `${p.amount} `;
      line = " ".repeat(PAY_COL) + p.desc;
      line = line.padEnd(PAY_AMOUNT_END - amount.length) + amount;
    }
    const d = deductions[i];
    if (d) {
      line = line.padEnd(DED_COL) + d.desc;
      line = line.padEnd(DED_AMOUNT_END - d.amount.length) + d.amount;
    }
    lines.push(line);
  }

  let totals = " ".repeat(PAY_COL + 1) + "Total Payments";
  totals = totals.padEnd(PAY_AMOUNT_END - totalPayments.length - 1) + `${totalPayments} `;
  totals = totals.padEnd(DED_COL) + "Total Deductions";
  totals = totals.padEnd(DED_AMOUNT_END - totalDeductions.length) + totalDeductions;
  lines.push(totals);

  lines.push(`                         Gross Pay    Taxable Pay      Tax        EE's NIC`);
  const figures = (label: string, v: string[]) =>
    `      ${label.padEnd(11)}${rightAt(v[0]!, 12)}${rightAt(v[1]!, 15)}${rightAt(v[2]!, 14)}${rightAt(v[3]!, 14)}`;
  lines.push(figures("This Period", thisPeriod));
  lines.push(figures("To date", toDate));
  lines.push(`${" ".repeat(48)}Net Pay${rightAt(netPay, 15)}`);
  lines.push("      Notes:");
  return lines;
}
