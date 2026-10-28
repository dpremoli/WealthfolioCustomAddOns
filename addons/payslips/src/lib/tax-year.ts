const MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];

function parseIso(isoDate: string): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) throw new Error(`Not an ISO date: ${isoDate}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** UK tax year (the calendar year it starts in) of a date; the year starts on 6 April. */
export function taxYearOf(isoDate: string): number {
  const { y, m, d } = parseIso(isoDate);
  return m < 4 || (m === 4 && d < 6) ? y - 1 : y;
}

/** "2026/27" for the tax year starting in 2026. */
export function taxYearLabel(start: number): string {
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Reads a SAP "Tax Period" such as "07/2026" (tax month 7 of the tax year starting 2026). */
export function parseTaxPeriod(s: string): { month: number; taxYear: number } {
  const m = /^(\d{1,2})\/(\d{4})$/.exec(s.trim());
  const month = m ? Number(m[1]) : 0;
  if (!m || month < 1 || month > 12) throw new Error(`Bad tax period: "${s}"`);
  return { month, taxYear: Number(m[2]) };
}

/** Month name of a tax period: 1 = Apr … 12 = Mar. */
export function periodLabel(month: number): string {
  const label = MONTHS[month - 1];
  if (!label) throw new Error(`Bad tax month: ${month}`);
  return label;
}

/** Tax month 1..12 of a date: 6 Apr–5 May is 1, 6 May–5 Jun is 2, … 6 Mar–5 Apr is 12. */
export function periodOfDate(isoDate: string): number {
  const { m, d } = parseIso(isoDate);
  const started = d >= 6 ? m : m - 1 || 12;
  return ((started - 4 + 12) % 12) + 1;
}
