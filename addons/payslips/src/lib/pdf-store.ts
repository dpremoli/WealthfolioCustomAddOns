import type { AddonContext } from "@wealthfolio/addon-sdk";
import { jsonStore } from "@wf-addons/kit";

/**
 * The original payslip PDFs. One storage value per pay date (`pdf:<YYYY-MM-DD>`, base64), since a
 * value is capped at ~244 KB; `pdf:index` lists the pay dates so the list and "remove all" never
 * need to enumerate keys. Nothing here depends on the payslip store, which calls `deletePdf`.
 */
const INDEX_KEY = "pdf:index";
const KEEP_KEY = "pdf:keep";
const pdfKey = (payDate: string) => `pdf:${payDate}`;

/** Largest base64 text kept per PDF (about 150 KB of PDF), well under the 244 KB value cap. */
export const MAX_PDF_BASE64_BYTES = 200_000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
// `btoa`/`atob` and `String.fromCharCode(...bytes)` choke on large inputs, so work in chunks. A
// byte chunk of a multiple of 3 (and a text chunk of a multiple of 4) keeps the pieces aligned.
const BYTE_CHUNK = 3 * 4096;
const TEXT_CHUNK = 4 * 4096;

export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += BYTE_CHUNK) {
    let binary = "";
    for (const b of bytes.subarray(i, i + BYTE_CHUNK)) binary += String.fromCharCode(b);
    out += btoa(binary);
  }
  return out;
}

export function base64Decode(text: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (let i = 0; i < text.length; i += TEXT_CHUNK) {
    const binary = atob(text.slice(i, i + TEXT_CHUNK));
    const chunk = new Uint8Array(binary.length);
    for (let j = 0; j < binary.length; j++) chunk[j] = binary.charCodeAt(j);
    chunks.push(chunk);
    length += chunk.length;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

export async function listPdfDates(ctx: AddonContext): Promise<string[]> {
  return [...(await jsonStore(ctx.api.storage).get<string[]>(INDEX_KEY, []))].sort();
}

async function writeIndex(ctx: AddonContext, dates: string[]): Promise<void> {
  const unique = [...new Set(dates)].sort();
  if (unique.length === 0) await ctx.api.storage.delete(INDEX_KEY);
  else await jsonStore(ctx.api.storage).set(INDEX_KEY, unique);
}

export async function hasPdf(ctx: AddonContext, payDate: string): Promise<boolean> {
  return (await listPdfDates(ctx)).includes(payDate);
}

/** Keeps the PDF of a pay date (replacing an earlier one). Throws, storing nothing, when it is too large. */
export async function savePdf(ctx: AddonContext, payDate: string, bytes: Uint8Array): Promise<void> {
  if (!DAY.test(payDate)) throw new Error(`Cannot keep a PDF: "${payDate}" is not a pay date`);
  if (base64Length(bytes.length) > MAX_PDF_BASE64_BYTES) {
    throw new Error("This PDF is too large to keep (over ~150 KB).");
  }
  await ctx.api.storage.set(pdfKey(payDate), base64Encode(bytes));
  await writeIndex(ctx, [...(await listPdfDates(ctx)), payDate]);
}

export async function loadPdf(ctx: AddonContext, payDate: string): Promise<Uint8Array | null> {
  const text = await ctx.api.storage.get(pdfKey(payDate));
  return text === null || text === undefined || text === "" ? null : base64Decode(text);
}

export async function deletePdf(ctx: AddonContext, payDate: string): Promise<void> {
  await ctx.api.storage.delete(pdfKey(payDate));
  const dates = await listPdfDates(ctx);
  if (dates.includes(payDate)) await writeIndex(ctx, dates.filter((d) => d !== payDate));
}

/** Removes every stored PDF; resolves to how many there were. */
export async function deleteAllPdfs(ctx: AddonContext): Promise<number> {
  const dates = await listPdfDates(ctx);
  for (const d of dates) await ctx.api.storage.delete(pdfKey(d));
  await ctx.api.storage.delete(INDEX_KEY);
  return dates.length;
}

/** Whether new imports keep a copy of the PDF. On unless the user turned it off. */
export async function getKeepPdfs(ctx: AddonContext): Promise<boolean> {
  return (await ctx.api.storage.get(KEEP_KEY)) !== "false";
}

export function setKeepPdfs(ctx: AddonContext, keep: boolean): Promise<void> {
  return ctx.api.storage.set(KEEP_KEY, keep ? "true" : "false");
}

/** Opens the host's save dialog for the stored PDF (never `<a download>` or `window.open`: popups are blocked). */
export async function downloadPdf(ctx: AddonContext, payDate: string): Promise<void> {
  const bytes = await loadPdf(ctx, payDate);
  if (!bytes) throw new Error(`There is no stored PDF for the ${payDate} payslip.`);
  await ctx.api.files.openSaveDialog(bytes, `payslip-${payDate}.pdf`);
}
