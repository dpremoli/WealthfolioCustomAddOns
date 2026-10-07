import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import type { AddonContext } from "@wealthfolio/addon-sdk";
import { addonRoute, relativeTime, type AddonPageProps } from "@wf-addons/kit";
import { PageShell } from "@wf-addons/kit/ui";
import { ADDON_ID } from "../constants";
import { isUnauthorized } from "../lib/t212-client";
import type { T212Connection, T212Env, T212Settings, T212TrackingMode } from "../types";
import {
  addConnection,
  ensureMigrated,
  ensureProviderAccount,
  getConnections,
  getSettings,
  getSyncState,
  keyIdLast4,
  randomId,
  removeConnection,
  resetSyncState,
  saveCredentials,
  setSettings,
  verifyCredentials,
} from "../hooks/use-config";
import { ConnectionHealth } from "../components/connection-status";
import { maskedKeyId } from "../lib/format";

/** Human message for a failed credential check / API call. */
function describeError(err: unknown): string {
  if (isUnauthorized(err))
    return "Trading 212 rejected the API key ID / secret. Check both values and the environment (Live keys only work on Live, Demo keys on Demo).";
  return (err as Error).message;
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
  const queryClient = useQueryClient();
  const [resetFeedback, setResetFeedback] = useState<string | null>(null);
  const [editingCreds, setEditingCreds] = useState(!!conn.needsCredentials);
  const [newKeyId, setNewKeyId] = useState("");
  const [newSecret, setNewSecret] = useState("");
  const [credsBusy, setCredsBusy] = useState(false);
  const [credsError, setCredsError] = useState<string | null>(null);
  const [credsSaved, setCredsSaved] = useState<string | null>(null);
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

  async function updateCredentials() {
    setCredsBusy(true);
    setCredsError(null);
    setCredsSaved(null);
    try {
      const summary = await verifyCredentials(ctx, settings.env, conn.id, newKeyId, newSecret);
      // Guard against pasting another Trading 212 account's key into this connection.
      const accounts = await ctx.api.accounts.getAll();
      const linked = accounts.find((a) => a.id === conn.accountId) as
        | { providerAccountId?: string }
        | undefined;
      if (linked?.providerAccountId && linked.providerAccountId !== String(summary.id)) {
        throw new Error("These credentials belong to a different Trading 212 account than this connection.");
      }
      await saveCredentials(ctx, conn.id, newKeyId, newSecret);
      setNewKeyId("");
      setNewSecret("");
      setEditingCreds(false);
      setCredsSaved("Credentials updated.");
      setTimeout(() => setCredsSaved(null), 5000);
      await queryClient.invalidateQueries({ queryKey: ["t212_status"] });
      onChanged();
    } catch (err) {
      setCredsError(describeError(err));
    } finally {
      setCredsBusy(false);
    }
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
            <span className="font-mono">{maskedKeyId(conn.keyIdLast4)}</span>
            <span className="flex items-center gap-1">
              <Icons.Clock size={10} weight="duotone" />
              {last ? <RelativeWithTooltip iso={last} /> : "Never synced"}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditingCreds((v) => !v)}>
            <Icons.Lock size={14} className="mr-1" weight="bold" />
            {conn.needsCredentials ? "Add credentials" : "Update key"}
          </Button>
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
                This forgets the stored API credentials and resets sync state. The Wealthfolio account itself
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
      {conn.needsCredentials && (
        <AlertFeedback variant="warning" title="Needs credentials">
          This connection used a legacy single API key, which can no longer be used. Re-enter the
          API key ID and secret below; syncing is skipped until you do.
        </AlertFeedback>
      )}
      {editingCreds && (
        <div className="space-y-3 rounded-md border bg-muted/20 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>API key ID</Label>
              <Input
                type="password"
                autoComplete="off"
                value={newKeyId}
                onChange={(e) => setNewKeyId(e.target.value)}
                placeholder="API key ID"
              />
            </div>
            <div className="space-y-1.5">
              <Label>API secret</Label>
              <Input
                type="password"
                autoComplete="off"
                value={newSecret}
                onChange={(e) => setNewSecret(e.target.value)}
                placeholder="API secret"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={updateCredentials} disabled={credsBusy || !newKeyId.trim() || !newSecret.trim()}>
              {credsBusy ? (
                <>
                  <Icons.Spinner size={14} className="mr-1 animate-spin" />
                  Verifying…
                </>
              ) : (
                "Verify & save"
              )}
            </Button>
            {!conn.needsCredentials && (
              <Button variant="ghost" size="sm" onClick={() => setEditingCreds(false)} disabled={credsBusy}>
                Cancel
              </Button>
            )}
            <span className="text-muted-foreground text-xs">
              Checked against Trading 212 ({settings.env === "live" ? "Live" : "Demo"}) before replacing the stored key.
            </span>
          </div>
          {credsError && (
            <AlertFeedback variant="error" title="Couldn't update the credentials">
              {credsError}
            </AlertFeedback>
          )}
        </div>
      )}
      {credsSaved && (
        <AlertFeedback variant="success" title="Updated">
          {credsSaved}
        </AlertFeedback>
      )}
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

export default function SettingsPage({ ctx }: AddonPageProps) {
  const queryClient = useQueryClient();
  const [migrated, setMigrated] = useState(false);

  const [env, setEnv] = useState<T212Env>("live");
  const [autoSync, setAutoSync] = useState(true);
  const [extractCard, setExtractCard] = useState(false);
  const [cardAccountType, setCardAccountType] = useState<"CASH" | "CREDIT_CARD">("CASH");
  const [settingsSaved, setSettingsSaved] = useState<string | null>(null);

  const [accountType, setAccountType] = useState<"invest" | "isa">("invest");
  const [trackingMode, setTrackingMode] = useState<T212TrackingMode>("HOLDINGS");
  const [name, setName] = useState("Trading 212 (Invest)");
  const [nameTouched, setNameTouched] = useState(false);
  const [keyId, setKeyId] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    // The v1 → v2 storage migration runs on enable; wait for it before reading storage.
    ensureMigrated(ctx)
      .catch(() => undefined)
      .finally(() => setMigrated(true));
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
    const s: T212Settings = { env, autoSync, extractCard, cardAccountType };
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
      const s: T212Settings = { env, autoSync, extractCard, cardAccountType };
      if (!keyId.trim() || !apiSecret.trim())
        throw new Error("Enter both the API key ID and the API secret.");
      if (!name.trim()) throw new Error("Enter an account name.");

      // Validate against Trading 212 using a temporary secret (nothing is kept on failure).
      const id = randomId();
      const summary = await verifyCredentials(ctx, env, id, keyId, apiSecret);
      const accountId = await ensureProviderAccount(ctx, name.trim(), summary, trackingMode);

      const existing = await getConnections(ctx);
      if (existing.some((c) => c.accountId === accountId))
        throw new Error("This Trading 212 account is already connected.");

      await setSettings(ctx, s);
      await saveCredentials(ctx, id, keyId, apiSecret);
      await addConnection(ctx, {
        id,
        name: name.trim(),
        keyIdLast4: keyIdLast4(keyId),
        accountId,
        trackingMode,
        kind: accountType,
      });

      queryClient.invalidateQueries({ queryKey: ["t212_connections"] });
      queryClient.invalidateQueries({ queryKey: ["t212_settings"] });
      setStatus(`Added "${name.trim()}" (${summary.currency}).`);
      setKeyId("");
      setApiSecret("");
      setNameTouched(false);
      setName(accountType === "invest" ? "Trading 212 (Invest)" : "Trading 212 (ISA)");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setIsConnecting(false);
    }
  }

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["t212_connections"] });
  }

  function openDashboard() {
    ctx.api.navigation.navigate(addonRoute(ADDON_ID));
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
            <p>To connect Trading 212 you'll need two things:</p>
            <ol className="ml-4 list-decimal space-y-1">
              <li>A Trading 212 API key ID and secret (with the read scopes listed below).</li>
              <li>Pick a sync mode — <strong>Holdings</strong> for an instant positions snapshot, or <strong>Transactions</strong> for full history.</li>
            </ol>
            <p className="text-muted-foreground">
              Choose Live or Demo below, then add your account at the bottom. Wealthfolio talks to
              Trading 212 directly — there is no proxy to set up.
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
            <code className="text-foreground">history:transactions</code>. Leave the key without
            an IP restriction (or allow this computer's address), or Trading 212 answers 403.
          </Step>
          <Step n={3}>
            Copy the <strong>API key ID</strong> and <strong>API secret</strong> (both are
            required — single-key access is no longer supported). A Live key only works in Live;
            a Demo key only in Demo.
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
            Shared by all accounts. Credentials are stored encrypted in Wealthfolio's keyring and
            used only by the host to call Trading 212 — this add-on never sees them again.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
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
                settings={settings ?? { env }}
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
            Pick the account type (sets the name), then paste that account's API key ID and secret.
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
              <Label>API key ID</Label>
              <Input
                type="password"
                autoComplete="off"
                value={keyId}
                onChange={(e) => setKeyId(e.target.value)}
                placeholder="API key ID"
              />
            </div>
            <div className="space-y-1.5">
              <Label>API secret</Label>
              <Input
                type="password"
                autoComplete="off"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder="API secret"
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
