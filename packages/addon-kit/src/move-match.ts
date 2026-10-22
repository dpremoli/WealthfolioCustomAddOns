import type { ActivityUpdate, AddonContext } from "@wealthfolio/addon-sdk";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far apart the two halves of a move between two accounts may be dated. */
export const MOVE_MATCH_WINDOW_MS = 3 * DAY_MS;

/** Payee text that points at Trading 212 ("Trading 212", "TRADING212", "T212"). */
export const TRADING_212_PAYEE = /trading\s*212|\bt212\b/i;

/** `providerAccountId` of the Wealthfolio account the Trading 212 add-on keeps the Cash ISA in. */
export const T212_CASH_ISA_PROVIDER_ID = "t212-cash-isa";

/** The fields of an activity row (`activities.getAll`) needed to match and convert a move. */
export interface MoveRow {
  id: string;
  accountId?: string;
  activityType: string;
  date?: Date | string | null;
  amount?: number | string | null;
  currency?: string | null;
  comment?: string | null;
  subtype?: string | null;
}

const OUT = ["WITHDRAWAL", "TRANSFER_OUT"];
const IN = ["DEPOSIT", "TRANSFER_IN"];

export const isMoneyOut = (r: MoveRow) => OUT.includes(r.activityType);
export const isMoneyIn = (r: MoveRow) => IN.includes(r.activityType);

const time = (r: MoveRow) => new Date(r.date ?? 0).getTime();

/**
 * Whether `a` and `b` could be the two halves of one move between accounts: one money out
 * (`WITHDRAWAL`/`TRANSFER_OUT`), one money in (`DEPOSIT`/`TRANSFER_IN`), in different accounts,
 * with the same currency and amount, dated within `windowMs`.
 */
export function isMoveMatch(a: MoveRow, b: MoveRow, windowMs = MOVE_MATCH_WINDOW_MS): boolean {
  const opposite = (isMoneyOut(a) && isMoneyIn(b)) || (isMoneyIn(a) && isMoneyOut(b));
  if (!opposite) return false;
  if (a.accountId && b.accountId && a.accountId === b.accountId) return false;
  if ((a.currency ?? "").toUpperCase() !== (b.currency ?? "").toUpperCase()) return false;
  const x = Number(a.amount);
  const y = Number(b.amount);
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x - y) >= 0.005) return false;
  return Math.abs(time(a) - time(b)) <= windowMs;
}

export interface MoveMatches<R> {
  pairs: { out: R; in: R }[];
  /** Legs left alone because the match was not unique. */
  ambiguous: R[];
}

/**
 * Pairs each money-out row with the closest-dated money-in row. A leg whose best counterparts tie
 * on date is ambiguous and left unpaired; a counterpart wanted by several legs goes to the
 * nearest of them, or to none when they are equally near.
 */
export function matchMoves<R extends MoveRow>(
  outs: R[],
  ins: R[],
  windowMs = MOVE_MATCH_WINDOW_MS,
): MoveMatches<R> {
  const ambiguous: R[] = [];
  const claimed = new Map<R, { out: R; gap: number }[]>();
  for (const out of outs) {
    const near = ins
      .filter((i) => isMoveMatch(out, i, windowMs))
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

export interface MoveLinkOutcome {
  /** Pairs converted to transfers and linked. */
  linked: number;
  /** Ids of legs skipped because the match was not unique. */
  ambiguous: string[];
  /** Why converting or linking some pair failed (the rows were put back). */
  failed: string[];
}

/**
 * Finds the pairs between `mine` and `theirs` (rows of two different sets of accounts, already
 * narrowed by the caller to rows that can belong to such a move) and, for a confident match only,
 * converts both legs to `TRANSFER_OUT` / `TRANSFER_IN` in place and links them through
 * Wealthfolio's transfer-link API. Rows with no match are not touched; a row that is already
 * linked is never a candidate. If converting or linking fails, the legs are put back as they
 * were (an unlinked transfer would otherwise leave an ISA deposit out of the allowance). Safe to
 * repeat, and never throws: this is a nicety on top of an import that has already succeeded.
 */
export async function convertAndLinkMoves(
  ctx: AddonContext,
  mine: MoveRow[],
  theirs: MoveRow[],
  windowMs = MOVE_MATCH_WINDOW_MS,
): Promise<MoveLinkOutcome> {
  const out: MoveLinkOutcome = { linked: 0, ambiguous: [], failed: [] };
  const activities = ctx.api.activities;

  const linkedCache = new Map<string, boolean>();
  const isLinked = async (id: string): Promise<boolean> => {
    if (!linkedCache.has(id)) {
      try {
        linkedCache.set(id, (await activities.getTransferPair(id)) != null);
      } catch (err) {
        out.failed.push(`${id}: ${(err as Error).message}`);
        linkedCache.set(id, true); // unknown: leave it alone
      }
    }
    return linkedCache.get(id)!;
  };

  try {
    // Only look up link state for rows that could match at all.
    const open = async (rows: MoveRow[], others: MoveRow[]) => {
      const kept: MoveRow[] = [];
      for (const r of rows) {
        if (others.some((o) => isMoveMatch(r, o, windowMs)) && !(await isLinked(r.id))) kept.push(r);
      }
      return kept;
    };
    const m = await open(mine, theirs);
    const t = await open(theirs, mine);

    const a = matchMoves(m.filter(isMoneyOut), t.filter(isMoneyIn), windowMs);
    const b = matchMoves(t.filter(isMoneyOut), m.filter(isMoneyIn), windowMs);
    const pairs = [...a.pairs, ...b.pairs];
    for (const leg of [...a.ambiguous, ...b.ambiguous]) {
      out.ambiguous.push(leg.id);
      ctx.api.logger.warn(`Move ${leg.id}: several matching moves in the other account, left unlinked.`);
    }

    const update = (r: MoveRow, activityType: string): ActivityUpdate => ({
      id: r.id,
      accountId: r.accountId ?? "",
      activityType,
      subtype: r.subtype ?? null,
      activityDate: r.date ?? new Date(0),
      amount: r.amount ?? null,
      currency: r.currency ?? undefined,
      comment: r.comment ?? null,
    });
    for (const { out: o, in: i } of pairs) {
      const changes: { row: MoveRow; to: string }[] = [];
      if (o.activityType !== "TRANSFER_OUT") changes.push({ row: o, to: "TRANSFER_OUT" });
      if (i.activityType !== "TRANSFER_IN") changes.push({ row: i, to: "TRANSFER_IN" });
      const revert = () =>
        changes.length > 0
          ? activities
              .saveMany({ updates: changes.map((c) => update(c.row, c.row.activityType)) })
              .catch(() => null)
          : Promise.resolve(null);
      try {
        if (changes.length > 0) {
          const res = await activities.saveMany({ updates: changes.map((c) => update(c.row, c.to)) });
          if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join("; "));
        }
        await activities.linkTransfer(o.id, i.id);
        out.linked++;
      } catch (err) {
        await revert();
        out.failed.push(`${o.id} / ${i.id}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    out.failed.push((err as Error).message);
  }
  return out;
}

/** One log line for a {@link MoveLinkOutcome}, or null when there was nothing to say. */
export function moveLinkNote(otherName: string, o: MoveLinkOutcome): string | null {
  if (o.linked === 0 && o.ambiguous.length === 0 && o.failed.length === 0) return null;
  const parts = [`${o.linked} linked`];
  if (o.ambiguous.length) parts.push(`${o.ambiguous.length} left as they were (ambiguous: several matching moves)`);
  if (o.failed.length) parts.push(`could not link: ${o.failed.join("; ")}`);
  return `Moves to and from ${otherName}: ${parts.join(", ")}.`;
}
