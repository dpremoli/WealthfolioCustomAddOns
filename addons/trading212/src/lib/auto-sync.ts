import type { AddonContext, UnlistenFn } from "@wealthfolio/addon-sdk";
import { getConnections, getSettings, getSyncState } from "../hooks/use-config";
import { runSyncAll } from "../hooks/use-sync";

// How often the scheduler re-checks whether any account is due while the app stays
// open — covers a long-running session crossing midnight into a new calendar day.
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly

// Small delay after the add-on loads before the first background sync, so it doesn't
// contend with the app's own startup work.
const STARTUP_DELAY_MS = 8000;

/** Local calendar-day key (YYYY-MM-DD) used to decide "already synced today". */
function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * True when a connection should be auto-synced in the background.
 *
 * A connection is due only if it has been synced before (`lastSync` set) *and* that
 * last sync was on an earlier calendar day. Requiring a prior sync keeps the first
 * sync — a multi-minute, rate-limited backfill for TRANSACTIONS accounts — a
 * deliberate manual action. The calendar-day gate yields at most one background sync
 * per day, which matches HOLDINGS snapshots being keyed by date (a same-day re-sync
 * would only overwrite the day's snapshot, so it's skipped).
 */
export function isDueForBackgroundSync(lastSync: string | null | undefined, now: Date): boolean {
  if (!lastSync) return false;
  const last = new Date(lastSync);
  if (Number.isNaN(last.getTime())) return false;
  return localDayKey(last) !== localDayKey(now);
}

/** Handle returned by {@link startAutoSync}. */
export interface AutoSyncHandle {
  stop: () => void;
}

/**
 * Starts the background auto-sync scheduler. Runs the moment the add-on loads (so it
 * works regardless of which page the user is on), re-checks hourly while the app
 * stays open, and piggybacks on Wealthfolio's own portfolio refreshes. Each trigger
 * syncs only the accounts that are *due* (see {@link isDueForBackgroundSync}); a
 * same-day trigger is a cheap no-op. Honours the `autoSync` setting (opt-out).
 *
 * Background runs never confirm a tracking-mode switch, so a drifted account is
 * skipped rather than having its data cleared without the user's say-so.
 */
export function startAutoSync(ctx: AddonContext): AutoSyncHandle {
  let stopped = false;
  let running = false; // re-entrancy guard so overlapping triggers don't double-sync
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let intervalTimer: ReturnType<typeof setInterval> | undefined;
  const unlisteners: UnlistenFn[] = [];

  async function tick(trigger: string): Promise<void> {
    if (stopped || running) return;
    try {
      const settings = await getSettings(ctx);
      if (settings?.autoSync === false) return; // user opted out

      const connections = await getConnections(ctx);
      const now = new Date();
      const dueIds = new Set<string>();
      for (const conn of connections) {
        const { lastSync } = await getSyncState(ctx, conn.id);
        if (isDueForBackgroundSync(lastSync, now)) dueIds.add(conn.id);
      }
      if (dueIds.size === 0) return;

      running = true;
      const result = await runSyncAll(ctx, { onlyConnectionIds: dueIds });
      const refreshed = result.perAccount.filter((r) => !r.error).length;
      if (refreshed > 0) {
        ctx.api.logger.info(`[auto-sync] ${trigger}: refreshed ${refreshed} account(s).`);
      }
    } catch (e) {
      ctx.api.logger.error(`[auto-sync] ${trigger} failed: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  }

  // 1. On load / app open.
  startupTimer = setTimeout(() => void tick("startup"), STARTUP_DELAY_MS);

  // 2. Periodic re-check while the app stays open.
  intervalTimer = setInterval(() => void tick("interval"), CHECK_INTERVAL_MS);

  // 3. Piggyback on Wealthfolio's own portfolio refreshes. The due-gate keeps this
  //    from re-firing repeatedly: once today's sync lands, the account isn't due
  //    again until tomorrow, so a snapshot-triggered portfolio update is a no-op.
  ctx.api.events.portfolio.onUpdateComplete(() => void tick("portfolio-update")).then(
    (un) => {
      if (stopped) un();
      else unlisteners.push(un);
    },
    () => {
      /* events unavailable — startup + interval triggers still cover us */
    },
  );

  return {
    stop: () => {
      stopped = true;
      if (startupTimer) clearTimeout(startupTimer);
      if (intervalTimer) clearInterval(intervalTimer);
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
