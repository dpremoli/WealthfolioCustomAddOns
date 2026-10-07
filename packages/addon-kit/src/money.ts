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

/** FNV-1a string hash → 8-char hex. Used for stable ids derived from row content. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
