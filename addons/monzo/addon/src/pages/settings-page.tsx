import {
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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
import { useEffect, useRef, useState } from "react";
import { clearTokens, getTokens, setTokens } from "../hooks/use-tokens";
import { MonzoProxyClient } from "../lib/proxy-client";
import type { AccountMapping, MonzoAccount } from "../types";

const PROXY_URL_KEY = "monzo_proxy_url";
const MAPPING_KEY = "monzo_account_mapping";
const LAST_SYNC_KEY = "monzo_last_sync";

function monzoAccountName(acc: MonzoAccount): string {
  if (acc.account_number) return `Monzo (${acc.account_number})`;
  return `Monzo ${acc.description}`;
}

export default function SettingsPage({ ctx }: { ctx: AddonContext }) {
  const queryClient = useQueryClient();
  const [proxyUrl, setProxyUrl] = useState("");
  const [isSavingProxy, setIsSavingProxy] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [autoCreateStatus, setAutoCreateStatus] = useState<string | null>(null);
  const [resetStatus, setResetStatus] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Prevents the auto-create effect from running concurrently
  const autoCreatingRef = useRef(false);

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

  const { data: monzoAccountsData } = useQuery({
    queryKey: ["monzo_accounts"],
    queryFn: async () => {
      const t = await getTokens(ctx);
      if (!t) return null;
      const url = await ctx.api.secrets.get(PROXY_URL_KEY);
      if (!url) return null;
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

  // Auto-create Wealthfolio accounts for unmapped/stale Monzo accounts
  useEffect(() => {
    // Guard: don't run concurrently (prevents duplicate creation on rapid re-renders)
    if (autoCreatingRef.current) return;
    if (!monzoAccountsData?.accounts?.length || !wfAccounts || savedMapping === undefined) return;

    const wfAccountIds = new Set(wfAccounts.map((a) => a.id));
    // Track names already in Wealthfolio to avoid duplicates within a single run
    const wfAccountNames = new Set(wfAccounts.map((a) => a.name));

    const unmapped = monzoAccountsData.accounts.filter((acc) => {
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
          const name = monzoAccountName(acc);
          const currency = acc.currency || "GBP";

          // Reuse existing account if name already matches
          const existing = wfAccounts.find((a) => a.name === name);
          if (existing) {
            newMapping[acc.id] = existing.id;
            continue;
          }

          // Skip if this name was already created in this run
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
          // Only invalidate mapping — NOT wf_accounts (that would re-trigger this effect)
          queryClient.invalidateQueries({ queryKey: ["monzo_mapping"] });
          if (created.length > 0) {
            setAutoCreateStatus(`Created: ${created.join(", ")}`);
          }
        }
      } finally {
        autoCreatingRef.current = false;
      }
    })();
  }, [monzoAccountsData, wfAccounts, savedMapping]);

  async function saveProxyUrl() {
    setIsSavingProxy(true);
    try {
      await ctx.api.secrets.set(PROXY_URL_KEY, proxyUrl.trim());
      queryClient.invalidateQueries({ queryKey: ["monzo_proxy_url"] });
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

  return (
    <div className="space-y-6 p-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold">Monzo Sync Settings</h1>
        <p className="text-muted-foreground mt-1">Configure your Monzo Bank connection.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Proxy Server</CardTitle>
          <CardDescription>
            The local FastAPI proxy that handles Monzo OAuth and API requests.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={proxyUrl}
              onChange={(e) => setProxyUrl(e.target.value)}
              placeholder="http://YOUR_SERVER_IP:8001"
              className="flex-1"
            />
            <Button onClick={saveProxyUrl} disabled={isSavingProxy || !proxyUrl.trim()}>
              {isSavingProxy ? "Saving…" : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Monzo Connection</CardTitle>
          <CardDescription>
            Connect your Monzo account. Accounts will be created automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {tokens ? (
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-green-600 border-green-600">
                    Connected
                  </Badge>
                  <span className="text-sm text-muted-foreground">Monzo account linked</span>
                </div>
                <Button variant="outline" size="sm" onClick={disconnect}>
                  Disconnect
                </Button>
              </div>
              {autoCreateStatus && (
                <p className="text-sm text-green-600">{autoCreateStatus}</p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Button onClick={connectMonzo} disabled={isConnecting || !savedProxyUrl}>
                {isConnecting ? "Waiting for authentication…" : "Connect Monzo"}
              </Button>
              {!savedProxyUrl && (
                <p className="text-sm text-muted-foreground">Save a proxy URL above first.</p>
              )}
              {connectError && (
                <p className="text-sm text-destructive">{connectError}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Advanced</CardTitle>
          <CardDescription>Sync management and troubleshooting.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Reset Sync History</p>
              <p className="text-xs text-muted-foreground">
                Forces the next sync to re-import all 90 days of transactions.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={resetSyncHistory}>
              Reset
            </Button>
          </div>
          {resetStatus && (
            <p className="text-sm text-green-600">{resetStatus}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
