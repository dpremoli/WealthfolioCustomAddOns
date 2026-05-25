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
  const id = row["ID"];
  const action = row["Action"]?.trim();
  if (!id || !action) return null;

  const time = row["Time"];
  if (!time) return null;

  const ticker = row["Ticker"]?.trim() || undefined;
  const isin = row["ISIN"]?.trim() || undefined;
  const name = row["Name"]?.trim() || undefined;

  // Total amount in account currency. Column name differs between export versions.
  const totalStr = col(row, "Total", "Result (GBP)", "Result");
  const totalCurStr = col(row, "Currency (Total)", "Currency (Result)");
  const total = Math.abs(parseAmount(totalStr));
  const currency = totalCurStr || "GBP";

  const actionLower = action.toLowerCase();

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
      id: `t212-order-${id}`,
      accountId,
      activityType: "BUY" as ActivityType,
      date: time,
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
      id: `t212-order-${id}`,
      accountId,
      activityType: "SELL" as ActivityType,
      date: time,
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
      id: `t212-div-${id}`,
      accountId,
      activityType: "DIVIDEND" as ActivityType,
      date: time,
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
      id: `t212-txn-${id}`,
      accountId,
      activityType: "INTEREST" as ActivityType,
      date: time,
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
      id: `t212-txn-${id}`,
      accountId,
      activityType: "DEPOSIT" as ActivityType,
      date: time,
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
      id: `t212-txn-${id}`,
      accountId,
      activityType: "WITHDRAWAL" as ActivityType,
      date: time,
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
      id: `t212-txn-${id}`,
      accountId,
      activityType: "FEE" as ActivityType,
      date: time,
      amount: total,
      currency,
      isValid: true,
      isDraft: false,
    };
  }

  // Skip stock splits, spin-offs, and anything else unrecognised.
  return null;
}
