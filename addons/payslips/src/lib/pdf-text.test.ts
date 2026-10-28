import { describe, expect, it } from "vitest";
import { PDF_MARGIN_COLS, rawPdf, samplePayslipLines, writePdf } from "../test-utils";
import { PdfTextError, extractPdfLines } from "./pdf-text";

const margin = " ".repeat(PDF_MARGIN_COLS);
const withMargin = (lines: string[]) => lines.map((l) => margin + l.trimEnd());

describe("extractPdfLines", () => {
  it("round-trips the sample payslip with its column layout", async () => {
    const sample = samplePayslipLines();
    const lines = await extractPdfLines(writePdf([sample]));
    expect(lines).toEqual(withMargin(sample));
  });

  it("inflates FlateDecode streams", async () => {
    const sample = samplePayslipLines();
    const plain = await extractPdfLines(writePdf([sample]));
    const flate = await extractPdfLines(writePdf([sample], { flate: true }));
    expect(flate).toEqual(plain);
    expect(flate.length).toBeGreaterThan(5);
  });

  it("reads pages in order", async () => {
    const lines = await extractPdfLines(writePdf([["first page"], ["second page"]]));
    expect(lines.map((l) => l.trim())).toEqual(["first page", "second page"]);
  });

  it("reads literal strings with escapes and nested parentheses", async () => {
    const pdf = rawPdf(["BT 20 800 Td /F1 8 Tf (a\\(b\\) \\\\ \\101 (nested) end) Tj ET"]);
    const [line] = await extractPdfLines(pdf);
    expect(line!.trim()).toBe("a(b) \\ A (nested) end");
  });

  it("reads TJ arrays, ignoring kerning numbers", async () => {
    const pdf = rawPdf(["BT 20 800 Td /F1 8 Tf [(Hel) -20 (lo) 5 <2077> (orld)] TJ ET"]);
    const [line] = await extractPdfLines(pdf);
    expect(line!.trim()).toBe("Hello world");
  });

  it("pads odd-length hex strings", async () => {
    const pdf = rawPdf(["BT 20 800 Td /F1 8 Tf <414> Tj ET"]);
    const [line] = await extractPdfLines(pdf);
    expect(line!.trim()).toBe("A@");
  });

  it("decodes windows-1252 (pound sign is 0xA3)", async () => {
    const [line] = await extractPdfLines(writePdf([["Pay £250"]]));
    expect(line!.trim()).toBe("Pay £250");
  });

  it("follows Td, TD, Tm, T*, ' and \" operators", async () => {
    const pdf = rawPdf([
      [
        "BT /F1 8 Tf 10 TL",
        "20 800 Td (one) Tj",
        "0 -20 TD (two) Tj",
        "T* (three) Tj",
        "(four) '",
        '0 0 (five) "',
        "1 0 0 1 20 700 Tm (six) Tj",
        "ET",
      ].join("\n"),
    ]);
    const lines = (await extractPdfLines(pdf)).map((l) => l.trim());
    expect(lines).toEqual(["one", "two", "three", "four", "five", "six"]);
  });

  it("places strings of one line in columns by x", async () => {
    const pdf = rawPdf([
      "BT 20 800 Td /F1 8 Tf (left) Tj ET\nBT 120 800 Td /F1 8 Tf (right) Tj ET",
    ]);
    const [line] = await extractPdfLines(pdf);
    const cols = (x: number) => Math.round(x / 4.8);
    expect(line!.indexOf("left")).toBe(cols(20));
    expect(line!.indexOf("right")).toBe(cols(120));
  });

  it("rejects non-PDF bytes", async () => {
    const bytes = new TextEncoder().encode("hello, this is not a pdf");
    await expect(extractPdfLines(bytes)).rejects.toThrow(/not a PDF/);
    await expect(extractPdfLines(bytes)).rejects.toBeInstanceOf(PdfTextError);
  });

  it("rejects encrypted PDFs", async () => {
    const text = new TextDecoder("latin1").decode(writePdf([["x"]])).replace("/Root 1 0 R", "/Root 1 0 R /Encrypt 9 0 R");
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
    await expect(extractPdfLines(bytes)).rejects.toThrow(/encrypted/);
  });

  it("reports a PDF without a text layer", async () => {
    await expect(extractPdfLines(rawPdf([""]))).rejects.toThrow(/no text layer/);
    await expect(extractPdfLines(writePdf([[]]))).rejects.toThrow(PdfTextError);
  });
});
