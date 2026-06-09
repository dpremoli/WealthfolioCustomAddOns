import type { ActivityImport } from "@wealthfolio/addon-sdk";
import type { MonzoTransaction } from "../types";
import { resolveCategory } from "./category-map";

const DEPOSIT = "DEPOSIT" as ActivityImport["activityType"];
const WITHDRAWAL = "WITHDRAWAL" as ActivityImport["activityType"];

export function isPending(tx: MonzoTransaction): boolean {
  return tx.settled === "";
}

export function isPotTransfer(tx: MonzoTransaction): boolean {
  return tx.metadata?.provider_category === "uk_retail_pot";
}

export function isFlexRepayment(tx: MonzoTransaction): boolean {
  // The monthly Flex repayment debited from the current account is an internal
  // transfer paying down the Flex balance, not new spending. The matching spend
  // is already imported on the Flex account, so importing this too double-counts.
  const name = (tx.merchant?.name || tx.description || "").toLowerCase();
  return tx.category === "transfers" && name.includes("flex");
}

/**
 * Tallies spending transactions (debits) by their resolved category label, for the
 * dashboard breakdown. Credits (income/refunds) are ignored. Reuses the same
 * `resolveCategory` + user overrides as the comment, so labels match. Pure + testable;
 * the sync passes its eligible (non-pending, non-pot, non-Flex-repayment) transactions in.
 */
export function tallyByCategory(
  txs: MonzoTransaction[],
  categoryLabels: Record<string, string> = {},
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const tx of txs) {
    if (tx.amount >= 0) continue; // spending only
    const label = resolveCategory(tx.category || "general", categoryLabels);
    out[label] = (out[label] ?? 0) + 1;
  }
  return out;
}

function buildComment(
  tx: MonzoTransaction,
  categoryLabels: Record<string, string>,
): string {
  const parts: string[] = [];

  // Primary description: prefer merchant name, fall back to description
  const name = tx.merchant?.name || tx.description;
  if (name) parts.push(name);

  // Category label (skip "General" as it's noise)
  if (tx.category) {
    const label = resolveCategory(tx.category, categoryLabels);
    if (label !== "General") parts.push(label);
  }

  // Merchant location
  const city = tx.merchant?.address?.city;
  const country = tx.merchant?.address?.country;
  if (city && country) parts.push(`${city}, ${country}`);
  else if (city) parts.push(city);

  // Foreign currency amount
  if (
    tx.local_currency &&
    tx.local_amount !== undefined &&
    tx.local_currency !== tx.currency
  ) {
    const localAmt = (Math.abs(tx.local_amount) / 100).toFixed(2);
    parts.push(`${tx.local_currency} ${localAmt}`);
  }

  // User notes (only if different from description)
  if (tx.notes && tx.notes !== tx.description) {
    parts.push(`Note: ${tx.notes}`);
  }

  return parts.join(" | ");
}

export function mapTransactionToActivity(
  tx: MonzoTransaction,
  wealthfolioAccountId: string,
  categoryLabels: Record<string, string> = {},
): ActivityImport {
  const currency = tx.currency || "GBP";
  const amountInMajorUnits = Math.round((Math.abs(tx.amount) / 100) * 100) / 100;

  return {
    id: tx.id,
    accountId: wealthfolioAccountId,
    activityType: tx.amount >= 0 ? DEPOSIT : WITHDRAWAL,
    date: tx.created,
    amount: amountInMajorUnits,
    currency,
    symbol: currency,
    isValid: true,
    isDraft: false,
    comment: buildComment(tx, categoryLabels) || undefined,
  };
}
