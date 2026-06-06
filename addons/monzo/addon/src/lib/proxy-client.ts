import type { MonzoAccount, MonzoTokens, MonzoTransaction } from "../types";

export class MonzoProxyClient {
  constructor(private readonly proxyUrl: string) {}

  async testConnection(): Promise<void> {
    const resp = await fetch(`${this.proxyUrl}/health`);
    if (!resp.ok) throw new Error(`Proxy returned ${resp.status}`);
  }

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
    const data = await resp.json();
    return {
      ...data,
      expires_at:
        typeof data.expires_at === "number"
          ? data.expires_at
          : Date.now() + (data.expires_in ?? 21600) * 1000,
    };
  }

  async getAccounts(accessToken: string): Promise<MonzoAccount[]> {
    const resp = await fetch(`${this.proxyUrl}/accounts`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (resp.status === 401) throw new Error("UNAUTHORIZED");
    if (!resp.ok) throw new Error(`Accounts request failed: ${resp.statusText}`);
    const data = await resp.json();
    const accounts: MonzoAccount[] = data.accounts ?? [];
    return accounts.filter((a) => a.account_type !== "uk_monzo_flex_backing_loan");
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
