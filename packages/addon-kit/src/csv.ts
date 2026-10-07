/**
 * RFC 4180 CSV parsing shared by every importer. Handles quoted fields, escaped
 * quotes (`""`), delimiters and newlines inside quotes, CRLF/LF line endings and a
 * leading UTF-8 BOM. Rows that are entirely empty are dropped.
 */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (row.some((f) => f.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      endField();
    } else if (c === "\n") {
      endRow();
    } else if (c === "\r") {
      if (src[i + 1] === "\n") i++;
      endRow();
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/**
 * Looks up column positions by header label (case- and whitespace-insensitive),
 * falling back to a default index when a label is missing. Banks tweak their
 * exports, so matching by name keeps parsers working across format changes.
 */
export function headerIndex(header: string[]): (name: string | string[], fallback: number) => number {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const lower = header.map(norm);
  return (name, fallback) => {
    for (const n of Array.isArray(name) ? name : [name]) {
      const idx = lower.indexOf(norm(n));
      if (idx >= 0) return idx;
    }
    return fallback;
  };
}

/** Parses a CSV with a header row into records keyed by the trimmed header labels. */
export function parseCsvRecords(text: string, delimiter = ","): Record<string, string>[] {
  const [header, ...body] = parseCsv(text, delimiter);
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body.map((cells) =>
    Object.fromEntries(keys.map((k, i) => [k, (cells[i] ?? "").trim()])),
  );
}
