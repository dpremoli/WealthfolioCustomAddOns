/** Rounds to 2 decimal places, avoiding binary float drift (10.005 → 10.01). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Wealthfolio's synthetic cash symbol for a currency. Cash activities (deposits,
 * withdrawals, fees, cash transfers) must use this rather than a bare currency
 * code: a bare "GBP" is treated as a security and valued via an FX quote, which
 * inflates account totals.
 */
export function cashSymbol(currency: string): string {
  return `$CASH-${currency.trim().toUpperCase()}`;
}

// Minor-unit currencies Wealthfolio converts to their major unit on import (fx/currency.rs):
// the major code and how many minor units make one.
const MINOR_UNITS: Record<string, { major: string; factor: number }> = {
  GBX: { major: "GBP", factor: 100 },
  KWF: { major: "KWD", factor: 1000 },
  ZAC: { major: "ZAR", factor: 100 },
  ILA: { major: "ILS", factor: 100 },
  USX: { major: "USD", factor: 100 },
};

/** The major unit of a minor-unit currency and its size (GBp/GBX → GBP, 100), or null. */
export function minorUnit(currency: string): { major: string; factor: number } | null {
  // "GBp" is pence; uppercased it would read as pounds.
  const c = currency.trim();
  return MINOR_UNITS[c === "GBp" ? "GBX" : c.toUpperCase()] ?? null;
}

/**
 * The major unit of a minor-unit currency (GBp/GBX → GBP, ZAc → ZAR), else the code unchanged.
 * Wealthfolio divides an imported row's price, amount and fee by 100 (1,000 for KWF) when its
 * currency is a minor unit, whatever the row is: a SPLIT carries its ratio in `amount`, so one
 * sent in GBX stores a hundredth of the ratio. It keeps `fxRate` as sent, so a rate per penny
 * values the trade at a hundredth too. Send such rows in the major unit.
 */
export function majorCurrency(currency: string): string {
  return minorUnit(currency)?.major ?? currency;
}

/** FNV-1a string hash → 8-char hex. Used for stable ids derived from row content. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
