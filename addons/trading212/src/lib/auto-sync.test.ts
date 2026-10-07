import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isDueForBackgroundSync, startAutoSync, type AutoSyncHandle } from "./auto-sync";
import { runSyncAll } from "../hooks/use-sync";

// Replace the real sync with a spy so the scheduler tests observe *which* connections
// it's asked to sync without performing any network work.
vi.mock("../hooks/use-sync", () => ({
  runSyncAll: vi.fn(async () => ({
    perAccount: [],
    totals: { imported: 0, duplicates: 0, unresolved: 0 },
  })),
}));

const STARTUP_DELAY_MS = 8000;

describe("isDueForBackgroundSync", () => {
  // Build dates from local components so the calendar-day comparison is timezone-stable.
  const now = new Date(2026, 5, 8, 9, 0, 0); // local 2026-06-08 09:00
  const iso = (d: Date) => d.toISOString();

  it("is not due when the account was never synced", () => {
    expect(isDueForBackgroundSync(null, now)).toBe(false);
    expect(isDueForBackgroundSync(undefined, now)).toBe(false);
  });

  it("is not due when already synced earlier the same day", () => {
    expect(isDueForBackgroundSync(iso(new Date(2026, 5, 8, 1, 0, 0)), now)).toBe(false);
  });

  it("is due when the last sync was a previous calendar day", () => {
    expect(isDueForBackgroundSync(iso(new Date(2026, 5, 7, 23, 30, 0)), now)).toBe(true);
  });

  it("ignores an unparseable timestamp", () => {
    expect(isDueForBackgroundSync("not-a-date", now)).toBe(false);
  });
});

describe("startAutoSync scheduler", () => {
  const runSyncAllMock = vi.mocked(runSyncAll);
  let handle: AutoSyncHandle | undefined;

  function makeCtx(opts: {
    autoSync?: boolean;
    connections: { id: string; needsCredentials?: boolean }[];
    lastSyncByConn: Record<string, string | null>;
  }) {
    const storage = new Map<string, string>([
      ["t212_settings", JSON.stringify({ env: "demo", autoSync: opts.autoSync })],
      [
        "t212_connections",
        JSON.stringify(opts.connections.map((c) => ({ ...c, name: c.id, accountId: `acc-${c.id}` }))),
      ],
    ]);
    for (const c of opts.connections) {
      storage.set(`t212_sync_${c.id}`, JSON.stringify({ lastSync: opts.lastSyncByConn[c.id] ?? null, importedRefs: [] }));
    }
    const kv = (m: Map<string, string>) => ({
      get: async (k: string) => m.get(k) ?? null,
      set: async (k: string, v: string) => void m.set(k, v),
      delete: async (k: string) => void m.delete(k),
    });
    return {
      api: {
        storage: kv(storage),
        secrets: kv(new Map()), // empty keyring: nothing to migrate
        logger: { info: vi.fn(), error: vi.fn() },
        events: { portfolio: { onUpdateComplete: vi.fn(async () => () => {}) } },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    runSyncAllMock.mockClear();
  });

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    vi.useRealTimers();
  });

  it("syncs only the connections that are due (skips today's and never-synced)", async () => {
    const yesterday = new Date(2026, 5, 7, 12, 0, 0).toISOString();
    const today = new Date().toISOString();
    const ctx = makeCtx({
      connections: [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
      lastSyncByConn: { c1: yesterday, c2: today, c3: null },
    });

    handle = startAutoSync(ctx);
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);

    expect(runSyncAllMock).toHaveBeenCalledTimes(1);
    const ids = runSyncAllMock.mock.calls[0][1]?.onlyConnectionIds;
    expect([...(ids ?? [])]).toEqual(["c1"]);
  });

  it("does nothing when auto-sync is disabled", async () => {
    const ctx = makeCtx({
      autoSync: false,
      connections: [{ id: "c1" }],
      lastSyncByConn: { c1: new Date(2026, 5, 7, 12, 0, 0).toISOString() },
    });

    handle = startAutoSync(ctx);
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);

    expect(runSyncAllMock).not.toHaveBeenCalled();
  });

  it("does nothing when no connection is due", async () => {
    const ctx = makeCtx({
      connections: [{ id: "c1" }],
      lastSyncByConn: { c1: new Date().toISOString() },
    });

    handle = startAutoSync(ctx);
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);

    expect(runSyncAllMock).not.toHaveBeenCalled();
  });

  it("skips connections that still need credentials (legacy single key)", async () => {
    const yesterday = new Date(2026, 5, 7, 12, 0, 0).toISOString();
    const ctx = makeCtx({
      connections: [{ id: "c1", needsCredentials: true }, { id: "c2" }],
      lastSyncByConn: { c1: yesterday, c2: yesterday },
    });

    handle = startAutoSync(ctx);
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);

    expect(runSyncAllMock).toHaveBeenCalledTimes(1);
    expect([...(runSyncAllMock.mock.calls[0][1]?.onlyConnectionIds ?? [])]).toEqual(["c2"]);
  });
});
