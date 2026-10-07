/** A progress event emitted by a sync, rendered by `<SyncActivity>`. */
export interface SyncProgress<Phase extends string = string> {
  phase: Phase;
  message: string;
  current?: number;
  total?: number;
}

export interface SyncStep<Phase extends string = string> extends SyncProgress<Phase> {
  ts: string;
  status: "active" | "done";
}

/** Appends a progress event, coalescing consecutive duplicates and marking the prior step done. */
export function appendStep<P extends string>(prev: SyncStep<P>[], p: SyncProgress<P>, now = new Date()): SyncStep<P>[] {
  const last = prev[prev.length - 1];
  const incoming: SyncStep<P> = { ...p, ts: now.toISOString(), status: "active" };
  if (last && last.phase === p.phase && last.message === p.message) {
    return [...prev.slice(0, -1), { ...last, ...incoming }];
  }
  if (last) return [...prev.slice(0, -1), { ...last, status: "done" }, incoming];
  return [incoming];
}

/** Marks the final step done once a sync finishes. */
export function markLastDone<P extends string>(steps: SyncStep<P>[]): SyncStep<P>[] {
  if (steps.length === 0) return steps;
  return [...steps.slice(0, -1), { ...steps[steps.length - 1], status: "done" }];
}
