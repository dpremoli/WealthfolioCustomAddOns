import { describe, expect, it, vi } from "vitest";
import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import { ActivityImporter } from "./importer";
import type { KnownSplit } from "./known-splits";
import { proposeSplits, quantityEvents, repairSplits, simulateQuantity, type PositionGap, type QtyEvent } from "./split-repair";
import type { SymbolResolver } from "./symbol-resolver";

const buy = (day: string, value: number): QtyEvent => ({ day, kind: "add", value });
const sell = (day: string, value: number): QtyEvent => ({ day, kind: "remove", value });
const today = "2026-10-23";

describe("simulateQuantity", () => {
  it("multiplies what was held before the split day, not the trades of that day", () => {
    const events = [buy("2022-01-10", 1), buy("2022-06-06", 2), sell("2022-07-01", 0.5)];
    expect(simulateQuantity(events)).toBe(2.5);
    // The 20:1 on 2022-06-06: the first lot is split, the buy that day is already at the new price.
    expect(simulateQuantity(events, [{ date: "2022-06-06", ratio: 20 }])).toBe(21.5);
  });
});

describe("quantityEvents", () => {
  it("reads one asset's share counts from existing rows and from just-imported ones, ignoring cash", () => {
    const rows = [
      { activityType: "BUY", date: new Date("2022-01-10T10:00:00Z"), quantity: "0.5", assetSymbol: "AMZN" },
      { activityType: "SELL", date: "2022-03-01T10:00:00Z", quantity: 0.1, symbol: "AMZN" },
      { activityType: "SPLIT", date: "2022-06-06T00:00:00Z", amount: 20, symbol: "AMZN" },
      { activityType: "BUY", date: "2022-01-10T10:00:00Z", quantity: 9, assetSymbol: "GOOGL" },
      { activityType: "DEPOSIT", date: "2022-01-10T10:00:00Z", amount: 100, assetSymbol: "$CASH-EUR" },
      { activityType: "DIVIDEND", date: "2022-01-10T10:00:00Z", amount: 1, assetSymbol: "AMZN" },
    ];
    expect(quantityEvents(rows, "AMZN")).toEqual([
      { day: "2022-01-10", kind: "add", value: 0.5 },
      { day: "2022-03-01", kind: "remove", value: 0.1 },
      { day: "2022-06-06", kind: "split", value: 20 },
    ]);
  });
});

describe("proposeSplits — the silent splits of the Invest account", () => {
  const known: KnownSplit[] = [
    { isin: "US0231351067", date: "2022-06-06", ratio: 20, name: "Amazon" },
    { isin: "US67066G1040", date: "2021-07-20", ratio: 4, name: "NVIDIA" },
    { isin: "US67066G1040", date: "2024-06-10", ratio: 10, name: "NVIDIA" },
    { isin: "US9311421039", date: "2024-02-26", ratio: 3, name: "Walmart" },
    { isin: "US8243481061", date: "2021-04-01", ratio: 3, name: "Sherwin-Williams" },
  ];

  it("finds Amazon's 20:1 from the shares Trading 212 holds (0.108245 → 2.1649)", () => {
    const p = proposeSplits({ isin: "US0231351067", held: 2.1649, events: [buy("2021-09-01", 0.108245)], today, known });
    expect(p.splits.map((s) => [s.date, s.ratio])).toEqual([["2022-06-06", 20]]);
    expect(p.reason).toContain("20:1 on 2022-06-06 reproduces it exactly");
  });

  it("finds NVIDIA's 10:1 on Xetra (1.095510 → 10.955101) without the 2021 split, which predates the first buy", () => {
    const p = proposeSplits({ isin: "US67066G1040", held: 10.955101, events: [buy("2023-03-01", 1.09551)], today, known });
    expect(p.splits.map((s) => s.date)).toEqual(["2024-06-10"]);
  });

  it("finds both NVIDIA splits when the shares were bought before both", () => {
    const p = proposeSplits({ isin: "US67066G1040", held: 40, events: [buy("2021-01-05", 1)], today, known });
    expect(p.splits.map((s) => s.date)).toEqual(["2021-07-20", "2024-06-10"]);
  });

  it("uses the trades around the split: shares bought after it are not multiplied", () => {
    // Walmart 3:1 on 2024-02-26: 3.542146 held before, 1 more bought after → 3.542146×3 + 1.
    const p = proposeSplits({
      isin: "US9311421039",
      held: 3.542146 * 3 + 1,
      events: [buy("2022-05-01", 3.542146), buy("2024-05-01", 1)],
      today,
      known,
    });
    expect(p.splits.map((s) => s.date)).toEqual(["2024-02-26"]);
  });

  it("does nothing when the numbers do not match the known split (a missing trade is not a split)", () => {
    const p = proposeSplits({ isin: "US8243481061", held: 0.05, events: [buy("2020-05-01", 0.016015)], today, known });
    expect(p.splits).toEqual([]);
    expect(p.reason).toContain("do not reproduce it");
  });

  it("says what is likely for a position with no known split, like Pennon's consolidation", () => {
    const p = proposeSplits({ isin: "GB00BNNTLN49", held: 0.321687, events: [buy("2021-05-01", 0.399636)], today, known });
    expect(p.splits).toEqual([]);
    expect(p.reason).toContain("Trading 212 holds 0.321687, the activities add up to 0.399636 (×0.805)");
    expect(p.reason).toContain("No known split for GB00BNNTLN49");
  });

  it("does not add a split the account already holds, or one that predates the first buy", () => {
    const already = proposeSplits({
      isin: "US0231351067",
      held: 2.1649,
      events: [buy("2021-09-01", 0.108245), { day: "2022-06-06", kind: "split", value: 20 }],
      today,
      known,
    });
    expect(already.splits).toEqual([]);
    expect(already.reason).toContain("they agree");
    const before = proposeSplits({ isin: "US0231351067", held: 2.1649, events: [buy("2023-01-01", 0.108245)], today, known });
    expect(before.splits).toEqual([]);
  });

  it("refuses to choose when two known splits would explain it equally well", () => {
    const twin: KnownSplit[] = [
      { isin: "X", date: "2022-01-03", ratio: 5, name: "x" },
      { isin: "X", date: "2022-01-04", ratio: 5, name: "x" },
    ];
    const p = proposeSplits({ isin: "X", held: 5, events: [buy("2021-01-01", 1)], today, known: twin });
    expect(p.splits).toEqual([]);
    expect(p.reason).toContain("equally well");
  });
});

describe("repairSplits", () => {
  function setup(rows: Record<string, unknown>[]) {
    const imported: ActivityImport[][] = [];
    const ctx = {
      api: {
        activities: {
          getAll: async () => rows,
          checkImport: async (r: ActivityImport[]) => r,
          import: vi.fn(async (r: ActivityImport[]) => {
            imported.push(r);
            return { summary: { imported: r.length, skipped: 0 } };
          }),
        },
      },
    } as unknown as AddonContext;
    const resolver = {
      resolveDetailed: async () => ({ symbol: "AMZN", exchangeMic: "XNAS" }),
    } as unknown as SymbolResolver;
    return { importer: new ActivityImporter(ctx), resolver, imported };
  }
  const gap = (extra: Partial<PositionGap> = {}): PositionGap => ({
    ticker: "AMZN_US_EQ",
    isin: "US0231351067",
    name: "Amazon",
    symbol: "AMZN",
    currency: "USD",
    held: 2.1649,
    derived: 0.108245,
    ...extra,
  });

  it("imports the missing split as a SPLIT at that day, with the listing, and logs why", async () => {
    const t = setup([{ activityType: "BUY", date: new Date("2021-09-01T10:00:00Z"), quantity: "0.108245", assetSymbol: "AMZN" }]);
    const log: string[] = [];
    expect(await repairSplits(t.importer, t.resolver, "inv", [gap()], log)).toBe(1);
    expect(t.imported[0][0]).toMatchObject({
      id: "t212-split-US0231351067-20220606",
      accountId: "inv",
      activityType: "SPLIT",
      date: "2022-06-06T00:00:00.000Z",
      symbol: "AMZN",
      exchangeMic: "XNAS",
      instrumentType: "EQUITY",
      amount: 20,
      currency: "USD",
    });
    expect(log[0]).toContain("adding the 20:1 split of 2022-06-06 that Trading 212's history does not list");
    // Repeating adds nothing: the split is now one of the account's activities.
    expect(await repairSplits(t.importer, t.resolver, "inv", [gap()], log)).toBe(0);
  });

  it("logs the reason for a position it cannot explain and imports nothing", async () => {
    const t = setup([{ activityType: "BUY", date: new Date("2021-09-01T10:00:00Z"), quantity: "0.4", assetSymbol: "PNN" }]);
    const log: string[] = [];
    expect(await repairSplits(t.importer, t.resolver, "inv", [gap({ ticker: "PNN_GB_EQ", symbol: "PNN", isin: "GB00BNNTLN49", held: 0.32 })], log)).toBe(0);
    expect(log[0]).toContain("PNN_GB_EQ (Amazon)");
    expect(t.imported).toEqual([]);
  });
});
