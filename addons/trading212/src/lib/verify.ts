import type { AddonContext, Holding } from "@wealthfolio/addon-sdk";
import { round2 } from "@wf-addons/kit";
import type { AccountSummary, Position } from "../types";
import type { SymbolResolver } from "./symbol-resolver";

/** Outcome of comparing a Transactions-mode account with what Trading 212 reports. */
export interface Verification {
  ok: boolean;
  /** One line per position or currency that does not match. */
  mismatches: string[];
  /** Positions compared (Trading 212's count). */
  positions: number;
  checkedAt: string;
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
  symbol: string | null;
  quantity: number;
}

/** Fractional shares are stored to many decimals; allow for rounding, nothing more. */
const sameQuantity = (a: number, b: number) => Math.abs(a - b) <= 1e-4 + 1e-5 * Math.abs(b);
/** Cash is the sum of thousands of rows rounded to cents. */
const sameCash = (a: number, b: number) => Math.abs(a - b) <= 0.05 + 5e-4 * Math.abs(b);

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
}): Omit<Verification, "checkedAt" | "settled"> {
  const mismatches: string[] = [];
  const expected = new Map<string, { quantity: number; label: string }>();
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
    }
  }
  for (const [k, h] of held) {
    if (!expected.has(k) && !sameQuantity(h.quantity, 0)) {
      mismatches.push(`${h.symbol}: Wealthfolio holds ${fmt(h.quantity)}, Trading 212 none.`);
    }
  }

  const ccy = input.accountCurrency.toUpperCase();
  const haveCash = cash.get(ccy) ?? 0;
  if (!sameCash(haveCash, input.cash)) {
    mismatches.push(`Cash ${ccy}: Trading 212 ${round2(input.cash)}, Wealthfolio ${round2(haveCash)}.`);
  }
  for (const [c, amount] of cash) {
    if (c !== ccy && !sameCash(amount, 0)) {
      mismatches.push(`Cash ${c}: Wealthfolio holds ${round2(amount)}, Trading 212 keeps all cash in ${ccy}.`);
    }
  }
  return { ok: mismatches.length === 0, mismatches, positions: input.positions.length };
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
    out.push({ ticker, name: p.instrument?.name, symbol: r?.symbol ?? null, quantity: Number(p.quantity) });
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
  if (v.ok) return [`Matches Trading 212: ${v.positions} positions and the cash balance.`];
  const head = v.settled
    ? `Does not match Trading 212 (${v.mismatches.length} difference${v.mismatches.length === 1 ? "" : "s"}):`
    : `Wealthfolio had not finished recalculating, so these differences may be temporary (sync again to re-check):`;
  return [head, ...v.mismatches.map((m) => `  ${m}`)];
}
