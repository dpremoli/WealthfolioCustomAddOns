import type { Account, ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import {
  MOVE_MATCH_WINDOW_MS,
  adoptUntrackedRows,
  isTrading212Payee,
  jsonStore,
  ledgerAccountId,
  ledgerEntry,
  moveLinkNote,
  reconcileWithLedger,
  trading212Refs,
  type ImportLedger,
} from "@wf-addons/kit";
import { KEY_IMPORTED_IDS } from "../constants";
import type { RevolutTransaction } from "../types";
import { exchangeLinkNote, linkExchanges } from "./exchanges";
import { mapTransactionToActivity, openingBalanceActivity } from "./mapper";
import { isSavingsMove, isTrading212Account, linkSavingsMoves, linkTrading212Moves } from "./moves";

export interface ImportOutcome {
  imported: number;
  /** Already imported rows rewritten because the add-on now maps them differently. */
  updated: number;
  /** Already in the account (by id, or matched to an older row), so not imported again. */
  duplicates: number;
}

/**
 * Imports `desired` into a Wealthfolio account without duplicating what is already there.
 *
 * Wealthfolio's own content-hash dedupe would drop genuine identical same-day transactions, so
 * every row is force-imported and idempotency is handled here, by the kit's
 * `reconcileWithLedger`: the add-on remembers each imported row id (with its account and content
 * hash) in storage, so a re-imported row is recognised by its id even after it was converted to
 * a transfer, linked or edited. Rows imported before the ledger existed (versions before 2.1) are
 * matched by content the first time and recorded, so re-importing an old statement adds nothing.
 *
 * Revolut's ids are derived from the row itself (time, amount, description, balance), so the
 * source never changes under an id. A row is only reported `stale` when a later version of the
 * add-on maps the same row differently; it is then rewritten, like Monzo does when a transaction
 * changes. A row the user edited, or that linking converted to a transfer, no longer matches the
 * hash the ledger holds, so it is never rewritten.
 *
 * `movesIds` are rows that may be a move between the user's own accounts (Trading 212, a savings
 * pot, a top-up): one the user (or the linking) already turned into a transfer before the ledger
 * knew it is taken for the same move instead of being imported again.
 */
export async function importRows(
  ctx: AddonContext,
  accountId: string,
  desired: ActivityImport[],
  movesIds: ReadonlySet<string> = new Set(),
): Promise<ImportOutcome> {
  if (desired.length === 0) return { imported: 0, updated: 0, duplicates: 0 };
  const store = jsonStore(ctx.api.storage);
  const existing = await ctx.api.activities.getAll(accountId);
  const reconciled = reconcileWithLedger(
    desired,
    existing,
    await store.get<ImportLedger>(KEY_IMPORTED_IDS, {}),
    accountId,
  );
  const { present, stale, ledger } = reconciled;
  const { toImport, adopted } = adoptUntrackedRows(reconciled.toImport, existing, ledger, accountId, {
    equivalents: { DEPOSIT: ["TRANSFER_IN"], WITHDRAWAL: ["TRANSFER_OUT"] },
    eligible: (a) => !!a.id && movesIds.has(a.id),
    // The two legs of a move can be dated days apart; a transfer made by hand carries one date.
    windowMs: MOVE_MATCH_WINDOW_MS,
  });
  let imported = 0;
  if (toImport.length > 0) {
    const r = await ctx.api.activities.import(toImport);
    imported = r.summary.imported;
  }
  await store.set(KEY_IMPORTED_IDS, ledger);

  let updated = 0;
  if (stale.length > 0) {
    // Best effort: a refused update leaves the row as it was, and the next import retries it.
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
    if (!res) return { imported, updated: 0, duplicates: present.length + adopted.length };
    const failed = new Set((res.errors ?? []).map((e) => e.id));
    for (const { row, activity } of stale) {
      if (failed.has(row.id) || !activity.id) continue;
      ledger[activity.id] = ledgerEntry(accountId, activity);
      updated++;
    }
    await store.set(KEY_IMPORTED_IDS, ledger);
  }
  return { imported, updated, duplicates: present.length + adopted.length - updated };
}

export interface StatementImportOutcome extends ImportOutcome {
  /** One line per kind of linking (exchanges, Trading 212, savings). */
  notes: string[];
}

/**
 * Imports a parsed Revolut statement: each currency's rows (with its opening balance) into the
 * account `mapping` names for it, so every account reconciles to Revolut's per-currency balance.
 * Currencies without an account are skipped. Then links what moved between the user's own
 * accounts: the two legs of each currency exchange, moves to and from Trading 212, and (with
 * `savingsAccountId`) moves into and out of Revolut savings. Linking is best effort and never
 * fails the import.
 */
export async function importStatement(
  ctx: AddonContext,
  transactions: RevolutTransaction[],
  mapping: Record<string, string>,
  opts: { savingsAccountId?: string } = {},
): Promise<StatementImportOutcome> {
  const accounts = await ctx.api.accounts.getAll();
  const refs = trading212Refs(accounts);
  const total: ImportOutcome = { imported: 0, updated: 0, duplicates: 0 };
  for (const currency of new Set(transactions.map((tx) => tx.currency))) {
    const accountId = mapping[currency];
    if (!accountId) continue;
    const subset = transactions.filter((tx) => tx.currency === currency);
    const movements = subset.flatMap((tx) => mapTransactionToActivity(tx, accountId));
    // Seed the money held before the statement's first row so the balance matches Revolut.
    const opening = openingBalanceActivity(subset, accountId);
    const desired = opening ? [opening, ...movements] : movements;
    const moves = new Set(
      subset
        .filter(
          (tx) =>
            tx.type.toLowerCase() === "topup" ||
            isSavingsMove(tx.description) ||
            isTrading212Payee(tx.description, refs),
        )
        .map((tx) => tx.id),
    );
    // One currency at a time: each call reads and rewrites the shared ledger.
    const outcome = await importRows(ctx, accountId, desired, moves);
    total.imported += outcome.imported;
    total.updated += outcome.updated;
    total.duplicates += outcome.duplicates;
  }

  const notes = await linkOwnMoves(ctx, mapping, accounts, opts.savingsAccountId);
  return { ...total, notes };
}

/**
 * The accounts Revolut rows live in: every account the add-on has imported into (from the
 * ledger, so a currency missing from this statement still counts) and every mapped one, that
 * still exists.
 */
export async function revolutAccountIds(
  ctx: AddonContext,
  mapping: Record<string, string>,
  accounts: Pick<Account, "id">[],
): Promise<string[]> {
  const ledger = await jsonStore(ctx.api.storage).get<ImportLedger>(KEY_IMPORTED_IDS, {});
  const ids = new Set([...Object.values(ledger).map(ledgerAccountId), ...Object.values(mapping)]);
  return accounts.map((a) => a.id).filter((id) => ids.has(id));
}

async function linkOwnMoves(
  ctx: AddonContext,
  mapping: Record<string, string>,
  accounts: Account[],
  savingsAccountId: string | undefined,
): Promise<string[]> {
  const notes: string[] = [];
  try {
    const savings = savingsAccountId ? accounts.find((a) => a.id === savingsAccountId) : undefined;
    // The savings account is the other side of a savings move, never one of "ours".
    const mine = (await revolutAccountIds(ctx, mapping, accounts)).filter((id) => id !== savings?.id);

    notes.push(exchangeLinkNote(await linkExchanges(ctx, mine)));

    if (accounts.some(isTrading212Account)) {
      const t212 = await linkTrading212Moves(ctx, mine, accounts);
      notes.push(moveLinkNote("Trading 212", t212) ?? "Moves to and from Trading 212: none to link.");
    }
    if (savings) {
      const saved = await linkSavingsMoves(ctx, mine, savings.id, accounts);
      notes.push(moveLinkNote(savings.name, saved) ?? `Moves to and from ${savings.name}: none to link.`);
    }
  } catch (err) {
    notes.push(`Could not link transfers: ${(err as Error).message}`);
  }
  for (const n of notes) ctx.api.logger.info(`Revolut import: ${n}`);
  return notes;
}
