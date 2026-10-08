import { describe, expect, it, vi } from "vitest";
import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import { ensureCashIsaAccount, importCashIsa, parseCashIsaCsv } from "./cash-isa";

// The layout of the Trading 212 Cash ISA export (values made up).
const EXPORT = [
  "Action,Time (UTC),Notes,ID,Total,Currency (Total)",
  "Interest on cash,2025-12-03 06:45:21+00:00,Interest on cash,0cc283e7-35f2-494c-86f8-bac61c79ed12,87.43,GBP",
  "Deposit,2025-12-10 09:00:00+00:00,Transaction ID: 4458b9af-cfeb-4322-8f6f-1e8b6602fa66,,500.00,GBP",
  "Deposit,2025-12-10 09:00:00+00:00,Bank Transfer,9f1c2d3e-0000-4000-8000-000000000001,500.00,GBP",
  "Withdrawal,2026-01-15 12:30:00+00:00,Sent to Bank Account 04-00-75 / 00000000,9f1c2d3e-0000-4000-8000-000000000002,-250.00,GBP",
  "Withdrawal,,,,,GBP",
].join("\n");

describe("parseCashIsaCsv", () => {
  it("maps deposits, withdrawals and interest to cash activities", async () => {
    const { activities, skipped, currency } = await parseCashIsaCsv(EXPORT, "acc");
    expect(currency).toBe("GBP");
    expect(activities.map((a) => [a.activityType, a.amount, a.date])).toEqual([
      ["INTEREST", 87.43, "2025-12-03T06:45:21.000Z"],
      ["DEPOSIT", 500, "2025-12-10T09:00:00.000Z"],
      ["DEPOSIT", 500, "2025-12-10T09:00:00.000Z"],
      ["WITHDRAWAL", 250, "2026-01-15T12:30:00.000Z"],
    ]);
    expect(activities.every((a) => a.symbol === "$CASH-GBP")).toBe(true);
    // A row without a date or amount is left out and reported.
    expect(skipped).toEqual({ Withdrawal: 1 });
  });

  it("takes a deposit's id from its Notes when the ID column is empty", async () => {
    const { activities } = await parseCashIsaCsv(EXPORT, "acc");
    expect(activities[1].id).toBe("t212-txn-4458b9af-cfeb-4322-8f6f-1e8b6602fa66");
  });

  it("gives a row with no id at all a stable id, so re-importing it is recognised", async () => {
    const csv = "Action,Time (UTC),Notes,ID,Total,Currency (Total)\nInterest on cash,2026-02-01 06:00:00+00:00,Interest on cash,,1.23,GBP";
    const a = (await parseCashIsaCsv(csv, "acc")).activities;
    const b = (await parseCashIsaCsv(csv, "acc")).activities;
    expect(a).toHaveLength(1);
    expect(a[0].id).toBeTruthy();
    expect(a[0].id).toBe(b[0].id);
  });
});

function fakeCtx() {
  const rows: Record<string, unknown>[] = [];
  const storage = new Map<string, string>();
  const accounts: Record<string, unknown>[] = [];
  const importFn = vi.fn(async (batch: ActivityImport[]) => {
    for (const a of batch) {
      rows.push({
        activityType: a.activityType,
        date: new Date(String(a.date)),
        amount: String(a.amount),
        currency: a.currency,
        comment: a.comment ?? null,
        assetSymbol: a.symbol,
      });
    }
    return { summary: { imported: batch.length, skipped: 0 } };
  });
  const create = vi.fn(async (input: Record<string, unknown>) => {
    const acc = { id: `wf-${accounts.length + 1}`, ...input };
    accounts.push(acc);
    return acc;
  });
  const ctx = {
    api: {
      storage: {
        get: async (k: string) => storage.get(k) ?? null,
        set: async (k: string, v: string) => void storage.set(k, v),
        delete: async (k: string) => void storage.delete(k),
      },
      accounts: { getAll: async () => accounts, create },
      activities: { getAll: async () => rows, import: importFn },
    },
  } as unknown as AddonContext;
  return { ctx, rows, importFn, create };
}

describe("importCashIsa", () => {
  it("imports everything once, keeps two identical same-day deposits, and adds nothing on a re-import", async () => {
    const { ctx, rows } = fakeCtx();
    const { activities } = await parseCashIsaCsv(EXPORT, "");
    expect(await importCashIsa(ctx, "wf-1", activities)).toEqual({ imported: 4, duplicates: 0 });
    expect(rows).toHaveLength(4);
    expect(await importCashIsa(ctx, "wf-1", activities)).toEqual({ imported: 0, duplicates: 4 });
    expect(rows).toHaveLength(4);
  });
});

describe("ensureCashIsaAccount", () => {
  it("creates one Cash account and reuses it afterwards", async () => {
    const { ctx, create } = fakeCtx();
    const id = await ensureCashIsaAccount(ctx, "GBP");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Trading 212 Cash ISA", accountType: "CASH", currency: "GBP", trackingMode: "TRANSACTIONS" }),
    );
    expect(await ensureCashIsaAccount(ctx, "GBP")).toBe(id);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
