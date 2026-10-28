/**
 * Minimal, dependency-free text extraction for the text PDFs payroll systems produce.
 *
 * Content streams are found by scanning for `stream … endstream`, inflated when FlateDecode
 * (via the platform's `DecompressionStream`), and tokenised for the text operators. Every shown
 * string is placed by its position: lines are grouped by page and y, and within a line a string
 * starts at column `round(x / (0.6 × font size))`, i.e. the layout of fixed-width Courier text.
 * Fonts are not consulted (strings are decoded as windows-1252), so this only suits simple-font
 * PDFs; anything with a custom encoding yields garbage text that the payslip parser then rejects.
 */

export class PdfTextError extends Error {}

const NO_TEXT =
  "This PDF has no text layer (is it a scan?). Only text PDFs from the payroll system can be read.";

/** One byte per char, so offsets in the string are offsets in the file. */
function toBinaryString(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

function toBytes(binary: string): Uint8Array {
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff;
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const ds = new DecompressionStream("deflate");
    const writer = ds.writable.getWriter();
    // Not awaited before reading: the writable side only drains as the readable side is read.
    const written = writer.write(data as unknown as BufferSource).then(() => writer.close());
    written.catch(() => undefined);
    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    await written;
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  } catch {
    return null;
  }
}

/** Content streams of the file (decoded to binary strings) in document order. */
async function contentStreams(binary: string, bytes: Uint8Array): Promise<string[]> {
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(binary))) {
    if (m.index >= 3 && binary.slice(m.index - 3, m.index) === "end") continue;
    const start = m.index + m[0].length;
    const dictStart = Math.max(binary.lastIndexOf("obj", m.index), 0);
    const dict = binary.slice(dictStart, m.index);

    let end = binary.indexOf("endstream", start);
    if (end < 0) break;
    const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    if (declared) {
      const at = start + Number(declared[1]);
      if (/^\s*endstream/.test(binary.slice(at, at + 12))) end = at;
    }
    re.lastIndex = end;

    if (
      /\/Subtype\s*\/Image/.test(dict) ||
      /\/Length[123]\b/.test(dict) ||
      /\/Type\s*\/(?:XRef|ObjStm|Metadata|EmbeddedFile)/.test(dict) ||
      /\/Predictor\s+(?:[2-9]|\d\d)/.test(dict)
    ) {
      continue;
    }
    const filters = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1];
    const names = filters ? (filters.match(/\/\w+/g) ?? []) : [];
    if (names.length === 0) {
      out.push(binary.slice(start, end));
    } else if (names.length === 1 && names[0] === "/FlateDecode") {
      const inflated = await inflate(bytes.subarray(start, end));
      if (inflated) out.push(toBinaryString(inflated));
    }
  }
  return out;
}

type Token =
  | { t: "num"; v: number }
  | { t: "name"; v: string }
  | { t: "str"; v: string }
  | { t: "arr"; v: Token[] }
  | { t: "op"; v: string };

const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITERS = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)));

function isRegular(code: number): boolean {
  return !WHITESPACE.has(code) && !DELIMITERS.has(code);
}

/** Tokenises a content stream (a binary string). Dictionaries and inline data are skipped. */
function* tokenise(s: string): Generator<Token> {
  let i = 0;
  const n = s.length;

  const literal = (): string => {
    // s[i] is the char after the opening "("
    let depth = 1;
    let out = "";
    while (i < n && depth > 0) {
      const c = s[i++]!;
      if (c === "\\") {
        const e = s[i++];
        if (e === undefined) break;
        if (e >= "0" && e <= "7") {
          let oct = e;
          while (oct.length < 3 && s[i]! >= "0" && s[i]! <= "7") oct += s[i++];
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        } else if (e === "n") out += "\n";
        else if (e === "r") out += "\r";
        else if (e === "t") out += "\t";
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "\r") {
          if (s[i] === "\n") i++;
        } else if (e === "\n") {
          // line continuation
        } else out += e;
      } else if (c === "(") {
        depth++;
        out += c;
      } else if (c === ")") {
        depth--;
        if (depth > 0) out += c;
      } else out += c;
    }
    return out;
  };

  const hex = (): string => {
    let digits = "";
    while (i < n && s[i] !== ">") {
      if (/[0-9a-fA-F]/.test(s[i]!)) digits += s[i];
      i++;
    }
    i++; // ">"
    if (digits.length % 2) digits += "0";
    let out = "";
    for (let k = 0; k < digits.length; k += 2) out += String.fromCharCode(parseInt(digits.slice(k, k + 2), 16));
    return out;
  };

  const array = (): Token[] => {
    const items: Token[] = [];
    while (i < n) {
      while (i < n && WHITESPACE.has(s.charCodeAt(i))) i++;
      if (s[i] === "]") {
        i++;
        break;
      }
      const tok = next();
      if (!tok) break;
      items.push(tok);
    }
    return items;
  };

  const next = (): Token | null => {
    for (;;) {
      while (i < n && WHITESPACE.has(s.charCodeAt(i))) i++;
      if (i >= n) return null;
      const c = s[i]!;
      if (c === "%") {
        while (i < n && s[i] !== "\n" && s[i] !== "\r") i++;
        continue;
      }
      if (c === "(") {
        i++;
        return { t: "str", v: literal() };
      }
      if (c === "<") {
        if (s[i + 1] === "<") {
          i += 2;
          continue;
        }
        i++;
        return { t: "str", v: hex() };
      }
      if (c === ">") {
        i += s[i + 1] === ">" ? 2 : 1;
        continue;
      }
      if (c === "[") {
        i++;
        return { t: "arr", v: array() };
      }
      if (c === "]" || c === "{" || c === "}" || c === ")") {
        i++;
        continue;
      }
      if (c === "/") {
        const start = ++i;
        while (i < n && isRegular(s.charCodeAt(i))) i++;
        return { t: "name", v: s.slice(start, i) };
      }
      const start = i;
      while (i < n && isRegular(s.charCodeAt(i))) i++;
      const word = s.slice(start, i);
      if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) return { t: "num", v: Number(word) };
      return { t: "op", v: word };
    }
  };

  for (let tok = next(); tok; tok = next()) yield tok;
}

interface Shown {
  page: number;
  x: number;
  y: number;
  size: number;
  text: string;
}

function textOf(tok: Token | undefined): string {
  if (!tok) return "";
  if (tok.t === "str") return tok.v;
  if (tok.t === "arr") return tok.v.map((t) => (t.t === "str" ? t.v : "")).join("");
  return "";
}

/** Walks one content stream's text objects, returning every shown string with its position. */
function showStrings(stream: string, page: number): Shown[] {
  const out: Shown[] = [];
  let stack: Token[] = [];
  // Text line matrix [a b c d e f] and the current text position within the line.
  let tlm = [1, 0, 0, 1, 0, 0];
  let advance = 0;
  let size = 0;
  let leading = 0;

  const moveBy = (tx: number, ty: number) => {
    tlm = [tlm[0]!, tlm[1]!, tlm[2]!, tlm[3]!, tlm[4]! + tx * tlm[0]! + ty * tlm[2]!, tlm[5]! + tx * tlm[1]! + ty * tlm[3]!];
    advance = 0;
  };
  const show = (raw: string) => {
    if (!raw) return;
    const eff = Math.abs(size * tlm[0]!) || Math.abs(size) || 1;
    out.push({ page, x: tlm[4]! + advance, y: tlm[5]!, size: eff, text: raw });
    advance += raw.length * 0.6 * eff;
  };
  const num = (k: number): number => {
    const t = stack[stack.length - k];
    return t?.t === "num" ? t.v : 0;
  };

  for (const tok of tokenise(stream)) {
    if (tok.t !== "op") {
      stack.push(tok);
      if (stack.length > 64) stack = stack.slice(-32);
      continue;
    }
    switch (tok.v) {
      case "BT":
        tlm = [1, 0, 0, 1, 0, 0];
        advance = 0;
        break;
      case "Tf":
        size = num(1);
        break;
      case "TL":
        leading = num(1);
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
        advance = 0;
        break;
      case "T*":
        moveBy(0, -leading);
        break;
      case "Tj":
      case "TJ":
        show(textOf(stack[stack.length - 1]));
        break;
      case "'":
        moveBy(0, -leading);
        show(textOf(stack[stack.length - 1]));
        break;
      case '"':
        moveBy(0, -leading);
        show(textOf(stack[stack.length - 1]));
        break;
    }
    stack = [];
  }
  return out;
}

const decoder = () => new TextDecoder("windows-1252");

/** Text lines of a PDF, page by page, top to bottom, with columns kept by fixed-width position. */
export async function extractPdfLines(bytes: Uint8Array): Promise<string[]> {
  const binary = toBinaryString(bytes);
  if (!binary.startsWith("%PDF-") && !binary.slice(0, 1024).includes("%PDF-")) {
    throw new PdfTextError("This file is not a PDF.");
  }
  if (/\/Encrypt\b/.test(binary)) {
    throw new PdfTextError("This PDF is encrypted, so its text cannot be read. Export an unprotected copy.");
  }

  const streams = await contentStreams(binary, bytes);
  const lines: string[] = [];
  const dec = decoder();
  streams.forEach((stream, page) => {
    const rows = new Map<number, Shown[]>();
    for (const s of showStrings(stream, page)) {
      const y = Math.round(s.y * 2) / 2;
      const row = rows.get(y);
      if (row) row.push(s);
      else rows.set(y, [s]);
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      const chars: string[] = [];
      const strings = rows.get(y)!.map((s, order) => ({ s, order })).sort((a, b) => a.s.x - b.s.x || a.order - b.order);
      for (const { s } of strings) {
        const col = Math.max(0, Math.round(s.x / (0.6 * s.size)));
        const text = dec.decode(toBytes(s.text));
        [...text].forEach((ch, k) => {
          chars[col + k] = ch;
        });
      }
      const line = Array.from(chars, (c) => c ?? " ").join("").trimEnd();
      if (line.trim()) lines.push(line);
    }
  });

  if (lines.length === 0) throw new PdfTextError(NO_TEXT);
  return lines;
}
