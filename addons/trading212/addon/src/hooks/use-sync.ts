import { useState } from "react";
import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import type {
  DividendItem,
  HistoricalOrder,
  MultiSyncResult,
  Paginated,
  SyncResult,
  T212Connection,
  T212Settings,
  TransactionItem,
} from "../types";
import { Trading212ProxyClient, cursorFromNextPage, transactionPageParams } from "../lib/proxy-client";
import {
  mapDividendToActivity,
  mapOrderToActivity,
  mapTransactionToActivity,
} from "../lib/mapper";
import { parseCsv, mapCsvRow } from "../lib/csv";
import { SymbolResolver } from "../lib/symbol-resolver";
import {
  addImportedRefs,
  connectionConfig,
  getConnections,
  getImportedRefs,
  getSettings,
  getSymbolMap,
  getSyncState,
  setLastSync,
  setSymbolMap,
} from "./use-config";

interface SyncState {
  isSyncing: boolean;
  results: MultiSyncResult | null;
  error: string | null;
}

const PAGE_GUARD = 500; // hard cap on pages per endpoint

// Initial activity batch size for checkImport/import. The backend rejects
// oversized batches with a 422; oversized chunks are adaptively halved at runtime.
const IMPORT_CHUNK_SIZE = 20;

// Trading 212 caps each CSV export at ~1 year, so a full backfill walks back in
// one-year windows. Caps the walk so a sparse history can't loop forever.
const MAX_EXPORT_WINDOWS = 15;

/** Pages a cursor endpoint newest-first, stopping once records predate `since`. */
async function collectSince<T>(
  pageFn: (cursor?: string) => Promise<Paginated<T>>,
  dateOf: (item: T) => string | undefined,
  since: string | null,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < PAGE_GUARD; i++) {
    const page = await pageFn(cursor);
    for (const item of page.items ?? []) {
      const d = dateOf(item);
      if (since && d && d <= since) return out;
      out.push(item);
    }
    const next = cursorFromNextPage(page.nextPagePath);
    if (!next) break;
    cursor = next;
  }
  return out;
}

/**
 * Pages transactions newest-first, stopping once records predate `since`.
 * Trading 212's transactions endpoint requires `cursor` and `time` together (or
 * neither), so the first page sends neither and later pages carry both from the
 * returned `nextPagePath` — sending one without the other is a 400.
 */
async function collectTransactions(
  client: Trading212ProxyClient,
  since: string | null,
): Promise<TransactionItem[]> {
  const out: TransactionItem[] = [];
  let params: { cursor?: string; time?: string } = {};
  for (let i = 0; i < PAGE_GUARD; i++) {
    const page = await client.pageTransactions(params);
    for (const t of page.items ?? []) {
      if (since && t.dateTime && t.dateTime <= since) return out;
      out.push(t);
    }
    const next = transactionPageParams(page.nextPagePath);
    if (!next.cursor) break;
    params = next;
  }
  return out;
}

/** Fetches and maps all activities for a connection via the JSON paging endpoints. */
async function collectJsonActivities(
  client: Trading212ProxyClient,
  since: string | null,
  importedRefs: Set<string>,
  accountId: string,
  resolver: SymbolResolver,
): Promise<{ activities: ActivityImport[]; unresolved: number }> {
  const orders = await collectSince<HistoricalOrder>(
    (c) => client.pageOrders(c),
    (o) => o.fill?.filledAt || o.order?.createdAt,
    since,
  );
  const dividends = await collectSince<DividendItem>(
    (c) => client.pageDividends(c),
    (d) => d.paidOn,
    since,
  );
  const transactions = await collectTransactions(client, since);

  const activities: ActivityImport[] = [];
  let unresolved = 0;

  for (const ho of orders) {
    const o = ho.order;
    if (!o || o.id === undefined) continue;
    if (importedRefs.has(`t212-order-${o.id}`)) continue;
    const ticker = o.instrument?.ticker;
    if (!ticker) continue;
    const symbol = await resolver.resolve(ticker, o.instrument);
    if (!symbol) {
      unresolved++;
      continue;
    }
    const activity = mapOrderToActivity(ho, accountId, symbol);
    if (activity) activities.push(activity);
  }

  for (const d of dividends) {
    if (importedRefs.has(`t212-div-${d.reference}`)) continue;
    let symbol: string | null = null;
    if (d.type !== "INTEREST") {
      symbol = d.ticker ? await resolver.resolve(d.ticker, d.instrument) : null;
      if (!symbol) {
        unresolved++;
        continue;
      }
    }
    activities.push(mapDividendToActivity(d, accountId, symbol));
  }

  for (const t of transactions) {
    if (importedRefs.has(`t212-txn-${t.reference}`)) continue;
    activities.push(mapTransactionToActivity(t, accountId));
  }

  return { activities, unresolved };
}

/** Syncs one connection into its linked Wealthfolio account. */
async function syncOne(
  ctx: AddonContext,
  settings: T212Settings,
  conn: T212Connection,
  resolver: SymbolResolver,
): Promise<SyncResult> {
  const base = { connectionId: conn.id, accountId: conn.accountId, accountName: conn.name };
  try {
    const client = new Trading212ProxyClient(connectionConfig(settings, conn));
    const { lastSync: since } = await getSyncState(ctx, conn.id);
    const importedRefs = await getImportedRefs(ctx, conn.id);

    let activities: ActivityImport[];
    let unresolved: number;

    if (since === null) {
      // ── CSV backfill (full history) ──────────────────────────────────────
      // Trading 212 caps each export at ~1 year, so request (or reuse) one-year
      // windows back from now and stop after two consecutive empty windows.
      // Falls back to JSON paging if even the first window's export fails.
      const mapped: ActivityImport[] = [];
      const seen = new Set<string>();
      let csvUnresolved = 0;
      let exportFailed = false;

      let windowEnd = new Date();
      let emptyStreak = 0;
      for (let w = 0; w < MAX_EXPORT_WINDOWS; w++) {
        const windowStart = new Date(
          Date.UTC(
            windowEnd.getUTCFullYear() - 1,
            windowEnd.getUTCMonth(),
            windowEnd.getUTCDate(),
            windowEnd.getUTCHours(),
            windowEnd.getUTCMinutes(),
            windowEnd.getUTCSeconds(),
          ),
        );

        let csv: string;
        try {
          csv = await client.runExport({
            timeFrom: windowStart.toISOString(),
            timeTo: windowEnd.toISOString(),
          });
        } catch {
          if (w === 0) exportFailed = true; // couldn't retrieve any history
          break;
        }

        const rows = parseCsv(csv);
        if (rows.length === 0) {
          if (++emptyStreak >= 2) break; // assume no older history
          windowEnd = windowStart;
          continue;
        }
        emptyStreak = 0;

        for (const row of rows) {
          const act = await mapCsvRow(row, conn.accountId, resolver);
          if (act) {
            const id = act.id ?? "";
            if (id && !seen.has(id) && !importedRefs.has(id)) {
              seen.add(id);
              mapped.push(act);
            }
          } else {
            // Count failed symbol lookups as unresolved (not unknown actions or splits).
            const a = (row["Action"] ?? "").toLowerCase();
            if (
              row["Ticker"]?.trim() &&
              (a.endsWith(" buy") || a.endsWith(" sell") || a.startsWith("dividend"))
            ) {
              csvUnresolved++;
            }
          }
        }
        windowEnd = windowStart;
      }

      if (exportFailed) {
        // CSV unavailable — use JSON paging for the initial full sync.
        ({ activities, unresolved } = await collectJsonActivities(
          client,
          null,
          importedRefs,
          conn.accountId,
          resolver,
        ));
      } else {
        activities = mapped;
        unresolved = csvUnresolved;
      }
    } else {
      // ── JSON incremental (since last watermark) ──────────────────────────
      ({ activities, unresolved } = await collectJsonActivities(
        client,
        since,
        importedRefs,
        conn.accountId,
        resolver,
      ));
    }

    // ── Common import tail ───────────────────────────────────────────────
    // Wealthfolio's checkImport/import rejects oversized batches with a 422. The
    // exact limit is unknown, so submit in chunks and adaptively halve any chunk
    // that's rejected — down to a single row, which isolates a genuinely bad row.
    let imported = 0;
    let duplicates = 0;
    let invalidCount = 0;
    let invalidDetail: string | null = null;
    const accounted: string[] = [];

    // Imports a set, halving and retrying if the backend rejects the batch.
    const doImport = async (items: ActivityImport[]): Promise<void> => {
      if (items.length === 0) return;
      try {
        const res = await ctx.api.activities.import(items);
        imported += res.summary.imported;
        for (const a of items) if (a.id) accounted.push(a.id);
      } catch (e) {
        if (items.length > 1) {
          const mid = Math.ceil(items.length / 2);
          await doImport(items.slice(0, mid));
          await doImport(items.slice(mid));
          return;
        }
        throw new Error(`import rejected a single activity: ${errDetail(e)} — payload=${JSON.stringify(items[0])}`);
      }
    };

    // Validates a chunk, halving and retrying if the backend rejects the batch.
    const process = async (chunk: ActivityImport[]): Promise<void> => {
      if (chunk.length === 0) return;
      let checked: ActivityImport[];
      try {
        checked = await ctx.api.activities.checkImport(chunk);
      } catch (e) {
        if (chunk.length > 1) {
          const mid = Math.ceil(chunk.length / 2);
          await process(chunk.slice(0, mid));
          await process(chunk.slice(mid));
          return;
        }
        throw new Error(`checkImport rejected a single activity: ${errDetail(e)} — payload=${JSON.stringify(chunk[0])}`);
      }

      const invalid = checked.filter((a) => a.isValid === false);
      const toImport = checked.filter((a) => a.isValid !== false && !a.duplicateOfId);
      const dupes = checked.filter((a) => a.duplicateOfId);
      duplicates += dupes.length;
      invalidCount += invalid.length;
      if (!invalidDetail && invalid.length > 0) {
        const withErrors = invalid.find((a) => a.errors && Object.keys(a.errors).length > 0);
        invalidDetail = `${withErrors?.errors ? JSON.stringify(withErrors.errors) : "no detail"} — first: ${describeActivity(invalid[0])}`;
      }
      for (const a of dupes) if (a.id) accounted.push(a.id);

      await doImport(toImport);
    };

    for (let i = 0; i < activities.length; i += IMPORT_CHUNK_SIZE) {
      await process(activities.slice(i, i + IMPORT_CHUNK_SIZE));
    }

    if (accounted.length > 0) await addImportedRefs(ctx, conn.id, accounted);

    await setLastSync(ctx, conn.id, new Date().toISOString());

    // Nothing imported but some rows were flagged invalid — surface why.
    if (imported === 0 && invalidCount > 0) {
      return {
        ...base,
        imported,
        duplicates,
        unresolved,
        error: `${invalidCount}/${activities.length} rows invalid: ${invalidDetail ?? "no detail"}`,
      };
    }

    return { ...base, imported, duplicates, unresolved };
  } catch (err) {
    const message =
      (err as Error).message === "UNAUTHORIZED"
        ? "Trading 212 rejected this API key. Check it in Settings."
        : (err as Error).message;
    return { ...base, imported: 0, duplicates: 0, unresolved: 0, error: message };
  }
}

/** Extracts a readable message from a thrown value (Error, string, or object). */
function errDetail(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** One-line summary of an activity for diagnostic error messages. */
function describeActivity(a: ActivityImport | undefined): string {
  if (!a) return "(none)";
  return `${a.activityType} ${a.symbol ?? "-"} ${String(a.date ?? "")} amt=${a.amount ?? "-"} qty=${a.quantity ?? "-"} px=${a.unitPrice ?? "-"} fee=${a.fee ?? "-"} ccy=${a.currency ?? "-"} fx=${a.fxRate ?? "-"}`;
}

export function useSync(ctx: AddonContext) {
  const [state, setState] = useState<SyncState>({
    isSyncing: false,
    results: null,
    error: null,
  });

  async function syncAll() {
    setState((s) => ({ ...s, isSyncing: true, error: null }));
    try {
      const settings = await getSettings(ctx);
      if (!settings) throw new Error("Not connected. Open Settings to add your API key.");

      const connections = await getConnections(ctx);
      if (connections.length === 0)
        throw new Error("No accounts connected. Open Settings to add one.");

      // One shared resolver: ticker→symbol mapping is account-independent.
      const resolver = new SymbolResolver(
        (q) => ctx.api.market.searchTicker(q),
        await getSymbolMap(ctx),
      );

      const perAccount: SyncResult[] = [];
      for (const conn of connections) {
        perAccount.push(await syncOne(ctx, settings, conn, resolver));
      }

      if (resolver.isDirty) await setSymbolMap(ctx, resolver.snapshot());

      const totals = perAccount.reduce(
        (acc, r) => ({
          imported: acc.imported + r.imported,
          duplicates: acc.duplicates + r.duplicates,
          unresolved: acc.unresolved + r.unresolved,
        }),
        { imported: 0, duplicates: 0, unresolved: 0 },
      );

      setState({ isSyncing: false, results: { perAccount, totals }, error: null });
    } catch (err) {
      setState((s) => ({ ...s, isSyncing: false, error: (err as Error).message }));
    }
  }

  return { ...state, syncAll };
}
