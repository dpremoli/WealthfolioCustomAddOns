import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import {
  jsonStore,
  selectNewActivities,
  type ExistingActivityLike,
  type SyncProgress,
} from "@wf-addons/kit";
import { KEY_CATEGORY_LABELS, KEY_LAST_RUN, KEY_LAST_SYNC, KEY_MAPPING } from "../constants";
import type { AccountMapping, MonzoTransaction, SyncPhaseId, SyncResult } from "../types";
import { MonzoAuthError, getConnectionStatus } from "./auth";
import {
  isDeclined,
  isFlexRepayment,
  isPending,
  isPotTransfer,
  mapTransactionToActivity,
  tallyByCategory,
} from "./mapper";
import { MonzoClient } from "./monzo-client";
import { ensureMigrated } from "./migrate";

export type SyncProgressHandler = (p: SyncProgress<SyncPhaseId>) => void;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pending transactions older than this no longer hold the watermark back (stuck ones).
 * Monzo says most settle within 24-48 hours; this leaves room for the slow ones.
 */
const PENDING_HOLD_BACK_MS = 14 * DAY_MS;

/**
 * How far back Monzo lets a client read once 5 minutes have passed since the user
 * authenticated (90 days, per its docs), with a day's margin for clock skew.
 */
export const HISTORY_LIMIT_MS = 89 * DAY_MS;

/**
 * The `since` for an incremental sync: the watermark, but never further back than Monzo
 * allows (asking for more is refused). Undefined on a first sync, which tries for the
 * full history first (see {@link runSync}).
 */
export function syncSince(lastSync: string | undefined, now: Date): { since?: string; clamped: boolean } {
  if (!lastSync) return { since: undefined, clamped: false };
  const floor = new Date(now.getTime() - HISTORY_LIMIT_MS).toISOString();
  const last = Date.parse(lastSync);
  if (Number.isNaN(last) || last < Date.parse(floor)) return { since: floor, clamped: true };
  return { since: lastSync, clamped: false };
}

/**
 * Whether a fetched transaction should become an activity. Declined and zero-value ones
 * (card checks) moved no money. Pending ones are skipped (they can still change) except
 * on Flex, whose purchases never "settle" because they are billed monthly. Pot transfers,
 * Flex repayments (the matching spend is already on the Flex account) and savings-category
 * moves (investment transfers) are never imported.
 */
export function isEligible(tx: MonzoTransaction, isFlex: boolean): boolean {
  return (
    !isDeclined(tx) &&
    tx.amount !== 0 &&
    (isFlex || !isPending(tx)) &&
    !isPotTransfer(tx) &&
    !isFlexRepayment(tx) &&
    tx.category !== "savings"
  );
}

/**
 * v1.x imported cash with a bare currency code as the symbol ("GBP"), which Wealthfolio
 * stores against a *security* of that name. Treat such rows as cash so overlapping
 * syncs or CSV imports reconcile against them instead of importing everything twice.
 */
export function normaliseLegacyCash<T extends ExistingActivityLike>(existing: T[]): T[] {
  return existing.map((e) => {
    const symbol = e.assetSymbol?.trim().toUpperCase();
    if (symbol && /^[A-Z]{3}$/.test(symbol) && symbol === (e.currency ?? "").toUpperCase()) {
      return { ...e, assetSymbol: null };
    }
    return e;
  });
}

export interface ImportOutcome {
  imported: number;
  /** Already in the account (matched by count), so not imported again. */
  duplicates: number;
  skipped: number;
}

/**
 * Imports `desired` into a Wealthfolio account without duplicating what is already there.
 *
 * Wealthfolio's own content-hash dedupe would drop genuine identical same-day
 * transactions, so every row is force-imported and idempotency is handled here:
 * `selectNewActivities` matches the `[ref:tx_…]` the mapper puts in each comment, and
 * falls back to content (by count) for rows imported before refs were added.
 */
export async function importNew(
  ctx: AddonContext,
  accountId: string,
  desired: ActivityImport[],
): Promise<ImportOutcome> {
  if (desired.length === 0) return { imported: 0, duplicates: 0, skipped: 0 };
  const existing = normaliseLegacyCash(await ctx.api.activities.getAll(accountId));
  const toImport = selectNewActivities(desired, existing);
  const duplicates = desired.length - toImport.length;
  if (toImport.length === 0) return { imported: 0, duplicates, skipped: 0 };
  const r = await ctx.api.activities.import(toImport);
  return { imported: r.summary.imported, duplicates, skipped: r.summary.skipped };
}

/**
 * Earliest `created` among pending transactions that may still settle, else null. The
 * sync watermark is held back to here so a transaction that was pending at sync time is
 * picked up by a later sync once it settles (already-imported rows reconcile away).
 */
export function pendingHoldBack(txs: MonzoTransaction[], now: Date): string | null {
  let earliest: string | null = null;
  for (const tx of txs) {
    if (!isPending(tx) || tx.decline_reason) continue;
    const created = Date.parse(tx.created);
    if (Number.isNaN(created) || now.getTime() - created > PENDING_HOLD_BACK_MS) continue;
    if (earliest === null || tx.created < earliest) earliest = tx.created;
  }
  return earliest;
}

/** Fetch -> filter -> reconcile -> import for every mapped Monzo account. */
export async function runSync(
  ctx: AddonContext,
  onProgress: SyncProgressHandler = () => {},
): Promise<SyncResult> {
  await ensureMigrated(ctx);
  const store = jsonStore(ctx.api.storage);
  const log: string[] = [];

  onProgress({ phase: "fetch", message: "Checking connection…" });
  if (!(await getConnectionStatus(ctx)).connected) {
    throw new MonzoAuthError("not-connected", "Not connected to Monzo. Open Settings to connect.");
  }
  const mapping = await store.get<AccountMapping>(KEY_MAPPING, {});
  if (Object.keys(mapping).length === 0) {
    throw new Error("No account mapping configured. Open Settings first.");
  }
  const lastSync = (await store.get<string | null>(KEY_LAST_SYNC, null)) ?? undefined;
  const categoryLabels = await store.get<Record<string, string>>(KEY_CATEGORY_LABELS, {});
  const startedAt = new Date();
  const { since, clamped } = syncSince(lastSync, startedAt);
  if (!lastSync) log.push("Full sync (all history if Monzo allows it, otherwise the last 90 days).");
  else if (clamped) {
    log.push(
      `Last synced ${lastSync}, more than 90 days ago: Monzo only shares the last 90 days now, ` +
        "so fetching from " + since + ". Use CSV import to fill the gap.",
    );
  } else log.push(`Incremental sync since ${since}.`);
  const client = new MonzoClient(ctx);
  const monzoAccounts = await client.getAccounts();
  const flexAccountIds = new Set(
    monzoAccounts.filter((a) => a.account_type === "uk_monzo_flex").map((a) => a.id),
  );

  const entries = Object.entries(mapping).filter(([monzoId]) => {
    const known = monzoAccounts.some((a) => a.id === monzoId);
    if (!known) log.push(`Account ${monzoId.slice(0, 10)}…: not an open Monzo account, skipped.`);
    return known;
  });

  // Fail early (before importing anything) when a mapped Wealthfolio account was deleted.
  const wfIds = new Set((await ctx.api.accounts.getAll()).map((a) => a.id));
  if (entries.some(([, id]) => !wfIds.has(id))) {
    throw new Error(
      "Account mapping is out of date (mapped accounts were deleted). " +
        "Open Settings to reconnect and re-create accounts.",
    );
  }

  let imported = 0;
  let skipped = 0;
  let duplicates = 0;
  let holdBack: string | null = null;
  const breakdown: Record<string, number> = {};

  // Monzo shares all history only within 5 minutes of the user authenticating; after that,
  // asking for more than 90 days is refused (403). A first sync tries for everything and
  // falls back to 90 days on that refusal.
  const floor = new Date(startedAt.getTime() - HISTORY_LIMIT_MS).toISOString();
  let fullHistory = since === undefined;
  const fetchAll = async (accountId: string) => {
    if (!fullHistory) return client.getTransactions(accountId, since ?? floor);
    try {
      return await client.getTransactions(accountId, undefined);
    } catch (err) {
      if (!(err instanceof MonzoAuthError && err.kind === "approval")) throw err;
      fullHistory = false;
      log.push(
        "Monzo refused full history (it only shares it for 5 minutes after you connect); " +
          "fetching the last 90 days instead. Use CSV import for anything older.",
      );
      return client.getTransactions(accountId, floor);
    }
  };

  let idx = 0;
  for (const [monzoAccountId, wealthfolioAccountId] of entries) {
    idx++;
    onProgress({ phase: "fetch", message: "Fetching transactions…", current: idx, total: entries.length });
    const transactions = await fetchAll(monzoAccountId);

    const isFlex = flexAccountIds.has(monzoAccountId);
    const eligible = transactions.filter((tx) => isEligible(tx, isFlex));
    log.push(
      `Account ${monzoAccountId.slice(0, 10)}…: ${transactions.length} fetched, ${eligible.length} eligible.`,
    );
    if (!isFlex) {
      const hb = pendingHoldBack(transactions, startedAt);
      if (hb && (holdBack === null || hb < holdBack)) holdBack = hb;
    }
    for (const [k, v] of Object.entries(tallyByCategory(eligible, categoryLabels))) {
      breakdown[k] = (breakdown[k] ?? 0) + v;
    }
    if (eligible.length === 0) continue;

    onProgress({ phase: "import", message: `Importing ${eligible.length} transactions…` });
    const desired = eligible.map((tx) => mapTransactionToActivity(tx, wealthfolioAccountId, categoryLabels));
    const outcome = await importNew(ctx, wealthfolioAccountId, desired);
    imported += outcome.imported;
    duplicates += outcome.duplicates;
    skipped += outcome.skipped;
  }

  // Watermark: when this sync started, or earlier if a transaction was still pending.
  const watermark = holdBack && holdBack < startedAt.toISOString() ? holdBack : startedAt.toISOString();
  const finishedAt = new Date().toISOString();
  await store.set(KEY_LAST_SYNC, watermark);
  await store.set(KEY_LAST_RUN, finishedAt);
  log.push(`Import: ${imported} imported, ${duplicates} already present, ${skipped} skipped.`);
  if (watermark !== startedAt.toISOString()) {
    log.push(`Next sync re-checks from ${watermark} (a transaction was still pending).`);
  }

  onProgress({ phase: "done", message: `Synced ${imported} transaction${imported === 1 ? "" : "s"}.` });
  return { imported, skipped, duplicates, breakdown, log, finishedAt };
}
