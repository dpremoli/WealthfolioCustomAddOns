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
    const data = await this.get<{ accounts?: MonzoAccount[] }>(`${API_BASE}/accounts`);
    return (data.accounts ?? []).filter(
      (a) => !a.closed && a.account_type !== "uk_monzo_flex_backing_loan",
    );
  }

  /**
   * Every transaction of an account since `since` (RFC 3339 time or transaction id),
   * oldest first. Fetched `PAGE_SIZE` at a time, advancing `since` to the newest
   * transaction of each page, so no single response approaches the broker's 2 MB cap.
   */
  async getTransactions(
    accountId: string,
    since?: string,
    onPage?: (total: number) => void,
  ): Promise<MonzoTransaction[]> {
    const all: MonzoTransaction[] = [];
    const seen = new Set<string>();
    let cursor = since;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = withQuery(`${API_BASE}/transactions`, {
        account_id: accountId,
        since: cursor,
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
}

/** The most recently created transaction (Monzo lists oldest first; don't rely on it). */
function newest(txs: MonzoTransaction[]): MonzoTransaction {
  return txs.reduce((a, b) => (b.created >= a.created ? b : a));
}
