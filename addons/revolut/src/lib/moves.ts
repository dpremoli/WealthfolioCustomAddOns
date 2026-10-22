import type { Account, AddonContext } from "@wealthfolio/addon-sdk";
import {
  T212_PROVIDER,
  isTrading212Payee,
  linkMovesBetween,
  trading212Refs,
  type MoveLinkOutcome,
} from "@wf-addons/kit";

/** Descriptions Revolut gives money moved into a savings pot and back out of it. */
export const SAVINGS_MOVE = /depositing savings|withdrawing savings/i;

export const isSavingsMove = (comment: string | null | undefined) => SAVINGS_MOVE.test(comment ?? "");

/**
 * A Trading 212 account the Trading 212 add-on created for an Invest, Stocks ISA or Cash ISA
 * connection. Its card accounts (`<id>-card`) only receive card spending, never a bank transfer.
 */
export function isTrading212Account(a: Pick<Account, "provider" | "providerAccountId">): boolean {
  return a.provider === T212_PROVIDER && !(a.providerAccountId ?? "").endsWith("-card");
}

const none = (): MoveLinkOutcome => ({ linked: 0, ambiguous: [], failed: [] });

/**
 * Pairs moves between the Revolut accounts and Trading 212 (see {@link isTrading212Account}) and,
 * for each confident pair, converts both legs to a linked transfer (kit `linkMovesBetween`). Only
 * Revolut rows whose description points at Trading 212 (its name, or one of the user's Trading
 * 212 account numbers quoted as the reference) take part, so two unrelated moves of the same
 * amount are not mistaken for each other; a row with no counterpart, or a tie, is left as it is.
 */
export async function linkTrading212Moves(
  ctx: AddonContext,
  revolutAccountIds: string[],
  accounts?: Account[],
): Promise<MoveLinkOutcome> {
  try {
    const all = accounts ?? (await ctx.api.accounts.getAll());
    const refs = trading212Refs(all);
    return await linkMovesBetween(ctx, {
      accounts: all,
      mine: revolutAccountIds,
      theirs: isTrading212Account,
      mineRow: (r) => isTrading212Payee(r.comment, refs),
    });
  } catch (err) {
    return { ...none(), failed: [(err as Error).message] };
  }
}

/**
 * Pairs Revolut's savings-pot moves ("Depositing savings" out of a currency account, "Withdrawing
 * savings" back into it) with the rows of the account the user keeps the savings in, and links each
 * confident pair as a transfer. Does nothing without a savings account; rows with no counterpart
 * stay as they are.
 */
export async function linkSavingsMoves(
  ctx: AddonContext,
  revolutAccountIds: string[],
  savingsAccountId: string | undefined,
  accounts?: Account[],
): Promise<MoveLinkOutcome> {
  if (!savingsAccountId) return none();
  return linkMovesBetween(ctx, {
    accounts,
    mine: revolutAccountIds.filter((id) => id !== savingsAccountId),
    theirs: (a) => a.id === savingsAccountId,
    mineRow: (r) => isSavingsMove(r.comment),
  });
}
