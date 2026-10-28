import { describe, expect, it } from "vitest";
import { samplePayslipLines, writePdf } from "../test-utils";
import { PayslipFormatError, parsePayslipLines, parsePayslipPdf } from "./payslip-parser";

describe("parsePayslipLines", () => {
  it("reads the sample payslip by label", () => {
    const p = parsePayslipLines(samplePayslipLines());
    expect(p.payDate).toBe("2026-10-31");
    expect(p.taxYear).toBe(2026);
    expect(p.period).toBe(7);
    expect(p.taxCode).toBe("1257L 0");
    expect(p.payments).toEqual([
      { description: "Salary", amount: 3000 },
      { description: "USS(CRB) 16 SS", amount: -183 },
    ]);
    expect(p.deductions).toEqual([
      { description: "Tax paid", amount: 380 },
      { description: "Employee NIC", amount: 150 },
    ]);
    expect(p.totalPayments).toBe(2817);
    expect(p.totalDeductions).toBe(530);
    expect(p.netPay).toBe(2287);
    expect(p.thisPeriod).toEqual({ grossPay: 2817, taxablePay: 2817, tax: 380, eeNic: 150 });
    expect(p.toDate).toEqual({ grossPay: 19719, taxablePay: 19719, tax: 2660, eeNic: 1050 });
  });

  it("captures extra payment and student loan lines", () => {
    const p = parsePayslipLines(
      samplePayslipLines({
        payments: ["Salary 3000.00", "Overtime 120.00", "USS(CRB) 16 SS 183.00-"],
        deductions: ["Tax paid 380.00", "Employee NIC 150.00", "Student Loan 45.00"],
      }),
    );
    expect(p.payments.map((l) => l.description)).toEqual(["Salary", "Overtime", "USS(CRB) 16 SS"]);
    expect(p.payments[1]).toEqual({ description: "Overtime", amount: 120 });
    expect(p.deductions.map((l) => l.description)).toEqual(["Tax paid", "Employee NIC", "Student Loan"]);
    expect(p.deductions[2]).toEqual({ description: "Student Loan", amount: 45 });
    expect(p.totalPayments).toBe(2937);
    expect(p.totalDeductions).toBe(575);
    expect(p.netPay).toBe(2362);
  });

  it("reads units when a row has them", () => {
    const p = parsePayslipLines(samplePayslipLines({ payments: ["Overtime 8.00 120.00", "Salary 3000.00"] }));
    expect(p.payments[0]).toEqual({ description: "Overtime", units: 8, amount: 120 });
  });

  it("reads deductions without a matching payment row", () => {
    const p = parsePayslipLines(
      samplePayslipLines({ payments: ["Salary 3000.00"], deductions: ["Tax paid 380.00", "Employee NIC 150.00", "Student Loan 45.00"] }),
    );
    expect(p.payments).toHaveLength(1);
    expect(p.deductions).toHaveLength(3);
  });

  it("handles thousands separators", () => {
    const p = parsePayslipLines(samplePayslipLines({ payments: ["Salary 3,000.50"], totalPayments: "3,000.50" }));
    expect(p.payments[0]!.amount).toBe(3000.5);
    expect(p.totalPayments).toBe(3000.5);
  });

  it("never captures the personal header fields", () => {
    const p = parsePayslipLines(samplePayslipLines());
    const json = JSON.stringify(p);
    for (const secret of ["ZZNAME", "TESTPERSON", "99999999", "QQ123456C", "123/AB456", "Faketown"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("throws PayslipFormatError when a required field is missing", () => {
    const cases: [string, (l: string) => string][] = [
      ["Pay Date", (l) => l.replace(/Pay Date\s*:\s*\S+/, "")],
      ["Tax Period", (l) => l.replace(/Tax Period\s*:\s*\S+/, "")],
      ["Total Payments", (l) => l.replace(/Total Payments\s+\S+/, "")],
      ["Total Deductions", (l) => l.replace(/Total Deductions\s+\S+/, "")],
      ["Net Pay", (l) => l.replace(/Net Pay\s+\S+/, "")],
    ];
    for (const [field, strip] of cases) {
      const lines = samplePayslipLines().map(strip);
      expect(() => parsePayslipLines(lines), field).toThrow(PayslipFormatError);
      expect(() => parsePayslipLines(lines), field).toThrow(`missing ${field}`);
    }
  });

  it("names the missing field", () => {
    const lines = samplePayslipLines().map((l) => l.replace(/Net Pay\s+\S+/, ""));
    expect(() => parsePayslipLines(lines)).toThrow(/Not a recognised SAP payslip: missing Net Pay/);
  });

  it("rejects unrelated text", () => {
    expect(() => parsePayslipLines(["hello", "world"])).toThrow(PayslipFormatError);
  });
});

describe("parsePayslipPdf", () => {
  const now = new Date("2026-11-02T09:00:00.000Z");

  it("parses an uncompressed PDF end to end", async () => {
    const p = await parsePayslipPdf(writePdf([samplePayslipLines()]), now);
    expect(p.payDate).toBe("2026-10-31");
    expect(p.netPay).toBe(2287);
    expect(p.warnings).toEqual([]);
    expect(p.importedAt).toBe("2026-11-02T09:00:00.000Z");
  });

  it("parses a FlateDecode PDF end to end", async () => {
    const p = await parsePayslipPdf(writePdf([samplePayslipLines()], { flate: true }), now);
    expect(p.warnings).toEqual([]);
    expect(p.totalPayments).toBe(2817);
    expect(JSON.stringify(p)).not.toContain("QQ123456C");
  });

  it("warns when the figures do not add up", async () => {
    const p = await parsePayslipPdf(writePdf([samplePayslipLines({ netPay: "2000.00" })]), now);
    expect(p.warnings.length).toBeGreaterThan(0);
  });
});
