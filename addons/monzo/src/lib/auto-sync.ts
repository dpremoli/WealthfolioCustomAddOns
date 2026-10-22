import type { AddonContext, UnlistenFn } from "@wealthfolio/addon-sdk";
import { appendStep, jsonStore, markLastDone, type SyncStep } from "@wf-addons/kit";
import { KEY_AUTO_SYNC, KEY_LAST_RUN, KEY_LAST_SYNC } from "../constants";
import type { SyncPhaseId } from "../types";
import { isBusy } from "./busy";
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
 * Whether a background sync is due. Only once there has been a first sync (the watermark
 * exists): that one stays a deliberate manual action, since it is the one that reads all history
 * and may need approving in the Monzo app. After that, due once the last run is `MIN_SYNC_GAP_MS`
 * old (the watermark stands in when the run time was not recorded).
 */
export function isDueForBackgroundSync(
  lastSync: string | null | undefined,
  lastRun: string | null | undefined,
  now: Date,
): boolean {
  if (!lastSync) return false;
  const last = Date.parse(lastRun ?? lastSync);
  if (Number.isNaN(last)) return false;
  return now.getTime() - last >= MIN_SYNC_GAP_MS;
}

/** Handle returned by {@link startAutoSync}. */
export interface AutoSyncHandle {
  stop: () => void;
}

/**
 * Starts the background sync scheduler. It runs from the moment the add-on loads (whatever
 * page is open) and only while Wealthfolio is open: shortly after load, hourly, and whenever
 * Wealthfolio finishes refreshing the portfolio. Each trigger syncs only if one is due (see
 * {@link isDueForBackgroundSync}), so most are no-ops. Honours the `monzo_auto_sync` setting
 * (on unless switched off), never overlaps another sync or CSV import, and after a failure
 * waits out {@link MIN_SYNC_GAP_MS} instead of retrying every hour (a connection Monzo wants
 * approved in its app, or an expired login, would otherwise be retried all day). Failures are
 * logged, never shown: the dashboard keeps the last good result.
 */
export function startAutoSync(ctx: AddonContext): AutoSyncHandle {
  let stopped = false;
  let running = false;
  let retryAt = 0;
  const unlisteners: UnlistenFn[] = [];

  async function tick(trigger: string): Promise<void> {
    if (stopped || running || isBusy()) return;
    running = true;
    try {
      await ensureMigrated(ctx);
      const store = jsonStore(ctx.api.storage);
      if ((await store.get<boolean>(KEY_AUTO_SYNC, true)) === false) return;
      const now = new Date();
      if (now.getTime() < retryAt) return;
      const lastSync = await store.get<string | null>(KEY_LAST_SYNC, null);
      const lastRun = await store.get<string | null>(KEY_LAST_RUN, null);
      if (!isDueForBackgroundSync(lastSync, lastRun, now)) return;

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
      ctx.api.logger.info(`[auto-sync] ${trigger}: ${result.imported} imported.`);
    } catch (err) {
      retryAt = Date.now() + MIN_SYNC_GAP_MS;
      ctx.api.logger.error(`[auto-sync] ${trigger} failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }

  const startupTimer = setTimeout(() => void tick("startup"), STARTUP_DELAY_MS);
  const intervalTimer = setInterval(() => void tick("interval"), CHECK_INTERVAL_MS);
  ctx.api.events.portfolio.onUpdateComplete(() => void tick("portfolio-update")).then(
    (un) => {
      if (stopped) un();
      else unlisteners.push(un);
    },
    () => {
      /* events unavailable: the startup and hourly checks still cover us */
    },
  );

  return {
    stop: () => {
      stopped = true;
      clearTimeout(startupTimer);
      clearInterval(intervalTimer);
      for (const un of unlisteners) {
        try {
          un();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
