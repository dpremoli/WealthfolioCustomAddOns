import { deflateSync } from "node:zlib";

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

/**
 * A valid PDF 1.3 with one page per content stream (catalog, pages, a Type1 Courier `/F1`
 * with WinAnsiEncoding, exact xref offsets). `contents` are raw content-stream texts, so
 * tests can hand-write operators the line-based `writePdf` never emits.
 */
export function rawPdf(contents: (string | Uint8Array)[], opts: { flate?: boolean } = {}): Uint8Array {
  const pageCount = contents.length;
  // 1 catalog, 2 pages, 3 font, then (page, content) pairs from 4.
  const objects: Uint8Array[] = [];
  const kids = contents.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects.push(latin1("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.push(latin1(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`));
  objects.push(latin1("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"));
  contents.forEach((content, i) => {
    const contentId = 5 + i * 2;
    objects.push(
      latin1(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
    const raw = typeof content === "string" ? latin1(content) : content;
    const body = opts.flate ? new Uint8Array(deflateSync(raw)) : raw;
    const filter = opts.flate ? " /Filter /FlateDecode" : "";
    objects.push(
      concat([
        latin1(`<< /Length ${body.length}${filter} >>\nstream\n`),
        body,
        latin1("\nendstream"),
      ]),
    );
  });

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
export function writePdf(pages: string[][], opts: { flate?: boolean } = {}): Uint8Array {
  const contents = pages.map((lines) =>
    lines
      .map((line, i) => {
        const spaces = line.length - line.trimStart().length;
        const x = (LEFT_MARGIN + spaces * CHAR_WIDTH).toFixed(2);
        const y = TOP - i * LINE_STEP;
        return `BT ${x} ${y} Td /F1 ${FONT_SIZE} Tf <${hexOf(line.trimStart())}> Tj ET`;
      })
      .join("\n"),
  );
  return rawPdf(contents, opts);
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
  const thisPeriod = over.thisPeriod ?? [totalPayments, totalPayments, "380.00", "150.00"];
  const toDate = over.toDate ?? ["19719.00", "19719.00", "2660.00", "1050.00"];

  const lines: string[] = [];
  lines.push(`      Employee Name  : ZZNAME TESTPERSON          Pay Date  : ${payDate}`);
  lines.push(`      Employee Number: 99999999                   Tax Period: ${period}`);
  lines.push(`      NI Number      : QQ123456C                  Tax Ref   : 123/AB456`);
  lines.push(`      Tax Code/Basis : ${taxCode.padEnd(27)}Tax Office: Faketown`);
  lines.push(`                      Payments                          Deductions`);
  const headerLeft = " ".repeat(PAY_COL) + "Description       Units     Amount";
  lines.push(headerLeft.padEnd(DED_COL) + "Description      Amount");

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
  return lines;
}
