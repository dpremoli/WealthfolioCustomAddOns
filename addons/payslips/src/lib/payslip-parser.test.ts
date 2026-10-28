import { describe, expect, it } from "vitest";
import { lineContent, rawPdf, samplePayslipLines, writePdf } from "../test-utils";
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

/** A line with each text placed at its start column (the columns of the real payslip layout). */
const at = (...parts: [number, string][]): string =>
  parts.reduce((line, [col, text]) => line.padEnd(col) + text, "");

/** The real layout, every figure synthetic: payment descriptions at col 6, amounts ending at
 *  col 45 (a trailing '-' at col 45), deduction descriptions at col 48, amounts ending at col 75. */
const realLayout = (opts: { addressFirst?: boolean } = {}): string[] => {
  const address = ["Example House", "1 Sample Road", "Faketown", "ZZ1 1ZZ"].map((t) => at([64, t]));
  const identity = [
    "      Employee Name  : ZZNAME TESTPERSON          Pay Date  : 31.10.2026",
    "      Employee Number: 99999999                   Tax Period: 07/2026",
    "      NI Number      : QQ123456C                  Tax Ref   : 123/AB456",
    "      Tax Code/Basis : 1257L  0                   Tax Office: Faketown",
  ];
  return [
    ...(opts.addressFirst ? [...address, ...identity] : [...identity, ...address]),
    "                      Payments                          Deductions",
    at([10, "Description"], [28, "Units"], [38, "Amount"], [51, "Description"], [68, "Amount"]),
    at([6, "Salary"], [38, "3000.00"], [48, "Tax paid"], [69, "380.00"]),
    at([6, "USS(CRB) 16 SS"], [39, "183.00-"], [48, "Employee NIC"], [69, "150.00"]),
    at([6, "Gen Trav & Sub"], [38, "45.50"]),
    at([6, "Telephone Costs"], [39, "20.00"]),
    at([7, "Total Payments"], [38, "2882.50"], [48, "Total Deductions"], [69, "530.00"]),
    "                         Gross Pay    Taxable Pay      Tax        EE's NIC",
    "      This Period        2817.00       2817.00        380.00        150.00",
    "      To date           19719.00      19719.00       2660.00       1050.00",
    at([48, "Net Pay"], [69, "2352.50"]),
    "      Notes:",
  ];
};

describe("the real column layout", () => {
  it("parses the real column layout", () => {
    for (const addressFirst of [false, true]) {
      const p = parsePayslipLines(realLayout({ addressFirst }));
      expect(p.payments).toEqual([
        { description: "Salary", amount: 3000 },
        { description: "USS(CRB) 16 SS", amount: -183 },
        { description: "Gen Trav & Sub", amount: 45.5 },
        { description: "Telephone Costs", amount: 20 },
      ]);
      expect(p.deductions).toEqual([
        { description: "Tax paid", amount: 380 },
        { description: "Employee NIC", amount: 150 },
      ]);
      expect([p.totalPayments, p.totalDeductions, p.netPay]).toEqual([2882.5, 530, 2352.5]);
      expect(p.thisPeriod).toEqual({ grossPay: 2817, taxablePay: 2817, tax: 380, eeNic: 150 });
    }
  });

  it("is what samplePayslipLines prints by default, and parses without warnings", async () => {
    const sample = samplePayslipLines();
    expect(sample.find((l) => l.includes("Description") && l.indexOf("Description") === 10)).toBe(
      at([10, "Description"], [28, "Units"], [38, "Amount"], [51, "Description"], [68, "Amount"]),
    );
    expect(sample.filter((l) => l.startsWith(" ".repeat(64)) && l.trim())).toEqual(
      ["Example House", "1 Sample Road", "Faketown", "ZZ1 1ZZ"].map((t) => at([64, t])),
    );
    expect(sample.at(-1)).toBe("      Notes:");
    const p = await parsePayslipPdf(writePdf([sample]), new Date("2026-11-02T09:00:00.000Z"));
    expect(p.warnings).toEqual([]);
    expect(p.deductions.map((l) => l.description)).toEqual(["Tax paid", "Employee NIC"]);
  });

  it("keeps the employer address and the notes line out of the result", () => {
    for (const addressFirst of [false, true]) {
      const json = JSON.stringify(parsePayslipLines(realLayout({ addressFirst })));
      for (const leak of ["Example House", "1 Sample Road", "Faketown", "ZZ1 1ZZ", "Notes"]) {
        expect(json).not.toContain(leak);
      }
    }
  });

  it("keeps a Units value before the amount as units, and reads rows with one side only", () => {
    const lines = realLayout();
    lines.splice(
      lines.findIndex((l) => l.includes("Gen Trav")),
      0,
      at([6, "Overtime"], [29, "8.00"], [38, "120.00"]),
      at([48, "Student Loan"], [69, "45.00"]),
    );
    const p = parsePayslipLines(lines);
    expect(p.payments.find((l) => l.description === "Overtime")).toEqual({ description: "Overtime", units: 8, amount: 120 });
    expect(p.deductions.map((l) => l.description)).toEqual(["Tax paid", "Employee NIC", "Student Loan"]);
    expect(p.payments.map((l) => l.description)).not.toContain("Student Loan");
  });

  it("reads a number in the Units column as units, never as the amount of a row with no payment", () => {
    const lines = realLayout();
    lines.splice(
      lines.findIndex((l) => l.includes("Gen Trav")),
      0,
      at([6, "Overtime"], [29, "8.00"]),
      at([6, "Standby"], [29, "8.00"], [48, "Student Loan"], [69, "45.00"]),
    );
    const p = parsePayslipLines(lines);
    expect(p.payments.map((l) => l.description)).not.toContain("Overtime");
    expect(p.payments.map((l) => l.description)).not.toContain("Standby");
    expect(p.payments.every((l) => l.amount !== 8)).toBe(true);
    expect(p.deductions.map((l) => l.description)).toEqual(["Tax paid", "Employee NIC", "Student Loan"]);
  });

  it("falls back to the Deductions title when the second header is garbled", () => {
    const lines = realLayout().map((l) => (l.includes("Units") ? at([10, "Description"], [28, "Units"], [38, "Amount"], [51, "Descr."], [68, "Amt"]) : l));
    const p = parsePayslipLines(lines);
    expect(p.deductions.map((l) => l.description)).toEqual(["Tax paid", "Employee NIC"]);
    expect(p.payments).toHaveLength(4);
  });
});

describe("expense refund lines", () => {
  it("reads them as payments; Gross Pay (This Period) is left without them", () => {
    const p = parsePayslipLines(
      samplePayslipLines({ payments: ["Salary 3000.00", "USS(CRB) 16 SS 183.00-", "Gen Trav & Sub 45.50", "Telephone Costs 20.00"] }),
    );
    expect(p.payments.map((l) => l.description)).toEqual(["Salary", "USS(CRB) 16 SS", "Gen Trav & Sub", "Telephone Costs"]);
    expect(p.totalPayments).toBe(2882.5);
    expect(p.thisPeriod.grossPay).toBe(2817);
    expect(p.netPay).toBe(2352.5);
  });
});

describe("tax code", () => {
  const withCodeLine = (line: string) => {
    const lines = samplePayslipLines();
    lines[3] = `      Tax Code/Basis : ${line}`;
    return lines;
  };

  it("does not swallow the tax office that follows after a single space", () => {
    const p = parsePayslipLines(withCodeLine("1257L 0 Tax Office: Faketown"));
    expect(p.taxCode).toBe("1257L 0");
    expect(JSON.stringify(p)).not.toContain("Faketown");
  });

  it.each([
    ["K475 M1 Tax Office: Faketown", "K475 M1"],
    ["BR Tax Office: Faketown", "BR"],
    ["S1257L Tax Office: Faketown", "S1257L"],
    ["C1257L  W1", "C1257L W1"],
    ["0T", "0T"],
  ])("reads %s", (text, code) => {
    const p = parsePayslipLines(withCodeLine(text));
    expect(p.taxCode).toBe(code);
    expect(JSON.stringify(p)).not.toContain("Faketown");
  });

  it("stores nothing for a value that is not a tax code", () => {
    expect(parsePayslipLines(withCodeLine("Faketown Office")).taxCode).toBe("");
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

  it("parses a payslip page split across two content streams", async () => {
    const sample = samplePayslipLines();
    const first = sample[0]!;
    const at = first.indexOf("31.10.2026");
    const valueX = (20 + at * 4.8).toFixed(2);
    const pdf = rawPdf(
      [
        lineContent([first.slice(0, at).trimEnd()]),
        `BT ${valueX} 800 Td /F1 8 Tf (31.10.2026) Tj ET\n${lineContent(sample.slice(1), 1)}`,
      ],
      { pages: [[0, 1]] },
    );
    const p = await parsePayslipPdf(pdf, now);
    expect(p.payDate).toBe("2026-10-31");
    expect(p.netPay).toBe(2287);
    expect(p.warnings).toEqual([]);
  });

  it("warns when the figures do not add up", async () => {
    const p = await parsePayslipPdf(writePdf([samplePayslipLines({ netPay: "2000.00" })]), now);
    expect(p.warnings.length).toBeGreaterThan(0);
  });
});

describe("the figures by column", () => {
  const noTaxLines = () =>
    samplePayslipLines({
      noTax: true,
      payments: ["Salary 3000.00"],
      deductions: ["Employee NIC 150.00", "USS(CRB) 16 183.00"],
    });

  it("reads the real column spans when the Tax figures are blank", () => {
    const lines = noTaxLines();
    // The layout under test: header ends at 34, 49, 58, 74; amounts end at 32, 46, 60 (tax), 74.
    const header = lines.find((l) => l.includes("Gross Pay"))!;
    expect(header.indexOf("EE's NIC") + "EE's NIC".length).toBe(74);
    const thisPeriod = lines.find((l) => l.trimStart().startsWith("This Period"))!;
    expect(thisPeriod.length).toBe(74);
    expect(thisPeriod.slice(48).trim()).toBe("150.00");

    const p = parsePayslipLines(lines);
    expect(p.thisPeriod).toEqual({ grossPay: 3000, taxablePay: 3000, tax: 0, eeNic: 150 });
    expect(p.toDate).toEqual({ grossPay: 19719, taxablePay: 19719, tax: 0, eeNic: 1050 });
  });

  it("imports a month with no tax due without warnings", async () => {
    const p = await parsePayslipPdf(writePdf([noTaxLines()]), new Date("2026-11-01T00:00:00Z"));
    expect(p.warnings).toEqual([]);
    expect(p.deductions).toEqual([
      { description: "Employee NIC", amount: 150 },
      { description: "USS(CRB) 16", amount: 183 },
    ]);
  });

  it("reads a blank NIC figure too, and the tax figure wherever it ends within its column", () => {
    const lines = samplePayslipLines({ thisPeriod: ["3000.00", "3000.00", "380.00", ""], toDate: ["19719.00", "19719.00", "2660.00", ""] });
    const p = parsePayslipLines(lines);
    expect(p.thisPeriod).toEqual({ grossPay: 3000, taxablePay: 3000, tax: 380, eeNic: 0 });
    expect(p.toDate).toEqual({ grossPay: 19719, taxablePay: 19719, tax: 2660, eeNic: 0 });
  });

  it("falls back to reading the figures in order when there is no figures header", () => {
    const lines = samplePayslipLines().filter((l) => !l.includes("Gross Pay"));
    const p = parsePayslipLines(lines);
    expect(p.thisPeriod).toEqual({ grossPay: 2817, taxablePay: 2817, tax: 380, eeNic: 150 });
    expect(p.toDate).toEqual({ grossPay: 19719, taxablePay: 19719, tax: 2660, eeNic: 1050 });
  });
});
