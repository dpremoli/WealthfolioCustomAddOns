import { describe, expect, it, vi } from "vitest";
import type { AddonContext, Holding } from "@wealthfolio/addon-sdk";
import { PortfolioUpdates, compareWithTrading212, trading212Cash, verificationLines } from "./verify";

const security = (symbol: string, quantity: number): Holding =>
  ({ holdingType: "security", instrument: { symbol }, quantity, localCurrency: "USD" }) as unknown as Holding;
const cashOf = (currency: string, quantity: number): Holding =>
  ({ holdingType: "cash", quantity, localCurrency: currency }) as unknown as Holding;

describe("compareWithTrading212", () => {
  const positions = [
    { ticker: "NVDA_US_EQ", symbol: "NVDA", quantity: 10.955 },
    { ticker: "CRWD_US_EQ", symbol: "CRWD", quantity: 0.69 },
  ];

  it("matches when quantities agree within rounding and all cash is in the account currency", () => {
    const v = compareWithTrading212({
      positions,
      cash: 1822.4,
      accountCurrency: "EUR",
      holdings: [security("NVDA", 10.95500003), security("CRWD", 0.69), cashOf("EUR", 1822.42)],
    });
    expect(v).toEqual({ ok: true, mismatches: [], positions: 2 });
  });

  it("lists every wrong position, extra position and cash difference", () => {
    const v = compareWithTrading212({
      positions: [...positions, { ticker: "XYZ_US_EQ", name: "Xyz Corp", symbol: null, quantity: 3 }],
      cash: 1822,
      accountCurrency: "EUR",
      holdings: [
        security("NVDA", 1.0955),
        security("LTC-EUR", 2),
        cashOf("EUR", 12810.11),
        cashOf("GBP", 3699),
      ],
    });
    expect(v.ok).toBe(false);
    expect(v.mismatches).toEqual([
      "XYZ_US_EQ (Xyz Corp): Trading 212 holds 3, but it did not match a Wealthfolio symbol.",
      "NVDA (NVDA_US_EQ): Trading 212 holds 10.955, Wealthfolio 1.0955.",
      "CRWD (CRWD_US_EQ): Trading 212 holds 0.69, Wealthfolio 0.",
      "LTC-EUR: Wealthfolio holds 2, Trading 212 none.",
      "Cash EUR: Trading 212 1822, Wealthfolio 12810.11.",
      "Cash GBP: Wealthfolio holds 3699, Trading 212 keeps all cash in EUR.",
    ]);
  });

  it("sums cross-listings that resolve to one symbol, and ignores an exchange suffix", () => {
    const v = compareWithTrading212({
      positions: [
        { ticker: "RR_GB_EQ", symbol: "RR.L", quantity: 5 },
        { ticker: "RRl_EQ", symbol: "RR.L", quantity: 2 },
      ],
      cash: 0,
      accountCurrency: "GBP",
      holdings: [security("RR", 7)],
    });
    expect(v.ok).toBe(true);
  });
});

describe("trading212Cash", () => {
  it("adds the available, reserved and in-pie cash", () => {
    expect(trading212Cash({ id: 1, currency: "EUR", cash: { availableToTrade: 1000.1, reservedForOrders: 2, inPies: 0.3 } })).toBe(
      1002.4,
    );
  });
});

describe("PortfolioUpdates", () => {
  function fakeEvents() {
    let start: () => void = () => {};
    let complete: () => void = () => {};
    const ctx = {
      api: {
        events: {
          portfolio: {
            onUpdateStart: async (h: () => void) => ((start = h), () => {}),
            onUpdateComplete: async (h: () => void) => ((complete = h), () => {}),
          },
        },
      },
    } as unknown as AddonContext;
    return { ctx, start: () => start(), complete: () => complete() };
  }

  it("waits for a recalculation that started after the import, ignoring one already running", async () => {
    vi.useFakeTimers();
    try {
      const e = fakeEvents();
      const updates = new PortfolioUpdates(e.ctx);
      await Promise.resolve();
      e.start(); // a recalculation already under way when the import lands…
      vi.advanceTimersByTime(10);
      const since = Date.now();
      const done = updates.settledAfter(since, 60_000);
      e.complete(); // …finishing does not count
      vi.advanceTimersByTime(1000);
      let settled: boolean | undefined;
      void done.then((v) => (settled = v));
      await vi.advanceTimersByTimeAsync(5000);
      expect(settled).toBeUndefined();
      e.start();
      e.complete();
      await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the timeout, and without the events API at once", async () => {
    vi.useFakeTimers();
    try {
      const updates = new PortfolioUpdates(fakeEvents().ctx);
      const done = updates.settledAfter(Date.now(), 20_000);
      await vi.advanceTimersByTimeAsync(20_001);
      expect(await done).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(await new PortfolioUpdates({ api: {} } as unknown as AddonContext).settledAfter(0, 1000)).toBe(false);
  });
});

describe("verificationLines", () => {
  const base = { positions: 2, checkedAt: "t", mismatches: ["Cash EUR: Trading 212 1, Wealthfolio 2."] };
  it("says whether it matched, and marks differences found before Wealthfolio settled as possibly temporary", () => {
    expect(verificationLines({ ...base, ok: true, mismatches: [], settled: true })).toEqual([
      "Matches Trading 212: 2 positions and the cash balance.",
    ]);
    expect(verificationLines({ ...base, ok: false, settled: true })[0]).toBe("Does not match Trading 212 (1 difference):");
    expect(verificationLines({ ...base, ok: false, settled: false })[0]).toMatch(/may be temporary/);
  });
});
