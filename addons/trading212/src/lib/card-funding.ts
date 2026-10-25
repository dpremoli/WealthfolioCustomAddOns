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

// A refund an older version stored as CREDIT is funded like one stored as DEPOSIT.
const FUNDED_TYPES = ["WITHDRAWAL", "DEPOSIT", "CREDIT", "INTEREST"];

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

type Leg = ExistingActivityLike & { id?: string };
const legKey = (r: Leg) =>
  [(r.date instanceof Date ? r.date.toISOString() : String(r.date ?? "")).slice(0, 10), (Math.round(Math.abs(Number(r.amount ?? 0)) * 100) / 100).toFixed(2), (r.currency ?? "").toUpperCase()].join("|");
const isLeg = (r: Leg) => r.comment === CARD_FUNDING_COMMENT && (r.activityType === "TRANSFER_IN" || r.activityType === "TRANSFER_OUT");

/**
 * The funding legs in `accounts` whose other half is gone: no leg of the opposite direction with
 * the same day, amount and currency in another account. That is what deleting one of the two
 * accounts leaves behind (687 orphans after an Invest account was deleted). `legs` should hold the
 * funding legs of every account, so a leg whose partner sits in an older card account or a
 * previously linked investing account is not taken for an orphan. Pairing prefers the two
 * accounts in `accounts` (the connection's card and investing accounts).
 */
export function orphanFundingLegs(legs: (Leg & { accountId: string })[], accounts: [string, string]): (Leg & { accountId: string })[] {
  const own = new Set(accounts);
  const groups = new Map<string, (Leg & { accountId: string })[]>();
  for (const l of legs.filter(isLeg)) groups.set(legKey(l), [...(groups.get(legKey(l)) ?? []), l]);
  const orphans: (Leg & { accountId: string })[] = [];
  for (const group of groups.values()) {
    const outs = group.filter((l) => l.activityType === "TRANSFER_OUT");
    const ins = group.filter((l) => l.activityType === "TRANSFER_IN");
    const used = new Set<Leg>();
    // First the connection's own pairs, then any partner in another account.
    for (const pass of [true, false]) {
      for (const o of outs) {
        if (used.has(o)) continue;
        const partner = ins.find((i) => !used.has(i) && i.accountId !== o.accountId && (!pass || (own.has(i.accountId) && own.has(o.accountId))));
        if (partner) {
          used.add(o);
          used.add(partner);
        }
      }
    }
    orphans.push(...group.filter((l) => !used.has(l) && own.has(l.accountId)));
  }
  return orphans;
}

/**
 * The card refunds 2.6.4 imported a second time: a DEPOSIT beside the CREDIT an older version
 * stored for the same refund (same day, amount and currency in the card account), and any funding
 * pair beyond one per refund left. Only 2.6.4 wrote card refunds as DEPOSIT and only older versions
 * as CREDIT, so a CREDIT and a DEPOSIT with one key are one refund. Returns the ids to delete.
 */
export function refundTwins(
  cardRows: (ExistingActivityLike & { id?: string })[],
  mainRows: (ExistingActivityLike & { id?: string })[],
): string[] {
  const groups = new Map<string, { credits: Leg[]; deposits: Leg[]; outs: Leg[]; ins: Leg[] }>();
  const group = (r: Leg) => {
    const k = legKey(r);
    if (!groups.has(k)) groups.set(k, { credits: [], deposits: [], outs: [], ins: [] });
    return groups.get(k)!;
  };
  for (const r of cardRows) {
    if (r.comment === CARD_FUNDING_COMMENT) {
      if (r.activityType === "TRANSFER_OUT") group(r).outs.push(r);
    } else if (r.activityType === "CREDIT") group(r).credits.push(r);
    else if (r.activityType === "DEPOSIT") group(r).deposits.push(r);
  }
  for (const r of mainRows) if (isLeg(r) && r.activityType === "TRANSFER_IN" && groups.has(legKey(r))) group(r).ins.push(r);
  const ids: string[] = [];
  for (const g of groups.values()) {
    const twins = Math.min(g.credits.length, g.deposits.length);
    if (twins === 0) continue;
    ids.push(...g.deposits.slice(0, twins).map((r) => r.id ?? ""));
    // Refunds left, and the funding pairs beyond one each.
    const refunds = g.credits.length + g.deposits.length - twins;
    const extra = Math.max(0, Math.min(g.outs.length, g.ins.length) - refunds);
    ids.push(...g.outs.slice(0, extra).map((r) => r.id ?? ""), ...g.ins.slice(0, extra).map((r) => r.id ?? ""));
  }
  return ids.filter(Boolean);
}
