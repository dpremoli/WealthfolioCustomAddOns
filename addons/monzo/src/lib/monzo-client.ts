import type { AddonContext } from "@wealthfolio/addon-sdk";
import { HttpError, brokeredJson, withQuery } from "@wf-addons/kit";
import { API_BASE, SECRET_ACCESS_TOKEN } from "../constants";
import type { MonzoAccount, MonzoTransaction } from "../types";
import {
  APPROVAL_MESSAGE,
  MonzoAuthError,
  getConnectionStatus,
  getExpiresAt,
  refreshAccessToken,
} from "./auth";
import { isExpiring } from "./oauth";

/** Monzo's maximum page size for `GET /transactions`. */
export const PAGE_SIZE = 100;
/** Safety stop: 500 pages = 50,000 transactions per account. */
const MAX_PAGES = 500;
/**
 * Longest range asked for in one go when reading a whole history. Monzo refuses a range of
 * more than about a year (400 `invalid_time_range`) and asks for `since` + `before` slices.
 */
export const HISTORY_SLICE_MS = 180 * 24 * 60 * 60 * 1000;
/** Monzo did not exist before this; some APIs send a zero date for "unknown". */
const HISTORY_EARLIEST_MS = Date.UTC(2015, 0, 1);

/**
 * Thin Monzo API client over the Wealthfolio network broker. The access token is never
 * handled here: requests name it with `auth.secretKey` and the host injects the header.
 */
export class MonzoClient {
  constructor(private readonly ctx: AddonContext) {}

  /** GET a Monzo URL: refreshes proactively near expiry, once more on 401, maps 403. */
  private async get<T>(url: string): Promise<T> {
    const status = await getConnectionStatus(this.ctx);
    if (!status.connected) {
      throw new MonzoAuthError("not-connected", "Not connected to Monzo. Open Settings to connect.");
    }
    if (isExpiring(await getExpiresAt(this.ctx))) await refreshAccessToken(this.ctx);

    const call = () =>
      brokeredJson<T>(
        this.ctx,
        {
          url,
          method: "GET",
          auth: { type: "bearer", secretKey: SECRET_ACCESS_TOKEN },
          timeoutSecs: 30,
        },
        // Monzo answers 500/504 for trouble on its side; GETs are safe to repeat.
        { maxServerErrorRetries: 2 },
      );
    try {
      return await call();
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        await refreshAccessToken(this.ctx);
        try {
          return await call();
        } catch (retryErr) {
          throw this.mapError(retryErr);
        }
      }
      throw this.mapError(err);
    }
  }

  /** 403 means the app approval is pending, or (after a lapse) more than 90 days was asked for. */
  private mapError(err: unknown): unknown {
    if (err instanceof HttpError) {
      if (err.status === 403) return new MonzoAuthError("approval", APPROVAL_MESSAGE);
      if (err.status === 401) {
        return new MonzoAuthError(
          "reconnect",
          "Monzo no longer accepts this connection (401). Reconnect in Settings.",
        );
      }
    }
    return err;
  }

  /** Open accounts, without the Flex backing-loan pseudo account. */
  async getAccounts(): Promise<MonzoAccount[]> {
    const data = await this.get<{ accounts?: Partial<MonzoAccount>[] }>(`${API_BASE}/accounts`);
    return (data.accounts ?? [])
      .map((a) => ({ ...a, account_type: a.type ?? a.account_type ?? "" }) as MonzoAccount)
      .filter((a) => !a.closed && a.account_type !== "uk_monzo_flex_backing_loan");
  }

  /**
   * Every transaction of an account since `since` (RFC 3339 time or transaction id) and,
   * when given, before `before`, oldest first. Fetched `PAGE_SIZE` at a time, advancing
   * `since` to the newest transaction of each page, so no single response approaches the
   * broker's 2 MB cap.
   *
   * Always pass `since` when syncing: without it Monzo does not return the whole history,
   * only the last 30 days (and with no error to say so).
   */
  async getTransactions(
    accountId: string,
    since?: string,
    onPage?: (total: number) => void,
    before?: string,
  ): Promise<MonzoTransaction[]> {
    const all: MonzoTransaction[] = [];
    const seen = new Set<string>();
    let cursor = since;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = withQuery(`${API_BASE}/transactions`, {
        account_id: accountId,
        since: cursor,
        before,
        limit: PAGE_SIZE,
        "expand[]": "merchant",
      });
      const { transactions = [] } = await this.get<{ transactions?: MonzoTransaction[] }>(url);
      const fresh = transactions.filter((t) => !seen.has(t.id));
      for (const t of fresh) {
        seen.add(t.id);
        all.push(t);
      }
      onPage?.(all.length);
      // A short page is the last one; an all-seen page means the cursor stopped advancing.
      if (transactions.length < PAGE_SIZE || fresh.length === 0) break;
      cursor = newest(transactions).id;
    }
    return all;
  }

  /**
   * Every transaction of an account from `from` (its opening date) up to `now`, read in
   * slices of {@link HISTORY_SLICE_MS}, newest first, and returned oldest first. Monzo only
   * allows this within 5 minutes of the user authenticating; later it answers 403 for
   * anything 90 or more days back (or 400 for a range that is too long).
   *
   * If a slice is refused after another one succeeded, what was fetched is returned with
   * `complete: false` (the history ends part-way, not at `from`); if the very first slice is
   * refused, the error is thrown so the caller can fall back to a shorter range.
   */
  async getHistory(
    accountId: string,
    from: Date,
    now: Date,
  ): Promise<{ transactions: MonzoTransaction[]; complete: boolean }> {
    const floor = Math.max(from.getTime(), HISTORY_EARLIEST_MS);
    const all: MonzoTransaction[] = [];
    const seen = new Set<string>();
    let complete = true;
    // Upper bound of the slice being read; undefined for the newest (open-ended) one, and so
    // also while no slice has succeeded yet.
    let upper: number | undefined;
    let end = now.getTime();
    while (end > floor) {
      const lower = Math.max(floor, end - HISTORY_SLICE_MS);
      try {
        // `since` and `before` are exclusive, so each slice starts a second early: a
        // transaction on the boundary is in the slice above if not in this one.
        const slice = await this.getTransactions(
          accountId,
          new Date(lower - 1000).toISOString(),
          undefined,
          upper === undefined ? undefined : new Date(upper).toISOString(),
        );
        for (const t of slice) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          all.push(t);
        }
      } catch (err) {
        if (!isHistoryRefusal(err) || upper === undefined) throw err;
        complete = false;
        break;
      }
      upper = lower;
      end = lower;
    }
    all.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
    return { transactions: all, complete };
  }
}

/**
 * Monzo refusing to share a long range: 403 (older than 90 days, outside the 5 minutes after
 * logging in) or 400 (a range of more than about a year).
 */
export function isHistoryRefusal(err: unknown): boolean {
  return (
    (err instanceof MonzoAuthError && err.kind === "approval") ||
    (err instanceof HttpError && err.status === 400)
  );
}

/** The most recently created transaction (Monzo lists oldest first; don't rely on it). */
function newest(txs: MonzoTransaction[]): MonzoTransaction {
  return txs.reduce((a, b) => (b.created >= a.created ? b : a));
}
