/**
 * Wealthfolio 3.11's `activities.import` answers 200 even when it stores nothing (see the kit's
 * `host-import.ts`). These run the Cash ISA CSV import against the kit's fake 3.11 host and check
 * that a row the host did not store is reported and not remembered as imported, so the next
 * import stores it.
 */
import type { ActivityImport } from "@wealthfolio/addon-sdk";
import type { ImportLedger } from "@wf-addons/kit";
import { FakeWealthfolio } from "@wf-addons/kit/testing";
import { describe, expect, it } from "vitest";
import { importCashIsa, parseCashIsaCsv } from "./cash-isa";

const EXPORT = [
  "Action,Time (UTC),Notes,ID,Total,Currency (Total)",
  "Interest on cash,2025-12-03 06:45:21+00:00,Interest on cash,0cc283e7-35f2-494c-86f8-bac61c79ed12,87.43,GBP",
  "Deposit,2025-12-10 09:00:00+00:00,Bank Transfer,9f1c2d3e-0000-4000-8000-000000000001,500.00,GBP",
  "Deposit,2025-12-10 09:00:00+00:00,Bank Transfer,9f1c2d3e-0000-4000-8000-000000000003,500.00,GBP",
  "Withdrawal,2026-01-15 12:30:00+00:00,Sent to Bank Account,9f1c2d3e-0000-4000-8000-000000000002,-250.00,GBP",
].join("\n");

const host = () => new FakeWealthfolio([{ id: "isa", name: "Cash ISA", currency: "GBP", accountType: "CASH" }]);
const ledgerOf = (h: FakeWealthfolio) => JSON.parse(h.storage.get("t212_cash_isa_ledger") ?? "{}") as ImportLedger;
const isWithdrawal = (a: ActivityImport) => a.activityType === "WITHDRAWAL";

async function rows() {
  return (await parseCashIsaCsv(EXPORT, "")).activities;
}

describe("importCashIsa when the host does not store every row", () => {
  it("a call refused as a whole: the rest is stored, the bad row is reported and not recorded, and the next import stores it", async () => {
    const h = host();
    h.importValidation = (a) => (isWithdrawal(a) ? "Invalid date" : null);

    const first = await importCashIsa(h.ctx, "isa", await rows());
    expect(first.imported).toBe(3);
    expect(first.unsaved.map((u) => u.reason)).toEqual(["Invalid date"]);
    expect(first.error).toMatch(/1 row was not saved by Wealthfolio/);
    expect(Object.keys(ledgerOf(h))).toHaveLength(3);
    expect(Object.keys(ledgerOf(h))).not.toContain(first.unsaved[0].activity.id);
    expect(h.rows("isa")).toHaveLength(3);

    h.importValidation = () => null;
    const second = await importCashIsa(h.ctx, "isa", await rows());
    expect(second).toMatchObject({ imported: 1, duplicates: 3, unsaved: [] });
    expect(second.error).toBeUndefined();
    expect(h.rows("isa")).toHaveLength(4); // two identical same-day deposits survive
    expect(Object.keys(ledgerOf(h))).toHaveLength(4);
  });

  it("a row the writer policy refuses is reported and imported by the next import", async () => {
    const h = host();
    h.policy = (a) => (isWithdrawal(a) ? "Preparation failed" : null);

    const first = await importCashIsa(h.ctx, "isa", await rows());
    expect(first.imported).toBe(3);
    expect(first.unsaved.map((u) => u.reason)).toEqual(["Preparation failed"]);
    expect(first.error).toContain("Preparation failed");

    h.policy = () => null;
    expect(await importCashIsa(h.ctx, "isa", await rows())).toMatchObject({ imported: 1, unsaved: [] });
    expect(h.rows("isa")).toHaveLength(4);
  });

  it("a 200 that stored nothing is an error with nothing recorded, and the next import stores everything", async () => {
    const h = host();
    h.storeNothing = true;

    const first = await importCashIsa(h.ctx, "isa", await rows());
    expect(first.imported).toBe(0);
    expect(first.unsaved).toHaveLength(4);
    expect(first.error).toMatch(/4 rows were not saved/);
    expect(ledgerOf(h)).toEqual({});

    h.storeNothing = false;
    expect(await importCashIsa(h.ctx, "isa", await rows())).toMatchObject({ imported: 4, unsaved: [] });
    expect(h.rows("isa")).toHaveLength(4);
  });
});
