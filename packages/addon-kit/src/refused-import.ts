import type { ActivityImport } from "@wealthfolio/addon-sdk";
import type { UnsavedRow } from "./host-import";
import { addRefused, settleRefused, type RefusedRows } from "./refused-rows";

/**
 * Glue between {@link importStoredRows} and the refused-rows store, for importers that reconcile
 * rows against a ledger before importing (Monzo, Revolut, the Cash ISA CSV import):
 *
 * 1. `pendingRows`: the rows to reconcile are the refused ones of this account plus the new ones,
 *    so a refused row goes through the same ledger / content check (one already in the account is
 *    not sent again) and is sent again with everything else;
 * 2. reconcile, then `importStoredRows`;
 * 3. `recordRefused`: a row stored or already there leaves the list, a refused one joins it (or
 *    counts another attempt).
 */

/** `desired` plus the refused rows of `accountId` (first), once each: a row served again wins. */
export function pendingRows(refused: RefusedRows, accountId: string, desired: ActivityImport[]): ActivityImport[] {
  const fresh = new Map(desired.filter((a) => a.id).map((a) => [a.id!, a]));
  const retry = refused.entries
    .flatMap((e) => e.unit)
    .filter((a) => a.accountId === accountId)
    .map((a) => (a.id && fresh.get(a.id)) || a);
  const retrying = new Set(retry.map((a) => a.id).filter(Boolean));
  return [...retry, ...desired.filter((a) => !a.id || !retrying.has(a.id))];
}

/**
 * The refused rows after an import: `accounted` (stored, already there, adopted) settle their
 * entries, and each `unsaved` row is added as a unit of its own with the host's reason.
 */
export function recordRefused(refused: RefusedRows, accounted: ActivityImport[], unsaved: UnsavedRow[]): RefusedRows {
  const settled = settleRefused(refused, accounted.flatMap((a) => (a.id ? [a.id] : [])));
  return addRefused(settled, unsaved.map((u) => ({ unit: [u.activity], reason: u.reason })));
}
