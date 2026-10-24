import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import { moveLinkNote, unsavedMessage } from "@wf-addons/kit";
import type { MonzoTransaction } from "../types";
import { runExclusive } from "./busy";
import {
  isFlexRefund,
  isFlexRepayment,
  isFlexRepaymentDebit,
  isPotTransfer,
  isSavingsMove,
  legacyActivity,
  mapTransactionToActivity,
} from "./mapper";
import { importNew } from "./sync";
import { flexCreditsOf, linkNote, linkTransfers, matchWithCashIsa } from "./transfers";

/**
 * Drops what should not count as spending: pot transfers always, and (with `skipTransfers`)
 * the `transfers` category. Savings moves (to Trading 212 and the like) are kept: they change the
 * balance, so they are imported as ordinary withdrawals and deposits. Flex repayments and refunds are not spending
 * either, but they are not dropped by `skipTransfers`: they move money between the current
 * account and Flex, and are kept as transfers. A repayment needs a Flex account to credit
 * (`flexTracked`) and is dropped without one; a credit that looks like a repayment is always
 * dropped, since the import writes the Flex side itself.
 */
export function filterCsvTransactions(
  transactions: MonzoTransaction[],
  skipTransfers: boolean,
  flexTracked: boolean,
  /** The file is the Flex account's own export: repayments are not on it, so none are kept. */
  isFlexFile = false,
): MonzoTransaction[] {
  return transactions.filter((tx) => {
    if (isPotTransfer(tx)) return false;
    if (isFlexRefund(tx) || isSavingsMove(tx)) return true;
    if (isFlexRepayment(tx)) return flexTracked && !isFlexFile && isFlexRepaymentDebit(tx);
    return !skipTransfers || (tx.category !== "transfers" && tx.category !== "savings");
  });
}

export interface CsvImportFile {
  name: string;
  /** Target Wealthfolio account; a file without one is skipped. */
  accountId: string;
  /** Already filtered (see `filterCsvTransactions`). */
  transactions: MonzoTransaction[];
}

export interface CsvImportOutcome {
  name: string;
  imported: number;
  /** Already imported rows rewritten because the transaction changed. */
  updated: number;
  duplicates: number;
  error?: string;
}

export interface CsvImportOptions {
  /** The Wealthfolio account that repayments are credited to (the Flex account). */
  flexAccountId?: string;
  /** Receives one-line remarks about the whole import (e.g. how many transfers were linked). */
  onNote?: (note: string) => void;
}

/**
 * Imports the files one after another, never in parallel: `importNew` reads and rewrites one
 * shared ledger in add-on storage, so concurrent calls would lose entries. A file that fails
 * reports its error and does not stop the rest; files with no account or nothing to import
 * are skipped (and absent from the result). Never overlaps a sync or another import: that
 * rejects with a message saying so.
 */
export async function importCsvFiles(
  ctx: AddonContext,
  files: CsvImportFile[],
  categoryLabels: Record<string, string> = {},
  onProgress: (name: string, index: number, total: number) => void = () => {},
  options: CsvImportOptions = {},
): Promise<CsvImportOutcome[]> {
  return runExclusive(() => importFiles(ctx, files, categoryLabels, onProgress, options));
}

async function importFiles(
  ctx: AddonContext,
  files: CsvImportFile[],
  categoryLabels: Record<string, string>,
  onProgress: (name: string, index: number, total: number) => void,
  { flexAccountId, onNote = () => {} }: CsvImportOptions,
): Promise<CsvImportOutcome[]> {
  const todo = files.filter((f) => f.accountId && f.transactions.length > 0);
  const outcomes: CsvImportOutcome[] = [];
  const imported: ActivityImport[] = [];
  const credits = new Map<string, ActivityImport>();
  const savingsIds = new Set<string>();
  for (const [i, file] of todo.entries()) {
    onProgress(file.name, i, todo.length);
    try {
      // A repayment in the Flex account's own file is not a debit from a current account.
      const transactions = filterCsvTransactions(file.transactions, false, !!flexAccountId, file.accountId === flexAccountId);
      const activities = transactions.map((tx) =>
        mapTransactionToActivity(tx, file.accountId, categoryLabels),
      );
      // Reconcile against what the account already holds (by count, so genuine repeats
      // survive) and force-import the rest. Rows carry their Monzo transaction id, so this is
      // safe to re-run or overlap with API syncs and other files.
      const legacy = new Map(
        file.transactions.map((tx) => [tx.id, legacyActivity(tx, file.accountId, categoryLabels)]),
      );
      const savings = new Set(transactions.filter(isSavingsMove).map((tx) => tx.id));
      savings.forEach((id) => savingsIds.add(id));
      const outcome = await importNew(ctx, file.accountId, activities, legacy, savings);
      imported.push(...activities);
      if (flexAccountId) {
        for (const credit of flexCreditsOf(transactions, flexAccountId, categoryLabels)) {
          credits.set(credit.id!, credit);
        }
      }
      outcomes.push({
        name: file.name,
        imported: outcome.imported,
        updated: outcome.updated,
        duplicates: outcome.duplicates,
        error: unsavedMessage(outcome.unsaved),
      });
    } catch (err) {
      outcomes.push({
        name: file.name,
        imported: 0,
        updated: 0,
        duplicates: 0,
        error: (err as Error).message,
      });
    }
  }
  if (credits.size > 0 && flexAccountId) {
    // The Flex side of each repayment. Safe to repeat: the ledger knows the ids.
    try {
      const credited = await importNew(ctx, flexAccountId, [...credits.values()]);
      imported.push(...credits.values());
      const unsaved = unsavedMessage(credited.unsaved);
      if (unsaved) onNote(`Could not credit the Flex account with all the repayments: ${unsaved}`);
    } catch (err) {
      onNote(`Could not credit the Flex account with the repayments: ${(err as Error).message}`);
    }
  }
  const note = linkNote(await linkTransfers(ctx, imported));
  if (note) onNote(note);
  if (savingsIds.size > 0) {
    const current = [...new Set(todo.map((f) => f.accountId))].filter((id) => id !== flexAccountId);
    const isaNote = moveLinkNote("Trading 212", await matchWithCashIsa(ctx, current));
    if (isaNote) onNote(isaNote);
  }
  return outcomes;
}
