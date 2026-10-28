import { describe, expect, it } from "vitest";
import type { Payslip } from "./model";
import { parsePayslipLines } from "./payslip-parser";
import type { SalaryMatch } from "./salary-match";
import { DEFAULT_SORT, SORT_COLUMNS, nextSort, sortPayslips, type SortKey } from "./table-sort";
import { samplePayslipLines } from "../test-utils";

const slip = (payDate: string, period: string, over: Parameters<typeof samplePayslipLines>[0] = {}, warnings: string[] = []): Payslip => ({
  ...parsePayslipLines(samplePayslipLines({ payDate, period, ...over })),
  warnings,
  importedAt: "2026-11-02T09:00:00.000Z",
});

// Distinct figures in every column; none of them in the same order as the pay dates.
const a = slip("30.04.2026", "01/2026", { payments: ["Salary 2000.00", "USS(CRB) 16 SS 100.00-"], deductions: ["Tax paid 300.00", "Employee NIC 90.00"], toDate: ["1900.00", "1900.00", "300.00", "90.00"] }, ["w1", "w2"]);
const b = slip("29.05.2026", "02/2026", { payments: ["Salary 4000.00", "USS(CRB) 16 SS 200.00-"], deductions: ["Tax paid 700.00", "Employee NIC 250.00"], toDate: ["3800.00", "3800.00", "700.00", "250.00"] }, []);
const c = slip("30.06.2026", "03/2026", { payments: ["Salary 3000.00", "USS(CRB) 16 SS 300.00-"], deductions: ["Tax paid 500.00", "Employee NIC 150.00"], toDate: ["2700.00", "2700.00", "500.00", "150.00"] }, ["w1"]);
const rows = [b, c, a];

const dates = (list: Payslip[]) => list.map((p) => p.payDate);
const match = (payDate: string, status: SalaryMatch["status"], date?: string): SalaryMatch => ({
  payDate,
  status,
  candidates: [],
  ...(date ? { activity: { id: payDate, date: new Date(`${date}T12:00:00.000Z`) } as SalaryMatch["activity"] } : {}),
});

describe("DEFAULT_SORT", () => {
  it("is the pay date, newest first", () => {
    expect(DEFAULT_SORT).toEqual({ key: "payDate", dir: "desc" });
  });
});

describe("nextSort", () => {
  it("starts a new column ascending", () => {
    expect(nextSort(DEFAULT_SORT, "net")).toEqual({ key: "net", dir: "asc" });
  });

  it("flips the direction when the same column is clicked again", () => {
    expect(nextSort({ key: "net", dir: "asc" }, "net")).toEqual({ key: "net", dir: "desc" });
    expect(nextSort({ key: "net", dir: "desc" }, "net")).toEqual({ key: "net", dir: "asc" });
    expect(nextSort(DEFAULT_SORT, "payDate")).toEqual({ key: "payDate", dir: "asc" });
  });
});

describe("sortPayslips", () => {
  const sorted = (key: SortKey, dir: "asc" | "desc", matches: Record<string, SalaryMatch> = {}) =>
    dates(sortPayslips(rows, { key, dir }, (d) => matches[d]));

  it("sorts by pay date", () => {
    expect(sorted("payDate", "asc")).toEqual(["2026-04-30", "2026-05-29", "2026-06-30"]);
    expect(sorted("payDate", "desc")).toEqual(["2026-06-30", "2026-05-29", "2026-04-30"]);
  });

  it("sorts by tax period, across tax years", () => {
    const old = slip("31.03.2026", "12/2025");
    const list = [b, old, a];
    expect(dates(sortPayslips(list, { key: "period", dir: "asc" }, () => undefined))).toEqual(["2026-03-31", "2026-04-30", "2026-05-29"]);
    expect(dates(sortPayslips(list, { key: "period", dir: "desc" }, () => undefined))).toEqual(["2026-05-29", "2026-04-30", "2026-03-31"]);
  });

  it("sorts by each figure by value, not as text", () => {
    // gross before USS: a 2000, c 3000, b 4000
    expect(sorted("gross", "asc")).toEqual(["2026-04-30", "2026-06-30", "2026-05-29"]);
    // USS: a 100, b 200, c 300
    expect(sorted("uss", "asc")).toEqual(["2026-04-30", "2026-05-29", "2026-06-30"]);
    // tax: a 300, c 500, b 700
    expect(sorted("tax", "desc")).toEqual(["2026-05-29", "2026-06-30", "2026-04-30"]);
    // NI: a 90, c 150, b 250
    expect(sorted("ni", "asc")).toEqual(["2026-04-30", "2026-06-30", "2026-05-29"]);
    // net: a 1510, c 2050, b 3050 (Total Payments less deductions)
    expect(sorted("net", "asc")).toEqual(["2026-04-30", "2026-06-30", "2026-05-29"]);
    expect(sorted("net", "desc")).toEqual(["2026-05-29", "2026-06-30", "2026-04-30"]);
  });

  it("sorts by the number of warnings, then pay date", () => {
    expect(sorted("checks", "asc")).toEqual(["2026-05-29", "2026-06-30", "2026-04-30"]);
    expect(sorted("checks", "desc")).toEqual(["2026-04-30", "2026-06-30", "2026-05-29"]);
    const more = slip("30.07.2026", "04/2026", {}, ["w1"]);
    expect(dates(sortPayslips([more, c], { key: "checks", dir: "desc" }, () => undefined))).toEqual(["2026-06-30", "2026-07-30"]);
  });

  it("sorts the salary deposit by status, then by the deposit's date", () => {
    const matches = {
      "2026-04-30": match("2026-04-30", "missing"),
      "2026-05-29": match("2026-05-29", "matched", "2026-06-02"),
      "2026-06-30": match("2026-06-30", "matched", "2026-06-30"),
    };
    expect(sorted("deposit", "asc", matches)).toEqual(["2026-05-29", "2026-06-30", "2026-04-30"]);
    expect(sorted("deposit", "desc", matches)).toEqual(["2026-04-30", "2026-06-30", "2026-05-29"]);
  });

  it("puts matched before ambiguous before missing before not yet checked", () => {
    const matches = {
      "2026-04-30": match("2026-04-30", "ambiguous"),
      "2026-05-29": match("2026-05-29", "missing"),
    };
    // 2026-06-30 has no match yet.
    expect(sorted("deposit", "asc", matches)).toEqual(["2026-04-30", "2026-05-29", "2026-06-30"]);
  });

  it("does not change the rows it is given", () => {
    const copy = [...rows];
    sortPayslips(rows, { key: "net", dir: "asc" }, () => undefined);
    expect(rows).toEqual(copy);
  });
});

describe("SORT_COLUMNS", () => {
  it("names every sort key once, numbers right and text left", () => {
    expect(SORT_COLUMNS.map((c) => c.key)).toEqual(["payDate", "period", "gross", "uss", "tax", "ni", "net", "checks", "deposit"]);
    expect(SORT_COLUMNS.filter((c) => c.align === "right").map((c) => c.label)).toEqual(["Gross before USS", "USS", "Tax", "NI", "Net"]);
  });
});
