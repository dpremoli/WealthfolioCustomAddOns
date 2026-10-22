import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import { jsonStore, locateLedgerRows, type ImportLedger } from "@wf-addons/kit";
import { KEY_IMPORTED_IDS } from "../constants";
import { FLEX_CREDIT_SUFFIX } from "./mapper";

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
    if (out?.activityType !== "TRANSFER_OUT") continue;
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
  /** Transfer legs whose other half was not part of the import, so they stay unlinked. */
  unlinked: number;
  /** Why linking some pair failed (its rows were not found, or the host refused). */
  failed: string[];
}

/**
 * Links the transfer legs `activities` (already imported) as internal transfers, so Wealthfolio
 * treats each pair as money moving between two of the user's accounts. The host rows are found
 * through the import ledger, and a pair that is already linked is left alone, so this is safe
 * to repeat. Never throws: linking is a nicety on top of an import that has already succeeded.
 */
export async function linkTransfers(
  ctx: AddonContext,
  activities: ActivityImport[],
): Promise<LinkOutcome> {
  const pairs = pairTransferLegs(activities);
  const out: LinkOutcome = {
    linked: 0,
    unlinked: activities.filter(isTransfer).length - pairs.length * 2,
    failed: [],
  };
  if (pairs.length === 0) return out;

  try {
    const ledger = await jsonStore(ctx.api.storage).get<ImportLedger>(KEY_IMPORTED_IDS, {});
    const idsByAccount = new Map<string, string[]>();
    for (const { out: o, in: i } of pairs) {
      for (const leg of [o, i]) {
        idsByAccount.set(leg.accountId, [...(idsByAccount.get(leg.accountId) ?? []), leg.id!]);
      }
    }
    const rows = new Map<string, Map<string, { id: string }>>();
    for (const [accountId, ids] of idsByAccount) {
      rows.set(
        accountId,
        locateLedgerRows(await ctx.api.activities.getAll(accountId), ledger, accountId, ids),
      );
    }
    for (const { out: o, in: i } of pairs) {
      const outRow = rows.get(o.accountId)?.get(o.id!);
      const inRow = rows.get(i.accountId)?.get(i.id!);
      if (!outRow || !inRow) {
        out.failed.push(`${o.id}: could not find the imported rows`);
        continue;
      }
      try {
        if (await ctx.api.activities.getTransferPair(outRow.id)) continue; // already linked
        await ctx.api.activities.linkTransfer(outRow.id, inRow.id);
        out.linked++;
      } catch (err) {
        out.failed.push(`${o.id}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    out.failed.push((err as Error).message);
  }
  return out;
}

/** One log line for a {@link LinkOutcome}, or null when there was nothing to say. */
export function linkNote(o: LinkOutcome): string | null {
  if (o.linked === 0 && o.unlinked === 0 && o.failed.length === 0) return null;
  const parts = [`${o.linked} linked`];
  if (o.unlinked) {
    parts.push(
      `${o.unlinked} left unlinked (the other leg was not in this import; link them in Wealthfolio's Activities)`,
    );
  }
  if (o.failed.length) parts.push(`could not link: ${o.failed.join("; ")}`);
  return `Flex transfers: ${parts.join(", ")}.`;
}
