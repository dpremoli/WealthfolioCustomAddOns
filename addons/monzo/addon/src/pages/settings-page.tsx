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
} from "@wealthfolio/ui";
import { useEffect, useRef, useState } from "react";
import { clearTokens, getTokens, setTokens } from "../hooks/use-tokens";
import { MONZO_CATEGORIES, DEFAULT_CATEGORY_LABELS } from "../lib/category-map";
import { MonzoProxyClient } from "../lib/proxy-client";
import type { AccountMapping, MonzoAccount } from "../types";
import { PageShell } from "../components/page-shell";

const PROXY_URL_KEY = "monzo_proxy_url";
const MAPPING_KEY = "monzo_account_mapping";
const LAST_SYNC_KEY = "monzo_last_sync";
const CATEGORY_LABELS_KEY = "monzo_category_labels";

function accountTypeLabel(acc: MonzoAccount): string {
  switch (acc.account_type) {
    case "uk_retail":       return acc.account_number ? `Monzo Current (${acc.account_number})` : "Monzo Current Account";
    case "uk_retail_joint": return "Monzo Joint Account";
    case "uk_monzo_flex":   return "Monzo Flex";
    default:                return acc.description || acc.account_type;
  }
}

export default function SettingsPage({ ctx }: { ctx: AddonContext }) {
  const queryClient = useQueryClient();
  const [proxyUrl, setProxyUrl] = useState("");
  const [isSavingProxy, setIsSavingProxy] = useState(false);
  const [proxySaved, setProxySaved] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [autoCreateStatus, setAutoCreateStatus] = useState<string | null>(null);
  const [resetStatus, setResetStatus] = useState<string | null>(null);
  const [categoryOverrides, setCategoryOverrides] = useState<Record<string, string>>({});
  const [isSavingCategories, setIsSavingCategories] = useState(false);
  const [categoriesSaved, setCategoriesSaved] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoCreatingRef = useRef(false);
  const handledRef = useRef<Set<string>>(new Set());

  const { data: savedProxyUrl } = useQuery({
    queryKey: ["monzo_proxy_url"],
    queryFn: () => ctx.api.secrets.get(PROXY_URL_KEY),
  });

  useEffect(() => {
    if (savedProxyUrl) setProxyUrl(savedProxyUrl);
  }, [savedProxyUrl]);

  const { data: tokens, refetch: refetchTokens } = useQuery({
    queryKey: ["monzo_tokens"],
    queryFn: () => getTokens(ctx),
  });

  const { data: monzoAccounts = [] } = useQuery<MonzoAccount[]>({
    queryKey: ["monzo_accounts"],
    queryFn: async () => {
      const t = await getTokens(ctx);
      if (!t) return [];
      const url = await ctx.api.secrets.get(PROXY_URL_KEY);
      if (!url) return [];
      return new MonzoProxyClient(url).getAccounts(t.access_token);
    },
    enabled: !!tokens,
  });

  const { data: wfAccounts = [] } = useQuery({
    queryKey: ["wf_accounts"],
    queryFn: () => ctx.api.accounts.getAll(),
  });

  const { data: savedMapping } = useQuery({
    queryKey: ["monzo_mapping"],
    queryFn: async () => {
      const raw = await ctx.api.secrets.get(MAPPING_KEY);
      return raw ? (JSON.parse(raw) as AccountMapping) : ({} as AccountMapping);
    },
  });

  const { data: savedCategoryLabels } = useQuery({
    queryKey: ["monzo_category_labels"],
    queryFn: async () => {
      const raw = await ctx.api.secrets.get(CATEGORY_LABELS_KEY);
      return raw ? (JSON.parse(raw) as Record<string, string>) : ({} as Record<string, string>);
    },
  });

  useEffect(() => {
    if (savedCategoryLabels) setCategoryOverrides(savedCategoryLabels);
  }, [savedCategoryLabels]);

  // Auto-create Wealthfolio accounts for unmapped/stale Monzo accounts
  useEffect(() => {
    if (autoCreatingRef.current) return;
    if (!monzoAccounts.length || !wfAccounts || savedMapping === undefined) return;

    const wfAccountIds = new Set(wfAccounts.map((a) => a.id));
    const wfAccountNames = new Set(wfAccounts.map((a) => a.name));

    const unmapped = monzoAccounts.filter((acc) => {
      if (handledRef.current.has(acc.id)) return false;
      const mappedId = savedMapping[acc.id];
      return !mappedId || !wfAccountIds.has(mappedId);
    });

    if (unmapped.length === 0) return;

    autoCreatingRef.current = true;

    (async () => {
      try {
        const newMapping: AccountMapping = { ...savedMapping };
        const created: string[] = [];

        for (const acc of unmapped) {
          handledRef.current.add(acc.id);
          const name = accountTypeLabel(acc);
          const currency = acc.currency || "GBP";

          const existing = wfAccounts.find((a) => a.name === name);
          if (existing) {
            newMapping[acc.id] = existing.id;
            continue;
          }

          if (wfAccountNames.has(name)) continue;

          try {
            const newAcc = await ctx.api.accounts.create({
              name,
              accountType: "CASH",
              currency,
              isDefault: false,
              isActive: true,
              trackingMode: "TRANSACTIONS",
            });
            newMapping[acc.id] = newAcc.id;
            wfAccountNames.add(name);
            created.push(name);
          } catch (err) {
            ctx.api.logger.error(`Failed to create account ${name}: ${(err as Error).message}`);
          }
        }

        if (created.length > 0 || JSON.stringify(newMapping) !== JSON.stringify(savedMapping)) {
          await ctx.api.secrets.set(MAPPING_KEY, JSON.stringify(newMapping));
          queryClient.invalidateQueries({ queryKey: ["monzo_mapping"] });
          queryClient.invalidateQueries({ queryKey: ["wf_accounts"] });
          if (created.length > 0) setAutoCreateStatus(`Created: ${created.join(", ")}`);
        }
      } finally {
        autoCreatingRef.current = false;
      }
    })();
  }, [monzoAccounts, wfAccounts, savedMapping]);

  async function saveCategoryLabels() {
    setIsSavingCategories(true);
    setCategoriesSaved(false);
    try {
      await ctx.api.secrets.set(CATEGORY_LABELS_KEY, JSON.stringify(categoryOverrides));
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
      if (!trimmed || trimmed === DEFAULT_CATEGORY_LABELS[cat]) {
        delete next[cat];
      } else {
        next[cat] = trimmed;
      }
      return next;
    });
  }

  async function saveProxyUrl() {
    setIsSavingProxy(true);
    setProxySaved(false);
    try {
      await ctx.api.secrets.set(PROXY_URL_KEY, proxyUrl.trim());
      queryClient.invalidateQueries({ queryKey: ["monzo_proxy_url"] });
      setProxySaved(true);
    } finally {
      setIsSavingProxy(false);
    }
  }

  async function connectMonzo() {
    setIsConnecting(true);
    setConnectError(null);
    try {
      const client = new MonzoProxyClient(proxyUrl);
      const { url, state } = await client.getAuthUrl();
      window.open(url, "_blank", "width=600,height=700");

      let attempts = 0;
      const maxAttempts = 150;
      pollRef.current = setInterval(async () => {
        attempts++;
        try {
          const result = await client.pollTokenStatus(state);
          if (result.ready && result.tokens) {
            clearInterval(pollRef.current!);
            pollRef.current = null;
            await setTokens(ctx, result.tokens);
            refetchTokens();
            queryClient.invalidateQueries({ queryKey: ["monzo_accounts"] });
            setIsConnecting(false);
          } else if (attempts >= maxAttempts) {
            clearInterval(pollRef.current!);
            pollRef.current = null;
            setIsConnecting(false);
            setConnectError("Authentication timed out. Please try again.");
          }
        } catch {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setIsConnecting(false);
          setConnectError("Failed to complete authentication. Please try again.");
        }
      }, 2000);
    } catch (err) {
      setIsConnecting(false);
      setConnectError((err as Error).message);
    }
  }

  async function disconnect() {
    await clearTokens(ctx);
    handledRef.current.clear();
    refetchTokens();
    queryClient.invalidateQueries({ queryKey: ["monzo_accounts"] });
  }

  async function resetSyncHistory() {
    await ctx.api.secrets.delete(LAST_SYNC_KEY);
    queryClient.invalidateQueries({ queryKey: ["monzo_last_sync"] });
    setResetStatus("Sync history cleared. Next sync will re-import all 90 days of transactions.");
  }

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const isFirstRun = !savedProxyUrl && !tokens;

  return (
    <PageShell
      iconName="Settings"
      heading="Monzo Settings"
      description="Configure your Monzo Bank connection."
      actions={
        <Button variant="outline" size="lg" onClick={() => ctx.api.navigation.navigate("/addons/monzo")}>
          <Icons.ArrowLeft size={16} className="mr-1" weight="bold" />
          Dashboard
        </Button>
      }
    >
      {isFirstRun && (
        <AlertFeedback variant="success" title="Welcome 👋">
          <div className="space-y-2 text-sm">
            <p>Two steps to start syncing Monzo:</p>
            <ol className="ml-4 list-decimal space-y-1">
              <li>Run the proxy server and paste its URL below (it handles Monzo OAuth).</li>
              <li>Click <strong>Connect Monzo</strong> and authorise in the browser, then approve in the Monzo app. Accounts are created automatically.</li>
            </ol>
          </div>
        </AlertFeedback>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icons.Link size={18} weight="duotone" />
            Proxy server
          </CardTitle>
          <CardDescription>
            The local FastAPI proxy that handles Monzo OAuth and API requests.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>Proxy URL</Label>
            <div className="flex gap-2">
              <Input
                value={proxyUrl}
                onChange={(e) => {
                  setProxyUrl(e.target.value);
                  setProxySaved(false);
                }}
                placeholder="http://YOUR_SERVER_IP:8001"
                className="flex-1"
              />
              <Button onClick={saveProxyUrl} disabled={isSavingProxy || !proxyUrl.trim()}>
                <Icons.Save size={16} className="mr-1" weight="bold" />
                {isSavingProxy ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
          {proxySaved && (
            <span className="text-green-600 dark:text-green-500 flex items-center gap-1 text-sm">
              <Icons.CheckCircle size={14} weight="duotone" /> Saved.
            </span>
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
            Connect your Monzo account. Wealthfolio accounts are created automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {tokens ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="success" className="gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                    Connected
                  </Badge>
                  {monzoAccounts.length > 0 && (
                    <span className="text-sm text-muted-foreground">
                      {monzoAccounts.map(accountTypeLabel).join(" · ")}
                    </span>
                  )}
                </div>
                <ActionConfirm
                  confirmTitle="Disconnect Monzo?"
                  confirmMessage="This forgets your Monzo access tokens. Your Wealthfolio accounts and already-imported transactions stay intact. You can reconnect any time."
                  confirmButtonText="Disconnect"
                  confirmButtonVariant="destructive"
                  isPending={false}
                  handleConfirm={disconnect}
                  button={
                    <Button variant="outline" size="sm">
                      <Icons.Unlink size={14} className="mr-1" weight="bold" />
                      Disconnect
                    </Button>
                  }
                />
              </div>
              {autoCreateStatus && (
                <AlertFeedback variant="success" title="Accounts created">{autoCreateStatus}</AlertFeedback>
              )}
            </>
          ) : (
            <div className="space-y-2">
              <Button onClick={connectMonzo} disabled={isConnecting || !savedProxyUrl}>
                {isConnecting ? (
                  <>
                    <Icons.Spinner size={14} className="mr-1 animate-spin" />
                    Waiting for authentication…
                  </>
                ) : (
                  <>
                    <Icons.Link size={14} className="mr-1" weight="bold" />
                    Connect Monzo
                  </>
                )}
              </Button>
              {!savedProxyUrl && (
                <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
                  <Icons.Info size={14} weight="duotone" />
                  Save a proxy URL above first.
                </p>
              )}
              {connectError && <AlertFeedback variant="error" title="Connection failed">{connectError}</AlertFeedback>}
            </div>
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
                <span className="text-xs text-muted-foreground w-28 shrink-0 truncate" title={cat}>
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
              <span className="text-green-600 dark:text-green-500 flex items-center gap-1 text-sm">
                <Icons.CheckCircle size={14} weight="duotone" /> Saved.
              </span>
            )}
          </div>
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
              <p className="text-xs text-muted-foreground">
                Forces the next sync to re-import all 90 days of transactions.
              </p>
            </div>
            <ActionConfirm
              confirmTitle="Reset sync history?"
              confirmMessage="The next sync will re-fetch and re-check the last 90 days. Duplicates are skipped automatically, so this is safe — it just takes a little longer."
              confirmButtonText="Reset"
              isPending={false}
              handleConfirm={resetSyncHistory}
              button={
                <Button variant="outline" size="sm">
                  <Icons.RefreshCw size={14} className="mr-1" weight="bold" />
                  Reset
                </Button>
              }
            />
          </div>
          {resetStatus && <AlertFeedback variant="success" title="Done">{resetStatus}</AlertFeedback>}
        </CardContent>
      </Card>
    </PageShell>
  );
}
