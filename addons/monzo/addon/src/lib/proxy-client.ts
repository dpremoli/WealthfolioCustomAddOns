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

  async pollTokenStatus(
    state: string,
    maxAttempts = 150,
    intervalMs = 2000,
  ): Promise<MonzoTokens | null> {
    for (let i = 0; i < maxAttempts; i++) {
      const resp = await fetch(
        `${this.proxyUrl}/token-status?state=${encodeURIComponent(state)}`,
      );
      if (!resp.ok) throw new Error(`Token status request failed: ${resp.statusText}`);
      const data = await resp.json();
      if (data.ready && data.tokens) {
        const tokens: MonzoTokens = {
          ...data.tokens,
          expires_at:
            typeof data.tokens.expires_at === "number"
              ? data.tokens.expires_at
              : new Date(data.tokens.expires_at).getTime(),
        };
        return tokens;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return null;
  }

  async refreshToken(refreshToken: string, currentTokens?: MonzoTokens): Promise<MonzoTokens> {
    const resp = await fetch(`${this.proxyUrl}/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!resp.ok) throw new Error(`Token refresh failed: ${resp.statusText}`);
    const data = await resp.json();
    return {
      ...(currentTokens ?? {}),
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at:
        typeof data.expires_at === "number"
          ? data.expires_at
          : Date.now() + (data.expires_in ?? 21600) * 1000,
      token_type: data.token_type ?? "Bearer",
      user_id: data.user_id ?? currentTokens?.user_id ?? "",
    };
  }

  async getAccounts(accessToken: string): Promise<MonzoAccount[]> {
    const resp = await fetch(`${this.proxyUrl}/accounts?account_type=uk_retail`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (resp.status === 401) throw new Error("UNAUTHORIZED");
    if (!resp.ok) throw new Error(`Accounts request failed: ${resp.statusText}`);
    const data = await resp.json();
    return data.accounts ?? [];
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
