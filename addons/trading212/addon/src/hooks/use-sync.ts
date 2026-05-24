import { useState } from "react";
import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import type {
  DividendItem,
  HistoricalOrder,
  Paginated,
  SyncResult,
  TransactionItem,
} from "../types";
import { Trading212ProxyClient, cursorFromNextPage } from "../lib/proxy-client";
import {
  mapDividendToActivity,
  mapOrderToActivity,
  mapTransactionToActivity,
} from "../lib/mapper";
import { SymbolResolver } from "../lib/symbol-resolver";
import {
  addImportedRefs,
  getAccountId,
  getConfig,
  getImportedRefs,
  getLastSync,
  getSymbolMap,
  setLastSync,
  setSymbolMap,
} from "./use-config";

interface SyncState {
  isSyncing: boolean;
  lastResult: SyncResult | null;
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

export function useSync(ctx: AddonContext) {
  const [state, setState] = useState<SyncState>({
    isSyncing: false,
    lastResult: null,
    error: null,
  });

  async function sync() {
    setState((s) => ({ ...s, isSyncing: true, error: null }));
    try {
      const config = await getConfig(ctx);
      if (!config) throw new Error("Not connected. Open Settings to add your API key.");

      const accountId = await getAccountId(ctx);
      if (!accountId)
        throw new Error("No Wealthfolio account linked. Open Settings to set it up.");

      const since = await getLastSync(ctx);
      const importedRefs = await getImportedRefs(ctx);
      const client = new Trading212ProxyClient(config);
      const resolver = new SymbolResolver(
        (q) => ctx.api.market.searchTicker(q),
        await getSymbolMap(ctx),
      );

      const [orders, dividends, transactions] = [
        await collectSince<HistoricalOrder>(
          (c) => client.pageOrders(c),
          (o) => o.fill?.filledAt || o.order?.createdAt,
          since,
        ),
        await collectSince<DividendItem>(
          (c) => client.pageDividends(c),
          (d) => d.paidOn,
          since,
        ),
        await collectTransactions(client, since),
      ];

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
          continue; // can't import a trade without a resolved symbol
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

      if (resolver.isDirty) await setSymbolMap(ctx, resolver.snapshot());

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
        await addImportedRefs(ctx, accounted);
      }

      await setLastSync(ctx, new Date().toISOString());

      setState({
        isSyncing: false,
        lastResult: { imported, duplicates, unresolved },
        error: null,
      });
    } catch (err) {
      const message =
        (err as Error).message === "UNAUTHORIZED"
          ? "Trading 212 rejected your API key. Check it in Settings."
          : (err as Error).message;
      setState((s) => ({ ...s, isSyncing: false, error: message }));
    }
  }

  return { ...state, sync };
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
