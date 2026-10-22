import type { AddonContext } from "@wealthfolio/addon-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBackgroundChecks } from "./scheduler";

const OPTS = { startupDelayMs: 8000, intervalMs: 3_600_000 };

function setup(onUpdateComplete?: (cb: () => void) => Promise<() => void>) {
  const listeners: (() => void)[] = [];
  const unlisten = vi.fn();
  const subscribe =
    onUpdateComplete ??
    (async (cb: () => void) => {
      listeners.push(cb);
      return unlisten;
    });
  const ctx = { api: { events: { portfolio: { onUpdateComplete: vi.fn(subscribe) } } } } as unknown as AddonContext;
  return { ctx, listeners, unlisten };
}

describe("startBackgroundChecks", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("checks after the startup delay, then hourly, naming the trigger", async () => {
    const t = setup();
    const tick = vi.fn(async () => {});
    const h = startBackgroundChecks(t.ctx, tick, OPTS);
    await vi.advanceTimersByTimeAsync(OPTS.startupDelayMs - 1);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenLastCalledWith("startup");
    await vi.advanceTimersByTimeAsync(OPTS.intervalMs);
    expect(tick).toHaveBeenLastCalledWith("interval");
    h.stop();
  });

  it("checks when Wealthfolio finishes refreshing the portfolio", async () => {
    const t = setup();
    const tick = vi.fn(async () => {});
    const h = startBackgroundChecks(t.ctx, tick, OPTS);
    await vi.advanceTimersByTimeAsync(0);
    t.listeners.forEach((cb) => cb());
    expect(tick).toHaveBeenLastCalledWith("portfolio-update");
    h.stop();
  });

  it("stop cancels the timers and the listener", async () => {
    const t = setup();
    const tick = vi.fn(async () => {});
    const h = startBackgroundChecks(t.ctx, tick, OPTS);
    await vi.advanceTimersByTimeAsync(0);
    h.stop();
    expect(t.unlisten).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(OPTS.startupDelayMs + 3 * OPTS.intervalMs);
    expect(tick).not.toHaveBeenCalled();
  });

  it("unlistens a subscription that resolves only after stop", async () => {
    let resolve!: (un: () => void) => void;
    const un = vi.fn();
    const t = setup(() => new Promise((r) => (resolve = r)));
    const h = startBackgroundChecks(t.ctx, vi.fn(async () => {}), OPTS);
    h.stop();
    resolve(un);
    await vi.advanceTimersByTimeAsync(0);
    expect(un).toHaveBeenCalled();
  });

  it("carries on with the timers when events are unavailable, and survives a failing tick", async () => {
    const t = setup(async () => Promise.reject(new Error("no events")));
    const tick = vi.fn(async () => {
      throw new Error("boom");
    });
    const h = startBackgroundChecks(t.ctx, tick, OPTS);
    await vi.advanceTimersByTimeAsync(OPTS.startupDelayMs);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(OPTS.intervalMs);
    expect(tick).toHaveBeenCalledTimes(2);
    h.stop();
  });
});
