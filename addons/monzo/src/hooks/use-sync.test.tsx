import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  KEY_EXPIRES_AT,
  KEY_LAST_RESULT,
  KEY_MAPPING,
  SECRET_ACCESS_TOKEN,
} from "../constants";
import { saveLastSyncView, type LastSyncView } from "../lib/sync";
import { json, makeCtx, tx } from "../test-utils";
import { useSync } from "./use-sync";

const MONZO_ACC = "acc_00001";
const WF_ACC = "wf-1";

const saved: LastSyncView = {
  result: { imported: 7, skipped: 0, duplicates: 2, log: ["from last time"] },
  steps: [{ phase: "done", message: "Synced 7 transactions.", ts: "2026-05-01T12:00:00.000Z", status: "done" }],
};

/** A connected add-on whose Monzo has one transaction; `fail` makes the transactions call fail. */
function setup(opts: { fail?: boolean; gate?: Promise<void> } = {}) {
  const t = makeCtx({
    wfAccounts: [{ id: WF_ACC, name: "Monzo Current" }],
    handler: async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/accounts") return json(200, { accounts: [{ id: MONZO_ACC, type: "uk_retail" }] });
      await opts.gate;
      return opts.fail ? json(400, { code: "bad_request" }) : json(200, { transactions: [tx()] });
    },
  });
  t.secrets.set(SECRET_ACCESS_TOKEN, "acc");
  t.storage.set(KEY_EXPIRES_AT, String(Date.now() + 3_600_000));
  t.storage.set(KEY_MAPPING, JSON.stringify({ [MONZO_ACC]: WF_ACC }));
  return t;
}

describe("useSync", () => {
  it("shows the saved view again when asked to restore", async () => {
    const t = setup();
    await saveLastSyncView(t.ctx, saved);
    const { result } = renderHook(() => useSync(t.ctx, { restore: true }));
    await waitFor(() => expect(result.current.lastResult).toEqual(saved.result));
    expect(result.current.steps).toEqual(saved.steps);
    expect(result.current.isSyncing).toBe(false);
  });

  it("does not restore unless asked to", async () => {
    const t = setup();
    await saveLastSyncView(t.ctx, saved);
    const { result } = renderHook(() => useSync(t.ctx));
    await act(async () => {});
    expect(result.current.lastResult).toBeNull();
    expect(result.current.steps).toEqual([]);
  });

  it("saves a successful sync, and a fresh mount restores it", async () => {
    const t = setup();
    const first = renderHook(() => useSync(t.ctx, { restore: true }));
    await act(async () => {
      await first.result.current.sync();
    });
    expect(first.result.current.lastResult?.imported).toBe(1);
    const steps = first.result.current.steps;
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => s.status === "done")).toBe(true);
    first.unmount();

    const second = renderHook(() => useSync(t.ctx, { restore: true }));
    await waitFor(() => expect(second.result.current.lastResult?.imported).toBe(1));
    expect(second.result.current.steps.map((s) => s.message)).toEqual(steps.map((s) => s.message));
    expect(second.result.current.steps.every((s) => s.status === "done")).toBe(true);
  });

  it("keeps the saved view when a later sync fails", async () => {
    const t = setup({ fail: true });
    await saveLastSyncView(t.ctx, saved);
    const before = t.storage.get(KEY_LAST_RESULT);
    const { result } = renderHook(() => useSync(t.ctx, { restore: true }));
    await act(async () => {
      await result.current.sync();
    });
    expect(result.current.error).toBeTruthy();
    expect(t.storage.get(KEY_LAST_RESULT)).toBe(before);
  });

  it("keeps a failed sync's error on screen instead of restoring the older result over it", async () => {
    const t = setup({ fail: true });
    await saveLastSyncView(t.ctx, saved);
    const { result } = renderHook(() => useSync(t.ctx, { restore: true }));
    await waitFor(() => expect(result.current.lastResult).toEqual(saved.result));
    await act(async () => {
      await result.current.sync();
    });
    // Give the busy -> idle effect and any storage read it starts time to settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(result.current.error).toBeTruthy();
  });

  it("does not show a stale step list as progress while a run started elsewhere is in flight", async () => {
    let release!: () => void;
    const t = setup({ gate: new Promise<void>((r) => (release = r)) });
    await saveLastSyncView(t.ctx, saved);
    const first = renderHook(() => useSync(t.ctx));
    const second = renderHook(() => useSync(t.ctx, { restore: true }));
    await waitFor(() => expect(second.result.current.steps).toEqual(saved.steps));
    let running!: Promise<void>;
    act(() => {
      running = first.result.current.sync();
    });
    await waitFor(() => expect(second.result.current.isSyncing).toBe(true));
    expect(second.result.current.steps).toEqual([]);
    release();
    await act(async () => {
      await running;
    });
    await waitFor(() => expect(second.result.current.steps.length).toBeGreaterThan(0));
  });

  it("reports a sync started by another hook instance, and shows its result when it finishes", async () => {
    let release!: () => void;
    const t = setup({ gate: new Promise<void>((r) => (release = r)) });
    await saveLastSyncView(t.ctx, saved);
    // E.g. Settings starts the sync while the dashboard is (or later becomes) mounted.
    const first = renderHook(() => useSync(t.ctx));
    const second = renderHook(() => useSync(t.ctx, { restore: true }));
    await waitFor(() => expect(second.result.current.lastResult).toEqual(saved.result));
    expect(second.result.current.isSyncing).toBe(false);

    let running!: Promise<void>;
    act(() => {
      running = first.result.current.sync();
    });
    await waitFor(() => expect(second.result.current.isSyncing).toBe(true));
    expect(first.result.current.isSyncing).toBe(true);
    // The second one did not run it, so it has no progress of its own to show.
    expect(second.result.current.steps).toEqual([]);

    release();
    await act(async () => {
      await running;
    });
    await waitFor(() => expect(second.result.current.isSyncing).toBe(false));
    await waitFor(() => expect(second.result.current.lastResult?.imported).toBe(1));
    expect(second.result.current.steps.length).toBeGreaterThan(0);
    expect(second.result.current.steps.every((s) => s.status === "done")).toBe(true);
    expect(first.result.current.isSyncing).toBe(false);
  });

  it("does not run a second sync at the same time", async () => {
    let release!: () => void;
    const t = setup({ gate: new Promise<void>((r) => (release = r)) });
    const first = renderHook(() => useSync(t.ctx));
    const second = renderHook(() => useSync(t.ctx));
    let running!: Promise<void>;
    act(() => {
      running = first.result.current.sync();
    });
    await waitFor(() => expect(second.result.current.isSyncing).toBe(true));
    await act(async () => {
      await second.result.current.sync();
    });
    expect(second.result.current.error).toMatch(/already running/);
    release();
    await act(async () => {
      await running;
    });
    expect(first.result.current.lastResult?.imported).toBe(1);
    expect(t.importCalls).toHaveLength(1);
  });
});
