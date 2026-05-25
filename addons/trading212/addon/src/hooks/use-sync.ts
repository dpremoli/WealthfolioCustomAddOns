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
import { Trading212ProxyClient, cursorFromNextPage } from "../lib/proxy-client";
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

/** Transactions support a server-side `time` filter, so we page from `since` forward. */
async function collectTransactions(
  client: Trading212ProxyClient,
  since: string | null,
): Promise<TransactionItem[]> {
  const out: TransactionItem[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < PAGE_GUARD; i++) {
    const page = await client.pageTransactions({
      cursor,
      time: cursor ? undefined : since || undefined,
    });
    out.push(...(page.items ?? []));
    const next = cursorFromNextPage(page.nextPagePath);
    if (!next) break;
    cursor = next;
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
      // Falls back to JSON paging if the export fails or times out.
      let csvText: string | null = null;
      try {
        csvText = await client.runExport();
      } catch {
        // intentional: fall through to JSON paging
      }

      if (csvText !== null) {
        const rows = parseCsv(csvText);
        const mapped: ActivityImport[] = [];
        let csvUnresolved = 0;
        for (const row of rows) {
          const act = await mapCsvRow(row, conn.accountId, resolver);
          if (act) {
            if (!importedRefs.has(act.id ?? "")) mapped.push(act);
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
        activities = mapped;
        unresolved = csvUnresolved;
      } else {
        // CSV unavailable — use JSON paging for the initial full sync.
        ({ activities, unresolved } = await collectJsonActivities(
          client,
          null,
          importedRefs,
          conn.accountId,
          resolver,
        ));
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
    let imported = 0;
    let duplicates = 0;
    if (activities.length > 0) {
      const checked = await ctx.api.activities.checkImport(activities);
      const toImport = checked.filter((a) => a.isValid !== false && !a.duplicateOfId);
      const dupes = checked.filter((a) => a.duplicateOfId);
      duplicates = dupes.length;

      if (toImport.length > 0) {
        const res = await ctx.api.activities.import(toImport);
        imported = res.summary.imported;
      }

      const accounted = [...toImport, ...dupes]
        .map((a) => a.id)
        .filter((id): id is string => !!id);
      await addImportedRefs(ctx, conn.id, accounted);
    }

    await setLastSync(ctx, conn.id, new Date().toISOString());

    return { ...base, imported, duplicates, unresolved };
  } catch (err) {
    const message =
      (err as Error).message === "UNAUTHORIZED"
        ? "Trading 212 rejected this API key. Check it in Settings."
        : (err as Error).message;
    return { ...base, imported: 0, duplicates: 0, unresolved: 0, error: message };
  }
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
