import type { ActivityImport } from "@wealthfolio/addon-sdk";
import type { SymbolResolver } from "./symbol-resolver";

type ActivityType = ActivityImport["activityType"];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Splits one CSV line into field values, handling RFC 4180 double-quoted fields. */
function parseFields(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) {
      fields.push("");
      break;
    }
    if (line[i] === '"') {
      i++;
      let val = "";
      while (i < line.length) {
        if (line[i] === '"') {
          i++;
          if (line[i] === '"') {
            // escaped double-quote
            val += '"';
            i++;
          } else {
            break; // closing quote
          }
        } else {
          val += line[i++];
        }
      }
      fields.push(val);
      if (line[i] === ",") i++;
    } else {
      const end = line.indexOf(",", i);
      if (end === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

/** Parses CSV text (with a header row) into an array of records keyed by column name. */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  if (lines.length < 2) return [];

  const headers = parseFields(lines[0]);
  const out: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const values = parseFields(line);
    const record: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      record[headers[j].trim()] = (values[j] ?? "").trim();
    }
    out.push(record);
  }

  return out;
}

/** Parses a numeric string from a T212 CSV. Removes comma thousands-separators. */
function parseAmount(s: string | undefined): number {
  if (!s || !s.trim()) return 0;
  const clean = s.trim().replace(/\s/g, "").replace(/,/g, "");
  const n = parseFloat(clean);
  return isNaN(n) ? 0 : n;
}

/** Returns the first non-empty value from the given column name candidates. */
function col(row: Record<string, string>, ...names: string[]): string {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v !== "") return v;
  }
  return "";
}

/**
 * Normalises a T212 CSV timestamp to ISO 8601 (UTC).
 * The CSV uses "YYYY-MM-DD HH:MM:SS" (space-separated, no timezone); Wealthfolio's
 * import expects ISO 8601, so we insert the `T` and append `Z` (T212 times are UTC).
 * Already-ISO values (with `T` and a `Z`/offset) pass through unchanged.
 */
function toIsoDate(s: string): string {
  const t = s.trim();
  // Already ISO with a timezone — leave as-is.
  if (/T\d{2}:\d{2}/.test(t) && /(Z|[+-]\d{2}:?\d{2})$/.test(t)) return t;
  const dt = t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?/);
  if (dt) return `${dt[1]}T${dt[2]}${dt[3] ?? ""}Z`;
  const dateOnly = t.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnly) return `${dateOnly[1]}T00:00:00Z`;
  return t; // unknown format — pass through and let import validate it
}

/**
 * Maps one T212 CSV row to a Wealthfolio ActivityImport.
 *
 * Returns null for unrecognised actions (stock splits, spin-offs, unknown rows),
 * rows missing required fields, or trades/dividends whose ticker cannot be resolved
 * to a Wealthfolio symbol.
 */
export async function mapCsvRow(
  row: Record<string, string>,
  accountId: string,
  resolver: SymbolResolver,
): Promise<ActivityImport | null> {
  const csvId = row["ID"]?.trim() ?? "";
  const action = row["Action"]?.trim();
  if (!action) return null;

  const rawTime = row["Time"];
  if (!rawTime) return null;
  const date = toIsoDate(rawTime);

  const ticker = row["Ticker"]?.trim() || undefined;
  const isin = row["ISIN"]?.trim() || undefined;
  const name = row["Name"]?.trim() || undefined;

  // Total amount in account currency. Column name differs between export versions.
  const totalStr = col(row, "Total", "Result (GBP)", "Result");
  const totalCurStr = col(row, "Currency (Total)", "Currency (Result)");
  const total = Math.abs(parseAmount(totalStr));
  const currency = totalCurStr || "GBP";

  // T212 CSV omits the ID field for dividends. Build a stable composite ID
  // from the key fields so the row can still be deduplicated across re-imports.
  const stableId = (action: string) =>
    csvId ||
    `${ticker ?? ""}-${rawTime.replace(/[^0-9]/g, "")}-${totalStr.replace(/[^0-9.]/g, "")}-${action}`;

  const actionLower = action.toLowerCase();

  // Dividends in the T212 CSV consistently have an empty ID column.
  // All other action types carry a UUID — skip them if the ID is missing.
  if (!csvId && !actionLower.startsWith("dividend")) return null;

  // ── BUY ────────────────────────────────────────────────────────────────
  if (actionLower.endsWith(" buy") || actionLower === "buy") {
    if (!ticker) return null;
    const qty = parseAmount(row["No. of shares"]);
    const unitPrice = parseAmount(row["Price / share"]);
    if (qty <= 0 || unitPrice <= 0) return null;
    const symbol = await resolver.resolve(ticker, { isin, name });
    if (!symbol) return null;
    const priceCurrency = col(row, "Currency (Price / share)") || currency;
    const fxRateRaw = parseAmount(row["Exchange rate"]);
    const fxRate = fxRateRaw && fxRateRaw !== 1 ? fxRateRaw : undefined;
    const fee = round2(
      Math.abs(parseAmount(row["Charge amount"])) +
        Math.abs(parseAmount(row["Currency conversion fee"])),
    );
    return {
      id: `t212-order-${csvId}`,
      accountId,
      activityType: "BUY" as ActivityType,
      date,
      symbol,
      quantity: qty,
      unitPrice,
      fee: fee > 0 ? fee : undefined,
      currency: priceCurrency,
      fxRate,
      isValid: true,
      isDraft: false,
      comment: name,
    };
  }

  // ── SELL ───────────────────────────────────────────────────────────────
  if (actionLower.endsWith(" sell") || actionLower === "sell") {
    if (!ticker) return null;
    const qty = parseAmount(row["No. of shares"]);
    const unitPrice = parseAmount(row["Price / share"]);
    if (qty <= 0 || unitPrice <= 0) return null;
    const symbol = await resolver.resolve(ticker, { isin, name });
    if (!symbol) return null;
    const priceCurrency = col(row, "Currency (Price / share)") || currency;
    const fxRateRaw = parseAmount(row["Exchange rate"]);
    const fxRate = fxRateRaw && fxRateRaw !== 1 ? fxRateRaw : undefined;
    const fee = round2(
      Math.abs(parseAmount(row["Charge amount"])) +
        Math.abs(parseAmount(row["Currency conversion fee"])),
    );
    return {
      id: `t212-order-${csvId}`,
      accountId,
      activityType: "SELL" as ActivityType,
      date,
      symbol,
      quantity: qty,
      unitPrice,
      fee: fee > 0 ? fee : undefined,
      currency: priceCurrency,
      fxRate,
      isValid: true,
      isDraft: false,
      comment: name,
    };
  }

  // ── DIVIDEND ───────────────────────────────────────────────────────────
  if (actionLower.startsWith("dividend")) {
    if (!ticker || total <= 0) return null;
    const symbol = await resolver.resolve(ticker, { isin, name });
    if (!symbol) return null;
    return {
      id: `t212-div-${stableId(actionLower)}`,
      accountId,
      activityType: "DIVIDEND" as ActivityType,
      date,
      symbol,
      amount: total,
      currency,
      isValid: true,
      isDraft: false,
    };
  }

  // ── INTEREST (Interest on cash / Lending interest) ─────────────────────
  if (actionLower.includes("interest")) {
    if (total <= 0) return null;
    return {
      id: `t212-txn-${csvId}`,
      accountId,
      activityType: "INTEREST" as ActivityType,
      date,
      amount: total,
      currency,
      isValid: true,
      isDraft: false,
    };
  }

  // ── DEPOSIT ────────────────────────────────────────────────────────────
  if (actionLower === "deposit") {
    if (total <= 0) return null;
    return {
      id: `t212-txn-${csvId}`,
      accountId,
      activityType: "DEPOSIT" as ActivityType,
      date,
      amount: total,
      currency,
      isValid: true,
      isDraft: false,
    };
  }

  // ── WITHDRAWAL ─────────────────────────────────────────────────────────
  if (actionLower === "withdrawal" || actionLower === "withdraw") {
    if (total <= 0) return null;
    return {
      id: `t212-txn-${csvId}`,
      accountId,
      activityType: "WITHDRAWAL" as ActivityType,
      date,
      amount: total,
      currency,
      isValid: true,
      isDraft: false,
    };
  }

  // ── FEE / CHARGE (standalone rows — fees embedded in trades are in the fee field) ─
  if (
    actionLower.includes("fee") ||
    actionLower.includes("charge") ||
    actionLower.includes("stamp duty") ||
    actionLower.includes("currency conversion")
  ) {
    if (total <= 0) return null;
    return {
      id: `t212-txn-${csvId}`,
      accountId,
      activityType: "FEE" as ActivityType,
      date,
      amount: total,
      currency,
      isValid: true,
      isDraft: false,
    };
  }

  // Skip stock splits, spin-offs, and anything else unrecognised.
  return null;
}
