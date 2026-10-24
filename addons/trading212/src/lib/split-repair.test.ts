import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import { FakeWealthfolio } from "@wf-addons/kit/testing";
import { ActivityImporter } from "./importer";
import type { KnownSplit } from "./known-splits";
import { KNOWN_SPLITS } from "./known-splits";
import {
  cleanRatio,
  describeRatio,
  healSplitRatios,
  inferSplit,
  minorUnitSplits,
  proposeSplits,
  quantityEvents,
  repairSplits,
  simulateQuantity,
  statedRatio,
  type DividendShares,
  type PositionGap,
  type QtyEvent,
} from "./split-repair";
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

  it("says what is likely for a position with no known split, with the overall ratio it implies", () => {
    const p = proposeSplits({ isin: "GB0000000000", held: 0.321687, events: [buy("2021-05-01", 0.399636)], today, known });
    expect(p.splits).toEqual([]);
    expect(p.reason).toContain("Trading 212 holds 0.321687, the activities add up to 0.399636 (overall ×0.805;");
    expect(p.reason).toContain("No known split for GB0000000000");
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
          // What the account holds: the rows given, and what was imported since.
          getAll: async () => [...rows, ...imported.flat().map((a) => ({ ...a, assetSymbol: a.symbol }))],
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
    expect(await repairSplits(t.importer, t.resolver, "inv", [gap({ ticker: "PNN_GB_EQ", symbol: "PNN", isin: "GB0000000000", held: 0.32 })], log)).toBe(0);
    expect(log[0]).toContain("PNN_GB_EQ (Amazon)");
    expect(t.imported).toEqual([]);
  });
});

describe("Pennon's 2-for-3 consolidation (numbers from a real Invest export)", () => {
  // Trading 212 books every Pennon row under GB00BNNTLN49. The two buys before the consolidation
  // total 0.23384732 shares (the split between them is illustrative); the two after are as exported.
  const events: QtyEvent[] = [
    buy("2021-03-10", 0.15),
    buy("2021-06-15", 0.08384732),
    buy("2021-07-29", 0.09429628),
    buy("2021-11-04", 0.0714921),
  ];
  const held = 0.321687; // Trading 212's position

  it("is in the table, as 2/3 on 2021-07-26", () => {
    expect(KNOWN_SPLITS).toContainEqual({ isin: "GB00BNNTLN49", date: "2021-07-26", ratio: 2 / 3, name: "Pennon (2-for-3 consolidation)" });
  });

  it("matches the dividend rows: 0.2338473200 held becomes 0.1558982100", () => {
    expect((0.23384732 * 2) / 3).toBeCloseTo(0.15589821, 8);
  });

  it("without the consolidation the trades add up to 0.3996357, 0.078 more than Trading 212 holds", () => {
    expect(simulateQuantity(events)).toBeCloseTo(0.3996357, 7);
  });

  it("replays to Trading 212's 0.321687 for any date from 2021-07-22 to 2021-07-29, and not after", () => {
    for (const date of ["2021-07-22", "2021-07-26", "2021-07-29"]) {
      expect(simulateQuantity(events, [{ date, ratio: 2 / 3 }])).toBeCloseTo(held, 6);
    }
    // The buy of 2021-07-29 would be consolidated too.
    expect(Math.abs(simulateQuantity(events, [{ date: "2021-07-30", ratio: 2 / 3 }]) - held)).toBeGreaterThan(0.02);
  });

  it("is proposed, from the real table, because it reproduces the position exactly", () => {
    const p = proposeSplits({ isin: "GB00BNNTLN49", held, events, today });
    expect(p.splits).toEqual([{ isin: "GB00BNNTLN49", date: "2021-07-26", ratio: 2 / 3, name: "Pennon (2-for-3 consolidation)" }]);
    expect(p.reason).toContain("2:3 on 2021-07-26 reproduces it exactly");
  });

  it("is imported as a SPLIT of 2/3 on that day", async () => {
    const imported: ActivityImport[][] = [];
    const ctx = {
      api: {
        activities: {
          getAll: async () =>
            events.map((e) => ({ activityType: "BUY", date: new Date(`${e.day}T10:00:00Z`), quantity: String(e.value), assetSymbol: "PNN" })),
          checkImport: async (r: ActivityImport[]) => r,
          import: async (r: ActivityImport[]) => {
            imported.push(r);
            return { summary: { imported: r.length, skipped: 0 } };
          },
        },
      },
    } as unknown as AddonContext;
    const resolver = { resolveDetailed: async () => ({ symbol: "PNN", exchangeMic: "XLON" }) } as unknown as SymbolResolver;
    const gap: PositionGap = { ticker: "PNN_GB_EQ", isin: "GB00BNNTLN49", name: "Pennon", symbol: "PNN", currency: "GBX", held, derived: 0.3996357 };
    expect(await repairSplits(new ActivityImporter(ctx), resolver, "inv", [gap], [])).toBe(1);
    expect(imported[0][0]).toMatchObject({
      id: "t212-split-GB00BNNTLN49-20210726",
      activityType: "SPLIT",
      date: "2021-07-26T00:00:00.000Z",
      symbol: "PNN",
      exchangeMic: "XLON",
      amount: 2 / 3,
      // In pounds: Wealthfolio would store a GBX ratio as a hundredth of itself.
      currency: "GBP",
    });
  });
});

describe("describeRatio", () => {
  it("reads whole ratios, reverse splits and consolidations the way they are said", () => {
    expect(describeRatio(20)).toBe("20:1");
    expect(describeRatio(0.1)).toBe("1:10");
    expect(describeRatio(2 / 3)).toBe("2:3");
    expect(describeRatio(0.96)).toBe("×0.96");
    expect(describeRatio(0.804955)).toBe("×0.804955");
  });
});

describe("cleanRatio", () => {
  it("reads whole ratios, reciprocals and small fractions, and nothing else", () => {
    expect(cleanRatio(20.0000001)).toBe(20);
    expect(cleanRatio(0.1000001)).toBe(0.1);
    expect(cleanRatio(0.15589821 / 0.23384732)).toBe(2 / 3);
    expect(cleanRatio(1.5000001)).toBe(1.5);
    expect(cleanRatio(0.804955)).toBeNull();
    expect(cleanRatio(1)).toBeNull();
    expect(cleanRatio(0)).toBeNull();
    expect(cleanRatio(Number.NaN)).toBeNull();
  });
});

describe("inferSplit — a split found from the dividend rows' share counts", () => {
  // Pennon, from the real export: nothing in the table. The dividend of 2021-07-21 was paid on
  // 0.23384732 shares; the one of 2021-09-06 on 0.15589821 (= ×2/3), which excludes the buy of
  // 2021-07-29, so the holding it quotes dates from before that buy.
  const events: QtyEvent[] = [
    buy("2021-03-10", 0.15),
    buy("2021-06-15", 0.08384732),
    buy("2021-07-29", 0.09429628),
    buy("2021-11-04", 0.0714921),
  ];
  const held = 0.321687;
  const dividends: DividendShares[] = [
    ["2021-07-21", 0.23384732],
    ["2021-09-06", 0.15589821],
  ];

  it("finds 2:3 between 2021-07-21 and 2021-09-06 and lands on Trading 212's 0.321687", () => {
    const r = inferSplit({ held, events, dividends });
    expect(r.split).toMatchObject({ ratio: 2 / 3, after: "2021-07-21", before: "2021-09-06", from: "2021-07-22", to: "2021-07-29" });
    expect(r.split!.date >= "2021-07-22" && r.split!.date <= "2021-07-29").toBe(true);
    expect(simulateQuantity(events, [{ date: r.split!.date, ratio: r.split!.ratio }])).toBeCloseTo(held, 6);
    expect(r.reason).toContain("2:3 split between 2021-07-21 and 2021-09-06");
    expect(r.reason).toContain("any date from 2021-07-22 to 2021-07-29");
  });

  it("is not thrown by dividends after the split and later trades (each gives the same ratio)", () => {
    // After the buy of 2021-11-04 the holding is 0.15589821 + 0.09429628 + 0.0714921 = 0.32168659,
    // and a dividend in 2022 quotes it; it is not the unsplit holding times anything.
    const later: DividendShares[] = [...dividends, ["2021-12-02", 0.15589821 + 0.09429628 + 0.0714921]];
    expect(inferSplit({ held, events, dividends: later }).split).toMatchObject({ ratio: 2 / 3, from: "2021-07-22", to: "2021-07-29" });
  });

  it("works when the position has sold shares since, and for a whole ratio", () => {
    // 10 shares, 3:1 split in the spring, 5 sold afterwards: 25 held.
    const ev = [buy("2020-01-10", 10), sell("2020-09-01", 5), buy("2020-10-05", 1)];
    const divs: DividendShares[] = [
      ["2020-02-14", 10],
      ["2020-05-15", 10],
      ["2020-08-14", 30],
      ["2020-11-13", 26],
    ];
    // 10×3 − 5 + 1 = 26.
    const r = inferSplit({ held: 26, events: ev, dividends: divs });
    expect(r.split).toMatchObject({ ratio: 3, after: "2020-05-15", before: "2020-08-14" });
  });

  it("finds a reverse split", () => {
    const ev = [buy("2020-01-10", 100)];
    const r = inferSplit({ held: 10, events: ev, dividends: [["2020-02-01", 100], ["2020-08-01", 10]] });
    expect(r.split).toMatchObject({ ratio: 0.1 });
  });

  it("proposes nothing without a dividend that agrees before it, or one that differs after it", () => {
    const only = (d: DividendShares[]) => inferSplit({ held, events, dividends: d });
    expect(only([["2021-09-06", 0.15589821]]).split).toBeUndefined();
    expect(only([["2021-09-06", 0.15589821], ["2021-10-06", 0.15589821]]).reason).toContain("no dividend before");
    expect(only([["2021-07-21", 0.23384732], ["2021-08-21", 0.23384732]]).reason).toContain("none shows a change");
    expect(only([]).reason).toContain("0 dividend rows");
  });

  it("proposes nothing when the dividends after the window disagree on the ratio", () => {
    // 2/3 on 2021-09-06, but a December count (0.1) that no ratio of the same holding gives.
    const r = inferSplit({ held, events, dividends: [...dividends, ["2021-12-02", 0.1]] });
    expect(r.split).toBeUndefined();
    expect(r.reason).toContain("do not agree on one usual ratio");
  });

  it("proposes nothing when the share count is not a usual ratio of anything held", () => {
    const r = inferSplit({ held, events, dividends: [["2021-07-21", 0.23384732], ["2021-09-06", 0.17]] });
    expect(r.split).toBeUndefined();
    expect(r.reason).toContain("do not agree on one usual ratio");
  });

  it("proposes nothing when a later dividend agrees with the activities again", () => {
    const r = inferSplit({ held, events, dividends: [...dividends, ["2021-12-02", 0.3996357]] });
    expect(r.split).toBeUndefined();
    expect(r.reason).toContain("agrees with the activities again");
  });

  it("proposes nothing when no date in the window reproduces Trading 212's quantity", () => {
    const r = inferSplit({ held: 0.33, events, dividends });
    expect(r.split).toBeUndefined();
    expect(r.reason).toContain("reproduces Trading 212's quantity (0.33)");
  });

  it("proposes nothing when the position already agrees, or has no activities", () => {
    expect(inferSplit({ held: 0.3996357, events, dividends }).reason).toContain("already agree");
    expect(inferSplit({ held, events: [], dividends }).split).toBeUndefined();
  });

  it("proposes nothing when a clean ratio from the dividends is not what Trading 212 holds", () => {
    // The dividend says ×2 (1 → 2 shares) but Trading 212 holds 4: the counts do not explain it.
    const r = inferSplit({ held: 4, events: [buy("2020-01-01", 1)], dividends: [["2020-02-01", 1], ["2020-06-01", 2]] });
    expect(r.split).toBeUndefined();
    expect(r.reason).toContain("reproduces Trading 212's quantity (4)");
  });

  it("does not repeat a dividend row it was given twice", () => {
    const r = inferSplit({ held, events, dividends: [...dividends, ...dividends] });
    expect(r.split?.ratio).toBe(2 / 3);
  });
});

describe("inferSplit — what the dividend counts cannot show, and what it refuses", () => {
  const pennon: QtyEvent[] = [
    buy("2021-03-10", 0.15),
    buy("2021-06-15", 0.08384732),
    buy("2021-07-29", 0.09429628),
    buy("2021-11-04", 0.0714921),
  ];
  const pennonDividends: DividendShares[] = [["2021-07-21", 0.23384732], ["2021-09-06", 0.15589821]];

  it("dates it in the middle of the days that reproduce the quantity", () => {
    // 2021-07-22 to 2021-07-29 are eight days: the fourth is 2021-07-25.
    expect(inferSplit({ held: 0.321687, events: pennon, dividends: pennonDividends }).split?.date).toBe("2021-07-25");
  });

  it("does not take a missing buy or sell for an odd split: only the usual ratios are read", () => {
    // 5 shares and a buy of 1 the activities lack: 6:5 would fit exactly, but it is no usual ratio.
    const miss = inferSplit({ held: 6, events: [buy("2020-01-10", 5)], dividends: [["2020-03-15", 5], ["2020-06-15", 6]] });
    expect(miss.split).toBeUndefined();
    expect(miss.reason).toContain("do not agree on one usual ratio");
    expect(inferSplit({ held: 140, events: [buy("2020-01-10", 120)], dividends: [["2020-03-15", 120], ["2020-06-15", 140]] }).split).toBeUndefined();
  });

  it("does not place a split when a trade moved the holding between the last matching dividend's record and pay dates", () => {
    // Bought 10, split 2:1 on 03-10 (not listed), bought 5 more on 03-15; the dividend paid 03-20
    // quotes the 10 held on its record date, 03-01. The replay says 15 by then: the split could be
    // anywhere before 03-15, so the window opened at 03-21 would mis-date it and scale the 5 as well.
    const r = inferSplit({
      held: 25,
      events: [buy("2020-01-02", 10), buy("2020-03-15", 5)],
      dividends: [["2020-03-20", 10], ["2020-06-20", 25]],
    });
    expect(r.split).toBeUndefined();
    expect(r.reason).toContain("a later trade had already changed");
  });

  it("is not fooled by a post-split dividend that quotes what an earlier holding was", () => {
    // 20 held, 10 sold on 03-01, a 2:1 split on 05-01 (not listed) gives 20 again: the dividend of
    // 05-20 quotes 20, as the holding in February did, but it is not an unsplit one.
    const r = inferSplit({
      held: 20,
      events: [buy("2020-01-01", 20), sell("2020-03-01", 10)],
      dividends: [["2020-02-01", 20], ["2020-05-20", 20], ["2020-09-20", 20]],
    });
    expect(r.split).toBeUndefined();
  });

  it("gives the same answer when the activities hold a split (the slow path) as when they do not", () => {
    const withSplit: QtyEvent[] = [{ day: "2021-01-04", kind: "split", value: 1 }, ...pennon];
    const a = inferSplit({ held: 0.321687, events: pennon, dividends: pennonDividends });
    const b = inferSplit({ held: 0.321687, events: withSplit, dividends: pennonDividends });
    expect(b.split).toEqual(a.split);
    expect(a.split?.ratio).toBe(2 / 3);
  });

  it("finds a split in a long history of daily buys without stalling", () => {
    // 1,800 one-share buys, a real 2:1 split in the middle of a year, annual dividends.
    const events: QtyEvent[] = [];
    for (let i = 0; i < 1800; i++) events.push(buy(new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), 1));
    const split = "2021-06-10"; // lots bought before it are doubled
    const shares = (day: string) => events.filter((e) => e.day <= day).reduce((n, e) => n + (e.day < split ? 2 : 1), 0);
    const dividends: DividendShares[] = [["2020-12-31", 366], ["2021-12-31", shares("2021-12-31")], ["2022-12-31", shares("2022-12-31")]];
    const t = Date.now();
    const r = inferSplit({ held: shares("9999-12-31"), events, dividends });
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.split).toMatchObject({ date: split, ratio: 2, after: "2020-12-31", before: "2021-12-31" });
  });

  it("gives up, and says so, on a long history that also holds a split (each query would replay it)", () => {
    const events: QtyEvent[] = [{ day: "2019-01-01", kind: "split", value: 1 }];
    for (let i = 0; i < 1800; i++) events.push(buy(new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), 1));
    const split = "2021-06-10";
    const shares = (day: string) => events.filter((e) => e.kind === "add" && e.day <= day).reduce((n, e) => n + (e.day < split ? 2 : 1), 0);
    const dividends: DividendShares[] = [["2020-12-31", 366], ["2021-12-31", shares("2021-12-31")], ["2022-12-31", shares("2022-12-31")]];
    const r = inferSplit({ held: shares("9999-12-31"), events, dividends });
    expect(r.split).toBeUndefined();
    expect(r.reason).toContain("too many activities to search");
  }, 30_000);

  it("still searches a short history that holds a split (within the budget)", () => {
    const events: QtyEvent[] = [{ day: "2019-01-01", kind: "split", value: 1 }, buy("2020-01-10", 10), buy("2020-09-01", 1)];
    // 10 shares, 3:1 in the spring (not listed), 1 more bought in September: 31.
    const r = inferSplit({ held: 31, events, dividends: [["2020-02-14", 10], ["2020-05-15", 10], ["2020-08-14", 30]] });
    expect(r.split).toMatchObject({ ratio: 3, after: "2020-05-15", before: "2020-08-14" });
  });
});

describe("repairSplits — from the dividend rows, with Pennon out of the table", () => {
  const entry = KNOWN_SPLITS.findIndex((k) => k.isin === "GB00BNNTLN49");
  let removed: KnownSplit[] = [];
  beforeEach(() => {
    removed = KNOWN_SPLITS.splice(entry, 1);
  });
  afterEach(() => {
    KNOWN_SPLITS.splice(entry, 0, ...removed);
  });

  const trades = [
    ["2021-03-10", "0.15"],
    ["2021-06-15", "0.08384732"],
    ["2021-07-29", "0.0942963"],
    ["2021-11-04", "0.0714921"],
  ];
  function setup() {
    const imported: ActivityImport[][] = [];
    const ctx = {
      api: {
        activities: {
          getAll: async () => [
            ...trades.map(([d, q]) => ({ activityType: "BUY", date: new Date(`${d}T10:00:00Z`), quantity: q, assetSymbol: "PNN" })),
            ...imported.flat().map((a) => ({ ...a, assetSymbol: a.symbol })),
          ],
          checkImport: async (r: ActivityImport[]) => r,
          import: async (r: ActivityImport[]) => {
            imported.push(r);
            return { summary: { imported: r.length, skipped: 0 } };
          },
        },
      },
    } as unknown as AddonContext;
    const resolver = { resolveDetailed: async () => ({ symbol: "PNN", exchangeMic: "XLON" }) } as unknown as SymbolResolver;
    return { importer: new ActivityImporter(ctx), resolver, imported };
  }
  const gap: PositionGap = {
    ticker: "PNN_GB_EQ",
    isin: "GB00BNNTLN49",
    name: "Pennon",
    symbol: "PNN",
    currency: "GBX",
    held: 0.321687,
    derived: 0.3996357,
  };
  const dividends = { GB00BNNTLN49: [["2021-07-21", 0.23384732], ["2021-09-06", 0.15589821]] as DividendShares[] };

  it("the table no longer holds Pennon", () => {
    expect(KNOWN_SPLITS.some((k) => k.isin === "GB00BNNTLN49")).toBe(false);
  });

  it("imports a 2/3 SPLIT inside the window, says how it was found, and repeating adds nothing", async () => {
    const t = setup();
    const log: string[] = [];
    expect(await repairSplits(t.importer, t.resolver, "inv", [gap], log, dividends)).toBe(1);
    const split = t.imported[0][0];
    expect(split).toMatchObject({ activityType: "SPLIT", symbol: "PNN", exchangeMic: "XLON", amount: 2 / 3, currency: "GBP" });
    const day = String(split.date).slice(0, 10);
    expect(day >= "2021-07-22" && day <= "2021-07-29").toBe(true);
    expect(split.id).toBe(`t212-split-GB00BNNTLN49-${day.replace(/-/g, "")}`);
    expect(split.comment).toContain("inferred from the dividend share counts");
    expect(log[0]).toContain("adding the 2:3 split of");
    expect(log[0]).toContain("between 2021-07-21 and 2021-09-06");
    expect(await repairSplits(t.importer, t.resolver, "inv", [gap], log, dividends)).toBe(0);
  });

  it("imports nothing, and says why, without dividend rows or when they are not clear", async () => {
    const t = setup();
    const log: string[] = [];
    expect(await repairSplits(t.importer, t.resolver, "inv", [gap], log)).toBe(0);
    expect(await repairSplits(t.importer, t.resolver, "inv", [gap], log, { GB00BNNTLN49: [["2021-09-06", 0.15589821]] })).toBe(0);
    expect(await repairSplits(t.importer, t.resolver, "inv", [gap], log, { GB0000000000: dividends.GB00BNNTLN49 })).toBe(0);
    expect(t.imported).toEqual([]);
    expect(log[1]).toContain("Dividend share counts: 1 dividend row");
  });

  it("prefers the table: with Pennon back in it the split is the table's and says so", async () => {
    KNOWN_SPLITS.splice(entry, 0, ...removed);
    try {
      const t = setup();
      expect(await repairSplits(t.importer, t.resolver, "inv", [gap], [], dividends)).toBe(1);
      expect(t.imported[0][0]).toMatchObject({ id: "t212-split-GB00BNNTLN49-20210726" });
      expect(t.imported[0][0].comment).toContain("found from the position difference");
    } finally {
      KNOWN_SPLITS.splice(entry, 1);
    }
  });
});

describe("splits stored at a hundredth of their ratio (sent in pence before 2.6.4)", () => {
  it("reads the ratio the add-on's comments state", () => {
    expect(statedRatio("Stock split: 1.2 → 1.152 shares")).toBeCloseTo(0.96, 10);
    expect(statedRatio("Stock split 2:3 (not in the Trading 212 export; found from the position difference)")).toBeCloseTo(2 / 3, 10);
    expect(statedRatio("Stock split ×0.805 (not in the Trading 212 export; …)")).toBe(0.805);
    expect(statedRatio("A split I added by hand")).toBeNull();
  });

  it("finds only the rows whose ratio is a hundredth (or thousandth) of what the comment says", () => {
    const rows = [
      { id: "a", activityType: "SPLIT", date: "2024-02-01", amount: "0.0096", comment: "Stock split: 1.2 → 1.152 shares" },
      { id: "b", activityType: "SPLIT", date: "2022-06-06", amount: "20", comment: "Stock split 20:1 (not in the Trading 212 export; x)" },
      // Off by a factor that is not a minor unit's: not this mistake, left alone.
      { id: "c", activityType: "SPLIT", date: "2022-06-06", amount: "2", comment: "Stock split 20:1 (not in the Trading 212 export; x)" },
      { id: "d", activityType: "BUY", date: "2022-06-06", amount: "0.0096", comment: "Stock split: 1.2 → 1.152 shares" },
    ];
    expect(minorUnitSplits(rows).map((b) => [b.row.id, b.ratio])).toEqual([["a", 0.96]]);
  });

  it("imports the right ratio in pounds, deletes the wrong row, and Reckitt's quantity comes back", async () => {
    const wf = new FakeWealthfolio([{ id: "inv", name: "Invest", currency: "GBP" }]);
    const rkt = () => Number(wf.holdings("inv").find((h) => h.instrument?.symbol === "RKT")?.quantity ?? 0);
    const importer = new ActivityImporter(wf.ctx);
    // As 2.6.2 sent it: a buy, then the consolidation pair as a SPLIT in GBX.
    const buy: ActivityImport = {
      id: "t212-order-1", accountId: "inv", activityType: "BUY" as ActivityImport["activityType"], date: "2023-01-10T10:00:00.000Z",
      symbol: "RKT", exchangeMic: "XLON", instrumentType: "EQUITY", quantity: 0.99155313, unitPrice: 5400, currency: "GBX", isValid: true, isDraft: false,
    };
    const split: ActivityImport = {
      id: "t212-split-GB00B24CGK77-202402010700", accountId: "inv", activityType: "SPLIT" as ActivityImport["activityType"], date: "2024-02-01T07:00:00.000Z",
      symbol: "RKT", exchangeMic: "XLON", instrumentType: "EQUITY", amount: 0.96, currency: "GBX", isValid: true, isDraft: false,
      comment: "Stock split: 0.99155313 → 0.951891 shares",
    };
    await importer.importRows([[buy], [split]]);
    expect(rkt()).toBeCloseTo(0.00951891, 8);

    const log: string[] = [];
    expect(await healSplitRatios(wf.ctx, new ActivityImporter(wf.ctx), "inv", log)).toBe(1);
    expect(rkt()).toBeCloseTo(0.951891, 6);
    expect(wf.rows("inv").filter((r) => r.activityType === "SPLIT")).toMatchObject([{ amount: 0.96, currency: "GBP" }]);
    expect(log.join("\n")).toContain("Fixed the RKT split of 2024-02-01");
    // Nothing left to fix.
    expect(await healSplitRatios(wf.ctx, new ActivityImporter(wf.ctx), "inv", [])).toBe(0);
  });
});
