import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { cashSymbol, fnv1a, round2 } from "@wf-addons/kit";
import type { RevolutTransaction } from "../types";

const DEPOSIT = "DEPOSIT" as ActivityImport["activityType"];
const WITHDRAWAL = "WITHDRAWAL" as ActivityImport["activityType"];
const TRANSFER_IN = "TRANSFER_IN" as ActivityImport["activityType"];
const TRANSFER_OUT = "TRANSFER_OUT" as ActivityImport["activityType"];
const FEE = "FEE" as ActivityImport["activityType"];

/**
 * Picks the Wealthfolio activity type for a Revolut row from its `type` and sign.
 *
 * The goal is a balance that always matches Revolut while keeping the spending module
 * clean: Wealthfolio's spending analytics count DEPOSIT/WITHDRAWAL but ignore the
 * TRANSFER_* types, so internal money movement (transfers between accounts, currency
 * exchanges) stays in the cash balance yet never shows up as spending.
 *
 *   - Transfer / Exchange → TRANSFER_IN (credit) or TRANSFER_OUT (debit). A cross-currency
 *     exchange therefore becomes a TRANSFER_OUT on one currency's account and a TRANSFER_IN
 *     on the other's — each account reconciles independently, no cross-account link needed.
 *   - Top-up → DEPOSIT (incoming funding / salary; income, not spending).
 *   - Anything else (Card Payment, ATM, Card Refund, Cashback, …) → DEPOSIT/WITHDRAWAL by sign.
 */
export function mapType(revolutType: string, amount: number): ActivityImport["activityType"] {
  const t = (revolutType || "").toLowerCase();
  if (t === "transfer" || t === "exchange") return amount >= 0 ? TRANSFER_IN : TRANSFER_OUT;
  if (t === "topup") return DEPOSIT;
  return amount >= 0 ? DEPOSIT : WITHDRAWAL;
}

/**
 * Builds an "Opening balance" activity that seeds the money already in the account
 * before the statement's first row.
 *
 * Revolut's CSV only lists movements within the statement period, so summing the
 * imported DEPOSIT/WITHDRAWAL/FEE activities reproduces the *net flow*, not the real
 * ending balance — the account is short by whatever it held on day one. We recover
 * that opening balance from the earliest row's `Balance` column (which is the running
 * balance *after* that row) by reversing the row's own effect:
 *
 *   balanceAfter = opening + amount − fee   ⇒   opening = balanceAfter − amount + fee
 *
 * Returns `null` when the opening balance can't be derived (no Balance column) or is
 * zero (nothing to seed). The id, day and comment are deterministic, so re-importing
 * the same statement reproduces the identical row and the host de-dupes it cleanly.
 *
 * Caveat: this assumes a single statement covering the account's start. Importing a
 * second statement that begins *earlier* would seed a second, different opening balance.
 */
export function openingBalanceActivity(
  transactions: RevolutTransaction[],
  wealthfolioAccountId: string,
): ActivityImport | null {
  if (transactions.length === 0) return null;

  // Earliest row by date — the CSV is usually oldest-first, but don't rely on order.
  const earliest = transactions.reduce((a, b) => (a.date <= b.date ? a : b));
  if (earliest.balance === null) return null;

  const opening = round2(earliest.balance - earliest.amount + earliest.fee);
  if (opening === 0) return null;

  const currency = earliest.currency || "GBP";
  // Date the seed at the start of the earliest transaction's day so it precedes every
  // movement and lands on a stable, re-import-deterministic day.
  const day = String(earliest.date).slice(0, 10);
  const date = `${day}T00:00:00.000Z`;

  return {
    id: `revolut-opening-${fnv1a(`${currency}|${opening}|${day}`)}`,
    accountId: wealthfolioAccountId,
    activityType: opening >= 0 ? DEPOSIT : WITHDRAWAL,
    date,
    amount: Math.abs(opening),
    currency,
    symbol: cashSymbol(currency),
    isValid: true,
    isDraft: false,
    comment: "Opening balance",
  };
}

/**
 * Maps a Revolut transaction to one or more Wealthfolio activities.
 *
 * `mapType` picks the activity type from the Revolut `type` and sign so the balance
 * matches Revolut while transfers/exchanges stay out of the spending module. The
 * merchant description is passed through as the comment so Wealthfolio's spending
 * module can categorise it. When Revolut charged a separate fee, a second FEE activity
 * is emitted (with a derived `-fee` id) so the cash balance stays accurate when
 * importing every row.
 */
export function mapTransactionToActivity(
  tx: RevolutTransaction,
  wealthfolioAccountId: string,
): ActivityImport[] {
  const currency = tx.currency || "GBP";
  const symbol = cashSymbol(currency);

  const activities: ActivityImport[] = [
    {
      id: tx.id,
      accountId: wealthfolioAccountId,
      activityType: mapType(tx.type, tx.amount),
      date: tx.date,
      amount: round2(Math.abs(tx.amount)),
      currency,
      symbol,
      isValid: true,
      isDraft: false,
      comment: tx.description || undefined,
    },
  ];

  if (tx.fee && tx.fee !== 0) {
    activities.push({
      id: `${tx.id}-fee`,
      accountId: wealthfolioAccountId,
      activityType: FEE,
      date: tx.date,
      amount: round2(Math.abs(tx.fee)),
      currency,
      symbol,
      isValid: true,
      isDraft: false,
      comment: "Revolut fee",
    });
  }

  return activities;
}
