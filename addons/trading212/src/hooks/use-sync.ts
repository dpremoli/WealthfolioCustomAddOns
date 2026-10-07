import { useState } from "react";
import type { Account, ActivityImport, AddonContext, SnapshotHoldingInput } from "@wealthfolio/addon-sdk";
import {
  appendStep,
  markLastDone,
  type SyncProgress as KitSyncProgress,
  type SyncStep as KitSyncStep,
} from "@wf-addons/kit";
import type {
  DividendItem,
  ExportReport,
  HistoricalOrder,
  Instrument,
  MultiSyncResult,
  Paginated,
  Position,
  SyncPhaseId,
  SyncProgress,
  SyncResult,
  T212Connection,
  T212Settings,
  T212TrackingMode,
  TradableInstrument,
  TransactionItem,
} from "../types";
import { Trading212Client, cursorFromNextPage, isUnauthorized, transactionPageParams } from "../lib/t212-client";
import {
  mapDividendToActivity,
  mapOrderToActivity,
  mapPositionToHolding,
  mapTransactionToActivity,
  mergeHoldingsBySymbol,
} from "../lib/mapper";
import { parseCsv, mapCsvRow } from "../lib/csv";
import { SymbolResolver, type ResolveDiag } from "../lib/symbol-resolver";
import {
  addImportedRefs,
  clearAccountData,
  connectionConfig,
  ensureCardAccount,
  ensureProviderAccount,
  getConnections,
  getImportedRefs,
  getSettings,
  getSymbolMap,
  getSyncState,
  resetSyncState,
  setBackfillCheckpoint,
  setCardLastSync,
  setLastSync,
  setSymbolMap,
  updateConnection,
} from "./use-config";

/** Effective tracking mode of a connection (absent ⇒ TRANSACTIONS). */
function connectionMode(conn: T212Connection): T212TrackingMode {
  return conn.trackingMode ?? "TRANSACTIONS";
}

interface SyncState {
  isSyncing: boolean;
  results: MultiSyncResult | null;
  error: string | null;
  progress: KitSyncProgress<SyncPhaseId> | null;
  // Live timeline of every `onProgress` step the sync emits. Resets each `syncAll`,
  // appended to as phases land. Drives the activity feed in the dashboard.
  steps: KitSyncStep<SyncPhaseId>[];
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
  client: Trading212Client,
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
  client: Trading212Client,
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
 * Fetches card spend/refund/cashback rows (CSV-only data) for the dedicated card
 * account. On the first run (`cardSince` null) it walks back up to MAX_EXPORT_WINDOWS
 * one-year windows to backfill card history; thereafter it fetches a single window since
 * the card watermark. Rows are mapped with `cardAccountId`, and only those that actually
 * routed to the card account are returned (non-card rows are handled by the JSON path).
 * Already-imported rows are skipped via `importedRefs`; the import's own duplicate check
 * is the backstop.
 */
async function fetchCardActivities(
  client: Trading212Client,
  resolver: SymbolResolver,
  mainAccountId: string,
  cardAccountId: string,
  cardSince: string | null,
  importedRefs: Set<string>,
  log: string[],
  onProgress: ProgressFn,
): Promise<ActivityImport[]> {
  // Build the window list: a single recent window when we already have a watermark,
  // otherwise a chain of one-year windows walked back from now (first-time backfill).
  const now = new Date();
  const windows: { start: Date; end: Date }[] = [];
  if (cardSince) {
    windows.push({ start: new Date(cardSince), end: now });
  } else {
    let end = now;
    for (let w = 0; w < MAX_EXPORT_WINDOWS; w++) {
      const start = new Date(
        Date.UTC(
          end.getUTCFullYear() - 1,
          end.getUTCMonth(),
          end.getUTCDate(),
          end.getUTCHours(),
          end.getUTCMinutes(),
          end.getUTCSeconds(),
        ),
      );
      windows.push({ start, end });
      end = start;
    }
  }

  let knownReports: ExportReport[] = [];
  try {
    knownReports = await client.listExports();
  } catch {
    // proceed without the cache; runExport fetches the list itself if needed
  }

  const out: ActivityImport[] = [];
  const seen = new Set<string>();
  let emptyStreak = 0;
  for (const { start, end } of windows) {
    const label = `${start.toISOString().slice(0, 10)}→${end.toISOString().slice(0, 10)}`;
    onProgress({ phase: "export", message: `Fetching card history ${label}…` });
    let csv: string;
    try {
      csv = await client.runExport({
        timeFrom: start.toISOString(),
        timeTo: end.toISOString(),
        knownReports,
        onNote: (m) => log.push(m),
      });
    } catch (e) {
      log.push(`Card window ${label}: export failed (${errDetail(e)})`);
      break;
    }
    const rows = parseCsv(csv);
    if (rows.length === 0) {
      // During a first-time backfill, two empty windows in a row means no older history.
      if (!cardSince && ++emptyStreak >= 2) break;
      continue;
    }
    emptyStreak = 0;
    for (const row of rows) {
      const act = await mapCsvRow(row, mainAccountId, resolver, cardAccountId);
      if (!act || act.accountId !== cardAccountId) continue; // keep card rows only
      const id = act.id ?? "";
      if (id && !seen.has(id) && !importedRefs.has(id)) {
        seen.add(id);
        out.push(act);
      }
    }
  }
  if (out.length > 0) log.push(`Card sync: ${out.length} card row(s) to import.`);
  return out;
}

/**
 * Self-contained card pipeline: fetches the connection's card rows ({@link fetchCardActivities})
 * and imports them into the dedicated card account, advancing the card watermark. Used by the
 * HOLDINGS path (whose main account has no activity import) and by incremental TRANSACTIONS
 * syncs (where card data isn't in the JSON feed). The TRANSACTIONS *full backfill* doesn't use
 * this — it routes card rows inline through the shared CSV loop. Import uses the same
 * checkImport → adaptive-halve → import pattern as the main path; card volume is low.
 */
async function syncCardAccount(
  ctx: AddonContext,
  client: Trading212Client,
  conn: T212Connection,
  mainAccountId: string,
  cardAccountId: string,
  resolver: SymbolResolver,
  log: string[],
  onProgress: ProgressFn,
): Promise<{ imported: number; duplicates: number }> {
  const { cardLastSync } = await getSyncState(ctx, conn.id);
  const importedRefs = await getImportedRefs(ctx, conn.id);
  const acts = await fetchCardActivities(
    client,
    resolver,
    mainAccountId,
    cardAccountId,
    cardLastSync ?? null,
    importedRefs,
    log,
    onProgress,
  );

  let imported = 0;
  let duplicates = 0;
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
      throw new Error(`card import rejected a single activity: ${errDetail(e)} — payload=${JSON.stringify(items[0])}`);
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
      throw new Error(`card checkImport rejected a single activity: ${errDetail(e)} — payload=${JSON.stringify(chunk[0])}`);
    }
    const dupes = checked.filter((a) => a.duplicateOfId);
    const toImport = checked.filter((a) => a.isValid !== false && !a.duplicateOfId);
    duplicates += dupes.length;
    for (const a of dupes) if (a.id) accounted.push(a.id);
    await doImport(toImport);
  };

  if (acts.length > 0) onProgress({ phase: "import", message: `Importing ${acts.length} card activities…` });
  for (let i = 0; i < acts.length; i += IMPORT_CHUNK_SIZE) {
    await process(acts.slice(i, i + IMPORT_CHUNK_SIZE));
  }

  if (accounted.length > 0) await addImportedRefs(ctx, conn.id, accounted);
  // Only advance the watermark once we've actually seen card data — otherwise a first
  // sync that returned an empty CSV would pin the window to "now→now" forever, silently
  // skipping any rows the user adds afterwards. With no rows AND no prior watermark, leave
  // it unset so the next sync re-runs the full backfill walk.
  const hadPriorWatermark = !!(await getSyncState(ctx, conn.id)).cardLastSync;
  if (acts.length > 0 || hadPriorWatermark) {
    await setCardLastSync(ctx, conn.id, new Date().toISOString());
  } else {
    log.push("Card account: no rows found yet — leaving the backfill window open for next sync.");
  }
  if (imported > 0 || duplicates > 0) log.push(`Card account: ${imported} imported, ${duplicates} duplicates.`);
  return { imported, duplicates };
}

/**
 * Returns the Wealthfolio account to sync into, healing a stale link. If the
 * linked account was deleted in Wealthfolio, recreate it (in the connection's
 * tracking mode), re-link the connection, and reset this connection's sync state
 * so the (now-gone) history re-imports cleanly instead of every row failing with
 * "Record not found". `account` is null when freshly recreated.
 */
async function resolveAccountId(
  ctx: AddonContext,
  conn: T212Connection,
  client: Trading212Client,
  log: string[],
): Promise<{ accountId: string; account: Account | null }> {
  const accounts = await ctx.api.accounts.getAll();
  const match = accounts.find((a) => a.id === conn.accountId);
  if (match) return { accountId: match.id, account: match };

  log.push("Linked Wealthfolio account not found — recreating and resetting sync state.");
  const summary = await client.getAccountSummary();
  const accountId = await ensureProviderAccount(ctx, conn.name, summary, connectionMode(conn));
  await updateConnection(ctx, conn.id, { accountId });
  await resetSyncState(ctx, conn.id);
  return { accountId, account: null };
}

/** One-line, human-readable dump of a resolution: chosen symbol + the raw
 *  search candidates (symbol/currency/MIC/score, ✓ = already in Wealthfolio).
 *  Surfaces in the sync report's Details panel for verifying cross-listings. */
function formatResolveDiag(d: ResolveDiag): string {
  const chosen = d.chosen
    ? `${d.chosen.symbol}${d.chosen.exchangeMic ? `@${d.chosen.exchangeMic}` : ""}`
    : "—";
  const cands = d.candidates
    .slice(0, 8)
    .map(
      (c) =>
        `${c.symbol}/${c.currency ?? "?"}/${c.exchangeMic ?? "?"}/s${c.score ?? 0}${c.isExisting ? "✓" : ""}`,
    )
    .join(", ");
  const more = d.candidates.length > 8 ? ` +${d.candidates.length - 8} more` : "";
  return `[resolve] ${d.ticker} → ${chosen} | ${cands || "no candidates"}${more}`;
}

/** True when a position carries no embedded ISIN/currency to resolve its listing from. */
function lacksInstrumentDetail(pos: Position): boolean {
  return !pos.instrument?.isin || !pos.instrument?.currency;
}

/** HOLDINGS-mode sync: writes a current positions + cash snapshot (no history). */
async function syncHoldings(
  ctx: AddonContext,
  client: Trading212Client,
  conn: T212Connection,
  accountId: string,
  resolver: SymbolResolver,
  onProgress: ProgressFn,
  log: string[],
  base: { connectionId: string; accountId: string; accountName: string; log: string[] },
): Promise<SyncResult> {
  log.push("Holdings sync — writing a current positions snapshot.");
  onProgress({ phase: "export", message: "Fetching current positions…" });
  const summary = await client.getAccountSummary();
  const positions = await client.getPositions();
  const accountCurrency = summary.currency || "GBP";

  // The /positions payload may carry only a bare ticker, so cross-reference the
  // instruments metadata for each holding's ISIN/currency/name. Accurate symbol
  // resolution depends on the instrument currency to disambiguate cross-listings
  // (e.g. TSM/USD vs the MXN-quoted TSMN) and the ISIN to find the right listing.
  // The instruments feed is ~5 MB upstream — over the host's 2 MB response cap — and rate
  // limited to 1 request / 50 s, so only ask for it when a position actually lacks the data.
  const instrumentMeta = new Map<string, TradableInstrument>();
  if (positions.some(lacksInstrumentDetail)) {
    try {
      for (const ins of await client.getInstruments()) instrumentMeta.set(ins.ticker, ins);
    } catch (e) {
      log.push(`Instrument metadata unavailable (${errDetail(e)}) — resolving from ticker only.`);
    }
  }

  onProgress({ phase: "map", message: "Matching symbols…" });
  const mapped: SnapshotHoldingInput[] = [];
  let unresolved = 0;
  // Diagnostic: log what market.searchTicker returned per ticker and what we
  // chose, so cross-listing resolution can be verified from the sync report.
  const diag = (d: ResolveDiag) => log.push(formatResolveDiag(d));
  for (const pos of positions) {
    const ticker = pos.instrument?.ticker ?? pos.ticker;
    if (!ticker) continue;
    const meta = instrumentMeta.get(ticker);
    const instrument: Instrument = {
      ticker,
      isin: pos.instrument?.isin ?? meta?.isin,
      name: pos.instrument?.name ?? meta?.name ?? meta?.shortName,
      currency: pos.instrument?.currency ?? meta?.currencyCode,
    };
    const resolved = await resolver.resolveDetailed(ticker, instrument, diag);
    if (!resolved) {
      unresolved++;
      continue;
    }
    mapped.push(
      mapPositionToHolding(
        { ...pos, instrument },
        resolved.symbol,
        accountCurrency,
        resolved.exchangeMic,
      ),
    );
  }

  // Two positions can resolve to one symbol (a same-ISIN cross-listing the
  // resolver couldn't keep distinct). A snapshot keeps one holding per symbol, so
  // merge rather than let a leg get silently dropped — preserving total value.
  const holdings = mergeHoldingsBySymbol(mapped);
  if (holdings.length < mapped.length) {
    log.push(`Merged ${mapped.length - holdings.length} position(s) that resolved to a shared symbol (cross-listing collapse).`);
  }

  const cashBalances: Record<string, string> = {
    [accountCurrency]: String(summary.cash?.availableToTrade ?? 0),
  };

  onProgress({ phase: "import", message: `Saving snapshot (${holdings.length} holdings)…` });
  await ctx.api.snapshots.save(accountId, holdings, cashBalances);
  await setLastSync(ctx, conn.id, new Date().toISOString());

  log.push(`Snapshot saved: ${holdings.length} holdings, cash ${cashBalances[accountCurrency]} ${accountCurrency}.`);
  if (unresolved > 0) log.push(`${unresolved} positions skipped (symbol not matched).`);
  onProgress({ phase: "done", message: "Snapshot saved." });

  // HOLDINGS has no per-type tally (it's a single snapshot), but the dashboard's Summary
  // tab requires `breakdown` to enable. Surface the holdings count so the tab has content;
  // the card sync — when on — adds its own row in the caller.
  return {
    ...base,
    imported: holdings.length,
    duplicates: 0,
    unresolved,
    breakdown: { Holdings: holdings.length },
  };
}

/** Syncs one connection into its linked Wealthfolio account. */
async function syncOne(
  ctx: AddonContext,
  settings: T212Settings,
  conn: T212Connection,
  resolver: SymbolResolver,
  onProgress: ProgressFn,
  confirmedModeSwitches: Set<string>,
): Promise<SyncResult> {
  const log: string[] = [];
  const base = { connectionId: conn.id, accountId: conn.accountId, accountName: conn.name, log };
  if (conn.needsCredentials) {
    // Migrated from a v1 legacy single-key connection: the API now needs key ID + secret.
    const message = "Needs credentials: re-enter the API key ID and secret in Settings.";
    log.push(`Skipped: ${message}`);
    return { ...base, imported: 0, duplicates: 0, unresolved: 0, finishedAt: new Date().toISOString(), error: message };
  }
  try {
    const client = new Trading212Client(ctx, connectionConfig(settings, conn));
    // Heal a stale account link (account deleted in Wealthfolio) before doing anything.
    const { accountId, account } = await resolveAccountId(ctx, conn, client, log);
    base.accountId = accountId;

    // Reconcile the tracking mode. The Wealthfolio account's mode is authoritative
    // (the add-on can't change it after creation); if the user switched it natively,
    // the data we synced under the old mode is now stale. Clearing is destructive, so
    // it only happens once the dashboard has confirmed this connection's switch.
    const current = connectionMode(conn);
    const liveMode = account?.trackingMode;
    let mode: T212TrackingMode = current;
    if (liveMode && liveMode !== "NOT_SET" && liveMode !== current) {
      if (!confirmedModeSwitches.has(conn.id)) {
        log.push(
          `Tracking mode changed to ${liveMode} in Wealthfolio — confirm in the dashboard to clear the ${current} data and re-sync.`,
        );
        return {
          ...base,
          imported: 0,
          duplicates: 0,
          unresolved: 0,
          error: `Tracking mode changed to ${liveMode}. Run Sync All and confirm to re-sync.`,
        };
      }
      log.push(`Tracking mode changed ${current} → ${liveMode}; clearing ${current} data and re-syncing.`);
      onProgress({ phase: "map", message: `Clearing ${current.toLowerCase()} data…` });
      await clearAccountData(ctx, conn.id, accountId, current);
      await updateConnection(ctx, conn.id, { trackingMode: liveMode });
      mode = liveMode;
    }

    // Card extraction (opt-in): ensure the dedicated "<name> Card" cash account exists so
    // card spend/refund/cashback rows go there instead of the investing account. It's an
    // independent CASH activity account, so it works regardless of the main account's mode —
    // in TRANSACTIONS the full backfill routes card rows inline; in HOLDINGS (and incremental
    // TRANSACTIONS) `syncCardAccount` imports them via its own CSV window. `undefined` ⇒ off.
    // Skipped for ISA — Trading 212's Stocks ISA has no card, so creating the side account
    // would just create an empty stub.
    const isIsa = conn.kind === "isa";
    if (settings.extractCard && isIsa) {
      log.push("Card extraction skipped: ISA accounts don't have a card.");
    }
    const cardAccountId = settings.extractCard && !isIsa
      ? await ensureCardAccount(ctx, conn, await client.getAccountSummary(), settings.cardAccountType ?? "CASH")
      : undefined;

    if (mode === "HOLDINGS") {
      const res = await syncHoldings(ctx, client, conn, accountId, resolver, onProgress, log, base);
      const out: SyncResult = { ...res, finishedAt: new Date().toISOString() };
      if (cardAccountId) {
        const card = await syncCardAccount(ctx, client, conn, accountId, cardAccountId, resolver, log, onProgress);
        out.imported += card.imported;
        out.duplicates += card.duplicates;
        out.card = card;
        // Surface the card import in the Summary tab too — HOLDINGS only has Holdings + Card.
        if (card.imported > 0) {
          out.breakdown = { ...(out.breakdown ?? {}), Card: card.imported };
        }
      }
      return out;
    }

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
    let cardResult: { imported: number; duplicates: number } | null = null;

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
            onNote: (m) => log.push(m),
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
          const act = await mapCsvRow(row, accountId, resolver, cardAccountId);
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
        // Card rows were routed inline during the backfill above — mark the card
        // pipeline backfilled so incremental syncs only fetch a recent top-up window.
        if (cardAccountId) await setCardLastSync(ctx, conn.id, new Date().toISOString());
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

      // Card data is CSV-only (the JSON feed has no card type), so refresh it separately
      // via its own watermark: a one-time backfill the first time extraction is on, then a
      // recent top-up window thereafter.
      if (cardAccountId) {
        cardResult = await syncCardAccount(ctx, client, conn, accountId, cardAccountId, resolver, log, onProgress);
        imported += cardResult.imported;
        duplicates += cardResult.duplicates;
      }
    }

    if (cardResult) tally.Card = (tally.Card ?? 0) + cardResult.imported;

    const breakdownLine =
      Object.entries(tally)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ") || "none";
    log.push(`Mapped ${totalToImport} activities: ${breakdownLine}.`);
    if (unresolved > 0) log.push(`${unresolved} rows skipped (symbol not matched).`);
    log.push(
      `Import: ${imported} imported, ${duplicates} duplicates, ${invalidCount} invalid.`,
    );

    const finishedAt = new Date().toISOString();

    // Nothing imported but some rows were flagged invalid — surface why.
    if (imported === 0 && invalidCount > 0) {
      return {
        ...base,
        imported,
        duplicates,
        unresolved,
        breakdown: tally,
        card: cardResult ?? undefined,
        finishedAt,
        error: `${invalidCount}/${totalToImport} rows invalid: ${invalidDetail ?? "no detail"}`,
      };
    }

    return { ...base, imported, duplicates, unresolved, breakdown: tally, card: cardResult ?? undefined, finishedAt };
  } catch (err) {
    const message = isUnauthorized(err)
      ? "Trading 212 rejected this API key. Check it in Settings."
      : (err as Error).message;
    log.push(`Error: ${message}`);
    return { ...base, imported: 0, duplicates: 0, unresolved: 0, finishedAt: new Date().toISOString(), error: message };
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

/** Options for {@link runSyncAll}. */
export interface RunSyncOptions {
  /** Connection ids the user confirmed clearing+re-syncing after a mode drift. */
  confirmedModeSwitches?: Set<string>;
  /** Restrict the sync to these connection ids (used by the background scheduler to
   *  sync only the accounts that are due). Absent ⇒ all connections. */
  onlyConnectionIds?: Set<string>;
  /** Receives live per-account progress (the React hook maps this to UI state). */
  onProgress?: (p: SyncProgress) => void;
}

/**
 * Runs a full sync across connections. Framework-agnostic (no React) so it can be
 * driven both by the dashboard's "Sync All" button and by the background auto-sync
 * scheduler. Throws if there are no settings / no connections; individual account
 * failures are captured per-account and don't abort the others.
 */
export async function runSyncAll(
  ctx: AddonContext,
  opts: RunSyncOptions = {},
): Promise<MultiSyncResult> {
  const confirmedModeSwitches = opts.confirmedModeSwitches ?? new Set<string>();

  const settings = await getSettings(ctx);
  if (!settings) throw new Error("Not connected. Open Settings to add your API key ID and secret.");

  let connections = await getConnections(ctx);
  if (connections.length === 0)
    throw new Error("No accounts connected. Open Settings to add one.");

  if (opts.onlyConnectionIds) {
    connections = connections.filter((c) => opts.onlyConnectionIds!.has(c.id));
  }

  // One shared resolver: ticker→symbol mapping is account-independent.
  const resolver = new SymbolResolver(
    (q) => ctx.api.market.searchTicker(q),
    await getSymbolMap(ctx),
  );

  const perAccount: SyncResult[] = [];
  for (const conn of connections) {
    const report: ProgressFn = (p) => opts.onProgress?.({ accountName: conn.name, ...p });
    perAccount.push(await syncOne(ctx, settings, conn, resolver, report, confirmedModeSwitches));
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

  return { perAccount, totals };
}

export function useSync(ctx: AddonContext) {
  const [state, setState] = useState<SyncState>({
    isSyncing: false,
    results: null,
    error: null,
    progress: null,
    steps: [],
  });

  async function syncAll(confirmedModeSwitches: Set<string> = new Set()) {
    setState((s) => ({ ...s, isSyncing: true, error: null, progress: null, steps: [] }));
    try {
      const results = await runSyncAll(ctx, {
        confirmedModeSwitches,
        onProgress: ({ accountName, ...p }) => {
          // The shared activity feed shows messages only, so carry the account in the text.
          const progress = { ...p, message: `${accountName}: ${p.message}` };
          setState((s) => ({
            ...s,
            progress,
            steps: appendStep(s.steps, progress),
          }));
        },
      });
      // Mark the last step as done so the timeline shows a final check on every node.
      setState((s) => ({
        ...s,
        isSyncing: false,
        results,
        error: null,
        progress: null,
        steps: markLastDone(s.steps),
      }));
    } catch (err) {
      setState((s) => ({ ...s, isSyncing: false, progress: null, error: (err as Error).message }));
    }
  }

  return { ...state, syncAll };
}
