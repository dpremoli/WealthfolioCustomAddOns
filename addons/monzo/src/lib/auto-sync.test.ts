import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEY_AUTO_SYNC, KEY_LAST_RUN, KEY_LAST_SYNC } from "../constants";
import { makeCtx } from "../test-utils";
import type { SyncResult } from "../types";
import { runExclusive } from "./busy";
import {
  CHECK_INTERVAL_MS,
  MIN_SYNC_GAP_MS,
  STARTUP_DELAY_MS,
  isDueForBackgroundSync,
  startAutoSync,
  type AutoSyncHandle,
} from "./auto-sync";
import { runSync, saveLastSyncView } from "./sync";

vi.mock("./sync", () => ({
  runSync: vi.fn(),
  saveLastSyncView: vi.fn(async () => {}),
}));

const NOW = new Date("2026-06-08T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 60 * 60 * 1000;

describe("isDueForBackgroundSync", () => {
  it("is never due before a first (manual) sync", () => {
    expect(isDueForBackgroundSync(null, null, NOW)).toBe(false);
    expect(isDueForBackgroundSync(undefined, ago(99 * HOUR), NOW)).toBe(false);
  });

  it("is due once the last run is at least the minimum gap old", () => {
    expect(isDueForBackgroundSync(ago(HOUR), ago(MIN_SYNC_GAP_MS - 1000), NOW)).toBe(false);
    expect(isDueForBackgroundSync(ago(HOUR), ago(MIN_SYNC_GAP_MS), NOW)).toBe(true);
  });

  it("falls back to the watermark when the last run was not recorded", () => {
    expect(isDueForBackgroundSync(ago(MIN_SYNC_GAP_MS + HOUR), null, NOW)).toBe(true);
    expect(isDueForBackgroundSync(ago(HOUR), null, NOW)).toBe(false);
  });

  it("ignores an unparseable timestamp", () => {
    expect(isDueForBackgroundSync("2026-01-01T00:00:00.000Z", "not-a-date", NOW)).toBe(false);
  });
});

describe("startAutoSync", () => {
  const runSyncMock = vi.mocked(runSync);
  const result: SyncResult = { imported: 1, skipped: 0, duplicates: 0, log: ["ok"] };
  let handle: AutoSyncHandle | undefined;

  function setup(opts: { lastSync?: string | null; lastRun?: string | null; autoSync?: boolean } = {}) {
    const t = makeCtx();
    const set = (k: string, v: unknown) => t.storage.set(k, JSON.stringify(v));
    if (opts.lastSync !== null) set(KEY_LAST_SYNC, opts.lastSync ?? ago(MIN_SYNC_GAP_MS + HOUR));
    if (opts.lastRun !== null) set(KEY_LAST_RUN, opts.lastRun ?? ago(MIN_SYNC_GAP_MS + HOUR));
    if (opts.autoSync !== undefined) set(KEY_AUTO_SYNC, opts.autoSync);
    const listeners: (() => void)[] = [];
    const api = t.ctx.api as unknown as Record<string, unknown>;
    api.events = {
      portfolio: { onUpdateComplete: vi.fn(async (cb: () => void) => (listeners.push(cb), () => {})) },
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    api.logger = logger;
    return { ...t, set, listeners, logger };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    runSyncMock.mockReset();
    runSyncMock.mockImplementation(async (_ctx, _progress, afterwards) => {
      await afterwards?.(result);
      return result;
    });
    vi.mocked(saveLastSyncView).mockClear();
  });

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    vi.useRealTimers();
  });

  it("syncs shortly after the add-on loads when the last sync is old enough", async () => {
    const t = setup();
    handle = startAutoSync(t.ctx);
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS - 1);
    expect(runSyncMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runSyncMock).toHaveBeenCalledTimes(1);
  });

  it("remembers the result for the dashboard", async () => {
    const t = setup();
    handle = startAutoSync(t.ctx);
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(saveLastSyncView).toHaveBeenCalledWith(t.ctx, expect.objectContaining({ result }));
  });

  it("does nothing after a recent sync, before a first sync, or when switched off", async () => {
    for (const opts of [
      { lastRun: ago(HOUR) },
      { lastSync: null, lastRun: null },
      { autoSync: false },
    ]) {
      const t = setup(opts);
      const h = startAutoSync(t.ctx);
      await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
      h.stop();
    }
    expect(runSyncMock).not.toHaveBeenCalled();
  });

  it("is on unless the setting says otherwise", async () => {
    const t = setup({ autoSync: true });
    handle = startAutoSync(t.ctx);
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(runSyncMock).toHaveBeenCalledTimes(1);
  });

  it("re-checks every hour while the app stays open", async () => {
    const t = setup({ lastRun: ago(HOUR) });
    handle = startAutoSync(t.ctx);
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(runSyncMock).not.toHaveBeenCalled();
    // The last run is 1h old; the gap is up at the 5h mark, found by the hourly check.
    await vi.advanceTimersByTimeAsync(MIN_SYNC_GAP_MS - 2 * HOUR);
    expect(runSyncMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(runSyncMock).toHaveBeenCalledTimes(1);
    expect(CHECK_INTERVAL_MS).toBe(HOUR);
  });

  it("waits out the gap after a failed attempt instead of retrying every hour", async () => {
    runSyncMock.mockRejectedValue(new Error("Monzo refused access"));
    const t = setup();
    handle = startAutoSync(t.ctx);
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(runSyncMock).toHaveBeenCalledTimes(1);
    expect(t.logger.error).toHaveBeenCalledWith(expect.stringContaining("Monzo refused access"));
    await vi.advanceTimersByTimeAsync(MIN_SYNC_GAP_MS - HOUR);
    expect(runSyncMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(runSyncMock).toHaveBeenCalledTimes(2);
  });

  it("leaves a sync or import that is already running alone", async () => {
    const t = setup();
    let release!: () => void;
    const running = runExclusive(() => new Promise<void>((r) => (release = r)));
    handle = startAutoSync(t.ctx);
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(runSyncMock).not.toHaveBeenCalled();
    release();
    await running;
  });

  it("checks when Wealthfolio finishes refreshing the portfolio", async () => {
    const t = setup({ lastRun: ago(HOUR) });
    handle = startAutoSync(t.ctx);
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    t.set(KEY_LAST_RUN, ago(MIN_SYNC_GAP_MS + HOUR));
    t.listeners.forEach((cb) => cb());
    await vi.advanceTimersByTimeAsync(0);
    expect(runSyncMock).toHaveBeenCalledTimes(1);
  });

  it("does not overlap with itself", async () => {
    let release!: () => void;
    runSyncMock.mockImplementation(() => new Promise<SyncResult>((r) => (release = () => r(result))));
    const t = setup();
    handle = startAutoSync(t.ctx);
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    t.listeners.forEach((cb) => cb());
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(runSyncMock).toHaveBeenCalledTimes(1);
    release();
  });

  it("stops: no timers or listeners fire afterwards", async () => {
    const t = setup();
    handle = startAutoSync(t.ctx);
    handle.stop();
    t.listeners.forEach((cb) => cb());
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 3 * CHECK_INTERVAL_MS);
    expect(runSyncMock).not.toHaveBeenCalled();
  });
});
