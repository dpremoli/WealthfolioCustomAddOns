import type { AddonContext, UnlistenFn } from "@wealthfolio/addon-sdk";

export interface BackgroundChecksOptions {
  /** Delay after the add-on loads before the first check, to stay out of the app's own startup. */
  startupDelayMs: number;
  /** How often to re-check while the app stays open. */
  intervalMs: number;
}

/**
 * Runs `tick` from the moment the add-on loads, in the background: once after `startupDelayMs`,
 * every `intervalMs`, and whenever Wealthfolio finishes refreshing its portfolio. `tick` decides
 * whether anything is due (most calls should be cheap no-ops) and must do its own error handling,
 * though a rejection is swallowed so a failing tick never escapes. The timers live inside the
 * add-on, so checks only happen while Wealthfolio is open. Call `stop` from `ctx.onDisable`.
 */
export function startBackgroundChecks(
  ctx: AddonContext,
  tick: (trigger: "startup" | "interval" | "portfolio-update") => Promise<void>,
  { startupDelayMs, intervalMs }: BackgroundChecksOptions,
): { stop: () => void } {
  let stopped = false;
  const unlisteners: UnlistenFn[] = [];
  const run = (trigger: "startup" | "interval" | "portfolio-update") => {
    if (!stopped) void tick(trigger).catch(() => {});
  };

  const startupTimer = setTimeout(() => run("startup"), startupDelayMs);
  const intervalTimer = setInterval(() => run("interval"), intervalMs);
  ctx.api.events.portfolio.onUpdateComplete(() => run("portfolio-update")).then(
    (un) => {
      if (stopped) un();
      else unlisteners.push(un);
    },
    () => {
      /* events unavailable: the startup and interval checks still cover us */
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
