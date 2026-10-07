import type { MonzoTransaction } from "../types";

function parseLine(line: string): string[] {
  const cols: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQ = !inQ;
    } else if (c === "," && !inQ) {
      cols.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  cols.push(cur.trim());
  return cols;
}

function toIso(date: string, time: string): string {
  const [d, m, y] = date.split("/");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${time || "00:00:00"}.000Z`;
}

// CSV columns (0-indexed):
// 0=Transaction ID, 1=Date, 2=Time, 3=Type, 4=Name, 5=Emoji,
// 6=Category, 7=Amount, 8=Currency, 9=Local amount, 10=Local currency,
// 11=Notes and #tags, 12=Address, 13=Receipt, 14=Description,
// 15=Category split, 16=Money Out, 17=Money In
export function parseMonzoCsv(text: string): MonzoTransaction[] {
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  if (lines.length < 2) return [];

  return lines.slice(1).flatMap((line): MonzoTransaction[] => {
    const c = parseLine(line);
    const id = c[0];
    const date = c[1];
    const time = c[2];
    const name = c[4] || "";
    const category = (c[6] || "general").toLowerCase().replace(/\s+/g, "_");
    const amountRaw = parseFloat(c[7]);
    const currency = c[8] || "GBP";
    const localAmountRaw = c[9] ? parseFloat(c[9]) : undefined;
    const localCurrency = c[10] || "";
    const notes = c[11] || "";
    const description = c[14] || name || "";

    if (!id || !date || isNaN(amountRaw) || amountRaw === 0) return [];

    const tx: MonzoTransaction = {
      id,
      created: toIso(date, time),
      settled: toIso(date, time),
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
