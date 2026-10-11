import type { AddonContext } from "@wealthfolio/addon-sdk";
import { appendStep, markLastDone, type SyncProgress, type SyncStep } from "@wf-addons/kit";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BUSY_MESSAGE, isBusy, subscribeBusy } from "../lib/busy";
import { loadLastSyncView, runSync, saveLastSyncView } from "../lib/sync";
import type { SyncPhaseId, SyncResult } from "../types";

interface SyncState {
  isSyncing: boolean;
  lastResult: SyncResult | null;
  error: string | null;
  progress: SyncProgress<SyncPhaseId> | null;
  steps: SyncStep<SyncPhaseId>[];
}

/**
 * React wrapper around {@link runSync}: tracks progress, steps, result and error. With
 * `restore`, the last successful sync's result and steps are shown again on mount, and again
 * when a run started elsewhere (another page) finishes. `isSyncing` is also true while such
 * a run is in flight.
 */
export function useSync(ctx: AddonContext, opts: { restore?: boolean } = {}) {
  const [state, setState] = useState<SyncState>({
    isSyncing: false,
    lastResult: null,
    error: null,
    progress: null,
    steps: [],
  });
  const busy = useSyncExternalStore(subscribeBusy, isBusy);
  const ranHere = useRef(false);
  const wasBusy = useRef(busy);

  // A run started elsewhere just finished: show its saved result.
  useEffect(() => {
    const finished = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (!finished || !opts.restore || ranHere.current) return;
    let unmounted = false;
    loadLastSyncView(ctx)
      .then((view) => {
        if (unmounted || ranHere.current || !view) return;
        // Never over a sync of this hook's own, or over the error one just ended with.
        setState((s) =>
          s.isSyncing || (s.error && s.error !== BUSY_MESSAGE)
            ? s
            : { ...s, lastResult: view.result, steps: view.steps, error: null }
        );
      })
      .catch(() => {});
    return () => {
      unmounted = true;
    };
  }, [busy]);

  useEffect(() => {
    if (!opts.restore) return;
    let unmounted = false;
    loadLastSyncView(ctx)
      .then((view) => {
        if (unmounted || !view) return;
        // Not over a sync the user started meanwhile, or anything already on screen.
        setState((s) =>
          s.isSyncing || s.lastResult || s.steps.length > 0 || s.error
            ? s
            : { ...s, lastResult: view.result, steps: view.steps }
        );
      })
      .catch(() => {});
    return () => {
      unmounted = true;
    };
    // Once, on mount.
  }, []);

  async function sync() {
    ranHere.current = true;
    setState((s) => ({ ...s, isSyncing: true, error: null, progress: null, steps: [] }));
    // The same step list the state holds, kept here too so it can be saved when done.
    let steps: SyncStep<SyncPhaseId>[] = [];
    const onProgress = (p: SyncProgress<SyncPhaseId>) => {
      steps = appendStep(steps, p);
      setState((s) => ({ ...s, progress: p, steps: appendStep(s.steps, p) }));
    };
    try {
      const result = await runSync(ctx, onProgress, async (r) => {
        steps = markLastDone(steps);
        await saveLastSyncView(ctx, { result: r, steps });
      });
      setState((s) => ({
        isSyncing: false,
        lastResult: result,
        error: null,
        progress: null,
        steps: markLastDone(s.steps),
      }));
    } catch (err) {
      setState((s) => ({ ...s, isSyncing: false, progress: null, error: (err as Error).message }));
    } finally {
      ranHere.current = false;
    }
  }

  // While a run started elsewhere is in flight, the steps held here are an older sync's:
  // showing them next to a spinner would pass them off as this run's progress.
  const elsewhere = busy && !state.isSyncing;
  return {
    ...state,
    steps: elsewhere ? [] : state.steps,
    isSyncing: state.isSyncing || busy,
    sync,
  };
}
