import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import type { MonzoTransaction } from "../types";
import { runExclusive } from "./busy";
import {
  flexRepaymentCredit,
  isFlexRefund,
  isFlexRepayment,
  isFlexRepaymentDebit,
  isPotTransfer,
  legacyActivity,
  mapTransactionToActivity,
} from "./mapper";
import { importNew } from "./sync";
import { linkNote, linkTransfers } from "./transfers";

/**
 * Drops what should not count as spending: pot transfers always, and (with `skipTransfers`)
 * the `transfers` and `savings` categories. Flex repayments and refunds are not spending
 * either, but they are not dropped by `skipTransfers`: they move money between the current
 * account and Flex, and are kept as transfers. A repayment needs a Flex account to credit
 * (`flexTracked`) and is dropped without one; a credit that looks like a repayment is always
 * dropped, since the import writes the Flex side itself.
 */
export function filterCsvTransactions(
  transactions: MonzoTransaction[],
  skipTransfers: boolean,
  flexTracked: boolean,
): MonzoTransaction[] {
  return transactions.filter((tx) => {
    if (isPotTransfer(tx)) return false;
    if (isFlexRefund(tx)) return true;
    if (isFlexRepayment(tx)) return flexTracked && isFlexRepaymentDebit(tx);
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
  for (const [i, file] of todo.entries()) {
    onProgress(file.name, i, todo.length);
    try {
      const activities = file.transactions.map((tx) =>
        mapTransactionToActivity(tx, file.accountId, categoryLabels),
      );
      // Reconcile against what the account already holds (by count, so genuine repeats
      // survive) and force-import the rest. Rows carry their Monzo transaction id, so this is
      // safe to re-run or overlap with API syncs and other files.
      const legacy = new Map(
        file.transactions.map((tx) => [tx.id, legacyActivity(tx, file.accountId, categoryLabels)]),
      );
      const outcome = await importNew(ctx, file.accountId, activities, legacy);
      imported.push(...activities);
      if (flexAccountId) {
        for (const tx of file.transactions.filter(isFlexRepaymentDebit)) {
          const credit = flexRepaymentCredit(tx, flexAccountId, categoryLabels);
          credits.set(credit.id!, credit);
        }
      }
      outcomes.push({
        name: file.name,
        imported: outcome.imported,
        updated: outcome.updated,
        duplicates: outcome.duplicates,
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
      await importNew(ctx, flexAccountId, [...credits.values()]);
      imported.push(...credits.values());
    } catch (err) {
      onNote(`Could not credit the Flex account with the repayments: ${(err as Error).message}`);
    }
  }
  const note = linkNote(await linkTransfers(ctx, imported));
  if (note) onNote(note);
  return outcomes;
}
