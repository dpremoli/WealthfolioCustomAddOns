import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import { majorCurrency, type ExistingActivityLike } from "@wf-addons/kit";
import { snapRatio } from "./corporate-actions";
import type { ActivityImporter } from "./importer";
import { KNOWN_SPLITS, type KnownSplit } from "./known-splits";
import { importAssetFields, type SymbolResolver } from "./symbol-resolver";

/** A position whose quantity Wealthfolio derives differently from Trading 212's. */
export interface PositionGap {
  ticker: string;
  isin?: string;
  name?: string;
  /** The Wealthfolio symbol the position resolves to. */
  symbol: string;
  /** The instrument's currency (what trades in it are booked in). */
  currency?: string;
  /** Trading 212's quantity. */
  held: number;
  /** Wealthfolio's quantity. */
  derived: number;
}

export interface QtyEvent {
  /** YYYY-MM-DD */
  day: string;
  kind: "add" | "remove" | "split";
  /** Shares for add/remove, the ratio for a split. */
  value: number;
}

const day = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d ?? "")).slice(0, 10);
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const symbolKey = (symbol: string) => symbol.toUpperCase().replace(/\.[A-Z]{1,4}$/, "");

type RowLike = ExistingActivityLike & { symbol?: string | null };

/** The share-count events of one asset in an account's activities (existing rows or just-imported ones). */
export function quantityEvents(rows: RowLike[], symbol: string): QtyEvent[] {
  const wanted = symbolKey(symbol);
  const out: QtyEvent[] = [];
  for (const r of rows) {
    const s = r.assetSymbol ?? r.symbol ?? "";
    if (!s || s.startsWith("$CASH") || symbolKey(s) !== wanted) continue;
    const type = String(r.activityType);
    if (type === "BUY" || type === "TRANSFER_IN") out.push({ day: day(r.date), kind: "add", value: num(r.quantity) });
    else if (type === "SELL" || type === "TRANSFER_OUT") out.push({ day: day(r.date), kind: "remove", value: num(r.quantity) });
    else if (type === "SPLIT") out.push({ day: day(r.date), kind: "split", value: num(r.amount) || num(r.quantity) });
  }
  return out;
}

/**
 * The quantity left after replaying `events` with `extra` splits added. Wealthfolio multiplies the
 * lots bought *before* the split day, so on the split day itself the split comes first.
 */
export function simulateQuantity(events: QtyEvent[], extra: { date: string; ratio: number }[] = []): number {
  const all: (QtyEvent & { order: number })[] = [
    ...events.map((e) => ({ ...e, order: e.kind === "split" ? 0 : 1 })),
    ...extra.map((s) => ({ day: s.date, kind: "split" as const, value: s.ratio, order: 0 })),
  ].sort((a, b) => (a.day === b.day ? a.order - b.order : a.day < b.day ? -1 : 1));
  let q = 0;
  for (const e of all) {
    if (e.kind === "add") q += e.value;
    else if (e.kind === "remove") q -= e.value;
    else q *= e.value;
  }
  return q;
}

export interface SplitProposal {
  splits: KnownSplit[];
  /** Why there is none, or what the proposal rests on. */
  reason: string;
  /** Several known splits explain the gap equally well: nothing else should be tried either. */
  ambiguous?: boolean;
  /** There is no gap to explain (no activities, or they agree): nothing else should be tried. */
  noGap?: boolean;
}

/** A ratio as people say it: 20:1, 1:10, 2:3 (a 2-for-3 consolidation); else "×0.805". */
export function describeRatio(ratio: number): string {
  for (let b = 1; b <= 12; b++) {
    const a = Math.round(ratio * b);
    if (a >= 1 && Math.abs(ratio - a / b) < 1e-9) return `${a}:${b}`;
  }
  // A reverse split of more than 1-for-12 (1:20, 1:100).
  const inverse = Math.round(1 / ratio);
  if (inverse > 1 && Math.abs(ratio - 1 / inverse) < 1e-9) return `1:${inverse}`;
  return `×${String(Math.round(ratio * 1e6) / 1e6)}`;
}

const tolerance = (held: number) => 1e-4 + 2e-5 * Math.abs(held);
const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);
const dayDistance = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/**
 * Finds the known splits (see `KNOWN_SPLITS`) that explain why `held`, Trading 212's quantity,
 * differs from what the position's activities add up to. A split is proposed only when replaying
 * the activities with it (or the smallest set of them) gives `held` to within rounding, so the
 * ratio and the date are both confirmed by the numbers. Splits the account already holds are
 * not proposed again.
 */
export function proposeSplits(input: {
  isin?: string;
  held: number;
  events: QtyEvent[];
  today?: string;
  known?: KnownSplit[];
}): SplitProposal {
  const { isin, held, events } = input;
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const base = simulateQuantity(events);
  const tol = tolerance(held);
  const gap = `Trading 212 holds ${fmt(held)}, the activities add up to ${fmt(base)}`;
  if (events.length === 0) return { splits: [], reason: `${gap}: no activities for it in the account.`, noGap: true };
  if (Math.abs(base - held) <= tol) {
    return { splits: [], reason: `${gap}: they agree, so Wealthfolio is probably still recalculating.`, noGap: true };
  }

  const first = events.map((e) => e.day).sort()[0];
  const existing = events.filter((e) => e.kind === "split");
  const candidates = (input.known ?? KNOWN_SPLITS).filter(
    (k) =>
      k.isin === isin &&
      k.date > first &&
      k.date <= today &&
      !existing.some((e) => dayDistance(e.day, k.date) <= 3 && Math.abs(e.value - k.ratio) <= 1e-6 * k.ratio),
  );

  const ratio = base > 0 ? held / base : undefined;
  const hint =
    ratio === undefined
      ? ""
      : ` (overall ×${fmt(snapRatio(ratio, 1e-4))}; only the shares bought before the event change, so its own ratio ` +
        `is stronger): a split or consolidation Trading 212 did not export is the likely cause. ` +
        `Add a SPLIT activity for it in Wealthfolio, or add the ISIN and date to the known splits`;
  if (candidates.length === 0) {
    return { splits: [], reason: `${gap}${hint || "."}${isin ? ` No known split for ${isin}.` : ""}` };
  }

  let best: KnownSplit[][] = [];
  const subsets = 1 << Math.min(candidates.length, 8);
  for (let mask = 1; mask < subsets; mask++) {
    const chosen = candidates.filter((_, i) => mask & (1 << i));
    const q = simulateQuantity(events, chosen.map((c) => ({ date: c.date, ratio: c.ratio })));
    if (Math.abs(q - held) > tol) continue;
    if (best.length === 0 || chosen.length < best[0].length) best = [chosen];
    else if (chosen.length === best[0].length) best.push(chosen);
  }
  if (best.length === 1) {
    return { splits: best[0], reason: `${gap}: ${best[0].map((s) => `${describeRatio(s.ratio)} on ${s.date}`).join(" and ")} reproduces it exactly.` };
  }
  if (best.length > 1) {
    return { splits: [], reason: `${gap}: several known splits would explain it equally well, so none was added.`, ambiguous: true };
  }
  return {
    splits: [],
    reason: `${gap}: the known splits for ${isin} (${candidates.map((c) => `${describeRatio(c.ratio)} on ${c.date}`).join(", ")}) do not reproduce it${hint || "."}`,
  };
}

/** What a dividend row says Trading 212 held when it paid: `[YYYY-MM-DD, "No. of shares"]`. */
export type DividendShares = [day: string, shares: number];

export interface InferredSplit {
  /** The day the SPLIT is dated: the middle of the days that reproduce the quantity. */
  date: string;
  ratio: number;
  /** The last dividend that still shows the unsplit holding. */
  after: string;
  /** The first dividend that shows the split one. */
  before: string;
  /** The first and last day in the window that reproduce Trading 212's quantity. */
  from: string;
  to: string;
}

export interface SplitInference {
  split?: InferredSplit;
  /** What it rests on, or why there is none. */
  reason: string;
}

/** How long before a dividend's pay date the holding it quotes may date from (the record date comes first). */
const LOOKBACK_DAYS = 100;
/** The widest window of days between two dividends that is searched. */
const MAX_WINDOW_DAYS = 800;

const addDays = (d: string, n: number): string => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
/** Dividend rows quote the holding to 10 decimals, so the replayed holding has to agree to within that. */
const sharesTolerance = (shares: number) => 1e-6 + 1e-6 * Math.abs(shares);

/**
 * A ratio as a company announces it: a whole ratio (20:1, 3:1), its reciprocal (1:10) or one of
 * 3:2, 2:3, 5:2, 2:5, when `ratio` is within `tolerance` (relative) of it, else null. 1 is not a
 * split. Other fractions are left out on purpose: a trade missing from the activities looks like a
 * split too, and a missing trade of a quarter or a fifth of the holding (5:4, 6:5, 7:6) is far
 * likelier than a split of that kind, whereas one of half the holding or more is not.
 */
export function cleanRatio(ratio: number, tolerance = 1e-5): number | null {
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const near = (a: number, b: number) => Math.abs(a - b) <= tolerance * Math.max(a, b);
  const whole = Math.round(ratio);
  if (whole >= 2 && whole <= 100 && near(ratio, whole)) return whole;
  const inverse = Math.round(1 / ratio);
  if (inverse >= 2 && inverse <= 100 && near(1 / ratio, inverse)) return 1 / inverse;
  for (const [a, b] of [[3, 2], [2, 3], [5, 2], [2, 5]]) if (near(ratio, a / b)) return a / b;
  return null;
}

/** Work (events visited) the search may spend before it gives up, so a long history cannot stall a sync. */
const WORK_BUDGET = 10_000_000;

/**
 * Finds a split Trading 212 never listed from the dividend rows of the position. A row says how
 * many shares Trading 212 held when it paid, so replaying the position's activities (without the
 * split) shows where the two part company: the last dividend whose count the replay agrees with
 * and the first whose count it does not bracket the split. The ratio is the count Trading 212
 * quotes divided by the holding the replay gives, which has to be one of the usual ratios (2:3,
 * 3:1, 1:10 …) and the same for every dividend after it. The split is proposed only if, dated
 * inside the window, it makes the activities add up to `held` exactly (the tolerance of
 * {@link proposeSplits}). Nothing is proposed when the evidence is not clear: no dividend on one
 * side of the window, a last matching dividend whose count a later trade has already moved (the
 * split could hide between its record and pay dates), a dividend that contradicts the order,
 * ratios that are unusual or differ, or several ratios that fit.
 *
 * What it cannot tell apart is a split and a trade missing from the activities: either changes
 * every later count by the same factor. The caller must not use it when rows were left out.
 */
export function inferSplit(input: { held: number; events: QtyEvent[]; dividends: DividendShares[] }): SplitInference {
  const { held, events } = input;
  const none = (reason: string): SplitInference => ({ reason: `Dividend share counts: ${reason}` });
  const tol = tolerance(held);
  if (events.length === 0) return none("no activities for the position.");
  if (Math.abs(simulateQuantity(events) - held) <= tol) return none("the activities already agree with Trading 212.");

  const seen = new Set<string>();
  const dividends = input.dividends
    .filter(([d, n]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && n > 0)
    .filter(([d, n]) => !seen.has(`${d}|${n}`) && !!seen.add(`${d}|${n}`))
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] < b[0] ? -1 : 1));
  if (dividends.length < 2) return none(`${dividends.length} dividend row${dividends.length === 1 ? "" : "s"} for it, too few to place a split.`);

  // Without splits among the activities the holding is a running sum, so every question below is
  // a lookup; with them (rare) each one replays the activities, within the work budget.
  const hasSplit = events.some((e) => e.kind === "split");
  const sorted = events.filter((e) => e.kind !== "split").sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const sortedDays = sorted.map((e) => e.day);
  const running: number[] = [];
  sorted.reduce((sum, e, i) => (running[i] = sum + (e.kind === "add" ? e.value : -e.value)), 0);
  const countUpTo = (day: string): number => {
    let lo = 0;
    let hi = sortedDays.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedDays[mid] <= day) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  let work = 0;
  const spend = (n: number) => {
    work += n;
    if (work > WORK_BUDGET) throw new Error("budget");
  };
  const upTo = (cutoff: string) => events.filter((e) => e.day <= cutoff);
  /** The holding at the end of `cutoff`, without the split. */
  const holdingAt = (cutoff: string): number => {
    if (!hasSplit) {
      const n = countUpTo(cutoff);
      return n === 0 ? 0 : running[n - 1];
    }
    spend(events.length);
    return simulateQuantity(upTo(cutoff));
  };
  /** With a split at `date`, the holding at `cutoff` (≥ the day before) is `f0 + ratio * a`. */
  const affineAt = (cutoff: string, date: string): { f0: number; a: number } => {
    if (!hasSplit) {
      const before = holdingAt(addDays(date, -1));
      return { f0: holdingAt(cutoff) - before, a: before };
    }
    spend(2 * events.length);
    const f0 = simulateQuantity(upTo(cutoff), [{ date, ratio: 0 }]);
    return { f0, a: simulateQuantity(upTo(cutoff), [{ date, ratio: 1 }]) - f0 };
  };
  const quantityWithSplit = (date: string, ratio: number): number => {
    if (hasSplit) {
      spend(events.length);
      return simulateQuantity(events, [{ date, ratio }]);
    }
    const before = holdingAt(addDays(date, -1));
    return ratio * before + (holdingAt("9999-12-31") - before);
  };

  try {
    const eventDays = [...new Set(events.map((e) => e.day))].sort();
    // The days within the lookback before a dividend whose holdings it may quote: the one at its
    // start, then the one after each event day. The count a row quotes is one of them (the record
    // date is before the pay date, so trades in between are not in it).
    const lookback = (day: string) => {
      const lo = addDays(day, -LOOKBACK_DAYS);
      return { lo, days: eventDays.filter((d) => d > lo && d <= day) };
    };
    const matches = (n: number, q: number) => Math.abs(q - n) <= sharesTolerance(n);
    const unchanged = dividends.map(([day, n]) => {
      const { lo, days } = lookback(day);
      return [lo, ...days].some((c) => matches(n, holdingAt(c)));
    });
    const k = unchanged.indexOf(false);
    if (k < 0) return none("every dividend agrees with the activities, so none shows a change.");
    if (k === 0) return none(`no dividend before the first difference (${dividends[0][0]}) agrees with the activities.`);
    if (unchanged.slice(k).some(Boolean)) {
      return none("a dividend after the first difference agrees with the activities again, so the counts are not one change.");
    }
    const [after, afterShares] = dividends[k - 1];
    const before = dividends[k][0];
    // The last matching dividend must be paid on the very holding the replay has on its pay date:
    // if a trade came in between its record date and then, a split could sit before that trade
    // (and outside the window), and would be dated after it, multiplying shares it never touched.
    if (!matches(afterShares, holdingAt(after))) {
      return none(`the dividend of ${after} quotes a holding a later trade had already changed, so the split's date cannot be bounded.`);
    }
    const changed = dividends.slice(k).map(([day, n]) => ({ day, n, ...lookback(day) }));
    const days: string[] = [];
    for (let d = addDays(after, 1); d <= before; d = addDays(d, 1)) days.push(d);
    if (days.length > MAX_WINDOW_DAYS) return none(`${after} to ${before} is too wide a window to search.`);

    // With the split at `date` the holding at any later point is `f0 + ratio * a` (a split scales
    // the lots bought before it), so each dividend gives the ratios that would produce its count.
    const ratiosAt = (date: string): number[] => {
      let common: number[] | null = null;
      for (const { day, n, lo: from, days: eventsIn } of changed) {
        const lo = from > date ? from : date;
        const cutoffs = new Set([lo, ...eventsIn.filter((d) => d > lo)]);
        if (lo === date) cutoffs.add(addDays(date, -1)); // just after the split, before the day's own trades
        const mine = new Set<number>();
        for (const c of cutoffs) {
          if (c > day) continue;
          const { f0, a } = affineAt(c, date);
          if (a <= 0) continue;
          const ratio = cleanRatio((n - f0) / a);
          if (ratio !== null) mine.add(ratio);
        }
        common = common === null ? [...mine] : common.filter((r) => mine.has(r));
        if (common.length === 0) return [];
      }
      return common ?? [];
    };

    const fits: { date: string; ratio: number }[] = [];
    let consistent = false;
    for (const date of days) {
      for (const ratio of ratiosAt(date)) {
        consistent = true;
        if (Math.abs(quantityWithSplit(date, ratio) - held) <= tol) fits.push({ date, ratio });
      }
    }
    if (!consistent) {
      return none(
        `the dividends after ${after} do not agree on one usual ratio (2:3, 3:1, 1:10 …), so no split was inferred.`,
      );
    }
    if (fits.length === 0) {
      return none(`no split between ${after} and ${before} reproduces Trading 212's quantity (${fmt(held)}), so none was added.`);
    }
    const ratios = [...new Set(fits.map((f) => f.ratio))];
    if (ratios.length > 1) {
      return none(`${ratios.map(describeRatio).join(" and ")} both reproduce it between ${after} and ${before}, so none was added.`);
    }
    const ratio = ratios[0];
    const dates = fits.map((f) => f.date);
    const date = dates[Math.floor((dates.length - 1) / 2)];
    // The lookups above are a shortcut for the replay; the proposal is held to the replay itself.
    if (Math.abs(simulateQuantity(events, [{ date, ratio }]) - held) > tol) {
      return none("the replay does not reproduce Trading 212's quantity, so none was added.");
    }
    const from = dates[0];
    const to = dates[dates.length - 1];
    const span = from === to ? from : `any date from ${from} to ${to}`;
    return {
      split: { date, ratio, after, before, from, to },
      reason:
        `Dividend share counts put a ${describeRatio(ratio)} split between ${after} and ${before}; ` +
        `${span} makes the activities add up to ${fmt(held)}, as Trading 212 holds, so it is dated ${date}.`,
    };
  } catch (e) {
    if (e instanceof Error && e.message === "budget") return none("too many activities to search, so none was inferred.");
    throw e;
  }
}

/**
 * Adds the splits Trading 212 did not export for the positions in `gaps`: for each, the known
 * splits that reproduce its quantity exactly. Imports them as SPLIT activities (ids derived from
 * the ISIN and date, so repeating is harmless) and writes what it did, and why it did nothing for
 * the rest, to `log`. Returns how many were imported.
 */
export async function repairSplits(
  importer: ActivityImporter,
  resolver: SymbolResolver,
  accountId: string,
  gaps: PositionGap[],
  log: string[],
  dividends: Record<string, DividendShares[]> = {},
): Promise<number> {
  // Read the account afresh: the repair replays what Wealthfolio holds, whatever an import call
  // answered about it (2.6.2 left rows it had misread as refused out of its view, and found no
  // activities to repair).
  const rows = (await importer.reload(accountId)) as RowLike[];
  const units: ActivityImport[][] = [];
  for (const gap of gaps) {
    const events = quantityEvents(rows, gap.symbol);
    let proposal = proposeSplits({ isin: gap.isin, held: gap.held, events });
    let how = "the known splits";
    if (proposal.splits.length === 0 && !proposal.ambiguous && !proposal.noGap && gap.isin && dividends[gap.isin]) {
      // No known split explains it: try the share counts the position's dividend rows report.
      const inferred = inferSplit({ held: gap.held, events, dividends: dividends[gap.isin] });
      if (inferred.split) {
        const { date, ratio } = inferred.split;
        proposal = { splits: [{ isin: gap.isin, date, ratio, name: gap.name ?? gap.ticker }], reason: inferred.reason };
        how = "the dividend share counts";
      } else {
        proposal = { splits: [], reason: `${proposal.reason} ${inferred.reason}` };
      }
    }
    if (proposal.splits.length === 0) {
      log.push(`${gap.ticker} (${gap.name ?? "?"}): ${proposal.reason}`);
      continue;
    }
    const resolved = await resolver.resolveDetailed(gap.ticker, { isin: gap.isin, name: gap.name, currency: gap.currency });
    if (!resolved) continue;
    for (const s of proposal.splits) {
      log.push(`${gap.ticker}: adding the ${describeRatio(s.ratio)} split of ${s.date} that Trading 212's history does not list. ${proposal.reason}`);
      const found = how === "the known splits" ? "found from the position difference" : `inferred from ${how}`;
      units.push([
        {
          id: `t212-split-${s.isin}-${s.date.replace(/-/g, "")}`,
          accountId,
          activityType: "SPLIT" as ActivityImport["activityType"],
          date: `${s.date}T00:00:00.000Z`,
          ...importAssetFields(resolved),
          amount: s.ratio,
          // In pounds, not pence: Wealthfolio divides a GBX row's amount by 100 (see mapStockSplit).
          currency: majorCurrency(gap.currency ?? "USD"),
          isValid: true,
          isDraft: false,
          comment: `Stock split ${describeRatio(s.ratio)} (not in the Trading 212 export; ${found})`,
        },
      ]);
    }
  }
  if (units.length === 0) return 0;
  const out = await importer.importRows(units);
  for (const r of out.rejected) log.push(`Split not imported: ${r.reason}`);
  return out.imported;
}

/**
 * The ratio a split row's comment states, as this add-on writes them ("Stock split: 1.2 → 1.152
 * shares" for an exported pair, "Stock split 2:3 (…" or "Stock split ×0.96 (…" for an added one),
 * or null for any other comment.
 */
export function statedRatio(comment?: string | null): number | null {
  const c = comment ?? "";
  const pair = /^Stock split: ([\d.]+) → ([\d.]+) shares/.exec(c);
  if (pair) {
    const [close, open] = [Number(pair[1]), Number(pair[2])];
    return close > 0 && open > 0 ? open / close : null;
  }
  const said = /^Stock split (\d+):(\d+) /.exec(c);
  if (said) return Number(said[2]) > 0 ? Number(said[1]) / Number(said[2]) : null;
  const times = /^Stock split ×([\d.]+) /.exec(c);
  return times ? Number(times[1]) : null;
}

type StoredSplit = ExistingActivityLike & { id?: string; exchangeMic?: string };

/**
 * The split rows Wealthfolio stored at a hundredth (or thousandth) of the ratio their comment
 * states: sent in a minor-unit currency (GBX) before 2.6.4, whose `amount` Wealthfolio divides by
 * 100 like any price. Each comes with the ratio it should have.
 */
export function minorUnitSplits(rows: StoredSplit[]): { row: StoredSplit; ratio: number }[] {
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-3 * b;
  const out: { row: StoredSplit; ratio: number }[] = [];
  for (const row of rows) {
    if (String(row.activityType) !== "SPLIT") continue;
    const stated = statedRatio(row.comment);
    const amount = num(row.amount);
    if (!stated || stated <= 0 || amount <= 0 || near(amount, stated)) continue;
    const factor = [100, 1000].find((f) => near(amount * f, stated));
    if (factor) out.push({ row, ratio: Number((amount * factor).toFixed(10)) });
  }
  return out;
}

/**
 * Puts right the splits Wealthfolio stored at a hundredth of their ratio (see
 * {@link minorUnitSplits}): imports each again with the right ratio, in the major currency, and
 * deletes the wrong row once the new one is stored. Returns how many were fixed.
 */
export async function healSplitRatios(
  ctx: AddonContext,
  importer: ActivityImporter,
  accountId: string,
  log: string[],
): Promise<number> {
  const bad = minorUnitSplits((await importer.existingIn(accountId)) as StoredSplit[]).filter((b) => b.row.id);
  if (bad.length === 0) return 0;
  const idOf = (b: (typeof bad)[number]) => `t212-split-fix-${b.row.id}`;
  const units: ActivityImport[][] = bad.map((b) => [
    {
      id: idOf(b),
      accountId,
      activityType: "SPLIT" as ActivityImport["activityType"],
      date: b.row.date instanceof Date ? b.row.date.toISOString() : String(b.row.date),
      ...importAssetFields({ symbol: b.row.assetSymbol ?? "", exchangeMic: b.row.exchangeMic }),
      amount: b.ratio,
      currency: majorCurrency(b.row.currency || "GBP"),
      isValid: true,
      isDraft: false,
      comment: b.row.comment ?? undefined,
    },
  ]);
  const out = await importer.importRows(units);
  const stored = new Set(out.accounted);
  const wrong = bad.filter((b) => stored.has(idOf(b))).map((b) => b.row.id as string);
  if (wrong.length > 0) {
    await ctx.api.activities.saveMany({ deleteIds: wrong });
    importer.forget(accountId, wrong);
  }
  for (const b of bad) {
    const what = `${b.row.assetSymbol} split of ${day(b.row.date)}: Wealthfolio stored a ratio of ${fmt(num(b.row.amount))} for ${fmt(b.ratio)} (it was sent in pence)`;
    log.push(stored.has(idOf(b)) ? `Fixed the ${what}.` : `Could not fix the ${what}.`);
  }
  for (const r of out.rejected) log.push(`Split not fixed: ${r.reason}`);
  return wrong.length;
}
