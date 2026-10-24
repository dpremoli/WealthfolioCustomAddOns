import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { jsonStore } from "./storage";

/**
 * Rows Wealthfolio refuses, kept apart from the sync watermark.
 *
 * A row the host refuses on every call (an unresolvable or delisted symbol, a bad date) must not
 * hold a watermark back: that would re-read the whole history on every sync, and a source that
 * only serves recent history (Monzo's 90 days) would lose the row for good. So the watermark moves
 * on as usual and the refused rows wait here, in a small storage key of their own: the row (as an
 * add-on sent it), the host's reason and how often it has been refused. An importer retries them
 * at the start of every sync and removes a row once the host has stored it (or already has it).
 * While the list is not empty the sync reports an error, and the log lists the rows.
 *
 * A "unit" is the rows that have to be imported together: usually one, or a transfer pair.
 */
export interface RefusedEntry {
  /** The id of the unit's first row: what identifies it across syncs. */
  id: string;
  /** The rows as an add-on built them, to be sent again. */
  unit: ActivityImport[];
  /** Wealthfolio's reason, from the latest attempt. */
  reason: string;
  /** How many syncs have refused it. */
  attempts: number;
  /** When it was first refused (ISO). */
  since: string;
  /** When it was last refused (ISO). */
  lastAt: string;
}

export interface RefusedRows {
  entries: RefusedEntry[];
  /** Entries that did not fit the size guard and are not kept (so they are not retried). */
  dropped: number;
}

/** A unit the host refused, with its reason: what an importer reports. */
export interface RefusedUnit {
  unit: ActivityImport[];
  reason: string;
}

/** Most entries kept, and most bytes of JSON they may take (the host's cap is ~244 KB per value). */
export const MAX_REFUSED_ENTRIES = 300;
export const MAX_REFUSED_BYTES = 120_000;

type KeyValueApi = Parameters<typeof jsonStore>[0];

export const emptyRefused = (): RefusedRows => ({ entries: [], dropped: 0 });

const idOf = (unit: ActivityImport[]): string => unit.find((a) => a.id)?.id ?? "";
const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** The refused rows stored under `key`, or none. */
export async function loadRefused(api: KeyValueApi, key: string): Promise<RefusedRows> {
  const v = await jsonStore(api).get<Partial<RefusedRows> | null>(key, null);
  if (!v || typeof v !== "object" || !Array.isArray(v.entries)) return emptyRefused();
  const entries = v.entries.filter((e): e is RefusedEntry => !!e && Array.isArray(e.unit) && e.unit.length > 0 && typeof e.id === "string");
  return { entries, dropped: typeof v.dropped === "number" ? v.dropped : 0 };
}

/**
 * Stores the rows, within the size guard: oldest first are kept, and what does not fit is counted
 * in `dropped` (so the error can say so) rather than written past the host's cap. An empty list
 * deletes the key. Returns what was kept.
 */
export async function saveRefused(api: KeyValueApi, key: string, rows: RefusedRows): Promise<RefusedRows> {
  const store = jsonStore(api);
  let entries = rows.entries.slice(0, MAX_REFUSED_ENTRIES);
  let dropped = rows.dropped + (rows.entries.length - entries.length);
  while (entries.length > 0 && size({ entries, dropped }) > MAX_REFUSED_BYTES) {
    const keep = Math.max(1, Math.floor(entries.length * 0.8));
    if (keep === entries.length) break;
    dropped += entries.length - keep;
    entries = entries.slice(0, keep);
  }
  const kept = { entries, dropped };
  if (entries.length === 0 && dropped === 0) await store.delete(key);
  else await store.set(key, kept);
  return kept;
}

/**
 * Takes out the units an import has dealt with: every row of the unit is in `accountedIds`
 * (stored by the host, or already in the account), which also clears the `dropped` count when
 * nothing is left.
 */
export function settleRefused(rows: RefusedRows, accountedIds: Iterable<string>): RefusedRows {
  const done = new Set(accountedIds);
  const entries = rows.entries.filter((e) => !e.unit.every((a) => !!a.id && done.has(a.id)));
  return { entries, dropped: entries.length === 0 ? 0 : rows.dropped };
}

/** Adds units the host refused: one already listed counts another attempt and takes the new reason. */
export function addRefused(rows: RefusedRows, refused: RefusedUnit[], now = new Date()): RefusedRows {
  const at = now.toISOString();
  const entries = [...rows.entries];
  for (const r of refused) {
    const id = idOf(r.unit);
    const i = id ? entries.findIndex((e) => e.id === id) : -1;
    if (i >= 0) entries[i] = { ...entries[i], unit: r.unit, reason: r.reason, attempts: entries[i].attempts + 1, lastAt: at };
    else entries.push({ id, unit: r.unit, reason: r.reason, attempts: 1, since: at, lastAt: at });
  }
  return { entries, dropped: rows.dropped };
}

/** The units to send again, in the order they were first refused. */
export const refusedUnits = (rows: RefusedRows): ActivityImport[][] => rows.entries.map((e) => e.unit);

/** One log line for a refused unit: what it is, why, and how long it has been refused. */
export function describeRefusedEntry(e: RefusedEntry): string {
  const a = e.unit.find((x) => x.activityType !== "TRANSFER_IN" && x.activityType !== "TRANSFER_OUT") ?? e.unit[0];
  const day = String(a.date ?? "").slice(0, 10) || "no date";
  const asset = a.symbol && !a.symbol.startsWith("$CASH") ? ` ${a.symbol}${a.exchangeMic ? `@${a.exchangeMic}` : ""}` : "";
  const qty = a.quantity != null ? ` qty ${a.quantity}` : "";
  const amount = a.amount != null ? ` ${a.amount} ${a.currency ?? ""}`.trimEnd() : "";
  const times = e.attempts === 1 ? "refused once" : `refused ${e.attempts} times since ${e.since.slice(0, 10)}`;
  return `${a.activityType} ${day}${asset}${qty}${amount} (${e.id || "no id"}): ${e.reason} — ${times}`;
}

/** The log section for the refused rows (empty when there are none). At most `max` rows are listed. */
export function describeRefused(rows: RefusedRows, max = 50): string[] {
  if (rows.entries.length === 0 && rows.dropped === 0) return [];
  const out = [
    `Wealthfolio refuses ${rows.entries.length} row${rows.entries.length === 1 ? "" : "s"}; they are tried again at the start of every sync and dropped from this list once saved:`,
  ];
  for (const e of rows.entries.slice(0, max)) out.push(`  ${describeRefusedEntry(e)}`);
  if (rows.entries.length > max) out.push(`  …and ${rows.entries.length - max} more.`);
  if (rows.dropped > 0) out.push(`  ${rows.dropped} further refused row${rows.dropped === 1 ? " was" : "s were"} not kept (the list is full), so they are not retried.`);
  return out;
}

/** The sync error for the refused rows, or undefined when there are none. */
export function refusedError(rows: RefusedRows): string | undefined {
  const n = rows.entries.length + rows.dropped;
  if (n === 0) return undefined;
  const first = rows.entries[0];
  return (
    `${n} row${n === 1 ? " is" : "s are"} refused by Wealthfolio and retried on every sync (see the log). ` +
    (first ? `First: ${describeRefusedEntry(first)}` : "")
  ).trim();
}
