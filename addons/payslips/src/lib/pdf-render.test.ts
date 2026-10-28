import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  checkerImage,
  imageContent,
  lineContent,
  rawPdf,
  runLengthEncode,
  ruleContent,
  samplePayslipLines,
  withoutPageTree,
  writePdf,
} from "../test-utils";
import { renderPdfPage, runLengthDecode } from "./pdf-render";

const bytes = (...n: number[]) => Uint8Array.from(n);
const render = (content: string, opts: Parameters<typeof rawPdf>[1] = {}) =>
  renderPdfPage(rawPdf([content], { fonts: { F2: "Times-Roman", F3: "Helvetica" }, ...opts }));

describe("runLengthDecode", () => {
  it("copies literal runs and repeats bytes, up to EOD", () => {
    // 2 → copy 3 bytes; 254 → repeat next byte 257-254 = 3 times; 128 → end (the rest is ignored).
    const out = runLengthDecode(bytes(2, 1, 2, 3, 254, 9, 0, 7, 128, 5, 5));
    expect([...out]).toEqual([1, 2, 3, 9, 9, 9, 7]);
  });

  it("round-trips the test encoder, including long runs and literals", () => {
    const data = Uint8Array.from({ length: 700 }, (_, i) => (i < 300 ? 0xff : i % 7 === 0 ? 1 : i % 251));
    expect([...runLengthDecode(runLengthEncode(data))]).toEqual([...data]);
  });

  it("tolerates a truncated run", () => {
    expect([...runLengthDecode(bytes(5, 1, 2))]).toEqual([1, 2]);
    expect([...runLengthDecode(bytes(255))]).toEqual([]);
  });
});

describe("renderPdfPage: page", () => {
  it("reads the media box", async () => {
    const page = await render("");
    expect(page.width).toBe(595);
    expect(page.height).toBe(842);
    expect(page.texts).toEqual([]);
    expect(page.lines).toEqual([]);
  });

  it("throws a clear error when the page does not exist or the file is not a PDF", async () => {
    await expect(renderPdfPage(rawPdf([""]), 3)).rejects.toThrow(/page 4/i);
    await expect(renderPdfPage(new TextEncoder().encode("hello"))).rejects.toThrow(/not a PDF/i);
    await expect(renderPdfPage(withoutPageTree(rawPdf([""])))).rejects.toThrow(/no page 1/i);
  });

  it("reads Flate-compressed streams with indirect lengths", async () => {
    const page = await render(ruleContent([{ x1: 1, y1: 2, x2: 3, y2: 4 }]), { flate: true, indirectLength: true });
    expect(page.lines).toHaveLength(1);
  });

  it("joins a page's content streams", async () => {
    const pdf = rawPdf([ruleContent([{ x1: 1, y1: 2, x2: 3, y2: 4 }]), ruleContent([{ x1: 5, y1: 6, x2: 7, y2: 8 }])], {
      pages: [[0, 1]],
    });
    expect((await renderPdfPage(pdf)).lines.map((l) => l.x1)).toEqual([1, 5]);
  });

  it("picks the page by index", async () => {
    const pdf = rawPdf([ruleContent([{ x1: 1, y1: 0, x2: 2, y2: 0 }]), ruleContent([{ x1: 9, y1: 0, x2: 8, y2: 0 }])]);
    expect((await renderPdfPage(pdf, 1)).lines[0]!.x1).toBe(9);
  });
});

describe("renderPdfPage: lines", () => {
  it("draws ruled lines with their coordinates, width and colour", async () => {
    const rules = [
      { x1: 28.35, y1: 524.4, x2: 28.35, y2: 473.4 },
      { x1: 28.35, y1: 473.4, x2: 566.9, y2: 473.4, width: 1.5, rgb: [1, 0, 0] as [number, number, number] },
    ];
    const { lines } = await render(ruleContent(rules));
    expect(lines).toEqual([
      { x1: 28.35, y1: 524.4, x2: 28.35, y2: 473.4, width: 0.75, color: "#000000" },
      { x1: 28.35, y1: 473.4, x2: 566.9, y2: 473.4, width: 1.5, color: "#ff0000" },
    ]);
  });

  it("reads many lines and gray colours", async () => {
    const rules = Array.from({ length: 105 }, (_, i) => ({ x1: i, y1: 0, x2: i, y2: 10 }));
    expect((await render(ruleContent(rules))).lines).toHaveLength(105);
    const { lines } = await render("0.5 G 0 0 m 10 0 l S");
    expect(lines[0]!.color).toBe("#808080");
    expect(lines[0]!.width).toBe(1); // the PDF default
  });

  it("strokes a polyline segment by segment, and a closed path back to its start", async () => {
    const { lines } = await render("0 0 m 10 0 l 10 10 l s");
    expect(lines.map((l) => [l.x1, l.y1, l.x2, l.y2])).toEqual([
      [0, 0, 10, 0],
      [10, 0, 10, 10],
      [10, 10, 0, 0],
    ]);
  });

  it("ignores a path that is never painted", async () => {
    expect((await render("0 0 m 10 0 l n")).lines).toEqual([]);
  });

  it("applies the CTM to points and the line width", async () => {
    const { lines } = await render("q 2 0 0 2 10 20 cm 1 w 0 0 m 5 0 l S Q");
    expect(lines).toEqual([{ x1: 10, y1: 20, x2: 20, y2: 20, width: 2, color: "#000000" }]);
  });

  it("draws rectangles: re f fills, re S strokes, re B does both", async () => {
    const { rects, lines } = await render("0 1 0 rg 10 20 30 40 re f 0 0 1 RG 2 w 50 60 5 6 re S 1 0 0 rg 0 0 1 RG 1 w 1 2 3 4 re B");
    expect(lines).toEqual([]);
    expect(rects).toEqual([
      { x: 10, y: 20, w: 30, h: 40, fill: "#00ff00" },
      { x: 50, y: 60, w: 5, h: 6, stroke: "#0000ff", width: 2 },
      { x: 1, y: 2, w: 3, h: 4, fill: "#ff0000", stroke: "#0000ff", width: 1 },
    ]);
  });
});

describe("renderPdfPage: graphics state", () => {
  it("q/Q restores the CTM, line width and colours", async () => {
    const { lines } = await render(
      "q 1 0 0 1 100 0 cm 3 w 1 0 0 RG 0 0 m 10 0 l S Q 0 0 m 10 0 l S",
    );
    expect(lines).toEqual([
      { x1: 100, y1: 0, x2: 110, y2: 0, width: 3, color: "#ff0000" },
      { x1: 0, y1: 0, x2: 10, y2: 0, width: 1, color: "#000000" },
    ]);
  });

  it("survives an unbalanced Q", async () => {
    const { lines } = await render("Q Q 0 0 m 1 1 l S");
    expect(lines).toHaveLength(1);
  });

  it("ignores operators it does not know, with their operands", async () => {
    const { lines, texts } = await render(
      "/OC /MC0 BDC 5 7 frobnicate (junk) bar [1 2] 0 d /GS0 gs 1 j 0 0 m 10 0 l S EMC BT /F1 8 Tf 0 0 Td (hi) Tj ET",
    );
    expect(lines).toHaveLength(1);
    expect(texts.map((t) => t.text)).toEqual(["hi"]);
  });
});

describe("renderPdfPage: text", () => {
  it("maps the font resource to a family by its BaseFont and reads size", async () => {
    const { texts } = await render(
      "BT /F1 12 Tf 10 100 Td (mono) Tj ET BT /F2 10 Tf 10 90 Td (serif) Tj ET BT /F3 9 Tf 10 80 Td (sans) Tj ET",
    );
    expect(texts).toEqual([
      { x: 10, y: 100, size: 12, font: "mono", text: "mono" },
      { x: 10, y: 90, size: 10, font: "serif", text: "serif" },
      { x: 10, y: 80, size: 9, font: "sans", text: "sans" },
    ]);
  });

  it("moves with Td relative to the line start, and advances along a line", async () => {
    const { texts } = await render("BT /F1 10 Tf 20 700 Td (ab) Tj 0 -12 Td (cd) Tj 50 0 Td (ef) Tj (gh) Tj ET");
    expect(texts.map((t) => [t.text, t.x, t.y])).toEqual([
      ["ab", 20, 700],
      ["cd", 20, 688],
      ["ef", 70, 688],
      ["gh", 82, 688], // "ef" is two Courier glyphs of 6 units
    ]);
  });

  it("supports Tm, TD with T*, quote operators and TJ", async () => {
    const { texts } = await render(
      "BT /F1 10 Tf 1 0 0 1 30 500 Tm (a) Tj 0 -14 TD (b) Tj T* (c) Tj (d) ' [(e) -2000 (f)] TJ ET",
    );
    expect(texts.map((t) => [t.text, t.x, t.y])).toEqual([
      ["a", 30, 500],
      ["b", 30, 486],
      ["c", 30, 472],
      ["d", 30, 458],
      ["e", 36, 458], // continues after "d"
      ["f", 36 + 6 + 20, 458],
    ]);
  });

  it("decodes strings as windows-1252, literal and hex", async () => {
    const { texts } = await render("BT /F1 10 Tf 0 0 Td <a34e6574> Tj 0 -10 Td (\\243 9 \\(x\\)) Tj ET");
    expect(texts.map((t) => t.text)).toEqual(["£Net", "£ 9 (x)"]);
  });

  it("keeps leading and inner spaces", async () => {
    const { texts } = await render("BT /F1 10 Tf 0 0 Td (  a  b ) Tj ET");
    expect(texts[0]!.text).toBe("  a  b ");
  });

  it("transforms the position and size by the CTM", async () => {
    const { texts } = await render("q 2 0 0 2 10 20 cm BT /F1 8 Tf 5 5 Td (x) Tj ET Q");
    expect(texts).toEqual([{ x: 20, y: 30, size: 16, font: "mono", text: "x" }]);
  });

  it("applies word and character spacing to the advance, and reports it", async () => {
    const { texts } = await render("BT /F1 10 Tf 2 Tw 1 Tc 0 0 Td (a b) Tj (c) Tj ET");
    expect(texts[0]!).toMatchObject({ text: "a b", wordSpacing: 2, charSpacing: 1 });
    // 3 glyphs × (6 + 1) + one space × 2
    expect(texts[1]!.x).toBe(23);
  });

  it("skips empty strings", async () => {
    expect((await render("BT /F1 10 Tf 0 0 Td () Tj ET")).texts).toEqual([]);
  });

  it("falls back to sans for a font it cannot resolve", async () => {
    const { texts } = await render("BT /Nope 10 Tf 0 0 Td (x) Tj ET");
    expect(texts[0]!.font).toBe("sans");
  });
});

describe("renderPdfPage: image masks", () => {
  const checker = checkerImage();

  it("places the image from the CTM and decodes the mask", async () => {
    const page = await render(imageContent(30, 738, 529.9, 89.3), { image: checker });
    expect(page.images).toHaveLength(1);
    const img = page.images[0]!;
    expect(img).toMatchObject({ x: 30, y: 738, w: 529.9, h: 89.3, widthPx: 16, heightPx: 4, color: "#000000" });
    expect([...img.mask]).toEqual([...checker.mask]);
  });

  it("paints with the current fill colour", async () => {
    const page = await render(imageContent(0, 0, 16, 4, [0, 0, 1]), { image: checker });
    expect(page.images[0]!.color).toBe("#0000ff");
  });

  it("inverts the mask for /Decode [1 0]", async () => {
    const page = await render(imageContent(0, 0, 16, 4), { image: { ...checker, invert: true } });
    expect([...page.images[0]!.mask]).toEqual([...checker.mask].map((b) => 1 - b));
  });

  it("handles rows padded to whole bytes", async () => {
    const odd = checkerImage(11, 3, 1);
    const page = await render(imageContent(0, 0, 11, 3), { image: odd });
    expect(page.images[0]!.widthPx).toBe(11);
    expect([...page.images[0]!.mask]).toEqual([...odd.mask]);
  });

  it("flips the mask for a negative scale", async () => {
    const page = await render("q 16 0 0 -4 0 4 cm /Im1 Do Q", { image: checker });
    const img = page.images[0]!;
    expect(img).toMatchObject({ x: 0, y: 0, w: 16, h: 4 });
    const flipped = new Uint8Array(64);
    for (let y = 0; y < 4; y++) flipped.set(checker.mask.subarray((3 - y) * 16, (4 - y) * 16), y * 16);
    expect([...img.mask]).toEqual([...flipped]);
  });

  it("skips XObjects it cannot draw, without failing", async () => {
    const page = await render("q 10 0 0 10 0 0 cm /Missing Do /Im1 Do Q 0 0 m 1 1 l S", {});
    expect(page.images).toEqual([]);
    expect(page.lines).toHaveLength(1);
  });

  it("reads a mask compressed with Flate only", async () => {
    // Hand-built: a direct /Filter name and a direct /Length.
    const samples = checker.samples;
    const body = new Uint8Array(deflateSync(samples));
    const img = new Uint8Array([
      ...new TextEncoder().encode(
        `<< /Type /XObject /Subtype /Image /ImageMask true /BitsPerComponent 1 /Width 16 /Height 4 /Filter /FlateDecode /Length ${body.length} >>\nstream\n`,
      ),
      ...body,
      ...new TextEncoder().encode("\nendstream"),
    ]);
    const bin = (u: Uint8Array) => Array.from(u, (b) => String.fromCharCode(b)).join("");
    const withImage = bin(rawPdf([imageContent(0, 0, 16, 4)]))
      .replace("/Resources << /Font", "/Resources << /XObject << /Im1 9 0 R >> /Font")
      .replace("xref", `9 0 obj\n${bin(img)}\nendobj\nxref`);
    const page = await renderPdfPage(Uint8Array.from(withImage, (c) => c.charCodeAt(0)));
    expect([...page.images[0]!.mask]).toEqual([...checker.mask]);
  });
});

describe("renderPdfPage: the sample payslip", () => {
  it("renders every line of the synthetic payslip as text at the writer's positions", async () => {
    const sample = samplePayslipLines();
    const page = await renderPdfPage(writePdf([sample]));
    const byRow = new Map<number, string[]>();
    for (const t of page.texts) byRow.set(t.y, [...(byRow.get(t.y) ?? []), t.text]);
    const rows = [...byRow.entries()].sort((a, b) => b[0] - a[0]).map(([, parts]) => parts.join(""));
    expect(rows).toEqual(sample.map((l) => l.trimStart()).filter((l) => l.trim()));
    expect(page.texts.every((t) => t.font === "mono" && t.size === 8)).toBe(true);
    const net = page.texts.find((t) => t.text.startsWith("Net Pay"))!;
    expect(net.x).toBeGreaterThan(20);
  });

  it("renders the text from Flate-compressed content too, next to rules and an image", async () => {
    const content = [lineContent(samplePayslipLines()), ruleContent([{ x1: 20, y1: 700, x2: 500, y2: 700 }]), imageContent(30, 738, 100, 20)].join("\n");
    const page = await renderPdfPage(rawPdf([content], { flate: true, image: checkerImage() }));
    expect(page.texts.some((t) => t.text.startsWith("Net Pay"))).toBe(true);
    expect(page.lines).toHaveLength(1);
    expect(page.images).toHaveLength(1);
  });
});
