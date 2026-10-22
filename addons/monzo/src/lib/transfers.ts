import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import {
  MOVE_MATCH_WINDOW_MS,
  T212_CASH_ISA_PROVIDER_ID,
  TRADING_212_PAYEE,
  convertAndLinkMoves,
  jsonStore,
  locateLedgerRows,
  type ImportLedger,
  type MoveLinkOutcome,
  type MoveRow,
} from "@wf-addons/kit";
import { KEY_IMPORTED_IDS } from "../constants";
import type { MonzoTransaction } from "../types";
import { FLEX_CREDIT_SUFFIX, flexRepaymentCredit, isFlexRepaymentDebit } from "./mapper";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far apart the two halves of a refund may be dated (Monzo books them together). */
const REFUND_WINDOW_MS = 2 * DAY_MS;

export interface TransferPair {
  out: ActivityImport;
  in: ActivityImport;
}

const isTransfer = (a: ActivityImport) =>
  !!a.id && (a.activityType === "TRANSFER_OUT" || a.activityType === "TRANSFER_IN");

const time = (a: ActivityImport) => new Date(a.date ?? 0).getTime();

/**
 * Matches the `TRANSFER_OUT`/`TRANSFER_IN` rows of one import into pairs: a repayment with the
 * Flex-side credit the add-on wrote for it (by id), then the legs of Flex refunds across the two
 * accounts (same amount and currency, dated within {@link REFUND_WINDOW_MS}, nearest first).
 * A leg whose other half is not in `activities` is left out.
 */
export function pairTransferLegs(activities: ActivityImport[]): TransferPair[] {
  const legs = activities.filter(isTransfer);
  const used = new Set<ActivityImport>();
  const pairs: TransferPair[] = [];

  const byId = new Map(legs.map((a) => [a.id!, a]));
  for (const inn of legs) {
    if (inn.activityType !== "TRANSFER_IN" || !inn.id!.endsWith(FLEX_CREDIT_SUFFIX)) continue;
    const out = byId.get(inn.id!.slice(0, -FLEX_CREDIT_SUFFIX.length));
    if (out?.activityType !== "TRANSFER_OUT" || out.accountId === inn.accountId) continue;
    pairs.push({ out, in: inn });
    used.add(out).add(inn);
  }

  const free = (type: string) => legs.filter((a) => a.activityType === type && !used.has(a));
  const ins = free("TRANSFER_IN");
  for (const out of free("TRANSFER_OUT").sort((a, b) => time(a) - time(b))) {
    let best: ActivityImport | undefined;
    for (const inn of ins) {
      if (used.has(inn) || inn.accountId === out.accountId) continue;
      if (Number(inn.amount) !== Number(out.amount) || inn.currency !== out.currency) continue;
      const gap = Math.abs(time(inn) - time(out));
      if (gap <= REFUND_WINDOW_MS && (!best || gap < Math.abs(time(best) - time(out)))) best = inn;
    }
    if (!best) continue;
    pairs.push({ out, in: best });
    used.add(out).add(best);
  }
  return pairs;
}

export interface LinkOutcome {
  /** Pairs linked as an internal transfer by this call. */
  linked: number;
  /** Transfer rows left unlinked: the other half was not part of the import, or a row was edited. */
  unlinked: number;
  /** Transfer rows that were already linked (by an earlier run or by hand), so left alone. Omitted when 0. */
  alreadyLinked?: number;
  /** Why linking some pair failed (the host refused). */
  failed: string[];
}

/**
 * Links the transfer legs `activities` (already imported) as internal transfers, so Wealthfolio
 * treats each pair as money moving between two of the user's accounts. The host rows are found
 * through the import ledger, and a pair that is already linked is left alone, so this is safe
 * to repeat. Legs that are not linked by this call are classified for the log: a row that is
 * already linked (found by the ledger, or, if the row was edited since, by the same type, amount
 * and a date within three days) is "already linked", anything else "unlinked". Never throws:
 * linking is a nicety on top of an import that has already succeeded.
 */
export async function linkTransfers(
  ctx: AddonContext,
  activities: ActivityImport[],
): Promise<LinkOutcome> {
  const legs = activities.filter(isTransfer);
  const pairs = pairTransferLegs(activities);
  const out: LinkOutcome = { linked: 0, unlinked: 0, failed: [] };
  if (legs.length === 0) return out;

  let alreadyLinked = 0;
  try {
    const ledger = await jsonStore(ctx.api.storage).get<ImportLedger>(KEY_IMPORTED_IDS, {});
    const existing = new Map<string, MoveRow[]>();
    const located = new Map<string, Map<string, { id: string }>>();
    for (const accountId of new Set(legs.map((l) => l.accountId))) {
      const rows = await ctx.api.activities.getAll(accountId);
      existing.set(accountId, rows as unknown as MoveRow[]);
      located.set(
        accountId,
        locateLedgerRows(
          rows,
          ledger,
          accountId,
          legs.filter((l) => l.accountId === accountId).map((l) => l.id!),
        ),
      );
    }
    // The host row a leg stands for: by the ledger, else (the row was edited since) the closest
    // row of the same type, amount and currency that no other leg has taken.
    const taken = new Set<string>();
    const rowFor = new Map<ActivityImport, string>();
    for (const leg of legs) {
      const row = located.get(leg.accountId)?.get(leg.id!);
      if (row) {
        rowFor.set(leg, row.id);
        taken.add(row.id);
      }
    }
    const time = (d: Date | string | null | undefined) => new Date(d ?? 0).getTime();
    for (const leg of legs) {
      if (rowFor.has(leg)) continue;
      const near = (existing.get(leg.accountId) ?? [])
        .filter(
          (r) =>
            !taken.has(r.id) &&
            r.activityType === leg.activityType &&
            (r.currency ?? "").toUpperCase() === (leg.currency ?? "").toUpperCase() &&
            Math.abs(Number(r.amount) - Number(leg.amount)) < 0.005 &&
            Math.abs(time(r.date) - time(leg.date)) <= MOVE_MATCH_WINDOW_MS,
        )
        .sort((x, y) => Math.abs(time(x.date) - time(leg.date)) - Math.abs(time(y.date) - time(leg.date)))[0];
      if (near) {
        rowFor.set(leg, near.id);
        taken.add(near.id);
      }
    }

    const isLinked = async (id: string) => {
      try {
        return (await ctx.api.activities.getTransferPair(id)) != null;
      } catch {
        return false;
      }
    };
    const done = new Set<ActivityImport>(); // legs that need no classification
    for (const { out: o, in: i } of pairs) {
      const outId = located.get(o.accountId)?.get(o.id!)?.id;
      const inId = located.get(i.accountId)?.get(i.id!)?.id;
      if (!outId || !inId) continue; // classified below
      if ((await isLinked(outId)) || (await isLinked(inId))) continue; // classified below
      try {
        await ctx.api.activities.linkTransfer(outId, inId);
        out.linked++;
        done.add(o).add(i);
      } catch (err) {
        out.failed.push(`${o.id}: ${(err as Error).message}`);
        done.add(o).add(i);
      }
    }
    for (const leg of legs) {
      if (done.has(leg)) continue;
      const id = rowFor.get(leg);
      if (id && (await isLinked(id))) alreadyLinked++;
      else out.unlinked++;
    }
  } catch (err) {
    out.failed.push((err as Error).message);
  }
  if (alreadyLinked > 0) out.alreadyLinked = alreadyLinked;
  return out;
}

/** One log line for a {@link LinkOutcome}, or null when there was nothing to say. */
export function linkNote(o: LinkOutcome): string | null {
  if (o.linked === 0 && o.unlinked === 0 && !o.alreadyLinked && o.failed.length === 0) return null;
  const parts = [`${o.linked} linked`];
  if (o.alreadyLinked) parts.push(`${o.alreadyLinked} already linked`);
  if (o.unlinked) {
    parts.push(
      `${o.unlinked} left unlinked (the other leg was not in this import, or a row was edited since; link them in Wealthfolio's Activities)`,
    );
  }
  if (o.failed.length) parts.push(`could not link: ${o.failed.join("; ")}`);
  return `Flex transfers: ${parts.join(", ")}.`;
}

/**
 * The Flex-account credits for the repayments among `transactions` (debits on a current
 * account; the caller has already dropped the ineligible ones).
 */
export function flexCreditsOf(
  transactions: MonzoTransaction[],
  flexAccountId: string,
  categoryLabels: Record<string, string> = {},
  ownNames: ReadonlySet<string> = new Set(),
): ActivityImport[] {
  return transactions
    .filter(isFlexRepaymentDebit)
    .map((tx) => flexRepaymentCredit(tx, flexAccountId, categoryLabels, ownNames));
}

const MOVE_TYPES = ["WITHDRAWAL", "DEPOSIT", "TRANSFER_OUT", "TRANSFER_IN"];

/**
 * Pairs Monzo savings moves with Trading 212 Cash ISA rows and, for each confident pair, converts
 * both to a linked transfer (see kit `convertAndLinkMoves`). The Cash ISA is the account the
 * Trading 212 add-on keeps it in (`providerAccountId`), or one whose name mentions Trading 212 and ISA. Only Monzo
 * rows whose payee reads "Trading 212" take part, so two unrelated moves of the same amount are
 * not mistaken for each other; a row with no counterpart, or a tie, is left as it is (an unlinked
 * transfer would drop an ISA deposit from the allowance). Does nothing when there is no Cash ISA.
 */
export async function matchWithCashIsa(
  ctx: AddonContext,
  monzoAccountIds: string[],
): Promise<MoveLinkOutcome> {
  const none: MoveLinkOutcome = { linked: 0, ambiguous: [], failed: [] };
  try {
    const accounts = await ctx.api.accounts.getAll();
    const isaIds = accounts
      .filter(
        (a) =>
          !monzoAccountIds.includes(a.id) &&
          (a.providerAccountId === T212_CASH_ISA_PROVIDER_ID ||
            (TRADING_212_PAYEE.test(a.name) && /isa/i.test(a.name))),
      )
      .map((a) => a.id);
    if (isaIds.length === 0) return none;

    const rowsOf = async (ids: string[]) =>
      (await Promise.all(ids.map((id) => ctx.api.activities.getAll(id))))
        .flat()
        .filter((r) => MOVE_TYPES.includes(r.activityType)) as unknown as MoveRow[];
    const mine = (await rowsOf(monzoAccountIds)).filter((r) => TRADING_212_PAYEE.test(r.comment ?? ""));
    if (mine.length === 0) return none;
    return await convertAndLinkMoves(ctx, mine, await rowsOf(isaIds));
  } catch (err) {
    return { ...none, failed: [(err as Error).message] };
  }
}
