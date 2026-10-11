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
} from "@wealthfolio/ui";
import { addonRoute, jsonStore, maskKey, relativeTime, type AddonPageProps } from "@wf-addons/kit";
import { PageShell } from "@wf-addons/kit/ui";
import { useEffect, useRef, useState } from "react";
import {
  ADDON_ID,
  KEY_CATEGORY_LABELS,
  KEY_LAST_RUN,
  KEY_LAST_SYNC,
  KEY_MAPPING,
  SUGGESTED_REDIRECT_URL,
} from "../constants";
import {
  accountTypeIssueText,
  accountTypeIssues,
  accountTypeLabel,
  ensureAccountMapping,
} from "../lib/accounts";
import {
  MonzoAuthError,
  beginAuthorisation,
  completeAuthorisation,
  disconnect,
  getConnectionStatus,
  loadCredentials,
  pendingState,
  saveSettings,
} from "../lib/auth";
import { copyText } from "../lib/clipboard";
import { DEFAULT_CATEGORY_LABELS, MONZO_CATEGORIES } from "../lib/category-map";
import { ensureMigrated } from "../lib/migrate";
import { MonzoClient } from "../lib/monzo-client";
import { useSync } from "../hooks/use-sync";
import { buildAuthUrl } from "../lib/oauth";
import { resetSyncHistory } from "../lib/sync";
import type { AccountMapping, MonzoAccount } from "../types";

interface SettingsData {
  clientId: string;
  redirectUrl: string;
  /** Masked stored client secret, or null when none is saved. */
  maskedSecret: string | null;
  status: Awaited<ReturnType<typeof getConnectionStatus>>;
  /** Login URL rebuilt for an authorisation that was started earlier, if any. */
  pendingUrl: string | null;
}

export default function SettingsPage({ ctx }: AddonPageProps) {
  const queryClient = useQueryClient();
  const store = jsonStore(ctx.api.storage);

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUrl, setRedirectUrl] = useState("");
  const [formLoaded, setFormLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  const [autoCreateStatus, setAutoCreateStatus] = useState<string | null>(null);
  const [resetStatus, setResetStatus] = useState<string | null>(null);
  const [categoryOverrides, setCategoryOverrides] = useState<Record<string, string>>({});
  const [isSavingCategories, setIsSavingCategories] = useState(false);
  const [categoriesSaved, setCategoriesSaved] = useState(false);
  const autoCreatingRef = useRef(false);
  const handledRef = useRef<Set<string>>(new Set());
  // Set when a connection completes on this page: once Monzo approval lands and accounts are
  // mapped, the first sync runs straight away to catch Monzo's 5-minute full-history window.
  const [firstSyncDue, setFirstSyncDue] = useState(false);
  const firstSync = useSync(ctx);

  const { data } = useQuery<SettingsData>({
    queryKey: ["monzo_settings"],
    queryFn: async () => {
      await ensureMigrated(ctx);
      const [creds, status, state] = await Promise.all([
        loadCredentials(ctx),
        getConnectionStatus(ctx),
        pendingState(ctx),
      ]);
      const pendingUrl =
        state && creds.clientId && creds.redirectUrl
          ? buildAuthUrl({ clientId: creds.clientId, redirectUrl: creds.redirectUrl, state })
          : null;
      return {
        clientId: creds.clientId,
        redirectUrl: creds.redirectUrl,
        maskedSecret: creds.clientSecret ? maskKey(creds.clientSecret) : null,
        status,
        pendingUrl,
      };
    },
  });

  // Fill the form once from what is stored; later edits stay in local state.
  useEffect(() => {
    if (!data || formLoaded) return;
    setClientId(data.clientId);
    setRedirectUrl(data.redirectUrl || SUGGESTED_REDIRECT_URL);
    if (data.pendingUrl) setAuthUrl(data.pendingUrl);
    setFormLoaded(true);
  }, [data, formLoaded]);

  const connected = !!data?.status.connected;
  const hasCredentials = !!data?.status.hasCredentials;

  const { data: monzoAccounts = [], error: accountsError } = useQuery<MonzoAccount[], Error>({
    queryKey: ["monzo_accounts", connected],
    queryFn: () => new MonzoClient(ctx).getAccounts(),
    enabled: connected,
    retry: false,
    // Monzo answers 403 until the access request is approved in the app, which usually
    // arrives a little after the login: keep checking so the page picks it up by itself.
    refetchInterval: (query) => (isAwaitingApproval(query.state.error) ? 5_000 : false),
  });
  const awaitingApproval = isAwaitingApproval(accountsError);

  const { data: wfAccounts = [] } = useQuery({
    queryKey: ["wf_accounts"],
    queryFn: () => ctx.api.accounts.getAll(),
  });

  const { data: savedMapping } = useQuery({
    queryKey: ["monzo_mapping"],
    queryFn: async () => {
      await ensureMigrated(ctx);
      return store.get<AccountMapping>(KEY_MAPPING, {});
    },
  });

  const { data: savedCategoryLabels } = useQuery({
    queryKey: ["monzo_category_labels"],
    queryFn: async () => {
      await ensureMigrated(ctx);
      return store.get<Record<string, string>>(KEY_CATEGORY_LABELS, {});
    },
  });

  const { data: lastRunIso } = useQuery({
    queryKey: ["monzo_last_run"],
    queryFn: async () =>
      (await store.get<string | null>(KEY_LAST_RUN, null)) ??
      (await store.get<string | null>(KEY_LAST_SYNC, null)),
  });

  useEffect(() => {
    if (savedCategoryLabels) setCategoryOverrides(savedCategoryLabels);
  }, [savedCategoryLabels]);

  // Create / map Wealthfolio accounts for Monzo accounts that have none (or a stale one).
  useEffect(() => {
    if (autoCreatingRef.current) return;
    if (!monzoAccounts.length || savedMapping === undefined) return;
    autoCreatingRef.current = true;
    (async () => {
      try {
        const { mapping, created } = await ensureAccountMapping(
          ctx,
          monzoAccounts,
          wfAccounts,
          savedMapping,
          handledRef.current,
        );
        if (created.length > 0 || JSON.stringify(mapping) !== JSON.stringify(savedMapping)) {
          await store.set(KEY_MAPPING, mapping);
          queryClient.invalidateQueries({ queryKey: ["monzo_mapping"] });
          queryClient.invalidateQueries({ queryKey: ["wf_accounts"] });
          if (created.length > 0) setAutoCreateStatus(`Created: ${created.join(", ")}`);
        }
      } finally {
        autoCreatingRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monzoAccounts, wfAccounts, savedMapping]);

  // Run a sync as soon as approval has landed and the accounts are mapped.
  useEffect(() => {
    if (!firstSyncDue || firstSync.isSyncing || awaitingApproval) return;
    if (!monzoAccounts.length || !savedMapping || Object.keys(savedMapping).length === 0) return;
    setFirstSyncDue(false);
    // Every (re)connection gets one sync; runSync decides how far back it goes.
    (async () => {
      await firstSync.sync();
      queryClient.invalidateQueries({ queryKey: ["monzo_last_run"] });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstSyncDue, awaitingApproval, monzoAccounts, savedMapping, firstSync.isSyncing]);

  const refreshStatus = () => queryClient.invalidateQueries({ queryKey: ["monzo_settings"] });

  async function saveCredentials() {
    setIsSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      await saveSettings(ctx, { clientId, clientSecret, redirectUrl });
      setClientSecret("");
      setSaved(true);
      setAuthUrl(null); // saving invalidates any link generated with the old settings
      setPasted("");
      await refreshStatus();
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setIsSaving(false);
    }
  }

  async function startConnect() {
    setIsStarting(true);
    setConnectError(null);
    setCopyNote(null);
    try {
      const { url } = await beginAuthorisation(ctx);
      setAuthUrl(url);
      setPasted("");
    } catch (err) {
      setConnectError((err as Error).message);
    } finally {
      setIsStarting(false);
    }
  }

  async function copyUrl() {
    if (!authUrl) return;
    const result = await copyText(authUrl, urlRef.current);
    setCopyNote(result === "copied" ? "Copied to the clipboard." : "Link selected: press Ctrl/Cmd+C to copy it.");
  }

  async function finishConnect() {
    setIsCompleting(true);
    setConnectError(null);
    try {
      await completeAuthorisation(ctx, pasted);
      setFirstSyncDue(true);
      setAuthUrl(null);
      setPasted("");
      setCopyNote(null);
      handledRef.current.clear();
      await refreshStatus();
      // Drop accounts cached from an earlier connection: until the new one is approved they
      // must not count as "approved", or the first sync would start too early.
      queryClient.resetQueries({ queryKey: ["monzo_accounts"] });
    } catch (err) {
      setConnectError((err as Error).message);
    } finally {
      setIsCompleting(false);
    }
  }

  async function handleDisconnect() {
    await disconnect(ctx);
    handledRef.current.clear();
    setAuthUrl(null);
    await refreshStatus();
    queryClient.invalidateQueries({ queryKey: ["monzo_accounts"] });
  }

  async function saveCategoryLabels() {
    setIsSavingCategories(true);
    setCategoriesSaved(false);
    try {
      await store.set(KEY_CATEGORY_LABELS, categoryOverrides);
      queryClient.invalidateQueries({ queryKey: ["monzo_category_labels"] });
      setCategoriesSaved(true);
    } finally {
      setIsSavingCategories(false);
    }
  }

  function handleCategoryChange(cat: string, value: string) {
    setCategoriesSaved(false);
    setCategoryOverrides((prev) => {
      const next = { ...prev };
      const trimmed = value.trim();
      if (!trimmed || trimmed === DEFAULT_CATEGORY_LABELS[cat]) delete next[cat];
      else next[cat] = trimmed;
      return next;
    });
  }

  async function onResetSyncHistory() {
    await resetSyncHistory(ctx);
    queryClient.invalidateQueries({ queryKey: ["monzo_last_run"] });
    setResetStatus(
      "Sync history cleared. The next sync re-fetches the last 90 days (the whole history if you reconnected within the last few minutes); transactions already imported are skipped.",
    );
  }

  const canSave = !!clientId.trim() && !!redirectUrl.trim() && (!!clientSecret.trim() || !!data?.maskedSecret);
  const isFirstRun = !!data && !data.clientId && !connected;
  const needsCredentialsForRefresh = connected && !hasCredentials;
  const expiryText = data?.status.expiresAt
    ? data.status.expiresAt > Date.now()
      ? `Access token valid until ${new Date(data.status.expiresAt).toLocaleString()}`
      : "Access token expired; it renews on the next sync"
    : null;

  return (
    <PageShell
      iconName="Settings"
      heading="Monzo Settings"
      description="Connect Monzo straight from Wealthfolio. No proxy server needed."
      actions={
        <Button
          variant="outline"
          size="lg"
          onClick={() => ctx.api.navigation.navigate(addonRoute(ADDON_ID))}
        >
          <Icons.ArrowLeft size={16} className="mr-1" weight="bold" />
          Dashboard
        </Button>
      }
    >
      {isFirstRun && (
        <AlertFeedback variant="success" title="Welcome">
          <div className="space-y-2 text-sm">
            <p>Three steps to start syncing Monzo:</p>
            <ol className="ml-4 list-decimal space-y-1">
              <li>
                Create a <strong>Confidential</strong> OAuth client at developers.monzo.com and
                save its client ID, secret and redirect URL below.
              </li>
              <li>
                Click <strong>Connect Monzo</strong>, open the link in your browser, approve via
                the Monzo email, then paste the URL you land on.
              </li>
              <li>
                Approve the access request in the <strong>Monzo app</strong>. Accounts are created
                automatically. Then run your first sync straight away: Monzo only shares your full
                history for 5 minutes after you connect, and just the last 90 days after that.
              </li>
            </ol>
          </div>
        </AlertFeedback>
      )}

      {needsCredentialsForRefresh && (
        <AlertFeedback variant="warning" title="Enter your client ID and secret">
          <p className="text-sm">
            Your Monzo connection was carried over from v1, which kept the client credentials in
            the proxy. Enter the same client ID and client secret below so Wealthfolio can renew
            it (Monzo access tokens last 6 hours). If renewal is rejected, just reconnect.
          </p>
        </AlertFeedback>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icons.Lock size={18} weight="duotone" />
            Monzo OAuth client
          </CardTitle>
          <CardDescription>
            Create a client at developers.monzo.com (Clients → New OAuth client) with
            confidentiality set to <strong>Confidential</strong>, then copy its details here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="monzo-client-id">Client ID</Label>
            <Input
              id="monzo-client-id"
              value={clientId}
              onChange={(e) => {
                setClientId(e.target.value);
                setSaved(false);
              }}
              placeholder="oauth2client_0000…"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="monzo-client-secret">Client secret</Label>
            <Input
              id="monzo-client-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => {
                setClientSecret(e.target.value);
                setSaved(false);
              }}
              placeholder={data?.maskedSecret ? `${data.maskedSecret} (saved, leave blank to keep)` : "mnzconf.…"}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-xs">
              Stored in the OS keyring; it is only sent to api.monzo.com.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="monzo-redirect">Redirect URL</Label>
            <Input
              id="monzo-redirect"
              value={redirectUrl}
              onChange={(e) => {
                setRedirectUrl(e.target.value);
                setSaved(false);
              }}
              placeholder={SUGGESTED_REDIRECT_URL}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-xs">
              Must match the redirect URL registered on your Monzo client exactly (even a trailing
              slash). Use <code>{SUGGESTED_REDIRECT_URL}</code>: the page never needs to load, you
              only copy the address your browser ends up on.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={saveCredentials} disabled={isSaving || !canSave}>
              <Icons.Save size={16} className="mr-1" weight="bold" />
              {isSaving ? "Saving…" : "Save"}
            </Button>
            {saved && (
              <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-500">
                <Icons.CheckCircle size={14} weight="duotone" /> Saved.
              </span>
            )}
          </div>
          {saveError && (
            <AlertFeedback variant="error" title="Could not save">
              {saveError}
            </AlertFeedback>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icons.Wallet size={18} weight="duotone" />
            Monzo connection
          </CardTitle>
          <CardDescription>
            Link your Monzo account. Wealthfolio cash accounts are created automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {connected && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="success" className="gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                    Connected
                  </Badge>
                  {monzoAccounts.length > 0 && (
                    <span className="text-muted-foreground text-sm">
                      {monzoAccounts.map(accountTypeLabel).join(" · ")}
                    </span>
                  )}
                </div>
                <ActionConfirm
                  confirmTitle="Disconnect Monzo?"
                  confirmMessage="This forgets your Monzo access and refresh tokens. Your OAuth client settings, Wealthfolio accounts and already-imported transactions stay intact. You can reconnect any time."
                  confirmButtonText="Disconnect"
                  confirmButtonVariant="destructive"
                  isPending={false}
                  handleConfirm={handleDisconnect}
                  button={
                    <Button variant="outline" size="sm">
                      <Icons.Unlink size={14} className="mr-1" weight="bold" />
                      Disconnect
                    </Button>
                  }
                />
              </div>
              {expiryText && <p className="text-muted-foreground text-xs">{expiryText}</p>}
              {lastRunIso && (
                <p className="text-muted-foreground text-xs">Last sync: {relativeTime(lastRunIso)}</p>
              )}
              {awaitingApproval ? (
                <AlertFeedback variant="warning" title="Waiting for approval in the Monzo app">
                  <p className="text-sm">
                    Open the Monzo app and approve the access request (it can take a minute to
                    appear). This page checks every few seconds and carries on by itself
                    {firstSyncDue ? ", then imports your full history" : ""}.
                  </p>
                </AlertFeedback>
              ) : (
                accountsError && (
                  <AlertFeedback variant="error" title="Could not load your Monzo accounts">
                    {accountsError.message}
                  </AlertFeedback>
                )
              )}
              {firstSync.isSyncing && (
                <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
                  <Icons.Spinner size={14} className="animate-spin" />
                  {firstSync.progress?.message ?? "Importing your Monzo history…"}
                </p>
              )}
              {firstSync.lastResult && (
                <AlertFeedback variant="success" title="First sync complete">
                  Imported {firstSync.lastResult.imported} transaction
                  {firstSync.lastResult.imported === 1 ? "" : "s"}. See the dashboard for details.
                </AlertFeedback>
              )}
              {firstSync.error && (
                <AlertFeedback variant="error" title="First sync failed">
                  {firstSync.error} Run Sync Now from the dashboard to try again.
                </AlertFeedback>
              )}
              {savedMapping &&
                accountTypeIssues(monzoAccounts, wfAccounts, savedMapping).map((issue) => (
                  <AlertFeedback key={issue.name} variant="warning" title="Account not counted in Spending">
                    <p className="text-sm">{accountTypeIssueText(issue)}</p>
                  </AlertFeedback>
                ))}
              {autoCreateStatus && (
                <AlertFeedback variant="success" title="Accounts created">
                  {autoCreateStatus}
                </AlertFeedback>
              )}
            </>
          )}

          {(!connected || awaitingApproval || authUrl) && (
            <AlertFeedback variant="warning" title="Approve access in the Monzo app">
              <p className="text-sm">
                After logging in, Monzo asks you to approve this client in the <strong>Monzo app</strong>{" "}
                (strong customer authentication). Until you do, API calls return 403 and nothing
                syncs. Approve it there, then come back and sync <strong>within 5 minutes</strong> to
                import your full history; after that Monzo only shares the last 90 days. This page
                does that first sync for you as soon as the approval comes through.
              </p>
            </AlertFeedback>
          )}

          {!authUrl ? (
            <div className="space-y-2">
              <Button onClick={startConnect} disabled={isStarting || !hasCredentials}>
                <Icons.Link size={14} className="mr-1" weight="bold" />
                {isStarting ? "Preparing…" : connected ? "Reconnect Monzo" : "Connect Monzo"}
              </Button>
              {!hasCredentials && (
                <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
                  <Icons.Info size={14} weight="duotone" />
                  Save your client ID, client secret and redirect URL above first.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <ol className="ml-4 list-decimal space-y-1 text-sm">
                <li>Copy the link below and open it in any browser.</li>
                <li>Enter your email, then approve the login from the email Monzo sends you.</li>
                <li>
                  Your browser lands on the redirect URL (the page itself will likely fail to load,
                  that is fine). Copy the <strong>full address</strong> from the address bar, or just
                  the <code>code</code> value, and paste it below.
                </li>
              </ol>
              <div className="space-y-1.5">
                <Label htmlFor="monzo-auth-url">Monzo login link</Label>
                <div className="flex gap-2">
                  <Input
                    id="monzo-auth-url"
                    ref={urlRef}
                    readOnly
                    value={authUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 font-mono text-xs"
                  />
                  <Button variant="outline" onClick={copyUrl}>
                    <Icons.Copy size={14} className="mr-1" weight="bold" />
                    Copy
                  </Button>
                </div>
                {copyNote && <p className="text-muted-foreground text-xs">{copyNote}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="monzo-pasted">Paste the redirect URL (or code)</Label>
                <Input
                  id="monzo-pasted"
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  placeholder={`${SUGGESTED_REDIRECT_URL}?code=…&state=…`}
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-muted-foreground text-xs">
                  The code is single-use and expires quickly: paste it straight away.
                </p>
              </div>
              <div className="flex gap-2">
                <Button onClick={finishConnect} disabled={isCompleting || !pasted.trim()}>
                  {isCompleting ? (
                    <>
                      <Icons.Spinner size={14} className="mr-1 animate-spin" />
                      Connecting…
                    </>
                  ) : (
                    "Complete connection"
                  )}
                </Button>
                <Button variant="outline" onClick={startConnect} disabled={isStarting}>
                  New link
                </Button>
              </div>
            </div>
          )}
          {connectError && (
            <AlertFeedback variant="error" title="Connection failed">
              {connectError}
            </AlertFeedback>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icons.Tag size={18} weight="duotone" />
            Category labels
          </CardTitle>
          <CardDescription>
            Customise how Monzo spending categories appear in transaction comments and the
            dashboard breakdown. Leave blank to use the default label.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {MONZO_CATEGORIES.map((cat) => (
              <div key={cat} className="flex items-center gap-2">
                <span className="text-muted-foreground w-28 shrink-0 truncate text-xs" title={cat}>
                  {cat}
                </span>
                <Input
                  className="h-7 text-sm"
                  value={categoryOverrides[cat] ?? ""}
                  onChange={(e) => handleCategoryChange(cat, e.target.value)}
                  placeholder={DEFAULT_CATEGORY_LABELS[cat] ?? cat}
                />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={saveCategoryLabels} disabled={isSavingCategories}>
              <Icons.Save size={14} className="mr-1" weight="bold" />
              {isSavingCategories ? "Saving…" : "Save labels"}
            </Button>
            {categoriesSaved && (
              <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-500">
                <Icons.CheckCircle size={14} weight="duotone" /> Saved.
              </span>
            )}
          </div>
          <p className="text-muted-foreground text-xs">
            Labels are part of each transaction&apos;s comment, which is how re-syncs recognise rows
            already imported. Changing them only affects transactions imported from now on.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icons.Settings2 size={18} weight="duotone" />
            Advanced
          </CardTitle>
          <CardDescription>Sync management and troubleshooting.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Reset sync history</p>
              <p className="text-muted-foreground text-xs">
                Forces the next sync to re-fetch the last 90 days (the whole history if you reconnected within the last few minutes).
              </p>
            </div>
            <ActionConfirm
              confirmTitle="Reset sync history?"
              confirmMessage="The next sync will re-fetch the last 90 days (the whole history if you reconnected within the last few minutes). Transactions already in Wealthfolio are recognised and skipped, so this is safe; it just takes a little longer."
              confirmButtonText="Reset"
              isPending={false}
              handleConfirm={onResetSyncHistory}
              button={
                <Button variant="outline" size="sm">
                  <Icons.RefreshCw size={14} className="mr-1" weight="bold" />
                  Reset
                </Button>
              }
            />
          </div>
          {resetStatus && (
            <AlertFeedback variant="success" title="Done">
              {resetStatus}
            </AlertFeedback>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}

/** 403 from Monzo: the access request has not been approved in the Monzo app (yet). */
function isAwaitingApproval(err: unknown): boolean {
  return err instanceof MonzoAuthError && err.kind === "approval";
}
