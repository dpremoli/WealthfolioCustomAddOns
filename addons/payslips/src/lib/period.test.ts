import { describe, expect, it } from "vitest";
import {
  inPeriod,
  payslipInPeriod,
  periodBounds,
  periodLabel,
  periodOfKind,
  periodYears,
  resolvePeriod,
  type Period,
} from "./period";

const slips = (...payDates: string[]) => payDates.map((payDate) => ({ payDate, taxYear: Number(payDate.slice(0, 4)) - (payDate.slice(5) < "04-06" ? 1 : 0) }));

describe("periodBounds", () => {
  it("runs a tax year from 6 April to the following 5 April", () => {
    expect(periodBounds({ kind: "tax", year: 2026 })).toEqual({ from: "2026-04-06", to: "2027-04-05" });
  });

  it("runs a calendar year from 1 January to 31 December", () => {
    expect(periodBounds({ kind: "calendar", year: 2026 })).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("returns a custom range as given", () => {
    expect(periodBounds({ kind: "range", from: "2026-02-10", to: "2026-09-30" })).toEqual({ from: "2026-02-10", to: "2026-09-30" });
  });
});

describe("inPeriod", () => {
  const tax: Period = { kind: "tax", year: 2026 };

  it("takes both ends of a tax year, 6 April and 5 April", () => {
    expect(inPeriod("2026-04-05", tax)).toBe(false);
    expect(inPeriod("2026-04-06", tax)).toBe(true);
    expect(inPeriod("2027-04-05", tax)).toBe(true);
    expect(inPeriod("2027-04-06", tax)).toBe(false);
  });

  it("splits a calendar year at 1 January", () => {
    const cal: Period = { kind: "calendar", year: 2026 };
    expect(inPeriod("2025-12-31", cal)).toBe(false);
    expect(inPeriod("2026-01-01", cal)).toBe(true);
    expect(inPeriod("2026-12-31", cal)).toBe(true);
    expect(inPeriod("2027-01-01", cal)).toBe(false);
  });

  it("includes both dates of a custom range", () => {
    const range: Period = { kind: "range", from: "2026-05-10", to: "2026-07-20" };
    expect(inPeriod("2026-05-09", range)).toBe(false);
    expect(inPeriod("2026-05-10", range)).toBe(true);
    expect(inPeriod("2026-07-20", range)).toBe(true);
    expect(inPeriod("2026-07-21", range)).toBe(false);
  });

  it("treats an empty end of a custom range as open", () => {
    expect(inPeriod("1999-01-01", { kind: "range", from: "", to: "2026-07-20" })).toBe(true);
    expect(inPeriod("2030-01-01", { kind: "range", from: "2026-05-10", to: "" })).toBe(true);
    expect(inPeriod("2026-05-09", { kind: "range", from: "2026-05-10", to: "" })).toBe(false);
  });

  it("holds nothing for a range that ends before it starts", () => {
    expect(inPeriod("2026-06-01", { kind: "range", from: "2026-07-01", to: "2026-05-01" })).toBe(false);
  });
});

describe("periodLabel", () => {
  it("names each kind", () => {
    expect(periodLabel({ kind: "tax", year: 2026 })).toBe("2026/27");
    expect(periodLabel({ kind: "tax", year: 2099 })).toBe("2099/00");
    expect(periodLabel({ kind: "calendar", year: 2026 })).toBe("2026");
    expect(periodLabel({ kind: "range", from: "2026-02-10", to: "2026-09-30" })).toBe("2026-02-10 to 2026-09-30");
  });

  it("shows an open end of a range", () => {
    expect(periodLabel({ kind: "range", from: "2026-02-10", to: "" })).toBe("2026-02-10 onwards");
    expect(periodLabel({ kind: "range", from: "", to: "2026-09-30" })).toBe("up to 2026-09-30");
    expect(periodLabel({ kind: "range", from: "", to: "" })).toBe("all dates");
  });
});

describe("periodYears", () => {
  const list = slips("2025-03-31", "2025-04-30", "2026-01-30", "2026-04-30");

  it("lists the tax years that have payslips, oldest first", () => {
    expect(periodYears(list, "tax")).toEqual([2024, 2025, 2026]);
  });

  it("lists the calendar years that have payslips, oldest first", () => {
    expect(periodYears(list, "calendar")).toEqual([2025, 2026]);
  });
});

describe("resolvePeriod", () => {
  const list = slips("2025-03-31", "2026-01-30", "2026-04-30");

  it("has no period without payslips", () => {
    expect(resolvePeriod(null, [])).toBeUndefined();
  });

  it("defaults to the latest tax year", () => {
    expect(resolvePeriod(null, list)).toEqual({ kind: "tax", year: 2026 });
  });

  it("keeps a chosen year that has payslips", () => {
    expect(resolvePeriod({ kind: "tax", year: 2024 }, list)).toEqual({ kind: "tax", year: 2024 });
    expect(resolvePeriod({ kind: "calendar", year: 2025 }, list)).toEqual({ kind: "calendar", year: 2025 });
  });

  it("falls back to the latest year of that kind when the chosen one has none", () => {
    expect(resolvePeriod({ kind: "tax", year: 2010 }, list)).toEqual({ kind: "tax", year: 2026 });
    expect(resolvePeriod({ kind: "calendar", year: 2010 }, list)).toEqual({ kind: "calendar", year: 2026 });
  });

  it("keeps a custom range as it is", () => {
    const range: Period = { kind: "range", from: "", to: "" };
    expect(resolvePeriod(range, list)).toEqual(range);
  });
});

describe("periodOfKind", () => {
  const list = slips("2025-03-31", "2026-01-30", "2026-04-30");

  it("switches to the latest year of the kind", () => {
    expect(periodOfKind("tax", { kind: "calendar", year: 2025 }, list)).toEqual({ kind: "tax", year: 2026 });
    expect(periodOfKind("calendar", { kind: "tax", year: 2024 }, list)).toEqual({ kind: "calendar", year: 2026 });
  });

  it("keeps the current period when the kind does not change", () => {
    expect(periodOfKind("tax", { kind: "tax", year: 2024 }, list)).toEqual({ kind: "tax", year: 2024 });
  });

  it("starts a custom range on the dates of the period it replaces", () => {
    expect(periodOfKind("range", { kind: "tax", year: 2025 }, list)).toEqual({ kind: "range", from: "2025-04-06", to: "2026-04-05" });
    expect(periodOfKind("range", { kind: "range", from: "2026-01-01", to: "2026-02-01" }, list)).toEqual({
      kind: "range",
      from: "2026-01-01",
      to: "2026-02-01",
    });
  });
});

describe("payslipInPeriod", () => {
  it("puts a payslip in the tax year of its tax period, even when its pay date is a few days before 6 April", () => {
    // Tax month 1 of 2026 paid early, on 3 April: by date it is still in the previous tax year.
    const early = { payDate: "2026-04-03", taxYear: 2026 };
    expect(payslipInPeriod(early, { kind: "tax", year: 2026 })).toBe(true);
    expect(payslipInPeriod(early, { kind: "tax", year: 2025 })).toBe(false);
  });

  it("puts a payslip in a calendar year or a range by its pay date", () => {
    const early = { payDate: "2026-04-03", taxYear: 2026 };
    expect(payslipInPeriod(early, { kind: "calendar", year: 2026 })).toBe(true);
    expect(payslipInPeriod(early, { kind: "range", from: "2026-04-04", to: "2026-05-01" })).toBe(false);
    expect(payslipInPeriod(early, { kind: "range", from: "2026-04-03", to: "2026-04-03" })).toBe(true);
  });
});
