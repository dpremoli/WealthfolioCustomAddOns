import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { cashSymbol, type ExistingActivityLike } from "@wf-addons/kit";
import type { ImportUnit } from "./importer";

type ActivityType = ActivityImport["activityType"];

/** Comment on the transfer pair that moves card money between the investing and the card account. */
export const CARD_FUNDING_COMMENT = "Card funding";

/**
 * The card row plus the transfer pair that funds it. Trading 212 pays card purchases out of the
 * investing account's cash and pays refunds and cashback back into it, while the add-on files the
 * card rows under a separate card account for the Spending module. Without the pair the investing
 * account keeps cash that was spent and the card account runs an ever-growing overdraft. With it
 * both balances match Trading 212: a purchase is a transfer investing → card plus the purchase on
 * the card account (still spending); a refund or cashback is the credit on the card account plus
 * a transfer card → investing. The three rows go into one import, where Wealthfolio links the pair
 * itself (same date, currency, asset and amount, different accounts).
 */
export function withCardFunding(card: ActivityImport, investAccountId: string): ImportUnit {
  return [card, ...fundingPair(card, investAccountId, card.id ?? "")];
}

function fundingPair(card: ActivityImport, investAccountId: string, key: string): ActivityImport[] {
  const spend = card.activityType === "WITHDRAWAL";
  const from = spend ? investAccountId : card.accountId;
  const to = spend ? card.accountId : investAccountId;
  const leg = (accountId: string, activityType: string, suffix: string): ActivityImport => ({
    id: `${key}-fund-${suffix}`,
    accountId,
    activityType: activityType as ActivityType,
    date: card.date,
    symbol: card.symbol,
    amount: card.amount,
    currency: card.currency,
    isValid: true,
    isDraft: false,
    comment: CARD_FUNDING_COMMENT,
  });
  return [leg(from, "TRANSFER_OUT", "out"), leg(to, "TRANSFER_IN", "in")];
}

/** Whether an import id is one of the funding legs {@link withCardFunding} adds. */
export const isFundingId = (id: string) => /-fund-(in|out)$/.test(id);

const FUNDED_TYPES = ["WITHDRAWAL", "DEPOSIT", "INTEREST"];

/**
 * Funding pairs for card rows already in the card account (imported before the add-on funded
 * them). One pair per row; the importer leaves out pairs the accounts already hold, by content
 * and count, so this is safe to run on every sync.
 */
export function fundingForExisting(
  cardRows: (ExistingActivityLike & { id?: string })[],
  cardAccountId: string,
  investAccountId: string,
): ImportUnit[] {
  return cardRows
    .filter((r) => FUNDED_TYPES.includes(r.activityType) && r.comment !== CARD_FUNDING_COMMENT)
    .map((r) => {
      const date = r.date instanceof Date ? r.date.toISOString() : String(r.date);
      const currency = r.currency ?? "";
      const card: ActivityImport = {
        accountId: cardAccountId,
        activityType: r.activityType as ActivityType,
        date,
        symbol: cashSymbol(currency),
        amount: Number(r.amount),
        currency,
        isValid: true,
        isDraft: false,
      };
      return fundingPair(card, investAccountId, `t212-card-${r.id ?? `${date}-${r.amount}`}`);
    });
}
