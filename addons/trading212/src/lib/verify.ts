import type { AddonContext, Holding } from "@wealthfolio/addon-sdk";
import { round2 } from "@wf-addons/kit";
import type { AccountSummary, Position } from "../types";
import type { PositionGap } from "./split-repair";
import type { SymbolResolver } from "./symbol-resolver";

/** Outcome of comparing a Transactions-mode account with what Trading 212 reports. */
export interface Verification {
  ok: boolean;
  /** One line per position or currency that does not match. */
  mismatches: string[];
  /** Positions compared (Trading 212's count). */
  positions: number;
  checkedAt: string;
  /** What could not be compared (no exchange rate for a wallet, say); not a difference. */
  notes?: string[];
  /**
   * False when Wealthfolio had not finished recalculating the account before the comparison
   * gave up waiting, so a mismatch may only mean the numbers were not up to date yet.
   */
  settled: boolean;
}

/** A Trading 212 position with the Wealthfolio symbol it resolves to (null: not matched). */
export interface ResolvedPosition {
  ticker: string;
  name?: string;
  isin?: string;
  /** The instrument's currency. */
  currency?: string;
  symbol: string | null;
  quantity: number;
}

/** An exchange rate as Wealthfolio keeps it: one `from` is worth `rate` of `to`. */
export interface RateLike {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
}

/** `from` → `to`: a direct rate, its inverse, or through one common currency. Null when unknown. */
export function convertRate(rates: RateLike[], from: string, to: string): number | null {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return 1;
  const direct = (a: string, b: string): number | null => {
    const r = rates.find((x) => x.fromCurrency.toUpperCase() === a && x.toCurrency.toUpperCase() === b && x.rate > 0);
    if (r) return r.rate;
    const inv = rates.find((x) => x.fromCurrency.toUpperCase() === b && x.toCurrency.toUpperCase() === a && x.rate > 0);
    return inv ? 1 / inv.rate : null;
  };
  const one = direct(f, t);
  if (one !== null) return one;
  for (const pivot of new Set(rates.flatMap((r) => [r.fromCurrency.toUpperCase(), r.toCurrency.toUpperCase()]))) {
    const a = direct(f, pivot);
    const b = a === null ? null : direct(pivot, t);
    if (a !== null && b !== null) return a * b;
  }
  return null;
}

/** Fractional shares are stored to many decimals; allow for rounding, nothing more. */
const sameQuantity = (a: number, b: number) => Math.abs(a - b) <= 1e-4 + 1e-5 * Math.abs(b);
/** Cash is the sum of thousands of rows rounded to cents. */
const sameCash = (a: number, b: number) => Math.abs(a - b) <= 0.05 + 5e-4 * Math.abs(b);
/**
 * Cash in several currencies is compared as one total, converted at Wealthfolio's current rates,
 * against Trading 212's total at its own: they differ by the rates' difference, so allow a margin.
 */
const sameConvertedCash = (a: number, b: number) => Math.abs(a - b) <= 1 + 0.01 * Math.abs(b);

/**
 * Wealthfolio may keep an asset under its canonical symbol (`RR` for `RR.L`), so symbols are
 * compared without an exchange suffix; one account never holds two listings that differ only by it
 * (the resolver keeps one listing per security).
 */
const key = (symbol: string) => symbol.toUpperCase().replace(/\.[A-Z]{1,4}$/, "");

const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);

/**
 * Compares Wealthfolio's holdings for the account (`portfolio.getHoldings`) with Trading 212's
 * positions and cash. Positions resolving to one symbol are summed on both sides; Trading 212's
 * cash (available, reserved for orders and in pies) is all in the account currency, so any other
 * currency Wealthfolio holds is a mismatch too (a deposit that was never converted, say).
 */
export function compareWithTrading212(input: {
  positions: ResolvedPosition[];
  cash: number;
  accountCurrency: string;
  holdings: Holding[];
  rates?: RateLike[];
}): Omit<Verification, "checkedAt" | "settled"> & { gaps: PositionGap[] } {
  const mismatches: string[] = [];
  const notes: string[] = [];
  const gaps: PositionGap[] = [];
  const expected = new Map<string, { quantity: number; label: string; position: ResolvedPosition & { symbol: string } }>();
  for (const p of input.positions) {
    if (!p.symbol) {
      mismatches.push(`${p.ticker} (${p.name ?? "?"}): Trading 212 holds ${fmt(p.quantity)}, but it did not match a Wealthfolio symbol.`);
      continue;
    }
    const k = key(p.symbol);
    const prev = expected.get(k);
    expected.set(k, {
      quantity: (prev?.quantity ?? 0) + p.quantity,
      label: prev ? `${prev.label} + ${p.ticker}` : `${p.symbol} (${p.ticker})`,
      position: prev?.position ?? { ...p, symbol: p.symbol },
    });
  }

  const held = new Map<string, { quantity: number; symbol: string }>();
  const cash = new Map<string, number>();
  for (const h of input.holdings) {
    if (h.holdingType === "cash") {
      const ccy = h.localCurrency.toUpperCase();
      cash.set(ccy, (cash.get(ccy) ?? 0) + Number(h.quantity));
    } else if (h.holdingType === "security" && h.instrument?.symbol) {
      const k = key(h.instrument.symbol);
      held.set(k, { quantity: (held.get(k)?.quantity ?? 0) + Number(h.quantity), symbol: h.instrument.symbol });
    }
  }

  for (const [k, e] of expected) {
    const have = held.get(k)?.quantity ?? 0;
    if (!sameQuantity(have, e.quantity)) {
      mismatches.push(`${e.label}: Trading 212 holds ${fmt(e.quantity)}, Wealthfolio ${fmt(have)}.`);
      const p = e.position;
      gaps.push({
        ticker: p.ticker,
        isin: p.isin,
        name: p.name,
        symbol: p.symbol,
        currency: p.currency,
        held: e.quantity,
        derived: have,
      });
    }
  }
  for (const [k, h] of held) {
    if (!expected.has(k) && !sameQuantity(h.quantity, 0)) {
      mismatches.push(`${h.symbol}: Wealthfolio holds ${fmt(h.quantity)}, Trading 212 none.`);
    }
  }

  // Trading 212 reports one cash figure, in the account currency, for every wallet the account has
  // (EUR plus the GBP and USD it was topped up in). With only account-currency cash the two figures
  // are compared directly; with other wallets Wealthfolio's are converted into the account currency.
  const ccy = input.accountCurrency.toUpperCase();
  const haveCash = cash.get(ccy) ?? 0;
  const others = [...cash].filter(([c, amount]) => c !== ccy && !sameCash(amount, 0));
  if (others.length === 0) {
    if (!sameCash(haveCash, input.cash)) {
      mismatches.push(`Cash ${ccy}: Trading 212 ${round2(input.cash)}, Wealthfolio ${round2(haveCash)}.`);
    }
  } else {
    let total = haveCash;
    const parts = [`${ccy} ${round2(haveCash)}`];
    let convertible = true;
    for (const [c, amount] of others) {
      const rate = convertRate(input.rates ?? [], c, ccy);
      parts.push(`${c} ${round2(amount)}`);
      if (rate === null) {
        convertible = false;
        notes.push(`Cash in ${c} (${round2(amount)}) was not compared: Wealthfolio has no ${c}→${ccy} exchange rate.`);
      } else {
        total += amount * rate;
      }
    }
    if (convertible && !sameConvertedCash(total, input.cash)) {
      mismatches.push(
        `Cash: Trading 212 ${round2(input.cash)} ${ccy}, Wealthfolio ${round2(total)} ${ccy} ` +
          `(${parts.join(" + ")}, converted at Wealthfolio's rates; allowed to differ by 1% for the rates).`,
      );
    }
  }
  return { ok: mismatches.length === 0, mismatches, notes, positions: input.positions.length, gaps };
}

/** Total cash Trading 212 reports for the account (all of it in the account currency). */
export function trading212Cash(summary: AccountSummary): number {
  const c = summary.cash;
  return round2((c?.availableToTrade ?? 0) + (c?.reservedForOrders ?? 0) + (c?.inPies ?? 0));
}

/** Resolves Trading 212 positions to Wealthfolio symbols with the sync's resolver (cached). */
export async function resolvePositions(positions: Position[], resolver: SymbolResolver): Promise<ResolvedPosition[]> {
  const out: ResolvedPosition[] = [];
  for (const p of positions) {
    const ticker = p.instrument?.ticker ?? p.ticker;
    if (!ticker) continue;
    const r = await resolver.resolveDetailed(ticker, {
      isin: p.instrument?.isin,
      name: p.instrument?.name,
      currency: p.instrument?.currency,
    });
    out.push({
      ticker,
      name: p.instrument?.name,
      isin: p.instrument?.isin,
      currency: p.instrument?.currency,
      symbol: r?.symbol ?? null,
      quantity: Number(p.quantity),
    });
  }
  return out;
}

/**
 * Notices when Wealthfolio finishes recalculating the portfolio. An import only queues the
 * recalculation (debounced, then run in the background), so holdings read straight after an
 * import are stale; {@link PortfolioUpdates.settledAfter} waits for the first recalculation that
 * started after a given moment. Without the events API it resolves at once (as unsettled).
 */
export class PortfolioUpdates {
  private startedAt: number[] = [];
  private completedAt: number[] = [];
  private waiters: (() => void)[] = [];
  private unlisten: (() => void)[] = [];
  readonly available: boolean;

  constructor(ctx: AddonContext) {
    const events = ctx.api.events?.portfolio;
    this.available = !!events?.onUpdateStart && !!events?.onUpdateComplete;
    if (!this.available) return;
    const listen = (p: Promise<() => void>) =>
      p.then(
        (u) => this.unlisten.push(u),
        () => undefined,
      );
    listen(events.onUpdateStart(() => void this.startedAt.push(Date.now())));
    listen(
      events.onUpdateComplete(() => {
        this.completedAt.push(Date.now());
        for (const w of this.waiters.splice(0)) w();
      }),
    );
  }

  /** Whether a recalculation started at or after `since` has completed. */
  private settled(since: number): boolean {
    const start = this.startedAt.find((t) => t >= since);
    return start !== undefined && this.completedAt.some((t) => t >= start);
  }

  /** Resolves true once a recalculation that started after `since` completed, false on timeout. */
  async settledAfter(since: number, timeoutMs: number): Promise<boolean> {
    if (!this.available) return false;
    const deadline = Date.now() + timeoutMs;
    while (!this.settled(since)) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 5_000));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return true;
  }

  stop(): void {
    for (const u of this.unlisten.splice(0)) u();
  }
}

/** Log lines for a {@link Verification}. */
export function verificationLines(v: Verification): string[] {
  if (v.ok) return [`Matches Trading 212: ${v.positions} positions and the cash balance.`, ...(v.notes ?? []).map((n) => `  (${n})`)];
  const head = v.settled
    ? `Does not match Trading 212 (${v.mismatches.length} difference${v.mismatches.length === 1 ? "" : "s"}):`
    : `Wealthfolio had not finished recalculating, so these differences may be temporary (sync again to re-check):`;
  return [head, ...v.mismatches.map((m) => `  ${m}`), ...(v.notes ?? []).map((n) => `  (${n})`)];
}
