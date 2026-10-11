import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import {
  jsonStore,
  ledgerEntry,
  reconcileWithLedger,
  sourceRefOf,
  spendingRulesNote,
  syncSpendingRules,
  type ExistingActivityLike,
  type ImportLedger,
  type SyncProgress,
  type SyncStep,
} from "@wf-addons/kit";
import {
  KEY_AUTHENTICATED_AT,
  KEY_CATEGORY_LABELS,
  KEY_IMPORTED_IDS,
  KEY_LAST_RESULT,
  KEY_LAST_RUN,
  KEY_LAST_SYNC,
  KEY_MAPPING,
  KEY_RECHECKED_90_DAYS,
} from "../constants";
import type {
  AccountMapping,
  MonzoAccount,
  MonzoTransaction,
  SyncPhaseId,
  SyncResult,
} from "../types";
import { MonzoAuthError, getConnectionStatus } from "./auth";
import {
  legacyActivity,
  isDeclined,
  isFlexRepayment,
  isPending,
  isPotTransfer,
  mapTransactionToActivity,
  tallyByCategory,
} from "./mapper";
import { runExclusive } from "./busy";
import { MonzoClient, isHistoryRefusal } from "./monzo-client";
import { accountTypeIssueText, accountTypeIssues } from "./accounts";
import { ensureMigrated } from "./migrate";
import { monzoSpendingRules } from "./spending-rules";

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
 * A sync this soon after the user logged in asks for the whole history. Monzo's window is 5
 * minutes, but it may only start once the login is approved in the Monzo app, which can come
 * well after the login this is measured from. Asking too late costs one refused request.
 */
const FRESH_AUTH_MS = 15 * 60 * 1000;

/**
 * The `since` for an incremental sync: the watermark, but never further back than Monzo
 * allows (asking for more is refused). Undefined on a first sync, which asks from each
 * account's opening date instead (see {@link runSync}).
 */
export function syncSince(
  lastSync: string | undefined,
  now: Date
): { since?: string; clamped: boolean } {
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
  /** Already imported rows rewritten because the transaction changed (payee name, notes, …). */
  updated: number;
  /** Already in the account (matched by count), so not imported again. */
  duplicates: number;
  skipped: number;
}

/**
 * Imports `desired` into a Wealthfolio account without duplicating what is already there.
 *
 * Wealthfolio's own content-hash dedupe would drop genuine identical same-day
 * transactions, so every row is force-imported and idempotency is handled here, by the
 * kit's `reconcileWithLedger`: the add-on remembers each imported Monzo transaction id
 * (with its account and content hash) in storage, so a re-fetched transaction is
 * recognised even after its comment changed, and a new identical one (a second coffee) is
 * not mistaken for it. Rows imported by versions before the ledger match by content.
 */
export async function importNew(
  ctx: AddonContext,
  accountId: string,
  desired: ActivityImport[],
  /** Each row as older versions imported it, by activity id (see `legacyActivity`). */
  legacyForms: ReadonlyMap<string, ActivityImport> = new Map()
): Promise<ImportOutcome> {
  if (desired.length === 0) return { imported: 0, updated: 0, duplicates: 0, skipped: 0 };
  const store = jsonStore(ctx.api.storage);
  const existing = normaliseLegacyCash(await ctx.api.activities.getAll(accountId));
  const { toImport, present, stale, ledger } = reconcileWithLedger(
    desired,
    existing,
    await store.get<ImportLedger>(KEY_IMPORTED_IDS, {}),
    accountId,
    { legacy: (a) => (a.id ? legacyForms.get(a.id) : undefined) }
  );
  let imported = 0;
  let skipped = 0;
  if (toImport.length > 0) {
    const r = await ctx.api.activities.import(toImport);
    imported = r.summary.imported;
    skipped = r.summary.skipped;
  }
  await store.set(KEY_IMPORTED_IDS, ledger);

  // Rewrite rows whose transaction changed since (payee name, notes, settled amount).
  let updated = 0;
  if (stale.length > 0) {
    // Best effort: a refused update leaves the row as it was, and the next sync retries it.
    const res = await ctx.api.activities
      .saveMany({
        updates: stale.map(({ row, activity }) => ({
          id: row.id,
          accountId,
          activityType: activity.activityType,
          subtype: activity.subtype ?? null,
          activityDate: activity.date ?? row.date,
          amount: activity.amount,
          currency: activity.currency,
          comment: activity.comment ?? null,
        })),
      })
      .catch(() => null);
    if (!res) return { imported, updated: 0, duplicates: present.length, skipped };
    const failed = new Set((res.errors ?? []).map((e) => e.id));
    for (const { row, activity } of stale) {
      if (failed.has(row.id) || !activity.id) continue;
      ledger[activity.id] = ledgerEntry(accountId, activity);
      updated++;
    }
    await store.set(KEY_IMPORTED_IDS, ledger);
  }
  return { imported, updated, duplicates: present.length - updated, skipped };
}

/**
 * v2.1–2.2 appended `[ref:tx_…]` to each comment. Records those ids in the import ledger
 * and rewrites the comments without the tag. Best effort, and a no-op once done.
 */
export async function stripRefTags(ctx: AddonContext, accountId: string): Promise<number> {
  const all = await ctx.api.activities.getAll(accountId);
  const tagged = all.filter((a) => sourceRefOf(a.comment));
  if (tagged.length === 0) return 0;
  const store = jsonStore(ctx.api.storage);
  // Reconciling nothing against the account records every tagged row in the ledger.
  const { ledger } = reconcileWithLedger(
    [],
    tagged,
    await store.get<ImportLedger>(KEY_IMPORTED_IDS, {}),
    accountId
  );
  await store.set(KEY_IMPORTED_IDS, ledger);
  const res = await ctx.api.activities.saveMany({
    updates: tagged.map((a) => ({
      id: a.id,
      accountId: a.accountId || accountId,
      activityType: a.activityType,
      activityDate: a.date,
      amount: a.amount,
      currency: a.currency,
      comment: stripRef(a.comment) || null,
    })),
  });
  return tagged.length - (res?.errors?.length ?? 0);
}

function stripRef(comment: string | undefined): string {
  return (comment ?? "").replace(/\s*\[ref:[^\]\s]+\]\s*$/, "").trim();
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

/** " (back to 2026-07-14)" for a sync log line: how far back a fetch actually reached. */
function oldestNote(txs: MonzoTransaction[]): string {
  if (txs.length === 0) return "";
  const oldest = txs.reduce((a, b) => (b.created < a.created ? b : a)).created;
  return ` (back to ${oldest.slice(0, 10)})`;
}

/**
 * Fetch -> filter -> reconcile -> import for every mapped Monzo account. Only one sync or
 * CSV import runs at a time (see `runExclusive`); `afterwards` runs inside that exclusive
 * section once the sync succeeded (the hook saves the dashboard's view there, so a page that
 * sees the run finish finds it saved).
 */
export function runSync(
  ctx: AddonContext,
  onProgress: SyncProgressHandler = () => {},
  afterwards: (result: SyncResult) => Promise<void> = async () => {}
): Promise<SyncResult> {
  return runExclusive(async () => {
    const result = await syncAll(ctx, onProgress);
    await afterwards(result);
    return result;
  });
}

async function syncAll(ctx: AddonContext, onProgress: SyncProgressHandler): Promise<SyncResult> {
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
  const authenticatedAt = Number(await ctx.api.storage.get(KEY_AUTHENTICATED_AT));
  const rechecked = await store.get<boolean>(KEY_RECHECKED_90_DAYS, false);
  const startedAt = new Date();
  const floor = new Date(startedAt.getTime() - HISTORY_LIMIT_MS).toISOString();
  const sinceLogin = startedAt.getTime() - authenticatedAt;
  const justAuthenticated = sinceLogin >= 0 && sinceLogin < FRESH_AUTH_MS;
  // Whole history: a first sync, or one right after logging in (already-imported rows
  // reconcile away). Otherwise one catch-up sync for people who synced with an older version.
  const fullHistory = !lastSync || justAuthenticated;
  const recheck = !fullHistory && !rechecked;
  const { since: watermarkSince, clamped } = syncSince(lastSync, startedAt);
  const since = fullHistory ? undefined : recheck ? floor : watermarkSince;
  // The account holders' names: Monzo's default payment reference, not worth repeating.
  const ownNames = new Set<string>();
  if (!lastSync)
    log.push("Full sync (all history if Monzo allows it, otherwise the last 90 days).");
  else if (justAuthenticated)
    log.push("You connected a moment ago: reading all history again (while Monzo allows it).");
  else if (recheck) {
    log.push(
      "One-off re-check of the last 90 days: earlier versions could miss up to two months of " +
        "transactions. Already imported ones are skipped."
    );
  } else if (clamped) {
    log.push(
      `Last synced ${lastSync}, more than 90 days ago: Monzo only shares the last 90 days now, ` +
        "so fetching from " +
        since +
        ". Use CSV import to fill the gap."
    );
  } else log.push(`Incremental sync since ${since}.`);
  const client = new MonzoClient(ctx);
  const monzoAccounts = await client.getAccounts();
  for (const a of monzoAccounts) {
    for (const o of a.owners ?? []) {
      if (o.preferred_name) ownNames.add(o.preferred_name.trim().toLowerCase());
    }
  }
  const flexAccountIds = new Set(
    monzoAccounts.filter((a) => a.account_type === "uk_monzo_flex").map((a) => a.id)
  );

  const entries = Object.entries(mapping).filter(([monzoId]) => {
    const known = monzoAccounts.some((a) => a.id === monzoId);
    if (!known) log.push(`Account ${monzoId.slice(0, 10)}…: not an open Monzo account, skipped.`);
    return known;
  });

  // Fail early (before importing anything) when a mapped Wealthfolio account was deleted.
  const wfAccounts = await ctx.api.accounts.getAll();
  const wfIds = new Set(wfAccounts.map((a) => a.id));
  if (entries.some(([, id]) => !wfIds.has(id))) {
    throw new Error(
      "Account mapping is out of date (mapped accounts were deleted). " +
        "Open Settings to reconnect and re-create accounts."
    );
  }
  for (const issue of accountTypeIssues(monzoAccounts, wfAccounts, mapping)) {
    log.push(`Warning: ${accountTypeIssueText(issue)}`);
  }

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let duplicates = 0;
  let holdBack: string | null = null;
  const breakdown: Record<string, number> = {};

  // Monzo shares all history only within 5 minutes of the user authenticating; after that,
  // a `since` 90 or more days back is refused (403). With no `since` at all it refuses
  // nothing and quietly returns just the last 30 days, so every request names one. A full
  // sync asks from the account's opening date and falls back to 90 days on that refusal.
  let askFullHistory = fullHistory;
  const fetchAll = async (account: MonzoAccount) => {
    const opened = Date.parse(account.created ?? "");
    const label = `Account ${account.id.slice(0, 10)}…`;
    if (!askFullHistory) return client.getTransactions(account.id, since ?? floor);
    if (Number.isNaN(opened)) {
      log.push(`${label}: Monzo gave no opening date, so it is limited to the last 90 days.`);
      return client.getTransactions(account.id, floor);
    }
    // An account younger than the limit is covered by the 90 days.
    if (opened >= Date.parse(floor)) return client.getTransactions(account.id, floor);
    try {
      const history = await client.getHistory(account.id, new Date(opened), startedAt);
      if (!history.complete) {
        const back = history.transactions[0]?.created.slice(0, 10);
        log.push(
          `${label}: Monzo stopped sharing history part-way, so only ${
            back ? `back to ${back}` : "the most recent part"
          } was fetched. CSV import covers the rest.`
        );
      }
      return history.transactions;
    } catch (err) {
      if (!isHistoryRefusal(err)) throw err;
      askFullHistory = false;
      log.push(
        "Monzo refused full history (it only shares it for 5 minutes after you connect); " +
          "fetching the last 90 days instead. Use CSV import for anything older."
      );
      return client.getTransactions(account.id, floor);
    }
  };

  // Fetch every account first: importing one must not eat into the time Monzo gives for the
  // next one's full history.
  const fetched: {
    monzoAccountId: string;
    wealthfolioAccountId: string;
    transactions: MonzoTransaction[];
  }[] = [];
  for (const [i, [monzoAccountId, wealthfolioAccountId]] of entries.entries()) {
    onProgress({
      phase: "fetch",
      message: "Fetching transactions…",
      current: i + 1,
      total: entries.length,
    });
    const transactions = await fetchAll(monzoAccounts.find((a) => a.id === monzoAccountId)!);
    fetched.push({ monzoAccountId, wealthfolioAccountId, transactions });
  }

  for (const { monzoAccountId, wealthfolioAccountId, transactions } of fetched) {
    try {
      const cleaned = await stripRefTags(ctx, wealthfolioAccountId);
      if (cleaned) log.push(`Removed the [ref:…] tag from ${cleaned} older comment(s).`);
    } catch (err) {
      log.push(`Could not tidy older comments: ${(err as Error).message}`);
    }

    const isFlex = flexAccountIds.has(monzoAccountId);
    const eligible = transactions.filter((tx) => isEligible(tx, isFlex));
    log.push(
      `Account ${monzoAccountId.slice(0, 10)}…: ${transactions.length} fetched${oldestNote(transactions)}, ` +
        `${eligible.length} eligible.`
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
    const desired = eligible.map((tx) =>
      mapTransactionToActivity(tx, wealthfolioAccountId, categoryLabels, ownNames)
    );
    const legacy = new Map(
      eligible.map((tx) => [tx.id, legacyActivity(tx, wealthfolioAccountId, categoryLabels)])
    );
    const outcome = await importNew(ctx, wealthfolioAccountId, desired, legacy);
    updated += outcome.updated;
    imported += outcome.imported;
    duplicates += outcome.duplicates;
    skipped += outcome.skipped;
  }

  // Watermark: when this sync started, or earlier if a transaction was still pending.
  const watermark =
    holdBack && holdBack < startedAt.toISOString() ? holdBack : startedAt.toISOString();
  const finishedAt = new Date().toISOString();
  await store.set(KEY_LAST_SYNC, watermark);
  await store.set(KEY_LAST_RUN, finishedAt);
  // Whatever kind of sync this was, the last 90 days are now covered.
  await store.set(KEY_RECHECKED_90_DAYS, true);
  log.push(
    `Import: ${imported} imported, ${updated} updated, ${duplicates} already present, ${skipped} skipped.`
  );

  // Keep Wealthfolio's Spending categories in step with Monzo's (rules keyed on the category
  // label in each comment). Best effort: never fails the sync.
  onProgress({ phase: "import", message: "Updating spending categories…" });
  const note = spendingRulesNote(await syncSpendingRules(ctx, monzoSpendingRules(categoryLabels)));
  if (note) log.push(note);
  if (watermark !== startedAt.toISOString()) {
    log.push(`Next sync re-checks from ${watermark} (a transaction was still pending).`);
  }

  onProgress({
    phase: "done",
    message: `Synced ${imported} transaction${imported === 1 ? "" : "s"}.`,
  });
  return { imported, skipped, duplicates, breakdown, log, finishedAt };
}

/** What the dashboard keeps showing of the last successful sync, across reloads. */
export interface LastSyncView {
  result: SyncResult;
  steps: SyncStep<SyncPhaseId>[];
}

/** Remembers the last sync's view. Best effort: a storage failure must not fail the sync. */
export async function saveLastSyncView(ctx: AddonContext, view: LastSyncView): Promise<void> {
  try {
    await jsonStore(ctx.api.storage).set(KEY_LAST_RESULT, view);
  } catch {
    /* best effort */
  }
}

/** The saved view, or null when there is none or what is stored is not one. */
export async function loadLastSyncView(ctx: AddonContext): Promise<LastSyncView | null> {
  const v = await jsonStore(ctx.api.storage).get<Partial<LastSyncView> | null>(
    KEY_LAST_RESULT,
    null
  );
  if (!v || typeof v !== "object" || !Array.isArray(v.steps)) return null;
  if (!v.result || typeof v.result.imported !== "number") return null;
  return v as LastSyncView;
}

/**
 * Forgets what was synced: the watermark, so the next sync starts from the beginning again,
 * and the last result, whose log would describe a watermark that no longer exists.
 */
export async function resetSyncHistory(ctx: AddonContext): Promise<void> {
  const store = jsonStore(ctx.api.storage);
  await store.delete(KEY_LAST_SYNC);
  await store.delete(KEY_LAST_RESULT);
}
