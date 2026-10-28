import { isoDay } from "./format";
import { employeeNi, grossBeforeSacrifice, incomeTax, ussSacrifice, type Payslip } from "./model";
import type { MatchStatus, SalaryMatch } from "./salary-match";

export type SortKey = "payDate" | "period" | "gross" | "uss" | "tax" | "ni" | "net" | "checks" | "deposit";
export type SortDir = "asc" | "desc";
export interface SortState {
  key: SortKey;
  dir: SortDir;
}

/** The sortable columns of the stored payslips table, in order; numbers align right. */
export const SORT_COLUMNS: { key: SortKey; label: string; align: "left" | "right" }[] = [
  { key: "payDate", label: "Pay date", align: "left" },
  { key: "period", label: "Period", align: "left" },
  { key: "gross", label: "Gross before USS", align: "right" },
  { key: "uss", label: "USS", align: "right" },
  { key: "tax", label: "Tax", align: "right" },
  { key: "ni", label: "NI", align: "right" },
  { key: "net", label: "Net", align: "right" },
  { key: "checks", label: "Checks", align: "left" },
  { key: "deposit", label: "Salary deposit", align: "left" },
];

/** Newest pay date first. */
export const DEFAULT_SORT: SortState = { key: "payDate", dir: "desc" };

/** A click on a header: the same column flips its direction, another one starts ascending. */
export function nextSort(current: SortState, key: SortKey): SortState {
  return current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
}

/** Matched first, then ambiguous, missing, and last the payslips not yet looked at. */
const STATUS_RANK: Record<MatchStatus, number> = { matched: 0, ambiguous: 1, missing: 2 };

type Cell = number | string;

/** What a column sorts by; a list is compared item by item. */
function cellOf(p: Payslip, key: SortKey, match: SalaryMatch | undefined): Cell[] {
  switch (key) {
    case "payDate":
      return [p.payDate];
    case "period":
      return [p.taxYear, p.period];
    case "gross":
      return [grossBeforeSacrifice(p)];
    case "uss":
      return [ussSacrifice(p)];
    case "tax":
      return [incomeTax(p)];
    case "ni":
      return [employeeNi(p)];
    case "net":
      return [p.netPay];
    case "checks":
      return [p.warnings.length];
    case "deposit":
      return [match ? STATUS_RANK[match.status] : Object.keys(STATUS_RANK).length, isoDay(match?.activity?.date)];
  }
}

function compareCells(a: Cell[], b: Cell[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The payslips ordered by a column; equal rows stay in pay date order, whichever the direction. */
export function sortPayslips(
  payslips: Payslip[],
  sort: SortState,
  matchOf: (payDate: string) => SalaryMatch | undefined,
): Payslip[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...payslips].sort(
    (a, b) =>
      sign * compareCells(cellOf(a, sort.key, matchOf(a.payDate)), cellOf(b, sort.key, matchOf(b.payDate))) ||
      compareCells([a.payDate], [b.payDate]),
  );
}
