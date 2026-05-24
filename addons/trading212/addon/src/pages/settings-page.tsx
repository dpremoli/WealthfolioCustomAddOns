import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AddonContext } from "@wealthfolio/addon-sdk";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from "@wealthfolio/ui";
import { useEffect, useState } from "react";
import { Trading212ProxyClient } from "../lib/proxy-client";
import type { AccountSummary, T212Config, T212Env } from "../types";
import {
  clearConfig,
  getAccountId,
  getConfig,
  resetSyncState,
  setAccountId,
  setConfig,
} from "../hooks/use-config";

const ACCOUNT_NAME = "Trading 212 (Invest)";
const PROVIDER = "trading212-addon";

async function ensureAccount(ctx: AddonContext, summary: AccountSummary): Promise<string> {
  const accounts = await ctx.api.accounts.getAll();
  const existingId = await getAccountId(ctx);
  if (existingId && accounts.some((a) => a.id === existingId)) return existingId;

  const providerId = String(summary.id);
  const match = accounts.find(
    (a) =>
      (a as { providerAccountId?: string }).providerAccountId === providerId ||
      a.name === ACCOUNT_NAME,
  );
  if (match) {
    await setAccountId(ctx, match.id);
    return match.id;
  }

  const created = await ctx.api.accounts.create({
    name: ACCOUNT_NAME,
    accountType: "SECURITIES",
    currency: summary.currency || "GBP",
    isDefault: false,
    isActive: true,
    trackingMode: "TRANSACTIONS",
    provider: PROVIDER,
    providerAccountId: providerId,
  });
  await setAccountId(ctx, created.id);
  return created.id;
}

export default function SettingsPage({ ctx }: { ctx: AddonContext }) {
  const queryClient = useQueryClient();
  const [proxyUrl, setProxyUrl] = useState("");
  const [env, setEnv] = useState<T212Env>("live");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const { data: config } = useQuery({
    queryKey: ["t212_config"],
    queryFn: () => getConfig(ctx),
  });

  useEffect(() => {
    if (config) {
      setProxyUrl(config.proxyUrl);
      setEnv(config.env);
      setApiKey(config.apiKey);
      setApiSecret(config.apiSecret ?? "");
    }
  }, [config]);

  async function connect() {
    setIsConnecting(true);
    setError(null);
    setStatus(null);
    try {
      const cfg: T212Config = {
        proxyUrl: proxyUrl.trim(),
        env,
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim() || undefined,
      };
      if (!cfg.proxyUrl) throw new Error("Enter the proxy URL.");
      if (!cfg.apiKey) throw new Error("Enter your Trading 212 API key.");

      const summary = await new Trading212ProxyClient(cfg).getAccountSummary();
      await setConfig(ctx, cfg);
      await ensureAccount(ctx, summary);

      queryClient.invalidateQueries({ queryKey: ["t212_config"] });
      setStatus(`Connected. Account currency: ${summary.currency}.`);
    } catch (err) {
      const msg =
        (err as Error).message === "UNAUTHORIZED"
          ? "Trading 212 rejected the API key. Check the key, secret and environment."
          : (err as Error).message;
      setError(msg);
    } finally {
      setIsConnecting(false);
    }
  }

  async function disconnect() {
    await clearConfig(ctx);
    queryClient.invalidateQueries({ queryKey: ["t212_config"] });
    setStatus("Disconnected. Your imported activity is kept in Wealthfolio.");
  }

  async function reset() {
    await resetSyncState(ctx);
    queryClient.invalidateQueries({ queryKey: ["t212_last_sync"] });
    setStatus("Sync history cleared. The next sync will re-scan your full history.");
  }

  return (
    <div className="space-y-6 p-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold">Trading 212 Settings</h1>
        <p className="text-muted-foreground mt-1">
          Connect your Trading 212 account via the public API.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>
            The proxy forwards requests to Trading 212 (required — Trading 212 blocks
            direct browser calls). Your API key is stored encrypted in Wealthfolio's
            keyring and never sent anywhere except Trading 212.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium">Proxy URL</label>
            <Input
              value={proxyUrl}
              onChange={(e) => setProxyUrl(e.target.value)}
              placeholder="http://YOUR_SERVER_IP:8000"
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Environment</label>
            <div className="flex gap-2">
              {(["live", "demo"] as T212Env[]).map((e) => (
                <Button
                  key={e}
                  variant={env === e ? "default" : "outline"}
                  size="sm"
                  onClick={() => setEnv(e)}
                >
                  {e === "live" ? "Live" : "Demo / Practice"}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">API Key</label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="API Key (ID)"
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">API Secret</label>
            <Input
              type="password"
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              placeholder="API Secret (leave blank for legacy single-key access)"
            />
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={connect} disabled={isConnecting}>
              {isConnecting ? "Connecting…" : config ? "Save & Reconnect" : "Connect"}
            </Button>
            {config && (
              <Badge variant="outline" className="text-green-600 border-green-600">
                Connected
              </Badge>
            )}
          </div>

          {status && <p className="text-sm text-green-600">{status}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {config && (
        <Card>
          <CardHeader>
            <CardTitle>Advanced</CardTitle>
            <CardDescription>Manage the connection and sync state.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Reset sync history</p>
                <p className="text-xs text-muted-foreground">
                  Forces the next sync to re-scan your full Trading 212 history.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={reset}>
                Reset
              </Button>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Disconnect</p>
                <p className="text-xs text-muted-foreground">
                  Removes the stored API key. Imported activity is kept.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={disconnect}>
                Disconnect
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
