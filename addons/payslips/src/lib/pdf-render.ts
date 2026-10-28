/**
 * Draws one page of the simple, uncompressed-structure PDFs payroll systems produce (PDF 1.3: a
 * classic xref table, one or a few content streams, standard Type1 fonts, ruled lines and
 * image-mask logos) as plain data: positioned text, lines, rectangles and 1-bit image masks, in
 * PDF user space (origin bottom-left). The viewer turns that into an SVG.
 *
 * Reads the objects itself (resolving indirect references for /Filter, /Length, /Contents,
 * /Resources, /Font and /XObject), decodes FlateDecode and RunLengthDecode chains, and walks the
 * content stream with a graphics-state stack. Anything it does not know (clipping, shading,
 * forms, other filters, object streams) is ignored, never fatal; only a page that cannot be found
 * throws.
 */
import { PdfTextError, decodeWin1252, inflate, toBinaryString, tokenise, type Token } from "./pdf-text";

export interface DrawnText {
  x: number;
  y: number;
  size: number;
  font: "serif" | "sans" | "mono";
  text: string;
  /** Extra space after each space character / each glyph, in user-space units, when not zero. */
  wordSpacing?: number;
  charSpacing?: number;
}
export interface DrawnLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  color: string;
}
export interface DrawnRect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  width?: number;
}
export interface DrawnImage {
  x: number;
  y: number;
  w: number;
  h: number;
  widthPx: number;
  heightPx: number;
  /** 1 = paint, row-major, `widthPx * heightPx`, first row at the top. */
  mask: Uint8Array;
  color: string;
}
export interface PageDrawing {
  width: number;
  height: number;
  texts: DrawnText[];
  lines: DrawnLine[];
  rects: DrawnRect[];
  images: DrawnImage[];
}

// ---------------------------------------------------------------------------------------------
// Filters

/**
 * RunLengthDecode: n < 128 copies n + 1 bytes, n > 128 repeats the next byte 257 − n times, 128 ends.
 * With `expected` the output is written into a buffer of that size and decoding stops when it is
 * full, so a few bytes that claim to expand to gigabytes cost no more than `expected` bytes;
 * without it the output is the data's own size, up to MAX_STREAM_BYTES.
 */
export function runLengthDecode(data: Uint8Array, expected?: number): Uint8Array {
  let size = expected;
  if (size === undefined) {
    size = 0;
    for (let i = 0; i < data.length && size < MAX_STREAM_BYTES; ) {
      const n = data[i]!;
      if (n === 128) break;
      if (n < 128) {
        const take = Math.min(n + 1, data.length - i - 1);
        size += take;
        i += 1 + take;
      } else {
        if (i + 1 < data.length) size += 257 - n;
        i += 2;
      }
    }
    size = Math.min(size, MAX_STREAM_BYTES);
  }
  const out = new Uint8Array(size);
  let at = 0;
  let i = 0;
  while (i < data.length && at < size) {
    const n = data[i++]!;
    if (n === 128) break;
    if (n < 128) {
      for (let k = 0; k <= n && i < data.length && at < size; k++) out[at++] = data[i++]!;
    } else if (i < data.length) {
      const count = Math.min(257 - n, size - at);
      out.fill(data[i++]!, at, at + count);
      at += count;
    }
  }
  return at === size ? out : out.subarray(0, at);
}

// ---------------------------------------------------------------------------------------------
// Objects

type Value =
  | { t: "num"; v: number }
  | { t: "name"; v: string }
  | { t: "ref"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "null" }
  | { t: "arr"; v: Value[] }
  | { t: "dict"; v: Dict };
type Dict = Record<string, Value>;

const NULL: Value = { t: "null" };
const WS = /[\0\t\n\f\r ]/;
const DELIM = /[()<>[\]{}/%]/;

class Reader {
  i: number;
  constructor(
    readonly s: string,
    start = 0,
  ) {
    this.i = start;
  }

  skip(): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (WS.test(c)) this.i++;
      else if (c === "%") while (this.i < s.length && s[this.i] !== "\n" && s[this.i] !== "\r") this.i++;
      else break;
    }
  }

  private word(): string {
    const start = this.i;
    while (this.i < this.s.length && !WS.test(this.s[this.i]!) && !DELIM.test(this.s[this.i]!)) this.i++;
    return this.s.slice(start, this.i);
  }

  value(depth = 0): Value {
    this.skip();
    const s = this.s;
    if (this.i >= s.length || depth > 32) return NULL;
    const c = s[this.i]!;
    if (c === "<" && s[this.i + 1] === "<") {
      this.i += 2;
      const dict: Dict = {};
      for (;;) {
        this.skip();
        if (this.i >= s.length) break;
        if (s[this.i] === ">" && s[this.i + 1] === ">") {
          this.i += 2;
          break;
        }
        if (s[this.i] !== "/") {
          this.i++; // junk between entries
          continue;
        }
        const key = this.name();
        dict[key] = this.value(depth + 1);
      }
      return { t: "dict", v: dict };
    }
    if (c === "<") {
      this.i++;
      let digits = "";
      while (this.i < s.length && s[this.i] !== ">") {
        if (/[0-9a-fA-F]/.test(s[this.i]!)) digits += s[this.i];
        this.i++;
      }
      this.i++;
      if (digits.length % 2) digits += "0";
      let out = "";
      for (let k = 0; k < digits.length; k += 2) out += String.fromCharCode(parseInt(digits.slice(k, k + 2), 16));
      return { t: "str", v: out };
    }
    if (c === "(") {
      this.i++;
      let depthP = 1;
      let out = "";
      while (this.i < s.length && depthP > 0) {
        const ch = s[this.i++]!;
        if (ch === "\\") out += s[this.i++] ?? "";
        else if (ch === "(") {
          depthP++;
          out += ch;
        } else if (ch === ")") {
          depthP--;
          if (depthP > 0) out += ch;
        } else out += ch;
      }
      return { t: "str", v: out };
    }
    if (c === "[") {
      this.i++;
      const items: Value[] = [];
      for (;;) {
        this.skip();
        if (this.i >= s.length) break;
        if (s[this.i] === "]") {
          this.i++;
          break;
        }
        const before = this.i;
        items.push(this.value(depth + 1));
        if (this.i === before) this.i++;
      }
      return { t: "arr", v: items };
    }
    if (c === "/") return { t: "name", v: this.name() };
    if (DELIM.test(c)) {
      this.i++;
      return NULL;
    }
    const start = this.i;
    const w = this.word();
    if (/^\d+$/.test(w)) {
      const m = /^\s+(\d+)\s+R(?![A-Za-z0-9])/.exec(s.slice(this.i, this.i + 24));
      if (m) {
        this.i += m[0].length;
        return { t: "ref", v: Number(w) };
      }
    }
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(w)) return { t: "num", v: Number(w) };
    if (w === "true" || w === "false") return { t: "bool", v: w === "true" };
    if (w === "") this.i = start + 1;
    return NULL;
  }

  /** A name starting at `/`, with its `#xx` escapes decoded. */
  name(): string {
    this.i++; // "/"
    return this.word().replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  }
}

interface Stream {
  dict: Dict;
  data: Uint8Array;
}

class PdfFile {
  readonly binary: string;
  private readonly offsets = new Map<number, number>();
  private readonly parsed = new Map<number, { value: Value; streamAt: number | null }>();

  constructor(readonly bytes: Uint8Array) {
    this.binary = toBinaryString(bytes);
    const re = /(?<![\w])(\d+)\s+\d+\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.binary))) {
      const n = Number(m[1]);
      if (!this.offsets.has(n)) this.offsets.set(n, m.index + m[0].length);
    }
  }

  numbers(): number[] {
    return [...this.offsets.keys()];
  }

  private object(n: number) {
    let hit = this.parsed.get(n);
    if (hit) return hit;
    const at = this.offsets.get(n);
    if (at === undefined) return undefined;
    const r = new Reader(this.binary, at);
    const value = r.value();
    r.skip();
    let streamAt: number | null = null;
    if (this.binary.startsWith("stream", r.i)) {
      let p = r.i + 6;
      if (this.binary[p] === "\r") p++;
      if (this.binary[p] === "\n") p++;
      streamAt = p;
    }
    hit = { value, streamAt };
    this.parsed.set(n, hit);
    return hit;
  }

  /** Follows indirect references (a few levels, in case of chains or cycles). */
  resolve(v: Value | undefined): Value | undefined {
    let cur = v;
    for (let depth = 0; cur && cur.t === "ref" && depth < 16; depth++) cur = this.object(cur.v)?.value;
    return cur && cur.t === "ref" ? undefined : cur;
  }

  dict(v: Value | undefined): Dict | undefined {
    const r = this.resolve(v);
    return r?.t === "dict" ? r.v : undefined;
  }

  get(d: Dict | undefined, key: string): Value | undefined {
    return d ? this.resolve(d[key]) : undefined;
  }

  num(v: Value | undefined): number | undefined {
    const r = this.resolve(v);
    return r?.t === "num" ? r.v : undefined;
  }

  name(v: Value | undefined): string | undefined {
    const r = this.resolve(v);
    return r?.t === "name" ? r.v : undefined;
  }

  numbersOf(v: Value | undefined): number[] | undefined {
    const r = this.resolve(v);
    if (r?.t !== "arr") return undefined;
    const out = r.v.map((x) => this.num(x));
    return out.every((x) => x !== undefined) ? (out as number[]) : undefined;
  }

  /** The (still encoded) stream of object `n`, with /Length resolved or, failing that, found by `endstream`. */
  stream(n: number): Stream | null {
    const o = this.object(n);
    if (!o || o.streamAt === null || o.value.t !== "dict") return null;
    const start = o.streamAt;
    const bin = this.binary;
    const length = this.num(o.value.v.Length);
    let end = -1;
    if (length !== undefined && length >= 0 && /^\s*endstream/.test(bin.slice(start + length, start + length + 12))) {
      end = start + length;
    } else {
      end = bin.indexOf("endstream", start);
      if (end < 0) return null;
      if (bin.startsWith("\r\n", end - 2)) end -= 2;
      else if (end > start && (bin[end - 1] === "\n" || bin[end - 1] === "\r")) end -= 1;
    }
    return { dict: o.value.v, data: this.bytes.subarray(start, end) };
  }

  /**
   * The stream's data with its /Filter chain applied in order, or null when a filter is unsupported
   * or fails. `expected` is the size of the final data when the caller knows it (an image mask):
   * decoding stops there. Otherwise every stage is capped at MAX_STREAM_BYTES.
   */
  async decode(s: Stream, expected?: number): Promise<Uint8Array | null> {
    const f = this.resolve(s.dict.Filter);
    const filters = !f ? [] : f.t === "arr" ? f.v.map((x) => this.name(x)) : [f.t === "name" ? f.v : undefined];
    let data: Uint8Array | null = s.data;
    for (const [k, name] of filters.entries()) {
      // What a stage may hand on: the final size for the last one; for an earlier one, what could
      // still turn into that size (run-length data is at most about twice its output).
      const final = k === filters.length - 1;
      const limit = expected === undefined ? undefined : final ? expected : 2 * expected + 1024;
      if (name === "FlateDecode" || name === "Fl") data = await inflate(data, limit ?? MAX_STREAM_BYTES);
      else if (name === "RunLengthDecode" || name === "RL") data = runLengthDecode(data, limit);
      else return null;
      if (!data) return null;
    }
    return data;
  }
}

/** Most bytes a content stream may inflate / run-length decode to. */
const MAX_STREAM_BYTES = 32 * 1024 * 1024;

interface PageInfo {
  dict: Dict;
  resources?: Dict;
  mediaBox?: number[];
}

/** The pages in document order: the page tree from the catalog, or any page objects in file order. */
function pagesOf(file: PdfFile): PageInfo[] {
  const pages: PageInfo[] = [];
  const seen = new Set<Dict>();
  const walk = (node: Value | undefined, inherited: { resources?: Dict; mediaBox?: number[] }, depth: number) => {
    const d = file.dict(node);
    if (!d || seen.has(d) || depth > 16) return;
    seen.add(d);
    const here = {
      resources: file.dict(d.Resources) ?? inherited.resources,
      mediaBox: file.numbersOf(d.MediaBox) ?? inherited.mediaBox,
    };
    const kids = file.get(d, "Kids");
    if (kids?.t === "arr") {
      for (const kid of kids.v) walk(kid, here, depth + 1);
    } else if (file.name(d.Type) !== "Pages") {
      pages.push({ dict: d, ...here });
    }
  };
  const all = file.numbers().map((n) => ({ n, d: file.dict({ t: "ref", v: n }) }));
  const catalog = all.find((o) => o.d && file.name(o.d.Type) === "Catalog");
  if (catalog) walk(catalog.d!.Pages, {}, 0);
  if (pages.length === 0) {
    for (const { d } of all) {
      if (d && file.name(d.Type) === "Page") {
        pages.push({
          dict: d,
          resources: file.dict(d.Resources),
          mediaBox: file.numbersOf(d.MediaBox) ?? file.numbersOf(file.dict(d.Parent)?.MediaBox),
        });
      }
    }
  }
  return pages;
}

// ---------------------------------------------------------------------------------------------
// Content stream

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m × n` for row vectors, as PDF composes them (m is applied first). */
function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function hex(v: number): string {
  return Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, "0");
}
const rgbCss = (r: number, g: number, b: number) => `#${hex(r)}${hex(g)}${hex(b)}`;
const grayCss = (g: number) => rgbCss(g, g, g);
const cmykCss = (c: number, m: number, y: number, k: number) => rgbCss((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));

/** A colour from the numeric operands of g / rg / k / sc …: 1 = gray, 3 = RGB, 4 = CMYK. */
function colourOf(nums: number[]): string | null {
  if (nums.length === 1) return grayCss(nums[0]!);
  if (nums.length === 3) return rgbCss(nums[0]!, nums[1]!, nums[2]!);
  if (nums.length === 4) return cmykCss(nums[0]!, nums[1]!, nums[2]!, nums[3]!);
  return null;
}

/** Average glyph width (em) of the standard fonts, used to advance consecutive strings. */
const GLYPH_EM = { mono: 0.6, serif: 0.45, sans: 0.5 } as const;

const familyOf = (baseFont: string | undefined): DrawnText["font"] =>
  baseFont && /courier/i.test(baseFont) ? "mono" : baseFont && /times/i.test(baseFont) ? "serif" : "sans";

interface GState {
  ctm: Matrix;
  lineWidth: number;
  stroke: string;
  fill: string;
}

const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_IMAGE_SIDE = 10_000;
/** The most things (texts, lines, rectangles, images) one page may draw. */
const MAX_ELEMENTS = 20_000;

async function maskOf(file: PdfFile, stream: Stream): Promise<{ widthPx: number; heightPx: number; mask: Uint8Array } | null> {
  const d = stream.dict;
  const widthPx = file.num(d.Width) ?? 0;
  const heightPx = file.num(d.Height) ?? 0;
  const side = (n: number) => Number.isInteger(n) && n > 0 && n <= MAX_IMAGE_SIDE;
  if (!side(widthPx) || !side(heightPx) || widthPx * heightPx > MAX_IMAGE_PIXELS) return null;
  const data = await file.decode(stream, Math.ceil(widthPx / 8) * heightPx);
  if (!data) return null;
  const decode = file.numbersOf(d.Decode);
  // Default /Decode [0 1]: a 0 sample paints. [1 0] inverts that.
  const paintBit = decode && decode[0] === 1 ? 1 : 0;
  const rowBytes = Math.ceil(widthPx / 8);
  const mask = new Uint8Array(widthPx * heightPx);
  for (let y = 0; y < heightPx; y++) {
    for (let x = 0; x < widthPx; x++) {
      // Data the stream is short of counts as 1 bits (not painted under the default decode).
      const byte = data[y * rowBytes + (x >> 3)] ?? (paintBit === 0 ? 0xff : 0);
      const bit = (byte >> (7 - (x & 7))) & 1;
      mask[y * widthPx + x] = bit === paintBit ? 1 : 0;
    }
  }
  return { widthPx, heightPx, mask };
}

async function interpret(file: PdfFile, content: string, resources: Dict | undefined, initial: Matrix): Promise<Omit<PageDrawing, "width" | "height">> {
  const texts: DrawnText[] = [];
  const lines: DrawnLine[] = [];
  const rects: DrawnRect[] = [];
  const images: DrawnImage[] = [];
  let elements = 0;
  const counted = () => {
    if (++elements > MAX_ELEMENTS) {
      throw new PdfTextError(`This page has too many elements to draw (more than ${MAX_ELEMENTS.toLocaleString("en-GB")}).`);
    }
  };

  let gs: GState = { ctm: initial, lineWidth: 1, stroke: "#000000", fill: "#000000" };
  const saved: GState[] = [];

  // Path under construction, already in user space.
  let segs: [number, number, number, number][] = [];
  let pathRects: { x: number; y: number; w: number; h: number }[] = [];
  let cur: [number, number] | null = null;
  let start: [number, number] | null = null;

  // Text state.
  let tlm: Matrix = IDENTITY;
  let adv = 0; // advance along the line in text space (unscaled by the text matrix)
  let fontSize = 0;
  let fontName = "";
  let leading = 0;
  let charSpace = 0;
  let wordSpace = 0;
  const families = new Map<string, DrawnText["font"]>();
  const fontDict = file.dict(resources?.Font);
  const familyFor = (name: string): DrawnText["font"] => {
    let f = families.get(name);
    if (!f) {
      f = familyOf(file.name(file.dict(fontDict?.[name])?.BaseFont));
      families.set(name, f);
    }
    return f;
  };

  const imageCache = new Map<number, Awaited<ReturnType<typeof maskOf>>>();
  const xobjects = file.dict(resources?.XObject);

  const scaleOf = (m: Matrix) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

  const moveBy = (tx: number, ty: number) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    adv = 0;
  };
  const show = (raw: string) => {
    if (!raw) return;
    const tm = mul(tlm, gs.ctm);
    const family = familyFor(fontName);
    const [x, y] = apply(tm, adv, 0);
    const hScale = Math.hypot(tm[0], tm[1]);
    const item: DrawnText = { x, y, size: Math.abs(fontSize) * Math.hypot(tm[2], tm[3]), font: family, text: decodeWin1252(raw) };
    if (wordSpace) item.wordSpacing = wordSpace * hScale;
    if (charSpace) item.charSpacing = charSpace * hScale;
    counted();
    texts.push(item);
    let spaces = 0;
    for (const ch of raw) if (ch === " ") spaces++;
    adv += raw.length * (GLYPH_EM[family] * fontSize + charSpace) + spaces * wordSpace;
  };

  const strokePath = () => {
    const w = gs.lineWidth * scaleOf(gs.ctm);
    for (const [x1, y1, x2, y2] of segs) {
      counted();
      lines.push({ x1, y1, x2, y2, width: w, color: gs.stroke });
    }
  };
  const closePath = () => {
    if (cur && start && (cur[0] !== start[0] || cur[1] !== start[1])) segs.push([cur[0], cur[1], start[0], start[1]]);
    if (start) cur = start;
  };
  const endPath = () => {
    segs = [];
    pathRects = [];
    cur = null;
    start = null;
  };
  const paint = (fill: boolean, stroke: boolean) => {
    const w = gs.lineWidth * scaleOf(gs.ctm);
    for (const r of pathRects) {
      if (!fill && !stroke) break;
      const rect: DrawnRect = { ...r };
      if (fill) rect.fill = gs.fill;
      if (stroke) {
        rect.stroke = gs.stroke;
        rect.width = w;
      }
      counted();
      rects.push(rect);
    }
    if (stroke) strokePath();
    endPath();
  };

  let stack: Token[] = [];
  const nums = (): number[] => stack.filter((t): t is Extract<Token, { t: "num" }> => t.t === "num").map((t) => t.v);
  const num = (k: number): number => {
    const t = stack[stack.length - k];
    return t?.t === "num" ? t.v : 0;
  };

  for (const tok of tokenise(content)) {
    if (tok.t !== "op") {
      stack.push(tok);
      if (stack.length > 256) stack = stack.slice(-128);
      continue;
    }
    switch (tok.v) {
      case "q":
        saved.push({ ...gs });
        break;
      case "Q": {
        const prev = saved.pop();
        if (prev) gs = prev;
        break;
      }
      case "cm":
        gs = { ...gs, ctm: mul([num(6), num(5), num(4), num(3), num(2), num(1)], gs.ctm) };
        break;
      case "w":
        gs = { ...gs, lineWidth: num(1) };
        break;
      case "g":
      case "rg":
      case "k": {
        const c = colourOf(nums());
        if (c) gs = { ...gs, fill: c };
        break;
      }
      case "G":
      case "RG":
      case "K": {
        const c = colourOf(nums());
        if (c) gs = { ...gs, stroke: c };
        break;
      }
      case "sc":
      case "scn": {
        const c = colourOf(nums());
        if (c) gs = { ...gs, fill: c };
        break;
      }
      case "SC":
      case "SCN": {
        const c = colourOf(nums());
        if (c) gs = { ...gs, stroke: c };
        break;
      }
      case "m": {
        const p = apply(gs.ctm, num(2), num(1));
        cur = start = p;
        break;
      }
      case "l": {
        const p = apply(gs.ctm, num(2), num(1));
        if (cur) segs.push([cur[0], cur[1], p[0], p[1]]);
        else start = p;
        cur = p;
        break;
      }
      case "h":
        closePath();
        break;
      case "re": {
        const [x, y, w, h] = [num(4), num(3), num(2), num(1)];
        const a = apply(gs.ctm, x, y);
        const b = apply(gs.ctm, x + w, y + h);
        pathRects.push({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) });
        break;
      }
      case "S":
        paint(false, true);
        break;
      case "s":
        closePath();
        paint(false, true);
        break;
      case "f":
      case "F":
      case "f*":
        paint(true, false);
        break;
      case "B":
      case "B*":
        paint(true, true);
        break;
      case "b":
      case "b*":
        closePath();
        paint(true, true);
        break;
      case "n":
        endPath();
        break;
      case "BT":
        tlm = IDENTITY;
        adv = 0;
        break;
      case "Tf": {
        fontSize = num(1);
        const n = stack[stack.length - 2];
        fontName = n?.t === "name" ? n.v : "";
        break;
      }
      case "TL":
        leading = num(1);
        break;
      case "Tc":
        charSpace = num(1);
        break;
      case "Tw":
        wordSpace = num(1);
        break;
      case "Td":
        moveBy(num(2), num(1));
        break;
      case "TD":
        leading = -num(1);
        moveBy(num(2), num(1));
        break;
      case "Tm":
        tlm = [num(6), num(5), num(4), num(3), num(2), num(1)];
        adv = 0;
        break;
      case "T*":
        moveBy(0, -leading);
        break;
      case "Tj": {
        const t = stack[stack.length - 1];
        if (t?.t === "str") show(t.v);
        break;
      }
      case "TJ": {
        const t = stack[stack.length - 1];
        if (t?.t === "arr") {
          for (const part of t.v) {
            if (part.t === "str") show(part.v);
            else if (part.t === "num") adv -= (part.v / 1000) * fontSize;
          }
        }
        break;
      }
      case "'":
      case '"': {
        if (tok.v === '"') {
          wordSpace = num(3);
          charSpace = num(2);
        }
        moveBy(0, -leading);
        const t = stack[stack.length - 1];
        if (t?.t === "str") show(t.v);
        break;
      }
      case "Do": {
        const nameTok = stack[stack.length - 1];
        if (nameTok?.t !== "name") break;
        const ref = xobjects?.[nameTok.v];
        if (ref?.t !== "ref") break;
        const [a, b, c, d, e, f] = gs.ctm;
        // Only upright (axis-aligned) placements are drawn.
        if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6) break;
        let img = imageCache.get(ref.v);
        if (img === undefined) {
          try {
            const s = file.stream(ref.v);
            img =
              s && file.name(s.dict.Subtype) === "Image" && file.get(s.dict, "ImageMask")?.t === "bool" && (file.get(s.dict, "ImageMask") as { v: boolean }).v
                ? await maskOf(file, s)
                : null;
          } catch {
            img = null; // one image that cannot be decoded does not cost the page
          }
          imageCache.set(ref.v, img);
        }
        if (!img) break;
        let mask = img.mask;
        const { widthPx, heightPx } = img;
        // The image's first row is the top of the unit square: a negative scale mirrors it.
        if (a < 0 || d < 0) {
          const flipped = new Uint8Array(mask.length);
          for (let y = 0; y < heightPx; y++) {
            for (let x = 0; x < widthPx; x++) {
              flipped[y * widthPx + x] = mask[(d < 0 ? heightPx - 1 - y : y) * widthPx + (a < 0 ? widthPx - 1 - x : x)]!;
            }
          }
          mask = flipped;
        }
        counted();
        images.push({ x: Math.min(e, e + a), y: Math.min(f, f + d), w: Math.abs(a), h: Math.abs(d), widthPx, heightPx, mask, color: gs.fill });
        break;
      }
      default:
        break; // unknown operators (and their operands) are ignored
    }
    stack = [];
  }
  return { texts, lines, rects, images };
}

// ---------------------------------------------------------------------------------------------

/** The parsed file and its pages, or why the PDF cannot be drawn. */
function openPdf(bytes: Uint8Array): { file: PdfFile; pages: PageInfo[] } {
  const head = toBinaryString(bytes.subarray(0, 1024));
  if (!head.includes("%PDF-")) throw new PdfTextError("This file is not a PDF.");
  const file = new PdfFile(bytes);
  if (/\/Encrypt\b/.test(file.binary)) {
    throw new PdfTextError("This PDF is encrypted, so it cannot be drawn. Export an unprotected copy.");
  }
  return { file, pages: pagesOf(file) };
}

async function drawPage(file: PdfFile, page: PageInfo): Promise<PageDrawing> {
  const box = page.mediaBox && page.mediaBox.length >= 4 ? page.mediaBox : [0, 0, 595, 842];
  const [x0, y0, x1, y1] = [Math.min(box[0]!, box[2]!), Math.min(box[1]!, box[3]!), Math.max(box[0]!, box[2]!), Math.max(box[1]!, box[3]!)];

  const contents = file.resolve(page.dict.Contents);
  const parts: Value[] = contents?.t === "arr" ? contents.v : page.dict.Contents ? [page.dict.Contents] : [];
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.t !== "ref") continue;
    const stream = file.stream(part.v);
    if (!stream) continue;
    const data = await file.decode(stream);
    if (!data) throw new PdfTextError("The page's content stream uses a filter that cannot be read.");
    chunks.push(toBinaryString(data));
  }

  const drawn = await interpret(file, chunks.join("\n"), page.resources, [1, 0, 0, 1, -x0, -y0]);
  return { width: x1 - x0, height: y1 - y0, ...drawn };
}

/** Draws page `pageIndex` (0-based) of a PDF. Throws when the file is not a PDF or has no such page. */
export async function renderPdfPage(bytes: Uint8Array, pageIndex = 0): Promise<PageDrawing> {
  const { file, pages } = openPdf(bytes);
  const page = pages[pageIndex];
  if (!page) throw new PdfTextError(`This PDF has no page ${pageIndex + 1}.`);
  return drawPage(file, page);
}

/** Draws every page of a PDF, in order. Throws when the file is not a PDF, has no page, or a page cannot be drawn. */
export async function renderPdfPages(bytes: Uint8Array): Promise<PageDrawing[]> {
  const { file, pages } = openPdf(bytes);
  if (pages.length === 0) throw new PdfTextError("This PDF has no page 1.");
  const drawings: PageDrawing[] = [];
  for (const page of pages) drawings.push(await drawPage(file, page));
  return drawings;
}
