import { useState } from "react";
import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import type {
  DividendItem,
  ExportReport,
  HistoricalOrder,
  MultiSyncResult,
  Paginated,
  SyncProgress,
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
  ensureProviderAccount,
  getConnections,
  getImportedRefs,
  getSettings,
  getSymbolMap,
  getSyncState,
  resetSyncState,
  setBackfillCheckpoint,
  setLastSync,
  setSymbolMap,
  updateConnection,
} from "./use-config";

interface SyncState {
  isSyncing: boolean;
  results: MultiSyncResult | null;
  error: string | null;
  progress: SyncProgress | null;
}

/** Callback used to stream step-by-step progress out of a running sync. */
type ProgressFn = (p: Omit<SyncProgress, "accountName">) => void;

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

/**
 * Returns the Wealthfolio account id to import into, healing a stale link. If the
 * linked account was deleted in Wealthfolio, recreate it, re-link the connection,
 * and reset this connection's sync state so the (now-gone) history re-imports
 * cleanly instead of every row failing with "Record not found".
 */
async function resolveAccountId(
  ctx: AddonContext,
  conn: T212Connection,
  client: Trading212ProxyClient,
  log: string[],
): Promise<string> {
  const accounts = await ctx.api.accounts.getAll();
  if (accounts.some((a) => a.id === conn.accountId)) return conn.accountId;

  log.push("Linked Wealthfolio account not found — recreating and resetting sync state.");
  const summary = await client.getAccountSummary();
  const accountId = await ensureProviderAccount(ctx, conn.name, summary);
  await updateConnection(ctx, conn.id, { accountId });
  await resetSyncState(ctx, conn.id);
  return accountId;
}

/** Syncs one connection into its linked Wealthfolio account. */
async function syncOne(
  ctx: AddonContext,
  settings: T212Settings,
  conn: T212Connection,
  resolver: SymbolResolver,
  onProgress: ProgressFn,
): Promise<SyncResult> {
  const log: string[] = [];
  const base = { connectionId: conn.id, accountId: conn.accountId, accountName: conn.name, log };
  try {
    const client = new Trading212ProxyClient(connectionConfig(settings, conn));
    // Heal a stale account link (account deleted in Wealthfolio) before doing anything.
    const accountId = await resolveAccountId(ctx, conn, client, log);
    base.accountId = accountId;
    const { lastSync: since, backfillCheckpoint } = await getSyncState(ctx, conn.id);
    const importedRefs = await getImportedRefs(ctx, conn.id);

    // Accumulators shared across every import batch. A backfill imports one batch
    // per year-window (checkpointing as it goes); other paths import a single batch.
    let imported = 0;
    let duplicates = 0;
    let invalidCount = 0;
    let invalidDetail: string | null = null;
    let totalToImport = 0;
    let unresolved = 0;
    const tally: Record<string, number> = {};

    // Imports one batch: validates+imports in chunks (halving on backend rejection),
    // tallies the outcome, and persists this batch's refs so an interrupted backfill
    // doesn't re-import what already landed. Wealthfolio's checkImport/import rejects
    // oversized batches with a 422, so we chunk and adaptively halve down to a single
    // row, which isolates a genuinely bad row.
    const importActivities = async (batch: ActivityImport[]): Promise<void> => {
      if (batch.length === 0) return;
      totalToImport += batch.length;
      for (const a of batch) {
        const k = String(a.activityType);
        tally[k] = (tally[k] ?? 0) + 1;
      }
      const accounted: string[] = [];

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

      for (let i = 0; i < batch.length; i += IMPORT_CHUNK_SIZE) {
        const chunk = batch.slice(i, i + IMPORT_CHUNK_SIZE);
        onProgress({
          phase: "import",
          message: `Importing activities… ${Math.min(i + chunk.length, batch.length)}/${batch.length}`,
          current: i + chunk.length,
          total: batch.length,
        });
        await process(chunk);
      }

      if (accounted.length > 0) await addImportedRefs(ctx, conn.id, accounted);
    };

    if (since === null) {
      log.push("Full backfill (no previous sync) via CSV export.");
      onProgress({ phase: "export", message: "Preparing full-history export…" });
      // ── CSV backfill (full history) ──────────────────────────────────────
      // Trading 212 caps each export at ~1 year, so request (or reuse) one-year
      // windows back from now and stop after two consecutive empty windows. Each
      // window is imported and checkpointed before moving on, so an interrupted
      // backfill resumes from the checkpoint instead of starting over.
      // Falls back to JSON paging if even the first window's export fails.
      const seen = new Set<string>();
      const skipped: Record<string, number> = {};
      let exportFailed = false;
      let backfillComplete = false;

      // Fetch the report list once and reuse it for every window's reuse-check —
      // the /exports list endpoint is limited to ~1/min, so a per-window check 429s.
      let knownReports: ExportReport[] = [];
      try {
        knownReports = await client.listExports();
      } catch {
        // proceed without the cache; runExport will fetch per window if needed
      }

      let windowEnd = backfillCheckpoint ? new Date(backfillCheckpoint) : new Date();
      if (backfillCheckpoint) log.push(`Resuming backfill from checkpoint ${backfillCheckpoint}.`);
      let emptyStreak = 0;
      let w = 0;
      for (; w < MAX_EXPORT_WINDOWS; w++) {
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

        const windowLabel = `${windowStart.toISOString().slice(0, 10)}→${windowEnd
          .toISOString()
          .slice(0, 10)}`;

        onProgress({
          phase: "export",
          message: `Fetching history ${windowLabel} (window ${w + 1})…`,
          current: w,
          total: MAX_EXPORT_WINDOWS,
        });

        let csv: string;
        try {
          csv = await client.runExport({
            timeFrom: windowStart.toISOString(),
            timeTo: windowEnd.toISOString(),
            knownReports,
          });
        } catch (e) {
          log.push(`Window ${windowLabel}: export failed (${errDetail(e)})`);
          // Only fall back to JSON if no history has been retrieved at all. A
          // mid-backfill failure keeps the checkpoint so a re-run resumes here.
          if (w === 0 && !backfillCheckpoint) exportFailed = true;
          break;
        }

        const rows = parseCsv(csv);
        log.push(`Window ${windowLabel}: ${rows.length} rows`);
        if (rows.length === 0) {
          if (++emptyStreak >= 2) {
            backfillComplete = true; // no older history → done
            break;
          }
          windowEnd = windowStart;
          continue;
        }
        emptyStreak = 0;

        const windowActivities: ActivityImport[] = [];
        for (const row of rows) {
          const act = await mapCsvRow(row, accountId, resolver);
          if (act) {
            const id = act.id ?? "";
            if (id && !seen.has(id) && !importedRefs.has(id)) {
              seen.add(id);
              windowActivities.push(act);
            }
          } else {
            // Count failed symbol lookups as unresolved; otherwise record the
            // unmapped action so dropped rows are visible in the log.
            const action = (row["Action"] ?? "").trim();
            const a = action.toLowerCase();
            if (
              row["Ticker"]?.trim() &&
              (a.endsWith(" buy") || a.endsWith(" sell") || a.startsWith("dividend"))
            ) {
              unresolved++;
            } else if (action) {
              skipped[action] = (skipped[action] ?? 0) + 1;
            }
          }
        }

        // Import this window and checkpoint before moving on, so an interruption
        // resumes from here rather than re-fetching everything already imported.
        await importActivities(windowActivities);
        windowEnd = windowStart;
        await setBackfillCheckpoint(ctx, conn.id, windowStart.toISOString());
      }
      if (w >= MAX_EXPORT_WINDOWS) backfillComplete = true;

      const skippedSummary = Object.entries(skipped)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ");
      if (skippedSummary) log.push(`Skipped (not imported): ${skippedSummary}.`);

      if (exportFailed) {
        // CSV unavailable — use JSON paging for the initial full sync.
        log.push("CSV export unavailable → falling back to JSON paging.");
        const { activities: jsonActs, unresolved: u } = await collectJsonActivities(
          client,
          null,
          importedRefs,
          accountId,
          resolver,
        );
        unresolved += u;
        await importActivities(jsonActs);
        backfillComplete = true;
      }

      // Only mark the full sync complete when the backfill actually finished;
      // otherwise keep the checkpoint so the next run resumes where this left off.
      if (backfillComplete) {
        await setLastSync(ctx, conn.id, new Date().toISOString());
        await setBackfillCheckpoint(ctx, conn.id, null);
      } else {
        log.push("Backfill incomplete — next sync resumes from the checkpoint.");
      }
    } else {
      // ── JSON incremental (since last watermark) ──────────────────────────
      log.push(`Incremental sync since ${since}.`);
      onProgress({ phase: "export", message: "Fetching recent activity…" });
      const { activities: jsonActs, unresolved: u } = await collectJsonActivities(
        client,
        since,
        importedRefs,
        accountId,
        resolver,
      );
      unresolved += u;
      await importActivities(jsonActs);
      await setLastSync(ctx, conn.id, new Date().toISOString());
    }

    const breakdown =
      Object.entries(tally)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ") || "none";
    log.push(`Mapped ${totalToImport} activities: ${breakdown}.`);
    if (unresolved > 0) log.push(`${unresolved} rows skipped (symbol not matched).`);
    log.push(
      `Import: ${imported} imported, ${duplicates} duplicates, ${invalidCount} invalid.`,
    );

    // Nothing imported but some rows were flagged invalid — surface why.
    if (imported === 0 && invalidCount > 0) {
      return {
        ...base,
        imported,
        duplicates,
        unresolved,
        error: `${invalidCount}/${totalToImport} rows invalid: ${invalidDetail ?? "no detail"}`,
      };
    }

    return { ...base, imported, duplicates, unresolved };
  } catch (err) {
    const message =
      (err as Error).message === "UNAUTHORIZED"
        ? "Trading 212 rejected this API key. Check it in Settings."
        : (err as Error).message;
    log.push(`Error: ${message}`);
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
    progress: null,
  });

  async function syncAll() {
    setState((s) => ({ ...s, isSyncing: true, error: null, progress: null }));
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
        const report: ProgressFn = (p) =>
          setState((s) => ({ ...s, progress: { accountName: conn.name, ...p } }));
        perAccount.push(await syncOne(ctx, settings, conn, resolver, report));
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

      setState({ isSyncing: false, results: { perAccount, totals }, error: null, progress: null });
    } catch (err) {
      setState((s) => ({ ...s, isSyncing: false, progress: null, error: (err as Error).message }));
    }
  }

  return { ...state, syncAll };
}
