/** "£1,234.50" (negative: "-£12.00"). */
export function gbp(n: number): string {
  const abs = Math.abs(n).toFixed(2);
  const [whole = "0", frac = "00"] = abs.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${n < 0 && Number(abs) !== 0 ? "-" : ""}£${grouped}.${frac}`;
}

/** A share (0..1) as "23.4%". */
export function pct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/** The YYYY-MM-DD of a date or ISO string, or "" when there is none. */
export function isoDay(d: Date | string | null | undefined): string {
  if (!d) return "";
  if (typeof d === "string") return d.slice(0, 10);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export const todayIso = (): string => new Date().toISOString().slice(0, 10);
