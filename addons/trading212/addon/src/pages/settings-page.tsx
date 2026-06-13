import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AddonContext } from "@wealthfolio/addon-sdk";
import {
  ActionConfirm,
  AlertFeedback,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Icons,
  Input,
  Label,
  Separator,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui";
import { useEffect, useState } from "react";
import { Trading212ProxyClient } from "../lib/proxy-client";
import type { T212Connection, T212Env, T212Settings, T212TrackingMode } from "../types";
import {
  addConnection,
  connectionConfig,
  ensureProviderAccount,
  getConnections,
  getSettings,
  getSyncState,
  migrateLegacyConfig,
  randomId,
  removeConnection,
  resetSyncState,
  setSettings,
} from "../hooks/use-config";
import { PageShell } from "../components/page-shell";
import { ConnectionHealth } from "../components/connection-status";
import { maskKey, relativeTime } from "../lib/format";

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
  const queryClient = useQueryClient();
  const [resetFeedback, setResetFeedback] = useState<string | null>(null);
  const { data: syncState } = useQuery({
    queryKey: ["t212_sync_state_row", conn.id],
    queryFn: () => getSyncState(ctx, conn.id),
  });
  const last = syncState?.lastSync ?? null;
  const mode = conn.trackingMode ?? "TRANSACTIONS";

  async function remove() {
    await removeConnection(ctx, conn.id);
    onChanged();
  }

  async function reset() {
    await resetSyncState(ctx, conn.id);
    // Without explicit invalidation the "Last sync" badge keeps showing the old time
    // because every component reads its own copy of the sync state.
    await queryClient.invalidateQueries({ queryKey: ["t212_sync_state_row", conn.id] });
    await queryClient.invalidateQueries({ queryKey: ["t212_sync_state", conn.id] });
    setResetFeedback("Sync history cleared. The next sync will start from scratch.");
    setTimeout(() => setResetFeedback(null), 5000);
    onChanged();
  }

  const kind = conn.kind ?? "invest";
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium truncate">{conn.name}</span>
            <ConnectionHealth ctx={ctx} settings={settings} conn={conn} />
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <Badge variant="outline" className="gap-1">
              <Icons.Globe size={10} weight="duotone" />
              {settings.env === "live" ? "Live" : "Demo"}
            </Badge>
            <Badge variant={kind === "isa" ? "info" : "secondary"} className="gap-1">
              <Icons.Wallet size={10} weight="duotone" />
              {kind === "isa" ? "Stocks ISA" : "Invest"}
            </Badge>
            <Badge variant={mode === "HOLDINGS" ? "info" : "secondary"} className="gap-1">
              <Icons.Activity size={10} weight="duotone" />
              {mode === "HOLDINGS" ? "Holdings" : "Transactions"}
            </Badge>
            {conn.cardAccountId && (
              <Badge variant="outline" className="gap-1">
                <Icons.CreditCard size={10} weight="duotone" />
                Card
              </Badge>
            )}
            <span className="font-mono">{maskKey(conn.apiKey)}</span>
            <span className="flex items-center gap-1">
              <Icons.Clock size={10} weight="duotone" />
              {last ? <RelativeWithTooltip iso={last} /> : "Never synced"}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <ActionConfirm
            confirmTitle="Reset sync history?"
            confirmMessage={
              <span>
                Forgets the last-sync watermarks and the de-dup ref cache for this account.
                The next sync re-imports from scratch (Wealthfolio's own duplicate check still
                runs, so nothing is double-counted). No accounts or activities are deleted.
              </span>
            }
            confirmButtonText="Reset"
            confirmButtonVariant="destructive"
            isPending={false}
            handleConfirm={reset}
            button={
              <Button variant="outline" size="sm">
                <Icons.RefreshCw size={14} className="mr-1" weight="bold" />
                Reset
              </Button>
            }
          />
          <ActionConfirm
            confirmTitle="Remove this connection?"
            confirmMessage={
              <span>
                This forgets the API key and resets sync state. The Wealthfolio account itself
                stays intact — delete it in Wealthfolio's Accounts page if you want it gone.
              </span>
            }
            confirmButtonText="Remove"
            confirmButtonVariant="destructive"
            isPending={false}
            handleConfirm={remove}
            button={
              <Button variant="outline" size="sm">
                <Icons.Trash size={14} className="mr-1" weight="bold" />
                Remove
              </Button>
            }
          />
        </div>
      </div>
      {resetFeedback && (
        <AlertFeedback variant="success" title="Reset">
          {resetFeedback}
        </AlertFeedback>
      )}
    </div>
  );
}

function RelativeWithTooltip({ iso }: { iso: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default">{relativeTime(iso)}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{new Date(iso).toLocaleString()}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default function SettingsPage({ ctx }: { ctx: AddonContext }) {
  const queryClient = useQueryClient();
  const [migrated, setMigrated] = useState(false);

  const [proxyUrl, setProxyUrl] = useState("");
  const [env, setEnv] = useState<T212Env>("live");
  const [autoSync, setAutoSync] = useState(true);
  const [extractCard, setExtractCard] = useState(false);
  const [cardAccountType, setCardAccountType] = useState<"CASH" | "CREDIT_CARD">("CASH");
  const [settingsSaved, setSettingsSaved] = useState<string | null>(null);

  const [accountType, setAccountType] = useState<"invest" | "isa">("invest");
  const [trackingMode, setTrackingMode] = useState<T212TrackingMode>("HOLDINGS");
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
      setAutoSync(settings.autoSync !== false);
      setExtractCard(settings.extractCard === true);
      setCardAccountType(settings.cardAccountType === "CREDIT_CARD" ? "CREDIT_CARD" : "CASH");
    }
  }, [settings]);

  function pickType(t: "invest" | "isa") {
    setAccountType(t);
    if (!nameTouched) setName(t === "invest" ? "Trading 212 (Invest)" : "Trading 212 (ISA)");
  }

  async function saveSettings() {
    const s: T212Settings = { proxyUrl: proxyUrl.trim(), env, autoSync, extractCard, cardAccountType };
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
      const s: T212Settings = { proxyUrl: proxyUrl.trim(), env, autoSync, extractCard, cardAccountType };
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
      const accountId = await ensureProviderAccount(ctx, name.trim(), summary, trackingMode);

      await addConnection(ctx, {
        id: randomId(),
        name: name.trim(),
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim() || undefined,
        accountId,
        trackingMode,
        kind: accountType,
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

  function openDashboard() {
    ctx.api.navigation.navigate("/addons/trading212");
  }

  const hasConnections = (connections?.length ?? 0) > 0;
  const isFirstRun = migrated && !settings && !hasConnections;

  return (
    <PageShell
      iconName="Settings"
      heading="Trading 212 Settings"
      description="Connect one or more Trading 212 accounts (Invest / ISA) via the public API."
      actions={
        <Button variant="outline" size="lg" onClick={openDashboard}>
          <Icons.ArrowLeft size={16} className="mr-1" weight="bold" />
          Dashboard
        </Button>
      }
    >
      {/* Onboarding banner for true first-time users */}
      {isFirstRun && (
        <AlertFeedback variant="success" title="Welcome 👋">
          <div className="space-y-2 text-sm">
            <p>To connect Trading 212 you'll need three things:</p>
            <ol className="ml-4 list-decimal space-y-1">
              <li>A running proxy server (Trading 212 blocks direct browser calls).</li>
              <li>A Trading 212 API key (with the read scopes listed below).</li>
              <li>Pick a sync mode — <strong>Holdings</strong> for an instant positions snapshot, or <strong>Transactions</strong> for full history.</li>
            </ol>
            <p className="text-muted-foreground">
              Configure the proxy below, then add your account at the bottom.
            </p>
          </div>
        </AlertFeedback>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icons.HelpCircle size={18} weight="duotone" />
            How to get an API key
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <Step n={1}>
            In the Trading 212 app or web, open <strong>Settings → API</strong>{" "}
            (separately for each account — Invest and Stocks ISA have their own keys).
          </Step>
          <Step n={2}>
            Generate a key with these <strong>read</strong> scopes:{" "}
            <code className="text-foreground">metadata</code>,{" "}
            <code className="text-foreground">account</code>,{" "}
            <code className="text-foreground">portfolio</code>,{" "}
            <code className="text-foreground">history:orders</code>,{" "}
            <code className="text-foreground">history:dividends</code>,{" "}
            <code className="text-foreground">history:transactions</code>.
          </Step>
          <Step n={3}>
            Copy the <strong>API Key (ID)</strong> and <strong>API Secret</strong>. A Live
            key only works in Live; a Demo key only in Demo.
          </Step>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icons.Globe size={18} weight="duotone" />
            Connection
          </CardTitle>
          <CardDescription>
            Shared by all accounts. The proxy forwards requests to Trading 212 — required, since
            Trading 212 blocks direct browser calls. Keys are stored encrypted in Wealthfolio's
            keyring and sent only to Trading 212.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              <Icons.Link size={13} weight="duotone" />
              Proxy URL
            </Label>
            <Input
              value={proxyUrl}
              onChange={(e) => setProxyUrl(e.target.value)}
              placeholder="http://YOUR_SERVER_IP:8000"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Environment</Label>
            <ToggleGroup
              type="single"
              value={env}
              onValueChange={(v) => v && setEnv(v as T212Env)}
              variant="outline"
              className="w-fit"
            >
              <ToggleGroupItem value="live">Live</ToggleGroupItem>
              <ToggleGroupItem value="demo">Demo / Practice</ToggleGroupItem>
            </ToggleGroup>
          </div>

          <Separator />

          <SwitchRow
            icon="CloudSync"
            title="Automatic sync"
            description="Refresh already-synced accounts about once a day (and when Wealthfolio refreshes its portfolio) while the app is open. The first sync of a new account is always manual."
            checked={autoSync}
            onChange={setAutoSync}
          />
          <SwitchRow
            icon="CreditCard"
            title="Extract card transactions"
            description="Route Trading 212 card spending into a dedicated “<name> Card” cash account, with the merchant category mapped to a Wealthfolio spending label — so the Spending module can categorise it. Skipped for Stocks ISA accounts (no card). Works in both Holdings and Transactions modes."
            checked={extractCard}
            onChange={setExtractCard}
          />
          {extractCard && (
            <div className="ml-10 space-y-1.5">
              <Label>Card account type</Label>
              <ToggleGroup
                type="single"
                value={cardAccountType}
                onValueChange={(v) => v && setCardAccountType(v as "CASH" | "CREDIT_CARD")}
                variant="outline"
                className="w-fit"
              >
                <ToggleGroupItem value="CASH">Cash</ToggleGroupItem>
                <ToggleGroupItem value="CREDIT_CARD">Credit Card</ToggleGroupItem>
              </ToggleGroup>
              <p className="text-xs text-muted-foreground">
                {cardAccountType === "CREDIT_CARD"
                  ? "Credit Card: treats the card account as a liability, so Wealthfolio can link payments from a tracked cash account as transfers (avoids counting the spend twice)."
                  : "Cash: accurate for a debit card that spends directly from your balance."}{" "}
                Applied when the card account is first created — change an existing one in
                Wealthfolio's Update Account dialog.
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button onClick={saveSettings}>
              <Icons.Save size={16} className="mr-1" weight="bold" />
              Save settings
            </Button>
            {settingsSaved && (
              <span className="text-green-600 dark:text-green-500 flex items-center gap-1 text-sm">
                <Icons.CheckCircle size={14} weight="duotone" /> {settingsSaved}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icons.Users size={18} weight="duotone" />
            Connected accounts
          </CardTitle>
          <CardDescription>
            Each API key maps to one Wealthfolio account. Rename or delete accounts in
            Wealthfolio's own Accounts page — removing one here only forgets the key.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {hasConnections ? (
            connections!.map((conn) => (
              <ConnectionRow
                key={conn.id}
                ctx={ctx}
                settings={settings ?? { proxyUrl, env }}
                conn={conn}
                onChanged={refresh}
              />
            ))
          ) : (
            <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
              <Icons.Info size={14} weight="duotone" />
              No accounts added yet. Add one below.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icons.PlusCircle size={18} weight="duotone" />
            Add account
          </CardTitle>
          <CardDescription>
            Pick the account type (sets the name), then paste that account's API key.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-1.5">
            <Label>Account type</Label>
            <ToggleGroup
              type="single"
              value={accountType}
              onValueChange={(v) => v && pickType(v as "invest" | "isa")}
              variant="outline"
              className="w-fit"
            >
              <ToggleGroupItem value="invest">Invest</ToggleGroupItem>
              <ToggleGroupItem value="isa">Stocks ISA</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="space-y-1.5">
            <Label>Sync mode</Label>
            <ToggleGroup
              type="single"
              value={trackingMode}
              onValueChange={(v) => v && setTrackingMode(v as T212TrackingMode)}
              variant="outline"
              className="w-fit"
            >
              <ToggleGroupItem value="HOLDINGS">Holdings</ToggleGroupItem>
              <ToggleGroupItem value="TRANSACTIONS">Transactions</ToggleGroupItem>
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">
              {trackingMode === "HOLDINGS"
                ? "Holdings: sync your current positions and cash as a snapshot — instant, no history."
                : "Transactions: import full trade/dividend/cash history. The first sync can take a few minutes."}{" "}
              The mode is fixed at creation; to change it, switch the account's tracking mode in Wealthfolio and re-sync.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Account name</Label>
            <Input
              value={name}
              onChange={(e) => {
                setNameTouched(true);
                setName(e.target.value);
              }}
              placeholder="Trading 212 (Invest)"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>API Key</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="API Key (ID)"
              />
            </div>
            <div className="space-y-1.5">
              <Label>API Secret</Label>
              <Input
                type="password"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder="Optional (legacy single-key access)"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button onClick={connectAndCreate} disabled={isConnecting}>
              {isConnecting ? (
                <>
                  <Icons.Spinner size={14} className="mr-1 animate-spin" />
                  Connecting…
                </>
              ) : (
                <>
                  <Icons.Plus size={14} className="mr-1" weight="bold" />
                  Add account
                </>
              )}
            </Button>
          </div>
          {status && <AlertFeedback variant="success" title="Added">{status}</AlertFeedback>}
          {error && <AlertFeedback variant="error" title="Couldn't add the account">{error}</AlertFeedback>}
        </CardContent>
      </Card>
    </PageShell>
  );
}

function SwitchRow({
  icon,
  title,
  description,
  checked,
  onChange,
}: {
  icon: keyof typeof Icons;
  title: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const Icon = Icons[icon];
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        <div className="text-muted-foreground mt-0.5 rounded-md bg-muted p-1.5">
          <Icon size={15} weight="duotone" />
        </div>
        <div>
          <div className="text-sm font-medium">{title}</div>
          <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5 shrink-0" />
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="bg-muted text-foreground flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium tabular-nums">
        {n}
      </span>
      <span>{children}</span>
    </div>
  );
}
