import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import { selectNewActivities, type ExistingActivityLike } from "@wf-addons/kit";

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
  imported: number;
  /** Ids of the rows imported by this call. */
  importedIds: string[];
  /** Rows the account already held (left out). */
  duplicates: number;
  /** Ids of every row now accounted for: imported, or already there. */
  accounted: string[];
  rejected: RejectedRow[];
}

type Progress = (done: number, total: number) => void;

/**
 * Imports activities for one sync: leaves out what each account already holds (by content and
 * count, see the kit's `selectNewActivities`), validates with `checkImport`, imports the rest
 * with `forceImport`, and reports every row it could not import instead of failing the sync.
 * Each account's existing activities are read once and then kept up to date in memory, so a
 * multi-window backfill does not re-read the whole account for every window.
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

  async import(units: ImportUnit[], onProgress?: Progress): Promise<ImportOutcome> {
    const out: ImportOutcome = { imported: 0, importedIds: [], duplicates: 0, accounted: [], rejected: [] };
    const fresh = await this.leaveOutPresent(units, out);
    const total = fresh.reduce((n, u) => n + u.length, 0);
    let done = 0;
    for (const chunk of chunked(fresh, this.chunkSize)) {
      await this.check(chunk, out);
      done += chunk.reduce((n, u) => n + u.length, 0);
      onProgress?.(done, total);
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
    let checked: ActivityImport[];
    try {
      checked = await this.ctx.api.activities.checkImport(units.flat());
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
    // checkImport returns the rows in order, filled in (resolved MIC, currency…). A unit with an
    // invalid row is left out whole, so a transfer leg is never imported without its other half.
    const byId = new Map(checked.filter((a) => a.id).map((a) => [a.id!, a]));
    const valid: ImportUnit[] = [];
    for (const u of units) {
      const rows = u.map((a) => (a.id ? byId.get(a.id) : undefined) ?? a);
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
    try {
      const res = await this.ctx.api.activities.import(units.flat());
      out.imported += res.summary.imported;
      if (res.summary.imported > 0) this.lastWriteAt = Date.now();
      for (const a of units.flat()) {
        if (a.id) {
          out.accounted.push(a.id);
          out.importedIds.push(a.id);
        }
        // Keep the in-memory view current, so a later window does not import the row again.
        this.existing.get(a.accountId)?.push(a as unknown as ExistingActivityLike);
      }
    } catch (e) {
      if (units.length > 1) {
        const [a, b] = halves(units);
        await this.write(a, out);
        await this.write(b, out);
      } else {
        for (const a of units[0]) out.rejected.push({ activity: a, reason: `import refused it: ${errText(e)}` });
      }
    }
  }
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
function reasonOf(a: ActivityImport): string {
  const msgs = [...Object.values(a.errors ?? {}), ...Object.values(a.warnings ?? {})].flat();
  return msgs.length > 0 ? [...new Set(msgs)].join("; ") : "invalid (no reason given)";
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

/** One log line for a row Wealthfolio did not import: type, date, asset and reason. */
export function describeRejected(r: RejectedRow): string {
  const a = r.activity;
  const day = String(a.date ?? "").slice(0, 10) || "no date";
  const asset = a.symbol && !a.symbol.startsWith("$CASH") ? ` ${a.symbol}${a.exchangeMic ? `@${a.exchangeMic}` : ""}` : "";
  const qty = a.quantity != null ? ` qty ${a.quantity}` : "";
  const amount = a.amount != null ? ` ${a.amount} ${a.currency ?? ""}`.trimEnd() : "";
  return `Not imported: ${a.activityType} ${day}${asset}${qty}${amount} (${a.id ?? "no id"}): ${r.reason}`;
}
