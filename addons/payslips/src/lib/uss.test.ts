import { describe, expect, it } from "vitest";
import { samplePayslipLines } from "../test-utils";
import type { Payslip, UssStatement } from "./model";
import { parsePayslipLines } from "./payslip-parser";
import { DB_CAPITAL_FACTOR, dbCapitalEstimate, isUssLine, latestStatement, ussContributions } from "./uss";

const make = (over?: Parameters<typeof samplePayslipLines>[0], taxYear?: number): Payslip => {
  const p = parsePayslipLines(samplePayslipLines(over));
  return { ...p, taxYear: taxYear ?? p.taxYear, warnings: [], importedAt: "2026-11-02T09:00:00.000Z" };
};

describe("isUssLine", () => {
  it("matches lines starting with USS", () => {
    expect(isUssLine({ description: "USS(CRB) 16 SS", amount: -183 })).toBe(true);
    expect(isUssLine({ description: "uss employer", amount: 1 })).toBe(true);
    expect(isUssLine({ description: "Salary", amount: 3000 })).toBe(false);
    expect(isUssLine({ description: "USSR bonus", amount: 3000 })).toBe(false);
  });
});

describe("ussContributions", () => {
  it("is zero for a payslip with no USS line", () => {
    const p = make({ payments: ["Salary 3000.00"] });
    expect(ussContributions([p])).toEqual({ byYear: [{ taxYear: 2026, amount: 0 }], total: 0 });
  });

  it("sums per tax year, ascending", () => {
    const list = [make(undefined, 2026), make(undefined, 2025), make({ payments: ["Salary 3000.00", "USS(CRB) 16 SS 183.10-"] }, 2026)];
    expect(ussContributions(list)).toEqual({
      byYear: [
        { taxYear: 2025, amount: 183 },
        { taxYear: 2026, amount: 366.1 },
      ],
      total: 549.1,
    });
  });

  it("handles no payslips", () => {
    expect(ussContributions([])).toEqual({ byYear: [], total: 0 });
  });
});

describe("statements", () => {
  const a: UssStatement = { date: "2025-03-31", dbPension: 1000, dbLumpSum: 3000 };
  const b: UssStatement = { date: "2026-03-31", dbPension: 1250.5, dbLumpSum: 3751.5 };

  it("finds the latest", () => {
    expect(latestStatement([b, a])).toBe(b);
    expect(latestStatement([])).toBeUndefined();
  });

  it("estimates DB capital as pension x 20 plus lump sum", () => {
    expect(DB_CAPITAL_FACTOR).toBe(20);
    expect(dbCapitalEstimate(a)).toBe(23000);
    expect(dbCapitalEstimate(b)).toBe(28761.5);
  });
});
