import type { AddonContext } from "@wealthfolio/addon-sdk";
import { appendStep, jsonStore, markLastDone, startBackgroundChecks, type SyncStep } from "@wf-addons/kit";
import {
  KEY_AUTO_SYNC,
  KEY_AUTO_SYNC_ERROR,
  KEY_LAST_RUN,
  KEY_LAST_SYNC,
  KEY_RECHECKED_90_DAYS,
} from "../constants";
import type { SyncPhaseId } from "../types";
import { BUSY_MESSAGE, isBusy } from "./busy";
import { ensureMigrated } from "./migrate";
import { runSync, saveLastSyncView } from "./sync";

/** How often the scheduler re-checks whether a sync is due while the app stays open. */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Delay after the add-on loads before the first check, so it stays out of the app's own startup. */
export const STARTUP_DELAY_MS = 8000;

/**
 * The least time between two background syncs (and the wait after a failed one). Monzo
 * transactions arrive all day, but a handful of syncs a day is plenty for a spending view and
 * keeps the add-on a polite API client.
 */
export const MIN_SYNC_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * When a background sync is next due, in ms since the epoch, or null before a first (manual)
 * sync: that one stays a deliberate action, since it is the one that reads all history and may
 * need approving in the Monzo app. After that a sync is due `MIN_SYNC_GAP_MS` after the last
 * run (the watermark stands in when the run time was not recorded).
 */
export function nextBackgroundSyncAt(
  lastSync: string | null | undefined,
  lastRun: string | null | undefined,
): number | null {
  if (!lastSync) return null;
  const last = Date.parse(lastRun ?? lastSync);
  return Number.isNaN(last) ? null : last + MIN_SYNC_GAP_MS;
}

/** Whether a background sync is due at `now` (see {@link nextBackgroundSyncAt}). */
export function isDueForBackgroundSync(
  lastSync: string | null | undefined,
  lastRun: string | null | undefined,
  now: Date,
): boolean {
  const due = nextBackgroundSyncAt(lastSync, lastRun);
  return due !== null && now.getTime() >= due;
}

/** Handle returned by {@link startAutoSync}. */
export interface AutoSyncHandle {
  stop: () => void;
}

/**
 * Starts the background sync scheduler (kit `startBackgroundChecks`): shortly after the add-on
 * loads, hourly, and whenever Wealthfolio finishes refreshing the portfolio, only while
 * Wealthfolio is open. Each check syncs only if one is due (see {@link isDueForBackgroundSync}),
 * so most are no-ops, and once it knows when the next one is due it does not even read storage
 * until then. Honours the `monzo_auto_sync` setting (on unless switched off). It never starts a
 * run the user's own sync or CSV import is already in, leaves the one-off 90-day re-check an
 * older version needs to a manual sync, and after a failure waits out {@link MIN_SYNC_GAP_MS}
 * instead of retrying every hour (an expired login, or a connection Monzo wants approved in its
 * app, would otherwise be retried all day). The reason is kept under `monzo_auto_sync_error` for
 * the dashboard and settings to show.
 */
export function startAutoSync(ctx: AddonContext): AutoSyncHandle {
  let stopped = false;
  let running = false;
  let notBefore = 0;

  async function tick(trigger: string): Promise<void> {
    if (stopped || running || isBusy() || Date.now() < notBefore) return;
    running = true;
    const store = jsonStore(ctx.api.storage);
    try {
      await ensureMigrated(ctx);
      if ((await store.get<boolean>(KEY_AUTO_SYNC, true)) === false) return;
      const lastSync = await store.get<string | null>(KEY_LAST_SYNC, null);
      const lastRun = await store.get<string | null>(KEY_LAST_RUN, null);
      const due = nextBackgroundSyncAt(lastSync, lastRun);
      if (due === null) return;
      if (Date.now() < due) {
        notBefore = due;
        return;
      }
      if (!(await store.get<boolean>(KEY_RECHECKED_90_DAYS, false))) return;
      // Re-checked after every await: the add-on may have been disabled, or a manual run started.
      if (stopped || isBusy()) return;

      let steps: SyncStep<SyncPhaseId>[] = [];
      const result = await runSync(
        ctx,
        (p) => {
          steps = appendStep(steps, p);
        },
        async (r) => {
          steps = markLastDone(steps);
          await saveLastSyncView(ctx, { result: r, steps });
        },
      );
      await store.delete(KEY_AUTO_SYNC_ERROR).catch(() => {});
      ctx.api.logger.info(`[auto-sync] ${trigger}: ${result.imported} imported.`);
    } catch (err) {
      const message = (err as Error).message;
      // A manual sync that took the lock in between is not a failure, and needs no back-off.
      if (message === BUSY_MESSAGE) return;
      notBefore = Date.now() + MIN_SYNC_GAP_MS;
      ctx.api.logger.error(`[auto-sync] ${trigger} failed: ${message}`);
      await store
        .set(KEY_AUTO_SYNC_ERROR, { at: new Date().toISOString(), message })
        .catch(() => {});
    } finally {
      running = false;
    }
  }

  const checks = startBackgroundChecks(ctx, tick, {
    startupDelayMs: STARTUP_DELAY_MS,
    intervalMs: CHECK_INTERVAL_MS,
  });
  return {
    stop: () => {
      stopped = true;
      checks.stop();
    },
  };
}

/**
 * Why the last background sync failed, or null: nothing failed, or a sync (of any kind) has
 * succeeded since (`lastRun`, ISO). For the dashboard and settings to show.
 */
export async function loadAutoSyncError(
  ctx: AddonContext,
  lastRun: string | null | undefined,
): Promise<{ at: string; message: string } | null> {
  const e = await jsonStore(ctx.api.storage).get<{ at?: string; message?: string } | null>(
    KEY_AUTO_SYNC_ERROR,
    null,
  );
  if (!e?.at || !e.message) return null;
  return lastRun && Date.parse(lastRun) >= Date.parse(e.at) ? null : { at: e.at, message: e.message };
}
