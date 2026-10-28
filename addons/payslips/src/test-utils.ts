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
  /** Extra Type1 fonts: resource name → `/BaseFont` (e.g. `{ F2: "Times-Roman" }`), after `/F1` Courier. */
  fonts?: Record<string, string>;
  /** An image-mask XObject `/Im1` on every page, with an indirect `[/FlateDecode/RunLengthDecode]`
   *  filter array and an indirect `/Length`, as the real SAP payslips write their logos. */
  image?: ImageMaskOptions;
}

export interface ImageMaskOptions {
  widthPx: number;
  heightPx: number;
  /** Packed 1-bit samples, rows padded to whole bytes: the image data before it is encoded. */
  samples: Uint8Array;
  /** Writes `/Decode [1 0]` (a 1 sample paints). */
  invert?: boolean;
}

/** Run-length encodes (PDF RunLengthDecode): literal runs of up to 128 bytes, repeats of 2..128. */
export function runLengthEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    let run = 1;
    while (i + run < data.length && run < 128 && data[i + run] === data[i]) run++;
    if (run >= 2) {
      out.push(257 - run, data[i]!);
      i += run;
      continue;
    }
    const start = i;
    i++;
    while (i < data.length && i - start < 128 && !(i + 1 < data.length && data[i] === data[i + 1])) i++;
    out.push(i - start - 1, ...data.subarray(start, i));
  }
  out.push(128);
  return Uint8Array.from(out);
}

/**
 * A tiny synthetic image mask: a checkerboard of `cell`-pixel squares whose top-left cell paints.
 * `mask` is what a reader must produce (1 = paint, row-major); `samples` is the packed 1-bit data
 * as PDF stores it, where 0 paints under the default `/Decode [0 1]`.
 */
export function checkerImage(widthPx = 16, heightPx = 4, cell = 2) {
  const mask = new Uint8Array(widthPx * heightPx);
  const rowBytes = Math.ceil(widthPx / 8);
  const samples = new Uint8Array(rowBytes * heightPx).fill(0xff);
  for (let y = 0; y < heightPx; y++) {
    for (let x = 0; x < widthPx; x++) {
      const paint = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      mask[y * widthPx + x] = paint ? 1 : 0;
      if (paint) samples[y * rowBytes + (x >> 3)]! &= ~(0x80 >> (x & 7));
    }
  }
  return { widthPx, heightPx, mask, samples };
}

export interface RuledLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width?: number;
  /** `[r, g, b]` 0..1; default black. */
  rgb?: [number, number, number];
}

/** Content-stream text for ruled lines, as the SAP payslips write them: `q 0 0 0 RG 0.75 w x y m x y l S Q`. */
export function ruleContent(rules: RuledLine[]): string {
  return rules
    .map((r) => {
      const [cr, cg, cb] = r.rgb ?? [0, 0, 0];
      return `q ${cr} ${cg} ${cb} RG ${r.width ?? 0.75} w ${r.x1} ${r.y1} m ${r.x2} ${r.y2} l S Q`;
    })
    .join("\n");
}

/** Content-stream text that paints the `/Im1` mask into the box at (x, y), w × h, in `rgb` (default black). */
export function imageContent(x: number, y: number, w: number, h: number, rgb: [number, number, number] = [0, 0, 0]): string {
  return `q ${rgb.join(" ")} rg ${w} 0 0 ${h} ${x} ${y} cm /Im1 Do Q`;
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
  // 1 catalog, 2 pages, 3 font, pages from 4, then the content streams, then /Length integers,
  // then the extra fonts and the image (filter array, length, stream).
  const firstContent = 4 + pageCount;
  const firstLength = firstContent + contents.length;
  const extraFonts = Object.entries(opts.fonts ?? {});
  const firstExtra = firstLength + (opts.indirectLength ? contents.length : 0);
  const fontRefs = ["/F1 3 0 R", ...extraFonts.map(([name], i) => `/${name} ${firstExtra + i} 0 R`)].join(" ");
  const imageObj = firstExtra + extraFonts.length + 2; // after the filter array and the length
  const xobjects = opts.image ? ` /XObject << /Im1 ${imageObj} 0 R >>` : "";
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
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << ${fontRefs} >>${xobjects} >> /Contents ${ref} >>`,
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
  for (const [, baseFont] of extraFonts) {
    objects.push(latin1(`<< /Type /Font /Subtype /Type1 /BaseFont /${baseFont} /Encoding /WinAnsiEncoding >>`));
  }
  if (opts.image) {
    const img = opts.image;
    const encoded = new Uint8Array(deflateSync(runLengthEncode(img.samples)));
    objects.push(latin1("[/FlateDecode/RunLengthDecode]"));
    objects.push(latin1(String(encoded.length)));
    const decode = img.invert ? " /Decode [1 0]" : "";
    objects.push(
      concat([
        latin1(
          `<< /Type /XObject /Subtype /Image /ImageMask true /BitsPerComponent 1 /Width ${img.widthPx} /Height ${img.heightPx}${decode} /Filter ${imageObj - 2} 0 R /Length ${imageObj - 1} 0 R >>\nstream\n`,
        ),
        encoded,
        latin1("\nendstream"),
      ]),
    );
  }

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

/**
 * The same PDF with its page tree broken (the page object loses its `/Type /Page`, the page-tree
 * root its `/Kids`), keeping every byte offset. A reader that walks pages cannot find one; a
 * reader that only scans content streams still reads the text.
 */
export function withoutPageTree(pdf: Uint8Array): Uint8Array {
  const text = Array.from(pdf, (b) => String.fromCharCode(b)).join("");
  const broken = text.replace("/Type /Page ", "/Type /Pagx ").replace(/\/Kids \[[^\]]*\]/, (m) => "/Kids".padEnd(m.length, " "));
  return latin1(broken);
}

/**
 * The same PDF with one more XObject, `/<name>`, in the resources of every page. `dict` is the
 * object's dictionary entries (without `<<` `>>` and `/Length`); `body` its raw stream data. The
 * xref table is not updated: readers that find objects by scanning (as this add-on's do) do not mind.
 */
export function withXObject(pdf: Uint8Array, name: string, dict: string, body: Uint8Array | string): Uint8Array {
  const text = Array.from(pdf, (b) => String.fromCharCode(b)).join("");
  const data = typeof body === "string" ? latin1(body) : body;
  const number = Math.max(...[...text.matchAll(/(\d+) 0 obj/g)].map((m) => Number(m[1]))) + 1;
  const ref = `/${name} ${number} 0 R`;
  const patched = text.includes("/XObject << ")
    ? text.replaceAll("/XObject << ", `/XObject << ${ref} `)
    : text.replaceAll("/Resources << ", `/Resources << /XObject << ${ref} >> `);
  const at = patched.lastIndexOf("xref\n0 ");
  const object = concat([latin1(`${number} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`), data, latin1("\nendstream\nendobj\n")]);
  return concat([latin1(patched.slice(0, at)), object, latin1(patched.slice(at))]);
}
