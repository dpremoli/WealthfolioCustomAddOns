import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { cashSymbol } from "@wf-addons/kit";
import { accountPerActivityRate, chargesInActivityCurrency } from "./mapper";
import type { SymbolResolver } from "./symbol-resolver";
import { mapSpendingCategory } from "./spending-category";

type ActivityType = ActivityImport["activityType"];

/** Builds a card activity comment from the merchant and mapped spending category. */
function cardComment(merchant?: string, category?: string): string | undefined {
  const parts = [merchant, category].filter((p): p is string => !!p);
  return parts.length ? parts.join(" · ") : undefined;
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
  // "2025-12-03 06:45:21+00:00" (the Cash ISA export): honour the offset.
  const withOffset = t.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)([+-]\d{2}:?\d{2}|Z)$/);
  if (withOffset) {
    const ms = Date.parse(`${withOffset[1]}T${withOffset[2]}${withOffset[3]}`);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  const dt = t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?/);
  if (dt) return `${dt[1]}T${dt[2]}${dt[3] ?? ""}Z`;
  const dateOnly = t.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnly) return `${dateOnly[1]}T00:00:00Z`;
  return t; // unknown format — pass through and let import validate it
}

/**
 * FX rate + charges for a BUY/SELL row, in Wealthfolio's final-cash terms: every monetary
 * field is in the activity (price) currency and `fxRate` is account-per-activity units (see
 * `accountPerActivityRate`). Only a cross-currency trade gets a rate; its charges, which the
 * CSV reports in the account currency, are converted back into the activity currency.
 */
function tradeFxAndFee(
  row: Record<string, string>,
  qty: number,
  unitPrice: number,
  priceCurrency: string,
  accountCurrency: string,
): { fxRate: number | undefined; fee: number } {
  const cross = priceCurrency.toUpperCase() !== accountCurrency.toUpperCase();
  const total = Math.abs(parseAmount(col(row, "Total", "Result (GBP)", "Result")));
  const implied = total > 0 && qty > 0 && unitPrice > 0 ? total / (qty * unitPrice) : undefined;
  const fxRate = cross ? accountPerActivityRate(parseAmount(row["Exchange rate"]) || undefined, implied) : undefined;
  const fee = chargesInActivityCurrency(
    [
      {
        amount: Math.abs(parseAmount(row["Charge amount"])),
        currency: col(row, "Currency (Charge amount)") || accountCurrency,
      },
      {
        amount: Math.abs(parseAmount(row["Currency conversion fee"])),
        currency: col(row, "Currency (Currency conversion fee)") || accountCurrency,
      },
    ],
    priceCurrency,
    fxRate,
  );
  return { fxRate, fee };
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
  cardAccountId?: string,
): Promise<ActivityImport | null> {
  // When card extraction is on, card spend/refund/cashback rows are routed to the
  // dedicated card (spending) account instead of the main investing account.
  const cardAccount = cardAccountId ?? accountId;
  const action = row["Action"]?.trim();
  if (!action) return null;
  // The Cash ISA export puts some deposits' id only in Notes ("Transaction ID: <uuid>").
  const csvId =
    row["ID"]?.trim() || /Transaction ID:\s*([0-9a-f-]{8,})/i.exec(row["Notes"] ?? "")?.[1] || "";

  // "Time" in the Invest/ISA export, "Time (UTC)" in the Cash ISA export.
  const rawTime = col(row, "Time", "Time (UTC)");
  if (!rawTime) return null;
  const date = toIsoDate(rawTime);

  const ticker = row["Ticker"]?.trim() || undefined;
  const isin = row["ISIN"]?.trim() || undefined;
  const name = row["Name"]?.trim() || undefined;
  const merchant = row["Merchant name"]?.trim() || undefined;
  const notes = row["Notes"]?.trim() || undefined;

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

  // Dividends in the T212 CSV consistently have an empty ID column, and so do some Cash ISA
  // cash rows; those get the stable composite id. Anything else without an ID is skipped.
  const cashAction =
    actionLower === "deposit" ||
    actionLower === "withdrawal" ||
    actionLower === "withdraw" ||
    actionLower.includes("interest");
  if (!csvId && !actionLower.startsWith("dividend") && !cashAction) return null;
  const cashId = csvId || stableId(actionLower);

  // ── BUY ────────────────────────────────────────────────────────────────
  if (actionLower.endsWith(" buy") || actionLower === "buy") {
    if (!ticker) return null;
    const qty = parseAmount(row["No. of shares"]);
    const unitPrice = parseAmount(row["Price / share"]);
    if (qty <= 0 || unitPrice <= 0) return null;
    const priceCurrency = col(row, "Currency (Price / share)") || currency;
    // Pass the share's quote currency so cross-listings resolve to the right
    // exchange (e.g. a USD price picks TSM over the MXN-quoted TSMN).
    const symbol = await resolver.resolve(ticker, { isin, name, currency: priceCurrency });
    if (!symbol) return null;
    const { fxRate, fee } = tradeFxAndFee(row, qty, unitPrice, priceCurrency, currency);
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
    const priceCurrency = col(row, "Currency (Price / share)") || currency;
    const symbol = await resolver.resolve(ticker, { isin, name, currency: priceCurrency });
    if (!symbol) return null;
    const { fxRate, fee } = tradeFxAndFee(row, qty, unitPrice, priceCurrency, currency);
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
    if (total <= 0) return null;
    // A dividend tied to a security (has a ticker) → DIVIDEND on that symbol.
    if (ticker) {
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
    // No security (e.g. "Dividend adjustment" — a withholding-tax cash credit) → cash income.
    return {
      id: `t212-txn-${csvId || stableId(actionLower)}`,
      accountId,
      activityType: "INTEREST" as ActivityType,
      date,
      symbol: cashSymbol(currency),
      amount: total,
      currency,
      isValid: true,
      isDraft: false,
      comment: notes,
    };
  }

  // ── CARD: debit (spend) → withdrawal, credit (refund) → deposit ─────────
  // The T212 `Merchant category` column (card debits only) is mapped to a Wealthfolio
  // spending label and appended to the comment ("MERCHANT · Label").
  if (actionLower === "card debit") {
    if (total <= 0) return null;
    const category = mapSpendingCategory(row["Merchant category"]);
    return {
      id: `t212-txn-${csvId}`,
      accountId: cardAccount,
      activityType: "WITHDRAWAL" as ActivityType,
      date,
      symbol: cashSymbol(currency),
      amount: total,
      currency,
      isValid: true,
      isDraft: false,
      comment: cardComment(merchant, category),
    };
  }
  if (actionLower === "card credit") {
    if (total <= 0) return null;
    const category = mapSpendingCategory(row["Merchant category"]);
    return {
      id: `t212-txn-${csvId}`,
      accountId: cardAccount,
      activityType: "DEPOSIT" as ActivityType,
      date,
      symbol: cashSymbol(currency),
      amount: total,
      currency,
      isValid: true,
      isDraft: false,
      comment: cardComment(merchant, category),
    };
  }

  // ── INTEREST (Interest on cash / Lending interest) and cashback rewards ──
  // Spending cashback is a card reward → route it to the card account too (so the
  // spending account nets correctly); cash/lending interest stays in the investing account.
  if (actionLower.includes("interest") || actionLower.includes("cashback")) {
    if (total <= 0) return null;
    const isCashback = actionLower.includes("cashback");
    return {
      id: `t212-txn-${cashId}`,
      accountId: isCashback ? cardAccount : accountId,
      activityType: "INTEREST" as ActivityType,
      date,
      symbol: cashSymbol(currency),
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
      id: `t212-txn-${cashId}`,
      accountId,
      activityType: "DEPOSIT" as ActivityType,
      date,
      symbol: cashSymbol(currency),
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
      id: `t212-txn-${cashId}`,
      accountId,
      activityType: "WITHDRAWAL" as ActivityType,
      date,
      symbol: cashSymbol(currency),
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
      symbol: cashSymbol(currency),
      amount: total,
      currency,
      isValid: true,
      isDraft: false,
    };
  }

  // Skip stock splits, spin-offs, and anything else unrecognised.
  return null;
}
