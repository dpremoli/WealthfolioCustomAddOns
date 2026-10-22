import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { cashSymbol, round2 } from "@wf-addons/kit";
import type { MonzoMerchant, MonzoTransaction } from "../types";
import { resolveCategory } from "./category-map";
import { SPENDING_CATEGORY_CANDIDATES } from "./spending-rules";

const DEPOSIT = "DEPOSIT" as ActivityImport["activityType"];
const WITHDRAWAL = "WITHDRAWAL" as ActivityImport["activityType"];
const CREDIT = "CREDIT" as ActivityImport["activityType"];
const TRANSFER_IN = "TRANSFER_IN" as ActivityImport["activityType"];
const TRANSFER_OUT = "TRANSFER_OUT" as ActivityImport["activityType"];

/** Suffix of the id of the Flex-account credit the add-on writes for a repayment. */
export const FLEX_CREDIT_SUFFIX = ":flex-in";

/**
 * Money back on a spending category (a refund, or Monzo's "Refunded (Flex)"), as opposed to
 * income or a transfer. Wealthfolio counts a cash `DEPOSIT` as income, so these are imported
 * as a `CREDIT` with subtype `REFUND`, which reduces the category's spending instead.
 * "General" credits are too vague to call refunds, and top-ups are not.
 */
export function isRefund(tx: MonzoTransaction): boolean {
  return (
    tx.amount > 0 &&
    !tx.is_load &&
    tx.category !== "general" &&
    Object.prototype.hasOwnProperty.call(SPENDING_CATEGORY_CANDIDATES, tx.category)
  );
}

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

/** Money moved between the account and one of its pots (not spending or income). */
export function isPotTransfer(tx: MonzoTransaction): boolean {
  return (
    tx.scheme === "uk_retail_pot" ||
    !!tx.metadata?.pot_id ||
    tx.metadata?.provider_category === "uk_retail_pot"
  );
}

/** Declined card attempts carry `decline_reason`; no money moved. */
export function isDeclined(tx: MonzoTransaction): boolean {
  return !!tx.decline_reason;
}

export function isFlexRepayment(tx: MonzoTransaction): boolean {
  // The monthly Flex repayment debited from the current account: the money that pays down
  // the Flex balance. It is a transfer between two of the user's own accounts, not spending.
  const name = (merchantOf(tx)?.name || tx.description || "").toLowerCase();
  return tx.category === "transfers" && name.includes("flex") && !isFlexRefund(tx);
}

/**
 * The debit side of a Flex repayment, on the current account. Monzo's Flex feed has no row
 * for the repayment, so the add-on writes the Flex side itself ({@link flexRepaymentCredit});
 * a credit that looks like a repayment is never imported, which would count it twice.
 */
export function isFlexRepaymentDebit(tx: MonzoTransaction): boolean {
  return tx.amount < 0 && isFlexRepayment(tx);
}

const FLEX_REFUND = /refunded\s*\(flex\)/i;

/**
 * One leg of a refunded Flex purchase. Monzo moves the refunded money off the Flex account
 * ("Refunded (Flex)") and into the current account, a debit on Flex and a credit on the
 * current account. Both are transfers between the user's own accounts, not income or spending.
 */
export function isFlexRefund(tx: MonzoTransaction): boolean {
  return [tx.description, tx.notes, merchantOf(tx)?.name, tx.counterparty?.name].some((t) =>
    FLEX_REFUND.test(t ?? ""),
  );
}

/**
 * Money moved to or from a savings or investment account outside Monzo (Trading 212, say): the
 * `savings` category, other than moves between the account and its own pots. It is the user's own
 * money changing place, so it is not spending (and no spending rule files it), but it does change
 * the balance, so it is imported as an ordinary withdrawal or deposit.
 */
export function isSavingsMove(tx: MonzoTransaction): boolean {
  return tx.category === "savings" && !isPotTransfer(tx);
}

/** A transaction that moves money between the current account and Flex. */
export function isFlexTransfer(tx: MonzoTransaction): boolean {
  return isFlexRefund(tx) || isFlexRepaymentDebit(tx);
}

/**
 * Tallies spending transactions (debits) by their resolved category label, for the
 * dashboard breakdown. Credits (income/refunds) are ignored. Reuses the same
 * `resolveCategory` + user overrides as the comment, so labels match. Pure + testable;
 * the sync passes its eligible (non-pending, non-pot) transactions in; Flex transfers and savings moves are skipped.
 */
export function tallyByCategory(
  txs: MonzoTransaction[],
  categoryLabels: Record<string, string> = {},
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const tx of txs) {
    if (tx.amount >= 0 || isFlexTransfer(tx) || tx.category === "savings") continue; // spending only
    const label = resolveCategory(tx.category || "general", categoryLabels);
    out[label] = (out[label] ?? 0) + 1;
  }
  return out;
}

/** Monzo internal ids (`user_…`, `acc_…`, `pot_…`) that sometimes stand in for a description. */
const INTERNAL_ID = /^(?:user|anonuser|acc|pot|merch)_[0-9A-Za-z]+$/;

/** Who the money went to or came from, for display. */
export function payeeName(tx: MonzoTransaction): string {
  const merchant = merchantOf(tx)?.name?.trim();
  if (merchant) return merchant;
  const counterparty = (tx.counterparty?.preferred_name || tx.counterparty?.name || "").trim();
  if (counterparty) return counterparty;
  const description = (tx.description || "").trim();
  return INTERNAL_ID.test(description) ? "" : description;
}

/**
 * The payment reference of a transfer, when it says something: not a merchant's raw
 * statement text, not the payee again, not an internal id, and not just the sender's own
 * name (Monzo's default reference, passed in as `ownNames`).
 */
function paymentReference(tx: MonzoTransaction, name: string, ownNames: ReadonlySet<string>): string | null {
  if (merchantOf(tx)?.name || !(tx.counterparty?.name || tx.counterparty?.preferred_name)) return null;
  const ref = (tx.description || "").trim();
  if (!ref || INTERNAL_ID.test(ref)) return null;
  const lower = ref.toLowerCase();
  if (lower === name.toLowerCase() || ownNames.has(lower)) return null;
  return ref;
}

function buildComment(
  tx: MonzoTransaction,
  categoryLabels: Record<string, string>,
  ownNames: ReadonlySet<string>,
  legacy = false,
): string {
  const parts: string[] = [];

  // Who it was paid to / received from; the category label must stay second (spending rules
  // match it there). Versions up to 2.2 used the merchant name or else the description.
  const merchant = merchantOf(tx);
  const name = legacy ? merchant?.name || tx.description : payeeName(tx);
  if (name) parts.push(name);

  // Category label. Versions up to 2.2 left out "General"; it is kept now so the spending
  // rules can file it.
  if (tx.category) {
    const label = resolveCategory(tx.category, categoryLabels);
    if (!legacy || label !== "General") parts.push(label);
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

  const reference = legacy ? null : paymentReference(tx, name, ownNames);
  if (reference) parts.push(`Ref: ${reference}`);

  // User notes (only if different from description)
  if (tx.notes && tx.notes !== tx.description) {
    parts.push(`Note: ${tx.notes}`);
  }

  return parts.join(" | ");
}

/**
 * `tx` as versions up to 2.2 imported it (a plain DEPOSIT/WITHDRAWAL, the old comment, no
 * `[ref:…]` tag): lets rows they imported be recognised, and rewritten in the current form.
 */
export function legacyActivity(
  tx: MonzoTransaction,
  wealthfolioAccountId: string,
  categoryLabels: Record<string, string> = {},
): ActivityImport {
  const current = mapTransactionToActivity(tx, wealthfolioAccountId, categoryLabels);
  return {
    ...current,
    activityType: tx.amount >= 0 ? DEPOSIT : WITHDRAWAL,
    subtype: undefined,
    comment: buildComment(tx, categoryLabels, new Set(), true) || undefined,
  };
}

export function mapTransactionToActivity(
  tx: MonzoTransaction,
  wealthfolioAccountId: string,
  categoryLabels: Record<string, string> = {},
  /** Lower-cased names of the account holders, to drop "reference = my own name". */
  ownNames: ReadonlySet<string> = new Set(),
): ActivityImport {
  const currency = tx.currency || "GBP";
  const amountInMajorUnits = round2(Math.abs(tx.amount) / 100);
  const transfer = isFlexTransfer(tx);

  return {
    id: tx.id,
    accountId: wealthfolioAccountId,
    activityType: transfer
      ? tx.amount >= 0
        ? TRANSFER_IN
        : TRANSFER_OUT
      : isRefund(tx)
        ? CREDIT
        : tx.amount >= 0
          ? DEPOSIT
          : WITHDRAWAL,
    subtype: !transfer && isRefund(tx) ? "REFUND" : undefined,
    // Between the user's own accounts: neither income nor spending.
    ...(transfer ? { isExternal: false } : {}),
    date: tx.created,
    amount: amountInMajorUnits,
    currency,
    // `$CASH-GBP`, not a bare "GBP": a bare code is valued as a security via an FX quote
    // and inflates account totals.
    symbol: cashSymbol(currency),
    isValid: true,
    isDraft: false,
    // `id` is the Monzo transaction id; `importNew` remembers imported ids so a re-fetch (or
    // a CSV import of the same transaction) is recognised even after its comment changed.
    comment: buildComment(tx, categoryLabels, ownNames) || undefined,
  };
}

/**
 * The Flex-account side of a repayment: the same amount and date as the debit on the current
 * account, as a `TRANSFER_IN` that pays the Flex balance down. Its id is the debit's plus
 * {@link FLEX_CREDIT_SUFFIX}, so the import ledger tells the two rows apart.
 */
export function flexRepaymentCredit(
  tx: MonzoTransaction,
  flexAccountId: string,
  categoryLabels: Record<string, string> = {},
  ownNames: ReadonlySet<string> = new Set(),
): ActivityImport {
  return {
    ...mapTransactionToActivity(tx, flexAccountId, categoryLabels, ownNames),
    id: `${tx.id}${FLEX_CREDIT_SUFFIX}`,
    activityType: TRANSFER_IN,
  };
}
