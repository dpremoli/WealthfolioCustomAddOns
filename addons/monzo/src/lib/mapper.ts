import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { cashSymbol, round2 } from "@wf-addons/kit";
import type { MonzoMerchant, MonzoTransaction } from "../types";
import { resolveCategory } from "./category-map";

const DEPOSIT = "DEPOSIT" as ActivityImport["activityType"];
const WITHDRAWAL = "WITHDRAWAL" as ActivityImport["activityType"];

/**
 * The merchant as an object, or null. Requests use `expand[]=merchant`, which makes it
 * an object; without expansion Monzo sends only the merchant id (a string), which carries
 * no name or address, so it is ignored here.
 */
export function merchantOf(tx: MonzoTransaction): MonzoMerchant | null {
  const m = tx.merchant;
  return m && typeof m === "object" ? m : null;
}

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
  const name = (merchantOf(tx)?.name || tx.description || "").toLowerCase();
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
  const merchant = merchantOf(tx);
  const name = merchant?.name || tx.description;
  if (name) parts.push(name);

  // Category label (skip "General" as it's noise)
  if (tx.category) {
    const label = resolveCategory(tx.category, categoryLabels);
    if (label !== "General") parts.push(label);
  }

  // Merchant location
  const city = merchant?.address?.city;
  const country = merchant?.address?.country;
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
  const amountInMajorUnits = round2(Math.abs(tx.amount) / 100);

  return {
    id: tx.id,
    accountId: wealthfolioAccountId,
    activityType: tx.amount >= 0 ? DEPOSIT : WITHDRAWAL,
    date: tx.created,
    amount: amountInMajorUnits,
    currency,
    // `$CASH-GBP`, not a bare "GBP": a bare code is valued as a security via an FX quote
    // and inflates account totals.
    symbol: cashSymbol(currency),
    isValid: true,
    isDraft: false,
    comment: buildComment(tx, categoryLabels) || undefined,
  };
}
