import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PDF_MARGIN_COLS, checkerImage, imageContent, lineContent, rawPdf, samplePayslipLines, writePdf } from "../test-utils";
import { PdfTextError, extractPdfLines, inflate, tokenise } from "./pdf-text";

const margin = " ".repeat(PDF_MARGIN_COLS);
const withMargin = (lines: string[]) => lines.map((l) => margin + l.trimEnd());

describe("extractPdfLines", () => {
  it("reads the text of a page that also draws an image mask with indirect filters", async () => {
    const sample = samplePayslipLines();
    const content = `${lineContent(sample)}\n${imageContent(30, 738, 100, 20)}`;
    const lines = await extractPdfLines(rawPdf([content], { image: checkerImage() }));
    expect(lines).toEqual(withMargin(sample));
  });

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

  it("reads FlateDecode streams whose /Length is an indirect reference", async () => {
    const sample = samplePayslipLines();
    const plain = await extractPdfLines(writePdf([sample]));
    for (const streamEol of ["\n", "\r\n"] as const) {
      for (const endEol of ["\n", "\r\n", "\r"] as const) {
        const pdf = writePdf([sample], { flate: true, indirectLength: true, streamEol, endEol });
        expect(await extractPdfLines(pdf), JSON.stringify({ streamEol, endEol })).toEqual(plain);
      }
    }
  });

  it("tolerates a stray extra byte after a deflate stream", async () => {
    const sample = samplePayslipLines();
    const plain = await extractPdfLines(writePdf([sample]));
    const pdf = writePdf([sample], { flate: true, indirectLength: true, endEol: "\n\n" });
    expect(await extractPdfLines(pdf)).toEqual(plain);
  });

  it("reads uncompressed streams whose /Length is an indirect reference", async () => {
    const sample = samplePayslipLines();
    const plain = await extractPdfLines(writePdf([sample]));
    const pdf = writePdf([sample], { indirectLength: true, endEol: "\r\n" });
    expect(await extractPdfLines(pdf)).toEqual(plain);
  });

  it("reads pages in order", async () => {
    const lines = await extractPdfLines(writePdf([["first page"], ["second page"]]));
    expect(lines.map((l) => l.trim())).toEqual(["first page", "second page"]);
  });

  it("reads several content streams of one page as one page", async () => {
    // Label in the first stream, value at the same y in the second, which sets no font of its
    // own (the font size carries over within a page).
    const pdf = rawPdf(
      [
        "BT 20 800 Td /F1 8 Tf (Pay Date  :) Tj ET",
        "BT 120 800 Td (31.10.2026) Tj ET\nBT 20 790 Td (next row) Tj ET",
      ],
      { pages: [[0, 1]] },
    );
    const lines = await extractPdfLines(pdf);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.indexOf("Pay Date")).toBe(Math.round(20 / 4.8));
    expect(lines[0]!.indexOf("31.10.2026")).toBe(Math.round(120 / 4.8));
    expect(lines[1]!.trim()).toBe("next row");
  });

  it("keeps streams of different pages on different pages", async () => {
    const pdf = rawPdf(
      ["BT 20 800 Td /F1 8 Tf (a1) Tj ET", "BT 60 800 Td /F1 8 Tf (a2) Tj ET", "BT 20 800 Td /F1 8 Tf (b1) Tj ET"],
      { pages: [[0, 1], [2]] },
    );
    const lines = (await extractPdfLines(pdf)).map((l) => l.trim().replace(/\s+/g, " "));
    expect(lines).toEqual(["a1 a2", "b1"]);
  });

  it("parses a payslip whose page is split across two streams", async () => {
    const sample = samplePayslipLines();
    const cut = 6;
    const pdf = rawPdf([lineContent(sample.slice(0, cut)), lineContent(sample.slice(cut), cut)], {
      pages: [[0, 1]],
    });
    const lines = await extractPdfLines(pdf);
    expect(lines).toEqual(withMargin(sample));
  });

  it("treats every stream as its own page when the file has no page objects", async () => {
    const text = new TextDecoder("latin1")
      .decode(rawPdf(["BT 20 800 Td /F1 8 Tf (one) Tj ET", "BT 20 800 Td /F1 8 Tf (two) Tj ET"]))
      .replaceAll("/Type /Page ", "/Type /Other ");
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
    expect((await extractPdfLines(bytes)).map((l) => l.trim())).toEqual(["one", "two"]);
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

  it("turns large negative TJ adjustments into spaces", async () => {
    const pdf = rawPdf([
      "BT 20 800 Td /F1 8 Tf [(Total)-600(Payments)] TJ ET\nBT 20 790 Td /F1 8 Tf [(a)-1200(b)-20(c)600(d)] TJ ET",
    ]);
    const lines = (await extractPdfLines(pdf)).map((l) => l.trim());
    expect(lines).toEqual(["Total Payments", "a  bcd"]);
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

describe("inflate: output limit", () => {
  it("stops reading once past maxBytes, returning no more than that", async () => {
    const bomb = new Uint8Array(deflateSync(new Uint8Array(40_000_000)));
    const t0 = performance.now();
    const out = await inflate(bomb, 1000);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(1000);
    expect(out!.length).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("returns everything when the output is within the limit, and when there is none", async () => {
    const data = new TextEncoder().encode("hello hello hello");
    expect([...(await inflate(new Uint8Array(deflateSync(data)), 1000))!]).toEqual([...data]);
    expect([...(await inflate(new Uint8Array(deflateSync(data))))!]).toEqual([...data]);
  });
});

describe("tokenise: nesting", () => {
  it("does not overflow the stack on a stream of 200 000 opening brackets", () => {
    const tokens = [...tokenise(`1 2 m ${"[".repeat(200_000)}`)];
    expect(tokens.slice(0, 3)).toEqual([
      { t: "num", v: 1 },
      { t: "num", v: 2 },
      { t: "op", v: "m" },
    ]);
  });

  it("still reads the text shown before the nesting starts", async () => {
    const pdf = rawPdf([`BT 20 800 Td /F1 8 Tf (before) Tj ET\n${"[".repeat(200_000)}`]);
    expect(await extractPdfLines(pdf)).toEqual([expect.stringContaining("before")]);
  });

  it("reads arrays nested a few levels, as before", () => {
    const [arr] = [...tokenise("[1 [2 [3]]]")];
    expect(arr).toEqual({ t: "arr", v: [{ t: "num", v: 1 }, { t: "arr", v: [{ t: "num", v: 2 }, { t: "arr", v: [{ t: "num", v: 3 }] }] }] });
  });
});
