import type { AddonContext } from "@wealthfolio/addon-sdk";
import { appendStep, markLastDone, type SyncProgress, type SyncStep } from "@wf-addons/kit";
import { useState } from "react";
import { runSync } from "../lib/sync";
import type { SyncPhaseId, SyncResult } from "../types";

interface SyncState {
  isSyncing: boolean;
  lastResult: SyncResult | null;
  error: string | null;
  progress: SyncProgress<SyncPhaseId> | null;
  steps: SyncStep<SyncPhaseId>[];
}

/** React wrapper around {@link runSync}: tracks progress, steps, result and error. */
export function useSync(ctx: AddonContext) {
  const [state, setState] = useState<SyncState>({
    isSyncing: false,
    lastResult: null,
    error: null,
    progress: null,
    steps: [],
  });

  async function sync() {
    setState((s) => ({ ...s, isSyncing: true, error: null, progress: null, steps: [] }));
    const onProgress = (p: SyncProgress<SyncPhaseId>) =>
      setState((s) => ({ ...s, progress: p, steps: appendStep(s.steps, p) }));
    try {
      const result = await runSync(ctx, onProgress);
      setState((s) => ({
        isSyncing: false,
        lastResult: result,
        error: null,
        progress: null,
        steps: markLastDone(s.steps),
      }));
    } catch (err) {
      setState((s) => ({ ...s, isSyncing: false, progress: null, error: (err as Error).message }));
    }
  }

  return { ...state, sync };
}
