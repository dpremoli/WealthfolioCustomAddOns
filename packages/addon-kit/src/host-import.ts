import type { ActivityImport, ImportActivitiesResult } from "@wealthfolio/addon-sdk";
import type { ImportLedger } from "./reconcile";

/**
 * Reading what Wealthfolio 3.11's `activities.import` actually stored.
 *
 * The call answers HTTP 200 even when it saves nothing: if any row fails its validation it
 * returns `summary.success: false`, `imported: 0`, an empty `importRunId` and stores NONE of the
 * call's rows (the reasons are on the returned rows as `isValid: false` + `errors`). A row its
 * writer policy refuses is returned `isValid: false` while the others are stored. So a row counts
 * as imported only when the answer says the host stored it; recording an id as imported for a
 * row that was merely sent makes every later sync skip it for good.
 */

/** A row the host did not store, with its reason. */
export interface UnsavedRow {
  activity: ActivityImport;
  reason: string;
}

export interface ImportRead {
  /** Rows the host stored. */
  stored: ActivityImport[];
  /** Rows the host answered with as already there (`duplicateOfId`): not stored by this call. */
  duplicates: ActivityImport[];
  /** Rows not stored, with the host's reason. */
  unsaved: UnsavedRow[];
  /**
   * Positions (in the rows sent) of the rows the host marked invalid in a call that stored
   * nothing: what made the call fail. Retrying without them can store the rest.
   */
  refused: number[];
}

type Summary = Partial<ImportActivitiesResult["summary"]> & { errorMessage?: string };

/** The reasons the host put on a returned row (`errors`, then `warnings`). */
export function reasonOf(row: Pick<ActivityImport, "errors" | "warnings"> | undefined): string {
  const msgs = [...Object.values(row?.errors ?? {}), ...Object.values(row?.warnings ?? {})].flat();
  return msgs.length > 0 ? [...new Set(msgs)].join("; ") : "invalid (no reason given)";
}

/**
 * Which of the `sent` rows the host stored, from its answer.
 *
 * - With a row-by-row answer (`res.activities` as long as `sent`), a row is stored when it is not
 *   `isValid: false` and not a duplicate; the host's own count (`summary.imported`) must equal
 *   the rows marked stored, otherwise nothing is trusted (the rows are reported unsaved: the next
 *   sync finds what is really there by content, so none is imported twice).
 * - With no row-by-row answer, only a count equal to what was sent proves every row stored.
 * - A call with `success: false` or `imported: 0` stored nothing; its invalid rows are in `refused`.
 */
export function readImportResult(sent: ActivityImport[], res: ImportActivitiesResult): ImportRead {
  const rows = res.activities ?? [];
  const summary = (res.summary ?? {}) as Summary;
  const perRow = rows.length === sent.length;
  const none = (reason: string, refused: number[] = []): ImportRead => ({
    stored: [],
    duplicates: [],
    unsaved: sent.map((activity, i) => ({ activity, reason: perRow && refused.includes(i) ? reasonOf(rows[i]) : reason })),
    refused,
  });

  if (summary.success === false || (summary.imported ?? 0) === 0) {
    const refused = perRow ? rows.flatMap((r, i) => (r.isValid === false ? [i] : [])) : [];
    // Rows the host reported as already there are not unsaved; without any, nothing was stored.
    if (perRow && refused.length === 0 && rows.every((r) => isDuplicate(r)) && sent.length > 0 && summary.success !== false) {
      return { stored: [], duplicates: [...sent], unsaved: [], refused };
    }
    const why =
      refused.length > 0
        ? `left out with the rows Wealthfolio refused (${reasonOf(rows[refused[0]])})`
        : summary.errorMessage
          ? `Wealthfolio saved nothing: ${summary.errorMessage}`
          : "Wealthfolio saved nothing and gave no reason";
    return none(why, refused);
  }

  const imported = summary.imported ?? 0;
  if (!perRow) {
    if (imported === sent.length) return { stored: [...sent], duplicates: [], unsaved: [], refused: [] };
    return none(`Wealthfolio reported ${imported} of ${sent.length} rows stored without saying which`);
  }

  const stored: ActivityImport[] = [];
  const duplicates: ActivityImport[] = [];
  const unsaved: UnsavedRow[] = [];
  sent.forEach((activity, i) => {
    const row = rows[i];
    if (row.isValid === false) unsaved.push({ activity, reason: reasonOf(row) });
    else if (isDuplicate(row)) duplicates.push(activity);
    else stored.push(activity);
  });
  if (imported !== stored.length) {
    return none(`Wealthfolio reported ${imported} of ${sent.length} rows stored but marked ${stored.length}`);
  }
  return { stored, duplicates, unsaved, refused: [] };
}

function isDuplicate(row: ActivityImport): boolean {
  return !!row.duplicateOfId || row.duplicateOfLineNumber != null;
}

export interface HostImport {
  stored: ActivityImport[];
  duplicates: ActivityImport[];
  unsaved: UnsavedRow[];
}

/**
 * Sends `rows` through `importFn` (`ctx.api.activities.import`) and returns what the host stored.
 * A call that stored nothing has its failing rows rejected (with the host's reasons) and the rest
 * sent again, so one bad row does not keep the others out; a call that throws, or that stored
 * nothing without saying why, leaves its rows unsaved (the next sync reads them again). Every row
 * ends up stored, a duplicate or unsaved, exactly once.
 */
export async function importStoredRows(
  importFn: (rows: ActivityImport[]) => Promise<ImportActivitiesResult>,
  rows: ActivityImport[],
): Promise<HostImport> {
  const out: HostImport = { stored: [], duplicates: [], unsaved: [] };
  let batch = rows;
  while (batch.length > 0) {
    let res: ImportActivitiesResult;
    try {
      res = await importFn(batch);
    } catch (e) {
      const reason = `import refused it: ${errText(e)}`;
      out.unsaved.push(...batch.map((activity) => ({ activity, reason })));
      break;
    }
    const read = readImportResult(batch, res);
    out.stored.push(...read.stored);
    out.duplicates.push(...read.duplicates);
    const refused = new Set(read.refused);
    if (refused.size === 0 || refused.size === batch.length) {
      out.unsaved.push(...read.unsaved);
      break;
    }
    // The call stored nothing because of the refused rows: report them, send the others again.
    const retry: ActivityImport[] = [];
    read.unsaved.forEach((u, i) => (refused.has(i) ? out.unsaved.push(u) : retry.push(u.activity)));
    batch = retry;
  }
  return out;
}

/** `ledger` without the entries of `unsaved` rows, which must be tried again. Does not change `ledger`. */
export function withoutUnsaved(ledger: ImportLedger, unsaved: UnsavedRow[]): ImportLedger {
  const next = { ...ledger };
  for (const { activity } of unsaved) if (activity.id) delete next[activity.id];
  return next;
}

/** One line for an unsaved row: type, day, amount, currency, comment and the host's reason. */
export function describeUnsaved({ activity: a, reason }: UnsavedRow): string {
  const day = a.date ? (a.date instanceof Date ? a.date.toISOString() : String(a.date)).slice(0, 10) : "no date";
  const amount = a.amount != null && a.amount !== "" ? ` ${Number(a.amount)} ${a.currency ?? ""}`.trimEnd() : "";
  const note = a.comment ? ` (${a.comment})` : "";
  return `${a.activityType} ${day}${amount}${note}: ${reason}`;
}

/** The error for a sync or import that left rows unsaved, or undefined when there are none. */
export function unsavedMessage(unsaved: UnsavedRow[]): string | undefined {
  if (unsaved.length === 0) return undefined;
  const n = unsaved.length;
  return (
    `${n} ${n === 1 ? "row was" : "rows were"} not saved by Wealthfolio and will be tried again ` +
    `on the next sync: ${describeUnsaved(unsaved[0])}` +
    (n > 1 ? ` (and ${n - 1} more, see the log)` : "")
  );
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
