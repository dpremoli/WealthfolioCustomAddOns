import { describe, expect, it } from "vitest";
import { parseTaxPeriod, periodLabel, periodOfDate, taxYearLabel, taxYearOf } from "./tax-year";

describe("taxYearOf", () => {
  it("starts the tax year on 6 April", () => {
    expect(taxYearOf("2026-04-05")).toBe(2025);
    expect(taxYearOf("2026-04-06")).toBe(2026);
    expect(taxYearOf("2026-01-15")).toBe(2025);
    expect(taxYearOf("2026-12-31")).toBe(2026);
    expect(taxYearOf("2027-03-31")).toBe(2026);
  });
});

describe("taxYearLabel", () => {
  it("formats start/end years", () => {
    expect(taxYearLabel(2026)).toBe("2026/27");
    expect(taxYearLabel(1999)).toBe("1999/00");
    expect(taxYearLabel(2009)).toBe("2009/10");
  });
});

describe("parseTaxPeriod", () => {
  it("reads MM/YYYY", () => {
    expect(parseTaxPeriod("07/2026")).toEqual({ month: 7, taxYear: 2026 });
    expect(parseTaxPeriod(" 12/2025 ")).toEqual({ month: 12, taxYear: 2025 });
  });
  it("throws on bad input", () => {
    expect(() => parseTaxPeriod("13/2026")).toThrow();
    expect(() => parseTaxPeriod("00/2026")).toThrow();
    expect(() => parseTaxPeriod("7-2026")).toThrow();
    expect(() => parseTaxPeriod("")).toThrow();
  });
});

describe("periodLabel", () => {
  it("maps 1=Apr .. 12=Mar", () => {
    expect(periodLabel(1)).toBe("Apr");
    expect(periodLabel(7)).toBe("Oct");
    expect(periodLabel(12)).toBe("Mar");
  });
});

describe("periodOfDate", () => {
  it("uses the 6th as the boundary", () => {
    expect(periodOfDate("2026-04-06")).toBe(1);
    expect(periodOfDate("2026-05-05")).toBe(1);
    expect(periodOfDate("2026-05-06")).toBe(2);
    expect(periodOfDate("2026-10-31")).toBe(7);
    expect(periodOfDate("2027-01-05")).toBe(9);
    expect(periodOfDate("2027-01-06")).toBe(10);
    expect(periodOfDate("2027-04-05")).toBe(12);
    expect(periodOfDate("2026-04-05")).toBe(12);
  });
});
