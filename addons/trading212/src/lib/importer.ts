import type { ActivityImport, AddonContext, ImportActivitiesResult } from "@wealthfolio/addon-sdk";
import { reasonOf, selectNewActivities, type ExistingActivityLike, type RefusedUnit } from "@wf-addons/kit";

/**
 * Rows per checkImport/import call. Wealthfolio has no row cap for add-on imports (the web
 * server's body limit is 64 MB) and every import queues a portfolio recalculation, so fewer,
 * larger calls are much faster than the 20-row batches this replaced. A call the host still
 * rejects is halved until the offending rows are isolated.
 */
export const IMPORT_CHUNK_SIZE = 1000;

/**
 * Rows that have to be imported in one call. Wealthfolio links a TRANSFER_OUT and a TRANSFER_IN in
 * different accounts only when both arrive in the same import, so a card purchase and the transfer
 * pair that funds it travel as one unit; most units are a single row.
 */
export type ImportUnit = ActivityImport[];

/** A row Wealthfolio did not import, with the reason it gave. */
export interface RejectedRow {
  activity: ActivityImport;
  reason: string;
}

export interface ImportOutcome {
  /** Rows Wealthfolio stored (and said so for): the only rows that count as imported. */
  imported: number;
  /** Ids of the rows stored by this call. */
  importedIds: string[];
  /** Rows the account already held (left out). */
  duplicates: number;
  /** Ids of every row now accounted for: stored, or already there. Never a row that was only sent. */
  accounted: string[];
  rejected: RejectedRow[];
  /**
   * The units (as given to `importRows`) that had a row refused, each with the reason of the
   * first refused row. A unit is sent again as a whole, which is why the whole unit is listed.
   */
  refused: RefusedUnit[];
}

type Progress = (done: number, total: number) => void;

/**
 * Imports activities for one sync: leaves out what each account already holds (by content and
 * count, see the kit's `selectNewActivities`), validates with `checkImport`, imports the rest
 * with `forceImport`, and reports every row it could not import instead of failing the sync.
 * Each account's existing activities are read once and then kept up to date in memory, so a
 * multi-window backfill does not re-read the whole account for every window.
 *
 * A row counts as imported only when Wealthfolio says it stored it. Its `import` answers 200 even
 * when it saved nothing (3.11 refuses a whole call on one row failing its validation and returns
 * `success: false` with the reasons on the rows), so the answer is read row by row; every row
 * ends up stored, already there, or rejected with a reason — never silently dropped.
 */
export class ActivityImporter {
  private readonly existing = new Map<string, ExistingActivityLike[]>();
  /** When the last import call that wrote rows returned (ms), 0 when none did. */
  lastWriteAt = 0;

  constructor(
    private readonly ctx: AddonContext,
    private readonly chunkSize = IMPORT_CHUNK_SIZE,
  ) {}

  /** The activities `accountId` holds, read once per importer. */
  async existingIn(accountId: string): Promise<ExistingActivityLike[]> {
    let rows = this.existing.get(accountId);
    if (!rows) {
      rows = [...(await this.ctx.api.activities.getAll(accountId))] as ExistingActivityLike[];
      this.existing.set(accountId, rows);
    }
    return rows;
  }

  // Not named `import`: the host rewrites every dynamic `import(` its lexer reports in the
  // bundle, and es-module-lexer reports a class method of that name as one (see
  // tooling/check-bundle.mjs).
  async importRows(units: ImportUnit[], onProgress?: Progress): Promise<ImportOutcome> {
    const out: ImportOutcome = { imported: 0, importedIds: [], duplicates: 0, accounted: [], rejected: [], refused: [] };
    const inputRows = units.reduce((n, u) => n + u.length, 0);
    const fresh = await this.leaveOutPresent(units, out);
    const total = fresh.reduce((n, u) => n + u.length, 0);
    let done = 0;
    for (const chunk of chunked(fresh, this.chunkSize)) {
      await this.check(chunk, out);
      done += chunk.reduce((n, u) => n + u.length, 0);
      onProgress?.(done, total);
    }
    out.refused = refusedUnitsOf(units, out.rejected);
    // Every row must have ended up somewhere; a gap here would be a row lost without a word.
    const handled = out.imported + out.duplicates + out.rejected.length;
    if (handled !== inputRows) {
      throw new Error(`Import accounting is off: ${inputRows} rows given, ${handled} stored, already there or rejected.`);
    }
    return out;
  }

  /** Units with the rows their account does not hold yet (the others are counted as duplicates). */
  private async leaveOutPresent(units: ImportUnit[], out: ImportOutcome): Promise<ImportUnit[]> {
    const byAccount = new Map<string, ActivityImport[]>();
    for (const u of units) for (const a of u) byAccount.set(a.accountId, [...(byAccount.get(a.accountId) ?? []), a]);
    const keep = new Set<ActivityImport>();
    for (const [accountId, rows] of byAccount) {
      const fresh = new Set(selectNewActivities(rows, await this.existingIn(accountId)).map((a) => a.id));
      for (const a of rows) {
        // Every row carries a stable id; a row without one is always new.
        if (!a.id || fresh.has(a.id)) keep.add(a);
        else {
          out.duplicates++;
          out.accounted.push(a.id);
        }
      }
    }
    return units.map((u) => u.filter((a) => keep.has(a))).filter((u) => u.length > 0);
  }

  private async check(units: ImportUnit[], out: ImportOutcome): Promise<void> {
    const sent = units.flat();
    let checked: ActivityImport[];
    try {
      checked = await this.ctx.api.activities.checkImport(sent);
      if (checked.length !== sent.length) {
        throw new Error(`checkImport returned ${checked.length} rows for ${sent.length}`);
      }
    } catch (e) {
      if (units.length > 1) {
        const [a, b] = halves(units);
        await this.check(a, out);
        await this.check(b, out);
      } else {
        for (const a of units[0]) out.rejected.push({ activity: a, reason: `checkImport refused it: ${errText(e)}` });
      }
      return;
    }
    // checkImport returns the rows in the order they were sent, filled in (the resolved asset, MIC,
    // quote currency…) — and gives every row a new id of its own, so rows are matched by position.
    // The filled-in row is what has to be imported: Wealthfolio refuses an equity row that still
    // lacks its quote currency. The row keeps this add-on's id, which the sync records.
    let at = 0;
    const valid: ImportUnit[] = [];
    for (const u of units) {
      const rows = u.map((a) => ({ ...checked[at++], id: a.id }));
      const bad = rows.filter((a) => a.isValid === false);
      if (bad.length === 0) {
        valid.push(rows.map((a) => ({ ...a, forceImport: true })));
        continue;
      }
      for (const a of rows) {
        out.rejected.push({
          activity: a,
          reason: a.isValid === false ? reasonOf(a) : `left out with the row it belongs to (${reasonOf(bad[0])})`,
        });
      }
    }
    await this.write(valid, out);
  }

  private async write(units: ImportUnit[], out: ImportOutcome): Promise<void> {
    if (units.length === 0) return;
    const sent = units.flat();
    let res: ImportActivitiesResult;
    try {
      res = await this.ctx.api.activities.import(sent);
    } catch (e) {
      return this.splitOrReject(units, out, `import refused it: ${errText(e)}`);
    }
    const rows = res.activities ?? [];
    const perRow = rows.length === sent.length;
    const summary = res.summary as Partial<ImportActivitiesResult["summary"]> & { errorMessage?: string };

    // A call that stored nothing: say which rows made it fail, leave those out, and try the rest.
    if (summary.success === false || (summary.imported ?? 0) === 0) {
      const badAt = perRow ? rows.map((r, i) => (r.isValid === false ? i : -1)).filter((i) => i >= 0) : [];
      if (badAt.length > 0) {
        const bad = new Set(badAt.map((i) => sent[i]));
        const good: ImportUnit[] = [];
        for (const u of units) {
          if (!u.some((a) => bad.has(a))) {
            good.push(u);
            continue;
          }
          for (const a of u) {
            const row = rows[sent.indexOf(a)];
            out.rejected.push({
              activity: a,
              reason: bad.has(a) ? reasonOf(row) : `left out with the row it belongs to (${reasonOf(rows[badAt[0]])})`,
            });
          }
        }
        return this.write(good, out);
      }
      const why =
        badAt.length > 0
          ? reasonOf(rows[badAt[0]])
          : (summary.errorMessage ?? "Wealthfolio imported none of the rows and gave no reason");
      return this.splitOrReject(units, out, `import saved nothing: ${why}`);
    }

    // The call stored something. Which rows? Wealthfolio marks the ones it left out (a row its
    // own checks failed) invalid on the returned row; with no per-row answer, only a count that
    // matches what was sent proves every row was stored.
    const stored = perRow
      ? sent.map((_, i) => rows[i].isValid !== false && !rows[i].duplicateOfId && rows[i].duplicateOfLineNumber == null)
      : sent.map(() => summary.imported === sent.length);
    const storedCount = stored.filter(Boolean).length;
    if (summary.imported !== storedCount) {
      // Its count and its rows disagree: record nothing as imported (the next sync finds what is
      // really there by content) rather than guess.
      const why = `Wealthfolio reported ${summary.imported} of ${sent.length} stored but marked ${storedCount}`;
      for (const a of sent) out.rejected.push({ activity: a, reason: why });
      return;
    }
    sent.forEach((a, i) => {
      if (stored[i]) {
        out.imported++;
        if (a.id) {
          out.accounted.push(a.id);
          out.importedIds.push(a.id);
        }
        // Keep the in-memory view current, so a later window does not import the row again.
        this.existing.get(a.accountId)?.push(a as unknown as ExistingActivityLike);
      } else {
        out.rejected.push({ activity: a, reason: perRow ? reasonOf(rows[i]) : "Wealthfolio did not store it" });
      }
    });
    this.lastWriteAt = Date.now();
  }

  /** Halves a call that failed as a whole to find the rows behind it; a single unit is rejected. */
  private async splitOrReject(units: ImportUnit[], out: ImportOutcome, reason: string): Promise<void> {
    if (units.length > 1) {
      const [a, b] = halves(units);
      await this.write(a, out);
      await this.write(b, out);
      return;
    }
    for (const a of units[0]) out.rejected.push({ activity: a, reason });
  }
}

/** The units that had a row refused (by the row's id), each with its first row's own reason. */
function refusedUnitsOf(units: ImportUnit[], rejected: RejectedRow[]): RefusedUnit[] {
  const unitOfId = new Map<string, ImportUnit>();
  for (const u of units) for (const a of u) if (a.id) unitOfId.set(a.id, u);
  const out = new Map<ImportUnit, string>();
  for (const r of rejected) {
    const unit = (r.activity.id ? unitOfId.get(r.activity.id) : undefined) ?? [r.activity];
    // The row that was actually refused says why; its pair-mates only say they were left out with it.
    if (!out.has(unit) || out.get(unit)!.startsWith("left out with")) out.set(unit, r.reason);
  }
  return [...out].map(([unit, reason]) => ({ unit, reason }));
}

/** Groups units into chunks of at most `size` rows (a unit larger than that goes alone). */
function chunked(units: ImportUnit[], size: number): ImportUnit[][] {
  const out: ImportUnit[][] = [];
  let cur: ImportUnit[] = [];
  let n = 0;
  for (const u of units) {
    if (n > 0 && n + u.length > size) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(u);
    n += u.length;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function halves<T>(xs: T[]): [T[], T[]] {
  const mid = Math.ceil(xs.length / 2);
  return [xs.slice(0, mid), xs.slice(mid)];
}

/** The reason Wealthfolio gave for an invalid row (its errors, else its warnings). */
function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** One log line for a row Wealthfolio did not import: type, date, asset and reason. */
export function describeRejected(r: RejectedRow): string {
  const a = r.activity;
  const day = String(a.date ?? "").slice(0, 10) || "no date";
  const asset = a.symbol && !a.symbol.startsWith("$CASH") ? ` ${a.symbol}${a.exchangeMic ? `@${a.exchangeMic}` : ""}` : "";
  const qty = a.quantity != null ? ` qty ${a.quantity}` : "";
  const amount = a.amount != null ? ` ${a.amount} ${a.currency ?? ""}`.trimEnd() : "";
  return `Not imported: ${a.activityType} ${day}${asset}${qty}${amount} (${a.id ?? "no id"}): ${r.reason}`;
}
