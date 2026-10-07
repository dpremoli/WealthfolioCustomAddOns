import { fnv1a, headerIndex, parseCsv } from "@wf-addons/kit";
import type { RevolutTransaction } from "../types";

/**
 * Converts Revolut's "YYYY-MM-DD HH:MM:SS" timestamp to ISO 8601. Revolut writes
 * single-digit hours (e.g. "2021-09-18 1:25:56"), so the time is normalised to
 * zero-padded HH:MM:SS before assembling the ISO string.
 */
function toIso(raw: string): string {
  const [datePart = "", timePart = "00:00:00"] = raw.trim().split(/\s+/);
  const [h = "00", m = "00", s = "00"] = timePart.split(":");
  const time = `${h.padStart(2, "0")}:${m.padStart(2, "0")}:${s.padStart(2, "0")}`;
  return `${datePart}T${time}.000Z`;
}

/**
 * Parses a Revolut account-statement CSV export into normalised transactions.
 *
 * Expected columns:
 *   Type, Product, Started Date, Completed Date, Description, Amount, Fee, Currency, State, Balance
 *
 * Only COMPLETED rows with a non-zero amount are kept (PENDING/REVERTED/DECLINED are
 * dropped). Amounts stay in major units. Each row gets a deterministic `id` derived
 * from its completed date, amount, description and running balance.
 */
export function parseRevolutCsv(text: string): RevolutTransaction[] {
  const [header, ...rows] = parseCsv(text);
  if (!header || rows.length === 0) return [];

  const at = headerIndex(header);
  const iType = at("Type", 0);
  const iProduct = at("Product", 1);
  const iStarted = at("Started Date", 2);
  const iCompleted = at("Completed Date", 3);
  const iDescription = at("Description", 4);
  const iAmount = at("Amount", 5);
  const iFee = at("Fee", 6);
  const iCurrency = at("Currency", 7);
  const iState = at("State", 8);
  const iBalance = at("Balance", 9);

  return rows.flatMap((raw): RevolutTransaction[] => {
    const c = raw.map((f) => f.trim());
    const type = c[iType] || "";
    const product = c[iProduct] || "";
    const completed = c[iCompleted] || c[iStarted] || "";
    const description = c[iDescription] || type || "";
    const amount = parseFloat(c[iAmount]);
    const feeRaw = parseFloat(c[iFee]);
    const fee = isNaN(feeRaw) ? 0 : feeRaw;
    const currency = c[iCurrency] || "GBP";
    const state = (c[iState] || "").toUpperCase();
    const balance = c[iBalance] || "";
    const balanceNum = parseFloat(balance);

    // Only finalised, money-moving rows. Pending/declined/reverted are excluded.
    if (!completed || isNaN(amount) || amount === 0) return [];
    if (state !== "COMPLETED") return [];

    // Guard against unparseable dates — without this an invalid timestamp would
    // be imported as the Unix epoch (1970) rather than the real transaction date.
    const date = toIso(completed);
    if (Number.isNaN(Date.parse(date))) return [];

    const id = `revolut-${currency}-${fnv1a(`${completed}|${amount}|${description}|${balance}`)}`;

    return [
      {
        id,
        type,
        date,
        description,
        amount,
        fee,
        currency,
        state,
        product,
        balance: isNaN(balanceNum) ? null : balanceNum,
      },
    ];
  });
}
