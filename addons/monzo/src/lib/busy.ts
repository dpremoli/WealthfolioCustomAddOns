/**
 * One sync or CSV import at a time. Both read an account and the shared import ledger before
 * writing, so two at once (e.g. started from different pages) would import transactions
 * twice. The flag is module-level on purpose: it spans every page and hook instance.
 */
export const BUSY_MESSAGE =
  "A sync or import is already running. Wait for it to finish, then try again.";

let busy = false;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());

/** Runs `job` unless another job is running, in which case it throws {@link BUSY_MESSAGE}. */
export async function runExclusive<T>(job: () => Promise<T>): Promise<T> {
  if (busy) throw new Error(BUSY_MESSAGE);
  busy = true;
  notify();
  try {
    return await job();
  } finally {
    busy = false;
    notify();
  }
}

export const isBusy = () => busy;

/** For React's `useSyncExternalStore`. */
export function subscribeBusy(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
