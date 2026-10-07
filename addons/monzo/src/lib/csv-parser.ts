import { headerIndex, parseCsv } from "@wf-addons/kit";
import type { MonzoTransaction } from "../types";

function toIso(date: string, time: string): string {
  const [d = "", m = "", y = ""] = date.split("/");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${time || "00:00:00"}.000Z`;
}

/**
 * Parses a Monzo CSV export (app: Account -> Export transactions -> CSV).
 *
 * Columns are matched by header name, falling back to the historical positions:
 * 0=Transaction ID, 1=Date, 2=Time, 3=Type, 4=Name, 5=Emoji, 6=Category, 7=Amount,
 * 8=Currency, 9=Local amount, 10=Local currency, 11=Notes and #tags, 12=Address,
 * 13=Receipt, 14=Description, 15=Category split, 16=Money Out, 17=Money In.
 *
 * Rows without an id/date, or with a zero or unparseable amount, are dropped.
 */
export function parseMonzoCsv(text: string): MonzoTransaction[] {
  const [header, ...rows] = parseCsv(text);
  if (!header || rows.length === 0) return [];

  const at = headerIndex(header);
  const iId = at("Transaction ID", 0);
  const iDate = at("Date", 1);
  const iTime = at("Time", 2);
  const iName = at("Name", 4);
  const iCategory = at("Category", 6);
  const iAmount = at("Amount", 7);
  const iCurrency = at("Currency", 8);
  const iLocalAmount = at("Local amount", 9);
  const iLocalCurrency = at("Local currency", 10);
  const iNotes = at(["Notes and #tags", "Notes"], 11);
  const iDescription = at("Description", 14);

  return rows.flatMap((raw): MonzoTransaction[] => {
    const c = raw.map((f) => f.trim());
    const id = c[iId];
    const date = c[iDate];
    const time = c[iTime];
    const name = c[iName] || "";
    const category = (c[iCategory] || "general").toLowerCase().replace(/\s+/g, "_");
    const amountRaw = parseFloat(c[iAmount]);
    const currency = c[iCurrency] || "GBP";
    const localAmountRaw = c[iLocalAmount] ? parseFloat(c[iLocalAmount]) : undefined;
    const localCurrency = c[iLocalCurrency] || "";
    const notes = c[iNotes] || "";
    const description = c[iDescription] || name || "";

    if (!id || !date || isNaN(amountRaw) || amountRaw === 0) return [];

    const created = toIso(date, time);
    // An unparseable date would otherwise be imported as the Unix epoch.
    if (Number.isNaN(Date.parse(created))) return [];

    const tx: MonzoTransaction = {
      id,
      created,
      settled: created,
      amount: Math.round(amountRaw * 100),
      currency,
      description,
      notes,
      category,
      merchant: name ? { name } : undefined,
      is_load: false,
      metadata: {},
    };

    if (
      localAmountRaw !== undefined &&
      !isNaN(localAmountRaw) &&
      localCurrency &&
      localCurrency !== currency
    ) {
      tx.local_amount = Math.round(localAmountRaw * 100);
      tx.local_currency = localCurrency;
    }

    return [tx];
  });
}
