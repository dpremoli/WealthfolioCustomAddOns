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
import type { AccountSummary, T212Connection, T212Env, T212Settings } from "../types";
import {
  addConnection,
  connectionConfig,
  getConnections,
  getSettings,
  migrateLegacyConfig,
  randomId,
  removeConnection,
  resetSyncState,
  setSettings,
} from "../hooks/use-config";

const PROVIDER = "trading212-addon";

/** Creates (or reuses) a Wealthfolio securities account for a Trading 212 account. */
async function ensureAccount(
  ctx: AddonContext,
  name: string,
  summary: AccountSummary,
): Promise<string> {
  const accounts = await ctx.api.accounts.getAll();
  const providerId = String(summary.id);
  // Reuse an existing account with the same Trading 212 id (remove-then-re-add).
  const match = accounts.find(
    (a) => (a as { providerAccountId?: string }).providerAccountId === providerId,
  );
  if (match) return match.id;

  const created = await ctx.api.accounts.create({
    name,
    accountType: "SECURITIES",
    currency: summary.currency || "GBP",
    isDefault: false,
    isActive: true,
    trackingMode: "TRANSACTIONS",
    provider: PROVIDER,
    providerAccountId: providerId,
  });
  return created.id;
}

function maskKey(key: string): string {
  return key.length <= 4 ? "••••" : `••••${key.slice(-4)}`;
}

function ConnectionRow({
  ctx,
  settings,
  conn,
  onChanged,
}: {
  ctx: AddonContext;
  settings: T212Settings;
  conn: T212Connection;
  onChanged: () => void;
}) {
  const { data: status } = useQuery({
    queryKey: ["t212_status", conn.id],
    queryFn: async () => {
      try {
        await new Trading212ProxyClient(connectionConfig(settings, conn)).getAccountSummary();
        return "ok" as const;
      } catch (err) {
        return (err as Error).message === "UNAUTHORIZED" ? ("auth" as const) : ("err" as const);
      }
    },
  });

  const badge =
    status === "ok" ? (
      <Badge variant="outline" className="text-green-600 border-green-600">
        Connected
      </Badge>
    ) : status === "auth" ? (
      <Badge variant="outline" className="text-destructive border-destructive">
        Auth failed
      </Badge>
    ) : status === "err" ? (
      <Badge variant="outline" className="text-amber-600 border-amber-600">
        Unreachable
      </Badge>
    ) : (
      <Badge variant="outline">Checking…</Badge>
    );

  async function remove() {
    await removeConnection(ctx, conn.id);
    onChanged();
  }

  async function reset() {
    await resetSyncState(ctx, conn.id);
    onChanged();
  }

  return (
    <div className="flex items-center justify-between border rounded-md p-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{conn.name}</span>
          {badge}
        </div>
        <p className="text-xs text-muted-foreground">
          {settings.env === "live" ? "Live" : "Demo"} · key {maskKey(conn.apiKey)}
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={reset}>
          Reset sync
        </Button>
        <Button variant="outline" size="sm" onClick={remove}>
          Remove
        </Button>
      </div>
    </div>
  );
}

export default function SettingsPage({ ctx }: { ctx: AddonContext }) {
  const queryClient = useQueryClient();
  const [migrated, setMigrated] = useState(false);

  const [proxyUrl, setProxyUrl] = useState("");
  const [env, setEnv] = useState<T212Env>("live");
  const [settingsSaved, setSettingsSaved] = useState<string | null>(null);

  const [accountType, setAccountType] = useState<"invest" | "isa">("invest");
  const [name, setName] = useState("Trading 212 (Invest)");
  const [nameTouched, setNameTouched] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    migrateLegacyConfig(ctx).finally(() => setMigrated(true));
  }, [ctx]);

  const { data: settings } = useQuery({
    queryKey: ["t212_settings", migrated],
    queryFn: () => getSettings(ctx),
    enabled: migrated,
  });

  const { data: connections } = useQuery({
    queryKey: ["t212_connections", migrated],
    queryFn: () => getConnections(ctx),
    enabled: migrated,
  });

  useEffect(() => {
    if (settings) {
      setProxyUrl(settings.proxyUrl);
      setEnv(settings.env);
    }
  }, [settings]);

  function pickType(t: "invest" | "isa") {
    setAccountType(t);
    if (!nameTouched) setName(t === "invest" ? "Trading 212 (Invest)" : "Trading 212 (ISA)");
  }

  async function saveSettings() {
    const s: T212Settings = { proxyUrl: proxyUrl.trim(), env };
    if (!s.proxyUrl) {
      setError("Enter the proxy URL.");
      return;
    }
    await setSettings(ctx, s);
    queryClient.invalidateQueries({ queryKey: ["t212_settings"] });
    queryClient.invalidateQueries({ queryKey: ["t212_status"] });
    setSettingsSaved("Saved.");
    setError(null);
  }

  async function connectAndCreate() {
    setIsConnecting(true);
    setError(null);
    setStatus(null);
    try {
      const s: T212Settings = { proxyUrl: proxyUrl.trim(), env };
      if (!s.proxyUrl) throw new Error("Enter and save the proxy URL first.");
      if (!apiKey.trim()) throw new Error("Enter your Trading 212 API key.");
      if (!name.trim()) throw new Error("Enter an account name.");

      const existing = await getConnections(ctx);
      if (existing.some((c) => c.apiKey === apiKey.trim()))
        throw new Error("This API key is already added.");

      await setSettings(ctx, s);

      const cfg = connectionConfig(s, {
        id: "",
        name: "",
        accountId: "",
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim() || undefined,
      });
      const summary = await new Trading212ProxyClient(cfg).getAccountSummary();
      const accountId = await ensureAccount(ctx, name.trim(), summary);

      await addConnection(ctx, {
        id: randomId(),
        name: name.trim(),
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim() || undefined,
        accountId,
      });

      queryClient.invalidateQueries({ queryKey: ["t212_connections"] });
      queryClient.invalidateQueries({ queryKey: ["t212_settings"] });
      setStatus(`Added "${name.trim()}" (${summary.currency}).`);
      setApiKey("");
      setApiSecret("");
      setNameTouched(false);
      setName(accountType === "invest" ? "Trading 212 (Invest)" : "Trading 212 (ISA)");
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

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["t212_connections"] });
  }

  return (
    <div className="space-y-6 p-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold">Trading 212 Settings</h1>
        <p className="text-muted-foreground mt-1">
          Connect one or more Trading 212 accounts (Invest / ISA) via the public API.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>How to get an API key</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-1">
          <p>
            1. In the Trading 212 app or web, open <strong>Settings → API</strong> (separately
            for each account — Invest and Stocks ISA have their own keys).
          </p>
          <p>
            2. Generate a key with these <strong>read</strong> scopes:{" "}
            <code>metadata</code>, <code>account</code>, <code>portfolio</code>,{" "}
            <code>history:orders</code>, <code>history:dividends</code>,{" "}
            <code>history:transactions</code>.
          </p>
          <p>
            3. Copy the <strong>API Key (ID)</strong> and <strong>API Secret</strong>. A Live key
            only works in Live; a Demo key only in Demo.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connection settings</CardTitle>
          <CardDescription>
            Shared by all accounts. The proxy forwards requests to Trading 212 (required —
            Trading 212 blocks direct browser calls). Keys are stored encrypted in Wealthfolio's
            keyring and sent only to Trading 212.
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
          <div className="flex items-center gap-3">
            <Button onClick={saveSettings} size="sm">
              Save settings
            </Button>
            {settingsSaved && <p className="text-sm text-green-600">{settingsSaved}</p>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connected accounts</CardTitle>
          <CardDescription>
            Each API key maps to one Wealthfolio account. Rename or delete accounts in
            Wealthfolio's own Accounts page — removing one here only forgets the key.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {connections && connections.length > 0 ? (
            connections.map((conn) => (
              <ConnectionRow
                key={conn.id}
                ctx={ctx}
                settings={settings ?? { proxyUrl, env }}
                conn={conn}
                onChanged={refresh}
              />
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No accounts added yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add account</CardTitle>
          <CardDescription>
            Pick the account type (sets the name), then paste that account's API key.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium">Account type</label>
            <div className="flex gap-2">
              {(["invest", "isa"] as const).map((t) => (
                <Button
                  key={t}
                  variant={accountType === t ? "default" : "outline"}
                  size="sm"
                  onClick={() => pickType(t)}
                >
                  {t === "invest" ? "Invest" : "Stocks ISA"}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Account name</label>
            <Input
              value={name}
              onChange={(e) => {
                setNameTouched(true);
                setName(e.target.value);
              }}
              placeholder="Trading 212 (Invest)"
            />
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
            <Button onClick={connectAndCreate} disabled={isConnecting}>
              {isConnecting ? "Connecting…" : "Add account"}
            </Button>
          </div>
          {status && <p className="text-sm text-green-600">{status}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
