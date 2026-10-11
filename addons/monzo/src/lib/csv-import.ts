import type { AddonContext } from "@wealthfolio/addon-sdk";
import type { MonzoTransaction } from "../types";
import { runExclusive } from "./busy";
import { isFlexRepayment, isPotTransfer, legacyActivity, mapTransactionToActivity } from "./mapper";
import { importNew } from "./sync";

/**
 * Drops what should not count as spending: Flex repayments and pot transfers always, and
 * (with `skipTransfers`) the `transfers` and `savings` categories.
 */
export function filterCsvTransactions(
  transactions: MonzoTransaction[],
  skipTransfers: boolean,
): MonzoTransaction[] {
  return transactions.filter(
    (tx) =>
      !isFlexRepayment(tx) &&
      !isPotTransfer(tx) &&
      (!skipTransfers || (tx.category !== "transfers" && tx.category !== "savings")),
  );
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
): Promise<CsvImportOutcome[]> {
  return runExclusive(() => importFiles(ctx, files, categoryLabels, onProgress));
}

async function importFiles(
  ctx: AddonContext,
  files: CsvImportFile[],
  categoryLabels: Record<string, string>,
  onProgress: (name: string, index: number, total: number) => void,
): Promise<CsvImportOutcome[]> {
  const todo = files.filter((f) => f.accountId && f.transactions.length > 0);
  const outcomes: CsvImportOutcome[] = [];
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
  return outcomes;
}
