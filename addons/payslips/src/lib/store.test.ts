import { FakeWealthfolio } from "@wf-addons/kit/testing";
import { describe, expect, it } from "vitest";
import { samplePayslipLines } from "../test-utils";
import type { Link, Payslip, UssStatement } from "./model";
import { parsePayslipLines } from "./payslip-parser";
import {
  addStatement,
  deletePayslip,
  deleteStatement,
  loadLinks,
  loadPayslips,
  loadSettings,
  loadStatements,
  saveLink,
  savePayslips,
  saveSettings,
  saveStatements,
  taxYears,
} from "./store";

const sample: Payslip = {
  ...parsePayslipLines(samplePayslipLines()),
  warnings: [],
  importedAt: "2026-11-02T09:00:00.000Z",
};

const slip = (payDate: string, taxYear: number, period = 1): Payslip => ({ ...sample, payDate, taxYear, period });
const link: Link = { activityId: "act-1", accountId: "acc-1", chosen: "auto" };
const host = () => new FakeWealthfolio([]);

describe("payslips", () => {
  it("shards by tax year and keeps an index", async () => {
    const h = host();
    await savePayslips(h.ctx, [slip("2026-04-30", 2026), slip("2025-10-31", 2025, 7)]);
    expect(JSON.parse(h.storage.get("payslips:2025")!)).toHaveLength(1);
    expect(JSON.parse(h.storage.get("payslips:2026")!)).toHaveLength(1);
    expect(JSON.parse(h.storage.get("payslips:index")!)).toEqual([2025, 2026]);
    expect(await taxYears(h.ctx)).toEqual([2025, 2026]);
    expect((await loadPayslips(h.ctx)).map((p) => p.payDate)).toEqual(["2025-10-31", "2026-04-30"]);
    expect((await loadPayslips(h.ctx, 2026)).map((p) => p.payDate)).toEqual(["2026-04-30"]);
    expect(await loadPayslips(h.ctx, 2024)).toEqual([]);
  });

  it("replaces a payslip with the same pay date", async () => {
    const h = host();
    expect(await savePayslips(h.ctx, [slip("2026-10-31", 2026, 7)])).toEqual({ added: 1, replaced: 0 });
    const corrected = { ...slip("2026-10-31", 2026, 7), netPay: 1 };
    expect(await savePayslips(h.ctx, [corrected])).toEqual({ added: 0, replaced: 1 });
    const all = await loadPayslips(h.ctx);
    expect(all).toHaveLength(1);
    expect(all[0]!.netPay).toBe(1);
  });

  it("deletes a payslip, its link and an emptied year", async () => {
    const h = host();
    await savePayslips(h.ctx, [slip("2025-10-31", 2025, 7), slip("2026-04-30", 2026)]);
    await saveLink(h.ctx, "2026-04-30", link);
    await deletePayslip(h.ctx, "2026-04-30");
    expect(await loadPayslips(h.ctx)).toHaveLength(1);
    expect(await loadLinks(h.ctx)).toEqual({});
    expect(h.storage.has("payslips:2026")).toBe(false);
    expect(h.storage.has("links:2026")).toBe(false);
    expect(await taxYears(h.ctx)).toEqual([2025]);
    await deletePayslip(h.ctx, "2030-01-01");
    expect(await loadPayslips(h.ctx)).toHaveLength(1);
  });

  it("stores 30 tax years of monthly payslips under the per-value cap", async () => {
    const h = host();
    const list: Payslip[] = [];
    for (let y = 1996; y < 2026; y++) {
      for (let m = 1; m <= 12; m++) {
        const month = ((m + 2) % 12) + 1; // Apr = 4
        const year = month >= 4 ? y : y + 1;
        list.push(slip(`${year}-${String(month).padStart(2, "0")}-28`, y, m));
      }
    }
    expect(await savePayslips(h.ctx, list)).toEqual({ added: 360, replaced: 0 });
    expect(h.maxStoredValueBytes).toBeLessThan(20_000);
    expect(await loadPayslips(h.ctx)).toHaveLength(360);
    expect(await taxYears(h.ctx)).toHaveLength(30);
  });
});

describe("links", () => {
  it("round-trips by tax year and deletes", async () => {
    const h = host();
    await savePayslips(h.ctx, [slip("2025-10-31", 2025, 7), slip("2026-10-31", 2026, 7)]);
    await saveLink(h.ctx, "2026-10-31", link);
    await saveLink(h.ctx, "2025-10-31", { ...link, activityId: "act-2", chosen: "manual" });
    expect(JSON.parse(h.storage.get("links:2026")!)).toEqual({ "2026-10-31": link });
    expect(await loadLinks(h.ctx, 2026)).toEqual({ "2026-10-31": link });
    expect(Object.keys(await loadLinks(h.ctx))).toEqual(["2025-10-31", "2026-10-31"]);
    await saveLink(h.ctx, "2026-10-31", null);
    expect(await loadLinks(h.ctx, 2026)).toEqual({});
    expect(h.storage.has("links:2026")).toBe(false);
  });
});

describe("settings", () => {
  it("defaults, then merges what is stored", async () => {
    const h = host();
    expect(await loadSettings(h.ctx)).toEqual({ windowDays: 4, payroll: { enabled: false } });
    await saveSettings(h.ctx, { windowDays: 6, payroll: { enabled: true, accountId: "a" }, accountIds: ["x"] });
    expect(await loadSettings(h.ctx)).toEqual({ windowDays: 6, payroll: { enabled: true, accountId: "a" }, accountIds: ["x"] });
    h.storage.set("settings", JSON.stringify({ windowDays: 2 }));
    expect(await loadSettings(h.ctx)).toEqual({ windowDays: 2, payroll: { enabled: false } });
  });
});

describe("statements", () => {
  const st = (date: string): UssStatement => ({ date, dbPension: 1000, dbLumpSum: 3000 });

  it("sorts by date, replaces the same date and deletes", async () => {
    const h = host();
    await addStatement(h.ctx, st("2026-03-31"));
    await addStatement(h.ctx, st("2025-03-31"));
    await addStatement(h.ctx, { ...st("2026-03-31"), dbPension: 5 });
    const list = await loadStatements(h.ctx);
    expect(list.map((s) => s.date)).toEqual(["2025-03-31", "2026-03-31"]);
    expect(list[1]!.dbPension).toBe(5);
    await deleteStatement(h.ctx, "2025-03-31");
    expect((await loadStatements(h.ctx)).map((s) => s.date)).toEqual(["2026-03-31"]);
  });

  it("caps at 100, keeping the newest", async () => {
    const h = host();
    const list = Array.from({ length: 105 }, (_, i) => st(new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10)));
    await saveStatements(h.ctx, [...list].reverse());
    const kept = await loadStatements(h.ctx);
    expect(kept).toHaveLength(100);
    expect(kept[0]).toEqual(list[5]);
    expect(kept[99]).toEqual(list[104]);
    await addStatement(h.ctx, st("2030-01-01"));
    expect(await loadStatements(h.ctx)).toHaveLength(100);
  });
});
