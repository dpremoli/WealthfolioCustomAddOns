import type { AddonContext } from "@wealthfolio/addon-sdk";
import type { MoveRow } from "@wf-addons/kit";

/** How far apart the two legs of one exchange may be dated (Revolut books them together). */
export const EXCHANGE_WINDOW_MS = 2 * 60 * 1000;

// "Exchanged to EUR" (Revolut writes it on both legs) or "Exchanged from GBP".
const EXCHANGE_RE = /\bexchanged\s+(to|from)\s+([a-z]{3,5})\b/i;

/**
 * What an exchange row's description says about the other currency: `to` names the currency
 * bought (the money-in leg's), `from` the currency sold (the money-out leg's). Null when the
 * comment is not an exchange.
 */
export function exchangeOf(comment: string | null | undefined): { to?: string; from?: string } | null {
  const m = (comment ?? "").match(EXCHANGE_RE);
  if (!m) return null;
  const currency = m[2].toUpperCase();
  return m[1].toLowerCase() === "to" ? { to: currency } : { from: currency };
}

const time = (r: MoveRow) => new Date(r.date ?? 0).getTime();
const ccy = (r: MoveRow) => (r.currency ?? "").toUpperCase();

/**
 * Whether `out` (a `TRANSFER_OUT`) and `inn` (a `TRANSFER_IN`) could be the two legs of one
 * Revolut currency exchange: both described as an exchange, in different accounts and
 * currencies, dated within `windowMs`, and what each description names agrees with the legs'
 * currencies (the bought currency is `inn`'s, the sold one `out`'s). Amounts are not compared:
 * they differ by the exchange rate.
 */
export function isExchangeMatch(out: MoveRow, inn: MoveRow, windowMs = EXCHANGE_WINDOW_MS): boolean {
  if (out.activityType !== "TRANSFER_OUT" || inn.activityType !== "TRANSFER_IN") return false;
  const a = exchangeOf(out.comment);
  const b = exchangeOf(inn.comment);
  if (!a || !b) return false;
  if (out.accountId && inn.accountId && out.accountId === inn.accountId) return false;
  if (!ccy(out) || !ccy(inn) || ccy(out) === ccy(inn)) return false;
  for (const said of [a, b]) {
    if (said.to && said.to !== ccy(inn)) return false;
    if (said.from && said.from !== ccy(out)) return false;
  }
  return Math.abs(time(out) - time(inn)) <= windowMs;
}

export interface ExchangeMatches<R> {
  pairs: { out: R; in: R }[];
  /** Legs left alone because the match was not unique. */
  ambiguous: R[];
}

/**
 * Pairs each exchange's money-out leg with its money-in leg among `rows` (rows of the Revolut
 * currency accounts). Each out leg takes the closest-dated matching in leg (see
 * {@link isExchangeMatch}); a leg whose best counterparts tie on date is ambiguous and left
 * unpaired, and an in leg wanted by several out legs goes to the nearest of them, or to none
 * when they are equally near. Two same-minute exchanges between the same currencies are
 * therefore skipped rather than guessed.
 */
export function matchExchanges<R extends MoveRow>(rows: R[], windowMs = EXCHANGE_WINDOW_MS): ExchangeMatches<R> {
  const outs = rows.filter((r) => r.activityType === "TRANSFER_OUT" && exchangeOf(r.comment));
  const ins = rows.filter((r) => r.activityType === "TRANSFER_IN" && exchangeOf(r.comment));
  const ambiguous: R[] = [];
  const claimed = new Map<R, { out: R; gap: number }[]>();
  for (const out of outs) {
    const near = ins
      .filter((i) => isExchangeMatch(out, i, windowMs))
      .map((i) => ({ i, gap: Math.abs(time(out) - time(i)) }))
      .sort((x, y) => x.gap - y.gap);
    if (near.length === 0) continue;
    if (near.length > 1 && near[1].gap === near[0].gap) {
      ambiguous.push(out);
      continue;
    }
    claimed.set(near[0].i, [...(claimed.get(near[0].i) ?? []), { out, gap: near[0].gap }]);
  }
  const pairs: { out: R; in: R }[] = [];
  for (const [inn, claims] of claimed) {
    claims.sort((x, y) => x.gap - y.gap);
    if (claims.length > 1 && claims[1].gap === claims[0].gap) {
      ambiguous.push(...claims.map((c) => c.out));
      continue;
    }
    pairs.push({ out: claims[0].out, in: inn });
  }
  return { pairs, ambiguous };
}

export interface ExchangeLinkOutcome {
  /** Exchanges linked by this call. */
  linked: number;
  /** Ids of legs skipped because the match was not unique. */
  ambiguous: string[];
  /** Why linking some pair failed. */
  failed: string[];
}

/**
 * Links the two legs of each Revolut currency exchange across the currency accounts
 * `accountIds`, so Wealthfolio shows an exchange as one move between the user's own accounts
 * rather than two unrelated transfers. Both legs are `TRANSFER_OUT`/`TRANSFER_IN` already (see
 * `mapType`), so nothing is converted, only linked. A leg that is already linked (by an earlier
 * import or by hand) is never a candidate, so this is safe to repeat. Never throws: linking is
 * a nicety on top of an import that has already succeeded.
 */
export async function linkExchanges(ctx: AddonContext, accountIds: string[]): Promise<ExchangeLinkOutcome> {
  const out: ExchangeLinkOutcome = { linked: 0, ambiguous: [], failed: [] };
  const activities = ctx.api.activities;
  const linkedNow = async (id: string): Promise<boolean> => {
    try {
      return (await activities.getTransferPair(id)) != null;
    } catch (err) {
      out.failed.push(`${id}: ${(err as Error).message}`);
      return true; // unknown: leave it alone
    }
  };
  try {
    const rows: MoveRow[] = [];
    for (const accountId of new Set(accountIds)) {
      for (const r of (await activities.getAll(accountId)) as unknown as MoveRow[]) {
        if ((r.activityType === "TRANSFER_OUT" || r.activityType === "TRANSFER_IN") && exchangeOf(r.comment)) {
          rows.push({ ...r, accountId: r.accountId || accountId });
        }
      }
    }
    // Only look up the link state of legs that have a counterpart at all, then match the rest.
    const open: MoveRow[] = [];
    for (const r of rows) {
      const hasMatch = rows.some((o) =>
        r.activityType === "TRANSFER_OUT" ? isExchangeMatch(r, o) : isExchangeMatch(o, r),
      );
      if (hasMatch && !(await linkedNow(r.id))) open.push(r);
    }
    const { pairs, ambiguous } = matchExchanges(open);
    for (const leg of ambiguous) {
      out.ambiguous.push(leg.id);
      ctx.api.logger.warn(`Exchange ${leg.id}: several matching legs in the other currency, left unlinked.`);
    }
    for (const { out: o, in: i } of pairs) {
      try {
        await activities.linkTransfer(o.id, i.id);
        out.linked++;
      } catch (err) {
        out.failed.push(`${o.id} / ${i.id}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    out.failed.push((err as Error).message);
  }
  return out;
}

/** One line for an {@link ExchangeLinkOutcome}. */
export function exchangeLinkNote(o: ExchangeLinkOutcome): string {
  const parts = [`${o.linked} linked`];
  if (o.ambiguous.length) {
    parts.push(`${o.ambiguous.length} left unlinked (ambiguous: several exchanges at the same time)`);
  }
  if (o.failed.length) parts.push(`could not link: ${o.failed.join("; ")}`);
  return `Exchanges: ${parts.join(", ")}.`;
}
