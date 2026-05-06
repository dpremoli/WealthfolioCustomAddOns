import type { MonzoAccount, MonzoTokens, MonzoTransaction } from "../types";

export class MonzoProxyClient {
  constructor(private readonly proxyUrl: string) {}

  async getAuthUrl(): Promise<{ url: string; state: string }> {
    const resp = await fetch(`${this.proxyUrl}/auth`);
    if (!resp.ok) throw new Error(`Auth URL request failed: ${resp.statusText}`);
    return resp.json();
  }

  async pollTokenStatus(state: string): Promise<{ ready: boolean; tokens?: MonzoTokens }> {
    const resp = await fetch(
      `${this.proxyUrl}/token-status?state=${encodeURIComponent(state)}`,
    );
    if (!resp.ok) throw new Error(`Token status request failed: ${resp.statusText}`);
    return resp.json();
  }

  async refreshToken(refreshToken: string): Promise<MonzoTokens> {
    const resp = await fetch(`${this.proxyUrl}/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!resp.ok) throw new Error(`Token refresh failed: ${resp.statusText}`);
    return resp.json();
  }

  async getAccounts(accessToken: string): Promise<{ accounts: MonzoAccount[] }> {
    const resp = await fetch(`${this.proxyUrl}/accounts?account_type=uk_retail`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (resp.status === 401) throw new Error("UNAUTHORIZED");
    if (!resp.ok) throw new Error(`Accounts request failed: ${resp.statusText}`);
    return resp.json();
  }

  async getTransactions(
    accessToken: string,
    accountId: string,
    since?: string,
  ): Promise<{ transactions: MonzoTransaction[] }> {
    const params = new URLSearchParams({ account_id: accountId });
    if (since) params.set("since", since);
    const resp = await fetch(`${this.proxyUrl}/transactions?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (resp.status === 401) throw new Error("UNAUTHORIZED");
    if (!resp.ok) throw new Error(`Transactions request failed: ${resp.statusText}`);
    return resp.json();
  }
}
