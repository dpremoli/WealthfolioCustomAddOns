import { useEffect, useState } from "react";
import type { Account, ActivityImport, AddonContext, SnapshotHoldingInput } from "@wealthfolio/addon-sdk";
import {
  T212_PROVIDER,
  appendStep,
  describeRefused,
  isTrading212Payee,
  linkMovesBetween,
  markLastDone,
  moveLinkNote,
  refusedError,
  round2,
  trading212Refs,
  type ExistingActivityLike,
  spendingRulesNote,
  syncSpendingRules,
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
import { parseCsv, mapCsvRow, dividendShareOf } from "../lib/csv";
import { cardSpendingRules } from "../lib/spending-category";
import { SymbolResolver, importAssetFields, type ResolveDiag } from "../lib/symbol-resolver";
import { ActivityImporter, describeRejected, type ImportUnit, type RejectedRow } from "../lib/importer";
import { RefusedRowsStore } from "../lib/refused";
import { CARD_FUNDING_COMMENT, fundingForExisting, isFundingId, withCardFunding } from "../lib/card-funding";
import { foldMonthlyInterest } from "../lib/interest";
import { repairSplits, type DividendShares, type PositionGap } from "../lib/split-repair";
import {
  describeRow,
  mapCurrencyConversion,
  mapStockSplit,
  pairStockSplits,
  splitCorporateRows,
} from "../lib/corporate-actions";
import {
  PortfolioUpdates,
  compareWithTrading212,
  resolvePositions,
  trading212Cash,
  verificationLines,
  type Verification,
} from "../lib/verify";
import {
  addDividendShares,
  addImportedRefs,
  clearAccountData,
  clearImportedRefs,
  connectionKind,
  setBackfillStartedAt,
  connectionConfig,
  ensureCardAccount,
  ensureProviderAccount,
  getConnections,
  getDividendShares,
  getImportedRefs,
  getSettings,
  getSymbolMap,
  getSyncState,
  loadLastResults,
  loadLastSteps,
  resetSyncState,
  saveLastResult,
  saveLastSteps,
  setBackfillCheckpoint,
  setCardLastSync,
  setLastSync,
  setSymbolMap,
  setVerification,
  updateConnection,
  type DividendShare,
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

// Trading 212 caps each CSV export at ~1 year, so a full backfill walks back in
// one-year windows. Caps the walk so a sparse history can't loop forever.
const MAX_EXPORT_WINDOWS = 15;

/** Card history is refreshed at most this often (each refresh is a slow CSV export). */
const CARD_REFRESH_MS = 3 * 60 * 60 * 1000;

/** Whether an RFC 3339 timestamp is at or before the watermark (compared as instants). */
function atOrBefore(d: string, since: string): boolean {
  const a = Date.parse(d);
  const b = Date.parse(since);
  return Number.isNaN(a) || Number.isNaN(b) ? d <= since : a <= b;
}

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
      if (since && d && atOrBefore(d, since)) return out;
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
      if (since && t.dateTime && atOrBefore(t.dateTime, since)) return out;
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
): Promise<{
  activities: ActivityImport[];
  unresolved: number;
  unresolvedRows: string[];
  nonTrade: Record<string, number>;
  /** The holding each dividend was paid on, as evidence for a split Trading 212 did not list. */
  dividendShares: DividendShare[];
}> {
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
  // Trades left out because their symbol did not resolve (each leaves a position wrong).
  const unresolvedRows: string[] = [];
  // Fills that are not trades (splits, stock dividends, spin-offs, …) are not imported;
  // counted so the log says what was left out.
  const nonTrade: Record<string, number> = {};

  for (const ho of orders) {
    const o = ho.order;
    if (!o || o.id === undefined) continue;
    if (importedRefs.has(`t212-order-${o.id}`)) continue;
    if (ho.fill?.type && ho.fill.type !== "TRADE") {
      nonTrade[ho.fill.type] = (nonTrade[ho.fill.type] ?? 0) + 1;
      continue;
    }
    // Map first: cancelled/rejected orders (no fill) need no symbol lookup.
    const activity = mapOrderToActivity(ho, accountId, "");
    if (!activity) continue;
    const ticker = o.instrument?.ticker ?? o.ticker;
    if (!ticker) continue;
    const resolved = await resolver.resolveDetailed(ticker, o.instrument);
    if (!resolved) {
      unresolved++;
      unresolvedRows.push(
        `Not imported: ${o.side ?? "order"} ${ho.fill?.filledAt ?? o.createdAt ?? ""} ${ticker} ` +
          `(${o.instrument?.name ?? "?"}, ISIN ${o.instrument?.isin ?? "?"}, order ${o.id}): symbol not matched`,
      );
      continue;
    }
    activities.push({ ...activity, ...importAssetFields(resolved) });
  }

  const dividendShares: DividendShare[] = [];
  for (const d of dividends) {
    const isin = d.instrument?.isin;
    // Interest and adjustments carry no holding of their own (the CSV path leaves them out too).
    if (d.type !== "INTEREST" && !/adjust/i.test(d.type ?? "") && isin && d.quantity && d.quantity > 0 && d.paidOn) {
      dividendShares.push({ isin, day: d.paidOn.slice(0, 10), shares: d.quantity });
    }
    if (importedRefs.has(`t212-div-${d.reference}`)) continue;
    if (d.type === "INTEREST") {
      activities.push(mapDividendToActivity(d, accountId, null));
      continue;
    }
    const resolved = d.ticker ? await resolver.resolveDetailed(d.ticker, d.instrument) : null;
    if (!resolved) {
      unresolved++;
      continue;
    }
    activities.push({ ...mapDividendToActivity(d, accountId, resolved.symbol), ...importAssetFields(resolved) });
  }

  for (const t of transactions) {
    if (importedRefs.has(`t212-txn-${t.reference}`)) continue;
    activities.push(mapTransactionToActivity(t, accountId));
  }

  return { activities, unresolved, unresolvedRows, nonTrade, dividendShares };
}

/** Log line for non-trade fills left out of the import, if any. */
function nonTradeNote(nonTrade: Record<string, number>): string | null {
  const parts = Object.entries(nonTrade).map(([k, v]) => `${v} ${k}`);
  return parts.length
    ? `Not imported (corporate-action fills, add them manually if they changed your holdings): ${parts.join(", ")}.`
    : null;
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
): Promise<{ activities: ActivityImport[]; complete: boolean }> {
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
  let complete = true;
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
      complete = false;
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
  return { activities: out, complete };
}

/**
 * Files card spending under Wealthfolio's spend categories: keeps one categorisation rule per
 * card label in place and re-runs rules over uncategorised activities. Best effort.
 */
async function categoriseCardSpending(ctx: AddonContext, log: string[]): Promise<void> {
  const note = spendingRulesNote(await syncSpendingRules(ctx, cardSpendingRules()));
  if (note) log.push(note);
}

/**
 * Self-contained card pipeline: fetches the connection's card rows ({@link fetchCardActivities})
 * and imports them into the dedicated card account, each with the transfer pair that funds it
 * from the investing account ({@link withCardFunding}), advancing the card watermark. Used by the
 * HOLDINGS path (whose main account has no activity import) and by incremental TRANSACTIONS
 * syncs (where card data isn't in the JSON feed). The TRANSACTIONS *full backfill* doesn't use
 * this — it routes card rows inline through the shared CSV loop.
 */
async function syncCardAccount(
  ctx: AddonContext,
  client: Trading212Client,
  conn: T212Connection,
  mainAccountId: string,
  cardAccountId: string,
  resolver: SymbolResolver,
  importer: ActivityImporter,
  log: string[],
  onProgress: ProgressFn,
  refused: RefusedRowsStore,
): Promise<{ imported: number; duplicates: number; rejected: RejectedRow[] }> {
  // The card windows end "now", so the watermark is when this run started, not finished.
  const startedAt = new Date().toISOString();
  const { cardLastSync } = await getSyncState(ctx, conn.id);
  // Card rows only exist in CSV exports, and each export takes Trading 212 15-80 s to
  // prepare under its rate limits, so recent card history is refreshed at most every few hours.
  const sinceCard = cardLastSync ? Date.now() - Date.parse(cardLastSync) : Infinity;
  if (sinceCard < CARD_REFRESH_MS) {
    log.push(
      `Card history refreshed ${Math.round(sinceCard / 60_000)} min ago; next refresh in ` +
        `${Math.ceil((CARD_REFRESH_MS - sinceCard) / 60_000)} min.`,
    );
    return { imported: 0, duplicates: 0, rejected: [] };
  }
  const importedRefs = await getImportedRefs(ctx, conn.id);
  const { activities: acts, complete } = await fetchCardActivities(
    client,
    resolver,
    mainAccountId,
    cardAccountId,
    cardLastSync ?? null,
    importedRefs,
    log,
    onProgress,
  );

  if (acts.length > 0) onProgress({ phase: "import", message: `Importing ${acts.length} card activities…` });
  const out = await importer.importRows(acts.map((a) => withCardFunding(a, mainAccountId)));
  if (out.accounted.length > 0) await addImportedRefs(ctx, conn.id, out.accounted);
  // Card rows Wealthfolio refuses wait in the refused list instead of holding the card watermark.
  await refused.record(out);
  // Count card rows, not the funding transfers that travel with them.
  const imported = out.importedIds.filter((id) => !isFundingId(id)).length;
  const duplicates = out.accounted.filter((id) => !isFundingId(id)).length - imported;
  // Advance the watermark once every window was read, even when they were all empty (an
  // account with no card spending): otherwise every sync would repeat the multi-year walk.
  // After a failed export, leave it so the next sync retries the same windows.
  if (complete) {
    await setCardLastSync(ctx, conn.id, startedAt);
  } else {
    log.push("Card history incomplete (an export failed); the next sync retries it.");
  }
  if (imported > 0 || duplicates > 0) {
    log.push(`Card account: ${imported} imported, ${duplicates} duplicates (each with its funding transfer).`);
  }
  return { imported, duplicates, rejected: out.rejected };
}

/**
 * Adds the funding transfer pair for card rows the card account already holds without one
 * (imported before the add-on funded card spending), so its balance and the investing account's
 * cash both match Trading 212. Pairs already there are left out, so this is a no-op once done.
 */
async function fundExistingCardRows(
  importer: ActivityImporter,
  mainAccountId: string,
  cardAccountId: string,
  log: string[],
  refused: RefusedRowsStore,
): Promise<RejectedRow[]> {
  const units = fundingForExisting(
    (await importer.existingIn(cardAccountId)) as (ExistingActivityLike & { id?: string })[],
    cardAccountId,
    mainAccountId,
  );
  const out = await importer.importRows(units);
  await refused.record(out);
  if (out.imported > 0) log.push(`Card funding: added ${out.imported / 2} transfer pairs for earlier card rows.`);
  // Funding pairs for earlier rows are not new activity; keep them out of the sync's counts.
  return out.rejected;
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

  // Trading 212 splits cash into disjoint buckets; all of it is the account's cash.
  const cash = summary.cash;
  const totalCash = round2(
    (cash?.availableToTrade ?? 0) + (cash?.reservedForOrders ?? 0) + (cash?.inPies ?? 0),
  );
  const cashBalances: Record<string, string> = { [accountCurrency]: String(totalCash) };

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
  updates: PortfolioUpdates,
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
      log.push(`Tracking mode changed ${current} → ${liveMode}; re-syncing in ${liveMode} mode.`);
      onProgress({ phase: "map", message: `Switching to ${liveMode.toLowerCase()} mode…` });
      try {
        log.push(await clearAccountData(ctx, conn.id, accountId, current));
      } catch (e) {
        // Leave the connection on its old mode so the user can retry (or switch back) knowingly.
        const message =
          `Could not switch to ${liveMode} mode: deleting the ${current} data failed (${errDetail(e)}). ` +
          "Nothing was re-synced; try again, or switch the account back in Wealthfolio.";
        log.push(message);
        return { ...base, imported: 0, duplicates: 0, unresolved: 0, finishedAt: new Date().toISOString(), error: message };
      }
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
    const isIsa = connectionKind(conn) === "isa";
    if (settings.extractCard && isIsa) {
      log.push("Card extraction skipped: ISA accounts don't have a card.");
    }
    const cardAccountId = settings.extractCard && !isIsa
      ? await ensureCardAccount(ctx, conn, await client.getAccountSummary(), settings.cardAccountType ?? "CASH")
      : undefined;

    // One importer per connection: it reads each account's activities once for the whole sync.
    const importer = new ActivityImporter(ctx);
    // Rows Wealthfolio refuses wait in their own list, retried at the start of every sync, so one
    // never holds a watermark back (and a sync never re-reads history for it).
    const refused = new RefusedRowsStore(ctx, conn.id);

    if (mode === "HOLDINGS") {
      const res = await syncHoldings(ctx, client, conn, accountId, resolver, onProgress, log, base);
      const out: SyncResult = { ...res, finishedAt: new Date().toISOString() };
      if (cardAccountId) {
        const retried = await retryRefused(ctx, conn.id, importer, refused, log);
        const card = await syncCardAccount(ctx, client, conn, accountId, cardAccountId, resolver, importer, log, onProgress, refused);
        const rejected = [...(retried?.rejected ?? []), ...card.rejected, ...(await fundExistingCardRows(importer, accountId, cardAccountId, log, refused))];
        logRejected(log, rejected);
        out.imported += card.imported;
        out.duplicates += card.duplicates;
        out.card = { imported: card.imported, duplicates: card.duplicates };
        await categoriseCardSpending(ctx, log);
        // Surface the card import in the Summary tab too — HOLDINGS only has Holdings + Card.
        if (card.imported > 0) {
          out.breakdown = { ...(out.breakdown ?? {}), Card: card.imported };
        }
      }
      log.push(...describeRefused(refused.current));
      const refusedMessage = refusedError(refused.current);
      if (refusedMessage && !out.error) out.error = refusedMessage;
      return out;
    }

    // A ledger that remembers rows the account does not hold (an earlier version recorded rows it
    // had only sent) would skip them for good: forget it and read everything again.
    await healLedger(ctx, conn.id, accountId, importer, log);
    const { lastSync: since, backfillCheckpoint, backfillStartedAt } = await getSyncState(ctx, conn.id);
    const syncStartedAt = new Date().toISOString();
    const importedRefs = await getImportedRefs(ctx, conn.id);

    // Accumulators shared across every import batch. A backfill imports one batch
    // per year-window (checkpointing as it goes); other paths import a single batch.
    let imported = 0;
    let duplicates = 0;
    let totalToImport = 0;
    let unresolved = 0;
    const tally: Record<string, number> = {};
    const rejected: RejectedRow[] = [];
    // Trades (and corporate actions) that never reached the account: each one leaves a position
    // wrong, so the sync result says so loudly instead of only counting them.
    const droppedTrades: string[] = [];
    let cardResult: { imported: number; duplicates: number } | null = null;
    // Whether this sync finished a full backfill (then the account is checked against Trading 212).
    let backfillFinished = false;

    // Imports one batch (see `ActivityImporter`) and persists its refs, so an interrupted
    // backfill doesn't re-import what already landed. A unit is a row, or a card row with the
    // transfer pair that funds it.
    const importActivities = async (units: ImportUnit[]): Promise<void> => {
      if (units.length === 0) return;
      for (const a of units.flat()) {
        // Funding transfers are bookkeeping for a card row, not activity of their own.
        if (a.comment === CARD_FUNDING_COMMENT) continue;
        totalToImport++;
        const k = String(a.activityType);
        tally[k] = (tally[k] ?? 0) + 1;
      }
      const out = await importer.importRows(units, (done, total) =>
        onProgress({ phase: "import", message: `Importing activities… ${done}/${total}`, current: done, total }),
      );
      // Funding transfers are bookkeeping for their card row; count activities only.
      const importedNow = out.importedIds.filter((id) => !isFundingId(id)).length;
      imported += importedNow;
      duplicates += out.accounted.filter((id) => !isFundingId(id)).length - importedNow;
      rejected.push(...out.rejected);
      if (out.accounted.length > 0) await addImportedRefs(ctx, conn.id, out.accounted);
      // A unit that was stored or is already there leaves the refused list; a refused one joins it.
      await refused.record(out);
    };

    // A card row goes with its funding transfer pair; every other row on its own.
    const unitOf = (a: ActivityImport): ImportUnit =>
      cardAccountId && a.accountId === cardAccountId ? withCardFunding(a, accountId) : [a];

    // Rows refused by earlier syncs are sent again first; each leaves the list once Wealthfolio has it.
    const pending = await refused.pending();
    if (pending.length > 0) {
      const before = refused.current.entries.length;
      log.push(`Retrying ${before} row${before === 1 ? "" : "s"} Wealthfolio refused in earlier syncs.`);
      await importActivities(pending);
      const left = refused.current.entries.length;
      log.push(`Refused rows: ${before - left} saved now, ${left} still refused.`);
    }

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

      // The newest window ends when the backfill first started, and that instant becomes
      // the watermark once it completes, so activity during (or between runs of) a long
      // backfill is picked up by the next incremental sync instead of being skipped.
      const backfillStart =
        backfillCheckpoint && backfillStartedAt ? backfillStartedAt : syncStartedAt;
      if (backfillStart !== backfillStartedAt) await setBackfillStartedAt(ctx, conn.id, backfillStart);
      let windowEnd = backfillCheckpoint ? new Date(backfillCheckpoint) : new Date(backfillStart);
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
        // What each dividend row says Trading 212 held, kept whether or not the row is new.
        await addDividendShares(ctx, conn.id, rows.flatMap((r) => dividendShareOf(r) ?? []));

        const windowUnits: ImportUnit[] = [];
        const take = (unit: ImportUnit) => {
          const ids = unit.map((a) => a.id ?? "");
          if (ids.some((id) => id && (seen.has(id) || importedRefs.has(id)))) return;
          for (const id of ids) if (id) seen.add(id);
          windowUnits.push(unit);
        };

        // Events that span rows: a split is a "close" row and an "open" row, a currency conversion
        // is two currencies and a fee.
        const { rest, splitRows, conversionRows } = splitCorporateRows(rows);
        const { splits, unpaired } = pairStockSplits(splitRows);
        for (const split of splits) {
          const resolved = await resolver.resolveDetailed(split.ticker, {
            isin: split.isin,
            name: split.name,
            currency: split.currency,
          });
          if (resolved) {
            take([mapStockSplit(split, accountId, resolved)]);
          } else {
            const line = `Not imported: stock split ${split.time.slice(0, 10)} ${split.ticker} (${split.name ?? "?"}, ISIN ${split.isin ?? "?"}): symbol not matched`;
            log.push(line);
            droppedTrades.push(line);
          }
        }
        for (const row of unpaired) {
          const line = `Not imported: ${describeRow(row)}: no matching open/close row, or the ticker changed (a swap into another security, not a split)`;
          log.push(line);
          droppedTrades.push(line);
        }
        for (const row of conversionRows) {
          const { units, problem } = mapCurrencyConversion(row, accountId);
          if (problem) log.push(`Not imported: ${describeRow(row)}: ${problem}`);
          for (const unit of units) take(unit);
        }

        for (const row of rest) {
          const act = await mapCsvRow(row, accountId, resolver, cardAccountId);
          if (act) {
            const id = act.id ?? "";
            if (id && !seen.has(id) && !importedRefs.has(id)) {
              seen.add(id);
              windowUnits.push(unitOf(act));
            }
            continue;
          }
          // Say exactly which rows were left out and why, so a wrong position can be traced.
          const action = (row["Action"] ?? "").trim();
          const a = action.toLowerCase();
          const ticker = row["Ticker"]?.trim();
          const isTrade = a.endsWith(" buy") || a.endsWith(" sell");
          if (ticker && (isTrade || a.startsWith("dividend"))) {
            unresolved++;
            const matched = await resolver.resolveDetailed(ticker, { isin: row["ISIN"]?.trim() || undefined });
            const why = matched ? "no usable quantity, price or amount" : "symbol not matched";
            const line =
              `Not imported: ${action} ${row["Time"] ?? ""} ${ticker} (${row["Name"] ?? "?"}, ISIN ${row["ISIN"] || "?"}, ` +
              `qty ${row["No. of shares"] || "?"}, ID ${row["ID"] || "?"}): ${why}`;
            log.push(line);
            if (isTrade) droppedTrades.push(line);
          } else if (action) {
            skipped[action] = (skipped[action] ?? 0) + 1;
          }
        }

        // Optionally fold the daily interest of finished months into monthly totals.
        const singles = foldMonthlyInterest(
          windowUnits.filter((u) => u.length === 1).map((u) => u[0]),
          {
            enabled: settings.monthlyInterest === true,
            accountId,
            before: new Date(backfillStart),
            windowKey: windowStart.toISOString().slice(0, 10),
            existing: await importer.existingIn(accountId),
          },
        );
        // Import this window and checkpoint before moving on, so an interruption
        // resumes from here rather than re-fetching everything already imported.
        await importActivities([...windowUnits.filter((u) => u.length > 1), ...singles.map((a) => [a])]);
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
        const { activities: jsonActs, unresolved: u, unresolvedRows, nonTrade, dividendShares } = await collectJsonActivities(
          client,
          null,
          importedRefs,
          accountId,
          resolver,
        );
        unresolved += u;
        for (const line of unresolvedRows) log.push(line);
        droppedTrades.push(...unresolvedRows);
        const note = nonTradeNote(nonTrade);
        if (note) log.push(note);
        await addDividendShares(ctx, conn.id, dividendShares);
        await importActivities(jsonActs.map(unitOf));
        backfillComplete = true;
      }

      // Only mark the full sync complete when the backfill actually finished;
      // otherwise keep the checkpoint so the next run resumes where this left off.
      if (backfillComplete) {
        // The JSON fallback fetched everything up to this run's start.
        const watermark = exportFailed ? syncStartedAt : backfillStart;
        await setLastSync(ctx, conn.id, watermark);
        await setBackfillCheckpoint(ctx, conn.id, null);
        await setBackfillStartedAt(ctx, conn.id, null);
        // Card rows were routed inline during the backfill above — mark the card
        // pipeline backfilled so incremental syncs only fetch a recent top-up window.
        if (cardAccountId) await setCardLastSync(ctx, conn.id, watermark);
        backfillFinished = true;
      } else {
        log.push("Backfill incomplete — next sync resumes from the checkpoint.");
      }
    } else {
      // ── JSON incremental (since last watermark) ──────────────────────────
      log.push(`Incremental sync since ${since}.`);
      onProgress({ phase: "export", message: "Fetching recent activity…" });
      const { activities: jsonActs, unresolved: u, unresolvedRows, nonTrade, dividendShares } = await collectJsonActivities(
        client,
        since,
        importedRefs,
        accountId,
        resolver,
      );
      unresolved += u;
      for (const line of unresolvedRows) log.push(line);
      droppedTrades.push(...unresolvedRows);
      const note = nonTradeNote(nonTrade);
      if (note) log.push(note);
      await addDividendShares(ctx, conn.id, dividendShares);
      await importActivities(jsonActs.map(unitOf));
      // Pages are read newest-first from when this run started; anything newer is for
      // the next run, so the watermark is the start time, not the finish time. Rows Wealthfolio
      // refused do not hold it back: they wait in the refused list and are retried each sync.
      await setLastSync(ctx, conn.id, syncStartedAt);

      // Card data is CSV-only (the JSON feed has no card type), so refresh it separately
      // via its own watermark: a one-time backfill the first time extraction is on, then a
      // recent top-up window thereafter.
      if (cardAccountId) {
        const card = await syncCardAccount(ctx, client, conn, accountId, cardAccountId, resolver, importer, log, onProgress, refused);
        cardResult = { imported: card.imported, duplicates: card.duplicates };
        rejected.push(...card.rejected);
        imported += card.imported;
        duplicates += card.duplicates;
      }
    }

    if (cardAccountId) rejected.push(...(await fundExistingCardRows(importer, accountId, cardAccountId, log, refused)));
    if (cardResult) tally.Card = (tally.Card ?? 0) + cardResult.imported;
    if (cardAccountId) await categoriseCardSpending(ctx, log);

    const breakdownLine =
      Object.entries(tally)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ") || "none";
    log.push(`Mapped ${totalToImport} activities: ${breakdownLine}.`);
    if (unresolved > 0) log.push(`${unresolved} rows skipped (listed above).`);
    logRejected(log, rejected);
    log.push(`Import: ${imported} imported, ${duplicates} duplicates, ${rejected.length} not imported.`);

    // The acceptance test of a backfill: do Wealthfolio's holdings and cash match Trading 212's?
    // Checked when a backfill finishes, and on every later sync until it matches.
    let verification: Verification | undefined;
    const previous = (await getSyncState(ctx, conn.id)).verification;
    if (backfillFinished || (previous && !previous.ok)) {
      try {
        // A trade left out of the account looks, in the dividend counts, just like a split. With
        // rows missing the counts are not used: add the rows (the log lists them) and sync again.
        let dividends = await getDividendShares(ctx, conn.id);
        const missing = droppedTrades.length + refused.current.entries.length + refused.current.dropped;
        if (missing > 0 && Object.keys(dividends).length > 0) {
          log.push(
            `Not looking for splits in the dividend rows: ${missing} row${missing === 1 ? " was" : "s were"} not imported ` +
              "or refused by Wealthfolio, which could be what the position is short of.",
          );
          dividends = {};
        }
        verification = await verifyAndRepair(ctx, client, accountId, resolver, importer, updates, onProgress, log, dividends);
        await setVerification(ctx, conn.id, verification);
        log.push(...verificationLines(verification));
      } catch (e) {
        log.push(`Could not compare with Trading 212's positions and cash: ${errDetail(e)}`);
      }
    }

    const finishedAt = new Date().toISOString();
    const result: SyncResult = {
      ...base,
      imported,
      duplicates,
      unresolved,
      breakdown: tally,
      card: cardResult ?? undefined,
      finishedAt,
      verification,
    };
    // Rows Wealthfolio refuses stay listed (and the error stays) until a sync stores them.
    log.push(...describeRefused(refused.current));
    result.log = log;
    const errors: string[] = [];
    const refusedMessage = refusedError(refused.current);
    if (refusedMessage) errors.push(refusedMessage);
    // A trade that never reached the account leaves its position wrong: say so loudly.
    if (droppedTrades.length > 0) {
      errors.push(
        `${droppedTrades.length} trade or corporate-action row${droppedTrades.length === 1 ? " was" : "s were"} not imported, so ` +
          `holdings will not match Trading 212 (see the log). First: ${droppedTrades[0]}`,
      );
    }
    if (errors.length === 0 && verification && !verification.ok && verification.settled) {
      errors.push(
        `Does not match Trading 212: ${verification.mismatches.length} difference` +
          `${verification.mismatches.length === 1 ? "" : "s"} (see the log). First: ${verification.mismatches[0]}`,
      );
    }
    if (errors.length > 0) result.error = errors.join(" ");
    return result;
  } catch (err) {
    const message = isUnauthorized(err)
      ? "Trading 212 rejected this API key. Check it in Settings."
      : (err as Error).message;
    log.push(`Error: ${message}`);
    return { ...base, imported: 0, duplicates: 0, unresolved: 0, finishedAt: new Date().toISOString(), error: message };
  }
}

/** How long the check waits for Wealthfolio to finish recalculating after the import. */
const VERIFY_WAIT_MS = 3 * 60 * 1000;

/**
 * Compares the account in Wealthfolio with Trading 212: the holdings Wealthfolio derived from the
 * imported activities (`portfolio.getHoldings`, the numbers the user sees) against `/positions`,
 * and the cash against `/account/summary` — the same calls HOLDINGS mode snapshots from. Waits
 * for the recalculation the import queued first, since holdings read straight after an import
 * are stale.
 */
async function verifyAccount(
  ctx: AddonContext,
  client: Trading212Client,
  accountId: string,
  resolver: SymbolResolver,
  importer: ActivityImporter,
  updates: PortfolioUpdates,
  onProgress: ProgressFn,
): Promise<{ verification: Verification; gaps: PositionGap[] }> {
  onProgress({ phase: "done", message: "Checking holdings and cash against Trading 212…" });
  const settled =
    importer.lastWriteAt === 0 ? true : await updates.settledAfter(importer.lastWriteAt, VERIFY_WAIT_MS);
  const summary = await client.getAccountSummary();
  const positions = await resolvePositions(await client.getPositions(), resolver);
  const holdings = await ctx.api.portfolio.getHoldings(accountId);
  // Wallets in other currencies are converted into the account currency; without rates (or the
  // permission to read them) those wallets are noted as not compared rather than failed.
  const rates = await (async () => {
    try {
      return await ctx.api.exchangeRates.getAll();
    } catch {
      return [];
    }
  })();
  const { gaps, ...cmp } = compareWithTrading212({
    positions,
    cash: trading212Cash(summary),
    accountCurrency: summary.currency || "GBP",
    holdings,
    rates,
  });
  return { verification: { ...cmp, checkedAt: new Date().toISOString(), settled }, gaps };
}

/**
 * Checks the account against Trading 212 and, for a position that is short by a split Trading 212
 * never listed in its history, adds that split ({@link repairSplits}) and checks again. Only
 * splits whose date and ratio reproduce Trading 212's quantity exactly are added, from the known
 * splits table or, failing that, from the share counts of the position's dividend rows.
 */
async function verifyAndRepair(
  ctx: AddonContext,
  client: Trading212Client,
  accountId: string,
  resolver: SymbolResolver,
  importer: ActivityImporter,
  updates: PortfolioUpdates,
  onProgress: ProgressFn,
  log: string[],
  dividends: Record<string, DividendShares[]> = {},
): Promise<Verification> {
  let { verification, gaps } = await verifyAccount(ctx, client, accountId, resolver, importer, updates, onProgress);
  // The repair compares the account's activities with Trading 212's quantity, not Wealthfolio's
  // holdings, so it does not wait for the recalculation: if that was merely not finished, the
  // activities agree with Trading 212 and nothing is added.
  if (!verification.ok && gaps.length > 0) {
    const added = await repairSplits(importer, resolver, accountId, gaps, log, dividends);
    if (added > 0) {
      log.push(`Added ${added} missing split${added === 1 ? "" : "s"}; checking again.`);
      ({ verification } = await verifyAccount(ctx, client, accountId, resolver, importer, updates, onProgress));
    }
  }
  return verification;
}

/**
 * Whether a connection's ledger of imported ids is ahead of what its account holds: ids recorded
 * but no trade or no row at all in the account. Versions 2.6.0/2.6.1 recorded the ids of rows
 * they had only sent, and Wealthfolio had stored none of them. Only the clear cases count (a
 * few trades the user deleted by hand must stay deleted).
 */
export function ledgerAhead(refs: Set<string>, existing: { activityType?: string }[]): string | null {
  if (refs.size === 0) return null;
  if (existing.length === 0) return `${refs.size} rows are recorded as imported but the account holds none`;
  const orders = [...refs].filter((r) => r.startsWith("t212-order-")).length;
  const trades = existing.filter((a) => a.activityType === "BUY" || a.activityType === "SELL").length;
  if (orders > 0 && trades === 0) return `${orders} trades are recorded as imported but the account holds none`;
  return null;
}

/** Forgets the ledger and the watermarks when it is ahead of the account (see {@link ledgerAhead}). */
async function healLedger(
  ctx: AddonContext,
  connectionId: string,
  accountId: string,
  importer: ActivityImporter,
  log: string[],
): Promise<void> {
  const why = ledgerAhead(await getImportedRefs(ctx, connectionId), await importer.existingIn(accountId));
  if (!why) return;
  log.push(`The import ledger is ahead of the account (${why}): forgetting it and reading the whole history again.`);
  await clearImportedRefs(ctx, connectionId);
  await setLastSync(ctx, connectionId, null);
  await setBackfillCheckpoint(ctx, connectionId, null);
  await setBackfillStartedAt(ctx, connectionId, null);
}

/** Sends the rows refused by earlier syncs again; each leaves the list once Wealthfolio has it. */
async function retryRefused(
  ctx: AddonContext,
  connectionId: string,
  importer: ActivityImporter,
  refused: RefusedRowsStore,
  log: string[],
) {
  const pending = await refused.pending();
  if (pending.length === 0) return null;
  const before = refused.current.entries.length;
  log.push(`Retrying ${before} row${before === 1 ? "" : "s"} Wealthfolio refused in earlier syncs.`);
  const out = await importer.importRows(pending);
  if (out.accounted.length > 0) await addImportedRefs(ctx, connectionId, out.accounted);
  await refused.record(out);
  const left = refused.current.entries.length;
  log.push(`Refused rows: ${before - left} saved now, ${left} still refused.`);
  return out;
}

/** Logs each row Wealthfolio did not import (capped, so a systematic failure stays readable). */
function logRejected(log: string[], rejected: RejectedRow[]): void {
  const MAX = 200;
  for (const r of rejected.slice(0, MAX)) log.push(describeRejected(r));
  if (rejected.length > MAX) log.push(`…and ${rejected.length - MAX} more rows not imported.`);
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

/**
 * Finds the bank side of an investing account's deposits and withdrawals (a Monzo or Revolut
 * account another add-on keeps in Wealthfolio, say) and turns each confident pair into a linked
 * transfer (kit `linkMovesBetween`: same amount and currency, within 3 days, unique). Only bank
 * rows whose payee points at Trading 212 take part — its name ("To Trading 212 UK Limited",
 * "Trading TwoOneTwo") or one of the user's Trading 212 account numbers quoted as the reference.
 * Rows without a counterpart stay deposits and withdrawals: Wealthfolio's ISA allowance counts a
 * deposit, and a linked transfer from outside the ISA, but not an unlinked transfer. The card
 * funding pairs are already linked and are left out. Never throws.
 */
async function linkWithBankAccounts(ctx: AddonContext, accountId: string) {
  try {
    const accounts = await ctx.api.accounts.getAll();
    const refs = trading212Refs(accounts);
    return await linkMovesBetween(ctx, {
      accounts,
      mine: [accountId],
      theirs: (a) => a.provider !== T212_PROVIDER && a.accountType !== "SECURITIES",
      mineRow: (r) => r.comment !== CARD_FUNDING_COMMENT,
      theirRow: (r) => isTrading212Payee(r.comment, refs),
    });
  } catch (err) {
    return { linked: 0, ambiguous: [] as string[], failed: [(err as Error).message] };
  }
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

  // Watches Wealthfolio's recalculations, so a check after an import reads settled holdings.
  const updates = new PortfolioUpdates(ctx);
  // Trading 212 rate-limits per API key, so connections (each with its own key) sync side by
  // side: an Invest and an ISA backfill export and import at the same time.
  let perAccount: SyncResult[];
  try {
    perAccount = await Promise.all(
      connections.map((conn) => {
        const report: ProgressFn = (p) => opts.onProgress?.({ accountName: conn.name, ...p });
        return syncOne(ctx, settings, conn, resolver, report, confirmedModeSwitches, updates);
      }),
    );
  } finally {
    updates.stop();
  }

  // Pair each account's deposits and withdrawals with the bank side of the move, one account at a
  // time so two accounts never race for the same bank row.
  for (const r of perAccount) {
    const conn = connections.find((c) => c.id === r.connectionId);
    if (!conn || conn.needsCredentials || connectionMode(conn) !== "TRANSACTIONS") continue;
    const note = moveLinkNote("your bank accounts", await linkWithBankAccounts(ctx, r.accountId));
    if (note) r.log.push(note);
  }

  if (resolver.isDirty) await setSymbolMap(ctx, resolver.snapshot());

  // Keep each account's result and log, so the dashboard shows them again after a reload.
  for (const r of perAccount) await saveLastResult(ctx, r.connectionId, r);

  return { perAccount, totals: sumTotals(perAccount) };
}

export function useSync(ctx: AddonContext, opts: { restore?: boolean } = {}) {
  const [state, setState] = useState<SyncState>({
    isSyncing: false,
    results: null,
    error: null,
    progress: null,
    steps: [],
  });

  // With `restore`, the last sync's results, logs and activity feed come back after a reload (or
  // when the dashboard is opened again), unless a sync of this page's own is already showing.
  useEffect(() => {
    if (!opts.restore) return;
    let unmounted = false;
    (async () => {
      const ids = (await getConnections(ctx)).map((c) => c.id);
      const perAccount = await loadLastResults(ctx, ids);
      if (perAccount.length === 0) return;
      const steps = (await loadLastSteps(ctx)) as KitSyncStep<SyncPhaseId>[];
      if (unmounted) return;
      const results: MultiSyncResult = { perAccount, totals: sumTotals(perAccount) };
      setState((s) => (s.isSyncing || s.results || s.error ? s : { ...s, results, steps: s.steps.length > 0 ? s.steps : steps }));
    })().catch(() => {});
    return () => {
      unmounted = true;
    };
    // Once, on mount.
  }, []);

  async function syncAll(confirmedModeSwitches: Set<string> = new Set()) {
    setState((s) => ({ ...s, isSyncing: true, error: null, progress: null, steps: [] }));
    // The same step list the state holds, kept here too so it can be saved when done.
    let steps: KitSyncStep<SyncPhaseId>[] = [];
    try {
      const results = await runSyncAll(ctx, {
        confirmedModeSwitches,
        onProgress: ({ accountName, ...p }) => {
          // The shared activity feed shows messages only, so carry the account in the text.
          const progress = { ...p, message: `${accountName}: ${p.message}` };
          steps = appendStep(steps, progress);
          setState((s) => ({
            ...s,
            progress,
            steps: appendStep(s.steps, progress),
          }));
        },
      });
      steps = markLastDone(steps);
      await saveLastSteps(ctx, steps);
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

/** The totals a multi-account result shows. */
function sumTotals(perAccount: SyncResult[]): MultiSyncResult["totals"] {
  return perAccount.reduce(
    (acc, r) => ({
      imported: acc.imported + r.imported,
      duplicates: acc.duplicates + r.duplicates,
      unresolved: acc.unresolved + r.unresolved,
    }),
    { imported: 0, duplicates: 0, unresolved: 0 },
  );
}
