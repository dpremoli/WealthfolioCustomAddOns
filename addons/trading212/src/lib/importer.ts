import type { ActivityImport, AddonContext, ImportActivitiesResult } from "@wealthfolio/addon-sdk";
import { contentKey, reasonOf, selectNewActivities, type ExistingActivityLike, type RefusedUnit } from "@wf-addons/kit";

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
 * What a card row is for matching: its day, kind, amount and currency — not the merchant text.
 * Versions before 2.6.4 stored a card refund as CREDIT, later ones as DEPOSIT: one kind of row.
 */
const CARD_TYPES = new Set(["WITHDRAWAL", "DEPOSIT", "CREDIT", "INTEREST"]);
const cardKind = (type: string) => (type === "CREDIT" ? "DEPOSIT" : type);
const FUNDING_COMMENT = "Card funding";
type CardLike = { activityType: string; date?: Date | string | null; amount?: number | string | null; currency?: string | null };
function cardKey(a: CardLike): string {
  const day = (a.date instanceof Date ? a.date.toISOString() : String(a.date ?? "")).slice(0, 10);
  const amount = Math.round(Math.abs(Number(a.amount ?? 0)) * 100) / 100;
  return [cardKind(String(a.activityType)), day, amount.toFixed(2), (a.currency ?? "").toUpperCase()].join("|");
}
const isCardRow = (a: { activityType: string; comment?: string | null }) =>
  CARD_TYPES.has(String(a.activityType)) && a.comment !== FUNDING_COMMENT;

export interface ImportOptions {
  /**
   * Rows of the same source window that were imported before (their ids are in the ledger, so they
   * are not sent): each stands for one of the account's rows when the card rows are matched.
   */
  recorded?: ActivityImport[];
}

/**
 * Imports activities for one sync: leaves out what each account already holds, validates with
 * `checkImport`, imports the rest, and reports every row it could not import instead of failing
 * the sync. Each account's existing activities are read once and then kept up to date in memory,
 * so a multi-window backfill does not re-read the whole account for every window.
 *
 * What an account already holds is found by content and count (the kit's `selectNewActivities`),
 * except in card accounts: a card row is matched on its day, type, amount and currency only, since
 * earlier versions wrote the merchant text differently ("Lidl GB · Shopping" against "Lidl ·
 * Shopping"), with the rows of the same window that are already recorded counting first, so a
 * second identical coffee is still new.
 *
 * `forceImport` is set only on a row Wealthfolio would otherwise drop as a duplicate (it marks it
 * at `checkImport`): two identical rows in one call, or one more than the account holds. The
 * markers are taken off before the import — a forced row comes back still carrying the one it was
 * sent with, which is how 2.6.2 took stored rows for refused ones.
 *
 * A row counts as imported only when Wealthfolio stored it. Its `import` answers 200 even when it
 * saved nothing (3.11 refuses a whole call on one row failing its validation and returns
 * `success: false` with the reasons on the rows), so the answer is read row by row, and when the
 * host's count and its rows disagree the account is read again to see what is there. Every row
 * ends up stored, already there, or rejected with a reason — never silently dropped.
 */
export class ActivityImporter {
  private readonly existing = new Map<string, ExistingActivityLike[]>();
  private readonly cardAccounts: Set<string>;
  /** When the last import call that wrote rows returned (ms), 0 when none did. */
  lastWriteAt = 0;

  constructor(
    private readonly ctx: AddonContext,
    private readonly chunkSize = IMPORT_CHUNK_SIZE,
    opts: { cardAccountIds?: Iterable<string | undefined> } = {},
  ) {
    this.cardAccounts = new Set([...(opts.cardAccountIds ?? [])].filter((x): x is string => !!x));
  }

  /** The activities `accountId` holds, read once per importer. */
  async existingIn(accountId: string): Promise<ExistingActivityLike[]> {
    let rows = this.existing.get(accountId);
    if (!rows) {
      rows = [...(await this.ctx.api.activities.getAll(accountId))] as ExistingActivityLike[];
      this.existing.set(accountId, rows);
    }
    return rows;
  }

  /**
   * Reads the account again: what Wealthfolio holds, not what this importer believes it stored.
   * For a check that must not trust the in-memory view (the split repair).
   */
  async reload(accountId: string): Promise<ExistingActivityLike[]> {
    this.existing.delete(accountId);
    return this.existingIn(accountId);
  }

  /** Drops rows that were deleted from the in-memory view of an account. */
  forget(accountId: string, ids: string[]): void {
    const gone = new Set(ids);
    const rows = this.existing.get(accountId);
    if (rows) this.existing.set(accountId, rows.filter((r) => !gone.has((r as { id?: string }).id ?? "")));
  }

  // Not named `import`: the host rewrites every dynamic `import(` its lexer reports in the
  // bundle, and es-module-lexer reports a class method of that name as one (see
  // tooling/check-bundle.mjs).
  async importRows(units: ImportUnit[], onProgress?: Progress, opts: ImportOptions = {}): Promise<ImportOutcome> {
    const out: ImportOutcome = { imported: 0, importedIds: [], duplicates: 0, accounted: [], rejected: [], refused: [] };
    const inputRows = units.reduce((n, u) => n + u.length, 0);
    const fresh = await this.leaveOutPresent(units, out, opts.recorded ?? []);
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
  private async leaveOutPresent(units: ImportUnit[], out: ImportOutcome, recorded: ActivityImport[]): Promise<ImportUnit[]> {
    const byAccount = new Map<string, ActivityImport[]>();
    for (const u of units) for (const a of u) byAccount.set(a.accountId, [...(byAccount.get(a.accountId) ?? []), a]);
    const keep = new Set<ActivityImport>();
    const present = (a: ActivityImport) => {
      out.duplicates++;
      if (a.id) out.accounted.push(a.id);
    };
    for (const [accountId, rows] of byAccount) {
      const existing = await this.existingIn(accountId);
      let others = rows;
      if (this.cardAccounts.has(accountId)) {
        // Card rows: by day, type, amount and currency. The window's recorded rows take their
        // account rows first; what is left over is what earlier versions (or a lost ledger) wrote.
        const free = new Map<string, number>();
        for (const e of existing) if (isCardRow(e)) free.set(cardKey(e), (free.get(cardKey(e)) ?? 0) + 1);
        for (const r of recorded) {
          if (r.accountId !== accountId || !isCardRow(r)) continue;
          const k = cardKey(r);
          if ((free.get(k) ?? 0) > 0) free.set(k, free.get(k)! - 1);
        }
        for (const a of rows) {
          if (!isCardRow(a)) continue;
          const k = cardKey(a);
          if ((free.get(k) ?? 0) > 0) {
            free.set(k, free.get(k)! - 1);
            present(a);
          } else keep.add(a);
        }
        others = rows.filter((a) => !isCardRow(a));
      }
      const fresh = new Set(selectNewActivities(others, existing).map((a) => a.id));
      for (const a of others) {
        // Every row carries a stable id; a row without one is always new.
        if (!a.id || fresh.has(a.id)) keep.add(a);
        else present(a);
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
        valid.push(rows.map(forImport));
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
    const summary = (res.summary ?? {}) as Partial<ImportActivitiesResult["summary"]> & { errorMessage?: string };
    const imported = summary.imported ?? 0;

    // A call its validation refused stored nothing: say which rows made it fail, leave those out,
    // and try the rest.
    if (summary.success === false) {
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
      return this.splitOrReject(
        units,
        out,
        `import saved nothing: ${summary.errorMessage ?? "Wealthfolio imported none of the rows and gave no reason"}`,
      );
    }

    // The call went through. Per row: refused by its writer policy (invalid), left out as a
    // duplicate (marked, and not forced: it is already in the account), or stored.
    const fate: ("stored" | "present" | "refused")[] = sent.map((a, i) => {
      if (!perRow) return "stored";
      const r = rows[i];
      if (r.isValid === false) return "refused";
      const forced = (a as ActivityImport & { forceImport?: boolean }).forceImport === true;
      if (!forced && (!!r.duplicateOfId || r.duplicateOfLineNumber != null)) return "present";
      return "stored";
    });
    const storedCount = fate.filter((f) => f === "stored").length;
    if (imported !== storedCount) {
      // Its count and its rows disagree: look at the account to see what it holds now.
      return this.settleByReading(sent, rows, perRow, out, `Wealthfolio reported ${imported} of ${sent.length} rows stored`);
    }
    sent.forEach((a, i) => {
      if (fate[i] === "stored") this.markStored(a, out);
      else if (fate[i] === "present") {
        out.duplicates++;
        if (a.id) out.accounted.push(a.id);
      } else out.rejected.push({ activity: a, reason: reasonOf(rows[i]) });
    });
    if (storedCount > 0) this.lastWriteAt = Date.now();
  }

  private markStored(a: ActivityImport, out: ImportOutcome) {
    out.imported++;
    if (a.id) {
      out.accounted.push(a.id);
      out.importedIds.push(a.id);
    }
    // Keep the in-memory view current, so a later window does not import the row again.
    this.existing.get(a.accountId)?.push(a as unknown as ExistingActivityLike);
  }

  /**
   * Decides what happened to `sent` from the accounts themselves, read again after the call: a row
   * the account now holds more of (by content) than before was stored; one it held before was
   * already there; one it does not hold was not saved.
   */
  private async settleByReading(
    sent: ActivityImport[],
    rows: ActivityImport[],
    perRow: boolean,
    out: ImportOutcome,
    why: string,
  ): Promise<void> {
    const accounts = [...new Set(sent.map((a) => a.accountId))];
    const added = new Map<string, number>();
    const before = new Map<string, number>();
    for (const accountId of accounts) {
      const old = this.existing.get(accountId) ?? [];
      const now = [...(await this.ctx.api.activities.getAll(accountId))] as ExistingActivityLike[];
      const count = (list: ExistingActivityLike[]) => {
        const m = new Map<string, number>();
        for (const e of list) m.set(`${accountId}|${contentKey(e)}`, (m.get(`${accountId}|${contentKey(e)}`) ?? 0) + 1);
        return m;
      };
      const was = count(old);
      for (const [k, n] of count(now)) {
        added.set(k, Math.max(0, n - (was.get(k) ?? 0)));
        before.set(k, was.get(k) ?? 0);
      }
      this.existing.set(accountId, now);
    }
    let any = false;
    sent.forEach((a, i) => {
      const k = `${a.accountId}|${contentKey(a)}`;
      if ((added.get(k) ?? 0) > 0) {
        added.set(k, added.get(k)! - 1);
        out.imported++;
        any = true;
        if (a.id) {
          out.accounted.push(a.id);
          out.importedIds.push(a.id);
        }
      } else if (perRow && rows[i].isValid === false) {
        out.rejected.push({ activity: a, reason: reasonOf(rows[i]) });
      } else if ((before.get(k) ?? 0) > 0) {
        out.duplicates++;
        if (a.id) out.accounted.push(a.id);
      } else {
        out.rejected.push({ activity: a, reason: `import saved nothing for it: ${why}, and the account does not hold it` });
      }
    });
    if (any) this.lastWriteAt = Date.now();
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

/**
 * A checked row ready to import: the duplicate markers `checkImport` set are taken off (a forced
 * row would come back still carrying them), and `forceImport` is set only where Wealthfolio would
 * otherwise leave the row out as a duplicate. The add-on has already left out what the account
 * holds, so a row still marked is a genuine repeat: two identical rows in this call, or one more
 * than the account holds.
 */
function forImport(row: ActivityImport): ActivityImport {
  const marked = !!row.duplicateOfId || row.duplicateOfLineNumber != null;
  const { duplicateOfId: _id, duplicateOfLineNumber: _line, ...rest } = row;
  const warnings = row.warnings ? Object.fromEntries(Object.entries(row.warnings).filter(([k]) => k !== "_duplicate")) : undefined;
  return { ...rest, warnings: warnings && Object.keys(warnings).length > 0 ? warnings : undefined, forceImport: marked } as ActivityImport;
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
