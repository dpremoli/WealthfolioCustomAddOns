import type { ActivityImport } from "@wealthfolio/addon-sdk";
import type { MonzoTransaction } from "../types";

const DEPOSIT = "DEPOSIT" as ActivityImport["activityType"];
const WITHDRAWAL = "WITHDRAWAL" as ActivityImport["activityType"];

export function isPending(tx: MonzoTransaction): boolean {
  return tx.settled === "";
}

export function isPotTransfer(tx: MonzoTransaction): boolean {
  return tx.metadata?.provider_category === "uk_retail_pot";
}

function formatCategory(category: string): string {
  return category
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function buildComment(tx: MonzoTransaction): string {
  const parts: string[] = [];

  // Primary description: prefer merchant name, fall back to description
  const name = tx.merchant?.name || tx.description;
  if (name) parts.push(name);

  // Category (skip generic ones)
  if (tx.category && tx.category !== "general") {
    parts.push(formatCategory(tx.category));
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
): ActivityImport {
  const currency = tx.currency || "GBP";
  const amountInMajorUnits = Math.round(Math.abs(tx.amount) / 100 * 100) / 100;

  return {
    id: tx.id,
    accountId: wealthfolioAccountId,
    activityType: tx.amount >= 0 ? DEPOSIT : WITHDRAWAL,
    date: tx.created, // full ISO timestamp — preserves actual transaction time
    amount: amountInMajorUnits,
    currency,
    symbol: currency,
    isValid: true,
    isDraft: false,
    comment: buildComment(tx) || undefined,
  };
}
