import type { ActivityImport } from "@wealthfolio/addon-sdk";
import type { ExistingActivityLike } from "@wf-addons/kit";
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
  if (events.length === 0) return { splits: [], reason: `${gap}: no activities for it in the account.` };
  if (Math.abs(base - held) <= tol) {
    return { splits: [], reason: `${gap}: they agree, so Wealthfolio is probably still recalculating.` };
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
      : ` (×${fmt(snapRatio(ratio, 1e-4))}): a split or consolidation Trading 212 did not export is the likely cause. ` +
        `Add a SPLIT activity for it in Wealthfolio, or tell us the ISIN and date so it can be added to the known splits`;
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
    return { splits: best[0], reason: `${gap}: ${best[0].map((s) => `${s.ratio}:1 on ${s.date}`).join(" and ")} reproduces it exactly.` };
  }
  if (best.length > 1) {
    return { splits: [], reason: `${gap}: several known splits would explain it equally well, so none was added.` };
  }
  return {
    splits: [],
    reason: `${gap}: the known splits for ${isin} (${candidates.map((c) => `${c.ratio}:1 on ${c.date}`).join(", ")}) do not reproduce it${hint || "."}`,
  };
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
): Promise<number> {
  const rows = (await importer.existingIn(accountId)) as RowLike[];
  const units: ActivityImport[][] = [];
  for (const gap of gaps) {
    const proposal = proposeSplits({ isin: gap.isin, held: gap.held, events: quantityEvents(rows, gap.symbol) });
    if (proposal.splits.length === 0) {
      log.push(`${gap.ticker} (${gap.name ?? "?"}): ${proposal.reason}`);
      continue;
    }
    const resolved = await resolver.resolveDetailed(gap.ticker, { isin: gap.isin, name: gap.name, currency: gap.currency });
    if (!resolved) continue;
    for (const s of proposal.splits) {
      log.push(`${gap.ticker}: adding the ${s.ratio}:1 split of ${s.date} that Trading 212's history does not list. ${proposal.reason}`);
      units.push([
        {
          id: `t212-split-${s.isin}-${s.date.replace(/-/g, "")}`,
          accountId,
          activityType: "SPLIT" as ActivityImport["activityType"],
          date: `${s.date}T00:00:00.000Z`,
          ...importAssetFields(resolved),
          amount: s.ratio,
          currency: gap.currency ?? "USD",
          isValid: true,
          isDraft: false,
          comment: `Stock split ${s.ratio}:1 (not in the Trading 212 export; found from the position difference)`,
        },
      ]);
    }
  }
  if (units.length === 0) return 0;
  const out = await importer.import(units);
  for (const r of out.rejected) log.push(`Split not imported: ${r.reason}`);
  return out.imported;
}
