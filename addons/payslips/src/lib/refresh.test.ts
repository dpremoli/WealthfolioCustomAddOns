import { FakeWealthfolio } from "@wf-addons/kit/testing";
import { describe, expect, it } from "vitest";
import { samplePayslipLines, writePdf } from "../test-utils";
import type { Link, Payslip } from "./model";
import { parsePayslipLines, parsePayslipPdf } from "./payslip-parser";
import { loadPdf, savePdf } from "./pdf-store";
import { refreshPayslips } from "./refresh";
import { loadLinks, loadPayslips, saveLink, savePayslips } from "./store";

const host = () => new FakeWealthfolio([]);
const NOW = new Date("2026-12-01T10:00:00.000Z");
const IMPORTED = "2026-11-02T09:00:00.000Z";

/** `iso` is YYYY-MM-DD; the sample payslip prints dd.mm.yyyy. */
const printed = (iso: string) => iso.split("-").reverse().join(".");
const lines = (iso: string, period: string) => samplePayslipLines({ payDate: printed(iso), period });
const pdfFor = (iso: string, period: string) => new Uint8Array(writePdf([lines(iso, period)]));

/** What an older parser stored: right figures, but empty lines and a false warning. */
const misread = (payDate: string, period: string): Payslip => ({
  ...parsePayslipLines(lines(payDate, period)),
  payments: [],
  deductions: [],
  warnings: ["Payments do not add up to Total Payments"],
  importedAt: IMPORTED,
});

const correct = async (bytes: Uint8Array): Promise<Payslip> => ({
  ...(await parsePayslipPdf(bytes)),
  importedAt: IMPORTED,
});

describe("refreshPayslips", () => {
  it("re-reads a stored payslip from its PDF, keeping its import date", async () => {
    const { ctx } = host();
    await savePayslips(ctx, [misread("2026-10-31", "07/2026")]);
    await savePdf(ctx, "2026-10-31", pdfFor("2026-10-31", "07/2026"));

    const result = await refreshPayslips(ctx, NOW);

    expect(result).toEqual({ reparsed: 1, unchanged: 0, failed: [], withoutPdf: [] });
    const [p] = await loadPayslips(ctx);
    expect(p!.payments.map((l) => l.description)).toEqual(["Salary", "USS(CRB) 16 SS"]);
    expect(p!.deductions.map((l) => l.description)).toEqual(["Tax paid", "Employee NIC"]);
    expect(p!.warnings).toEqual([]);
    expect(p!.importedAt).toBe(IMPORTED);
  });

  it("counts a payslip that already matches its PDF as unchanged", async () => {
    const { ctx } = host();
    const bytes = pdfFor("2026-10-31", "07/2026");
    await savePayslips(ctx, [await correct(bytes)]);
    await savePdf(ctx, "2026-10-31", bytes);
    const before = await loadPayslips(ctx);

    const result = await refreshPayslips(ctx, NOW);

    expect(result).toEqual({ reparsed: 0, unchanged: 1, failed: [], withoutPdf: [] });
    expect(await loadPayslips(ctx)).toEqual(before);
  });

  it("lists a payslip without a stored PDF and leaves it as it is", async () => {
    const { ctx } = host();
    const old = misread("2026-09-30", "06/2026");
    await savePayslips(ctx, [old]);

    const result = await refreshPayslips(ctx, NOW);

    expect(result).toEqual({ reparsed: 0, unchanged: 0, failed: [], withoutPdf: ["2026-09-30"] });
    expect(await loadPayslips(ctx)).toEqual([old]);
  });

  it("fails, keeping the old payslip, when the stored PDF is for another pay date", async () => {
    const { ctx } = host();
    const old = misread("2026-10-31", "07/2026");
    await savePayslips(ctx, [old]);
    await savePdf(ctx, "2026-10-31", pdfFor("2026-11-30", "08/2026"));

    const result = await refreshPayslips(ctx, NOW);

    expect(result.reparsed).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(result.failed).toEqual([{ payDate: "2026-10-31", reason: "the stored PDF is for 2026-11-30" }]);
    expect(await loadPayslips(ctx)).toEqual([old]);
  });

  it("reports an unreadable stored PDF as a failure and carries on with the others", async () => {
    const { ctx } = host();
    const old = misread("2026-09-30", "06/2026");
    await savePayslips(ctx, [old, misread("2026-10-31", "07/2026")]);
    await savePdf(ctx, "2026-09-30", new TextEncoder().encode("not a pdf"));
    await savePdf(ctx, "2026-10-31", pdfFor("2026-10-31", "07/2026"));

    const result = await refreshPayslips(ctx, NOW);

    expect(result.reparsed).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.payDate).toBe("2026-09-30");
    expect(result.failed[0]!.reason).not.toBe("");
    expect((await loadPayslips(ctx))[0]).toEqual(old);
  });

  it("never deletes anything and leaves links and PDFs untouched", async () => {
    const { ctx } = host();
    const link: Link = { activityId: "act-1", accountId: "acc-1", chosen: "manual", tagged: true };
    const bytes = pdfFor("2026-10-31", "07/2026");
    await savePayslips(ctx, [misread("2026-10-31", "07/2026"), misread("2026-09-30", "06/2026")]);
    await savePdf(ctx, "2026-10-31", bytes);
    await saveLink(ctx, "2026-10-31", link);

    await refreshPayslips(ctx, NOW);

    expect((await loadPayslips(ctx)).map((p) => p.payDate)).toEqual(["2026-09-30", "2026-10-31"]);
    expect(await loadLinks(ctx)).toEqual({ "2026-10-31": link });
    expect(await loadPdf(ctx, "2026-10-31")).toEqual(bytes);
  });

  it("fails rather than move a payslip to another tax year (which would leave a duplicate)", async () => {
    const { ctx } = host();
    const old = { ...misread("2026-10-31", "07/2026"), taxYear: 2025 };
    await savePayslips(ctx, [old]);
    await savePdf(ctx, "2026-10-31", pdfFor("2026-10-31", "07/2026"));

    const result = await refreshPayslips(ctx, NOW);

    expect(result.reparsed).toBe(0);
    expect(result.failed).toEqual([{ payDate: "2026-10-31", reason: "the stored PDF is for tax year 2026, not 2025" }]);
    expect(await loadPayslips(ctx)).toEqual([old]);
  });
});
