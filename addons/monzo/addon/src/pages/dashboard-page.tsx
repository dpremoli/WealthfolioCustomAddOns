import { useQuery } from "@tanstack/react-query";
import type { AddonContext } from "@wealthfolio/addon-sdk";
import { Button, Card, CardContent, EmptyPlaceholder, Icons } from "@wealthfolio/ui";
import { useSync } from "../hooks/use-sync";
import { getTokens } from "../hooks/use-tokens";
import { PageShell } from "../components/page-shell";
import { SyncActivity } from "../components/sync-activity";
import { StatusCard } from "../components/status-card";

const LAST_SYNC_KEY = "monzo_last_sync";

export default function DashboardPage({ ctx }: { ctx: AddonContext }) {
  const { isSyncing, lastResult, error, progress, steps, sync } = useSync(ctx);

  const { data: tokens } = useQuery({
    queryKey: ["monzo_tokens"],
    queryFn: () => getTokens(ctx),
  });

  const { data: lastSyncIso } = useQuery({
    queryKey: ["monzo_last_sync", isSyncing],
    queryFn: async () => {
      const raw = await ctx.api.secrets.get(LAST_SYNC_KEY);
      return raw ? (JSON.parse(raw) as string) : null;
    },
  });

  const openSettings = () => ctx.api.navigation.navigate("/addons/monzo/settings");
  const openImport = () => ctx.api.navigation.navigate("/addons/monzo/import");

  const connected = !!tokens;
  const canSync = connected && !isSyncing;

  return (
    <PageShell
      iconName="Wallet"
      heading="Monzo"
      description="Sync your Monzo transactions into Wealthfolio."
      actions={
        <>
          <Button variant="outline" size="lg" onClick={openImport}>
            <Icons.Import size={16} className="mr-1" weight="duotone" />
            Import CSV
          </Button>
          <Button variant="outline" size="lg" onClick={openSettings}>
            <Icons.Settings size={16} className="mr-1" weight="duotone" />
            Settings
          </Button>
          <Button onClick={sync} disabled={!canSync} size="lg">
            <Icons.Refresh size={16} className={`mr-1 ${isSyncing ? "animate-spin" : ""}`} weight="bold" />
            {isSyncing ? "Syncing…" : "Sync Now"}
          </Button>
        </>
      }
    >
      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6 space-y-2 text-sm text-destructive">
            <div className="flex items-start gap-2">
              <Icons.AlertTriangle size={18} className="shrink-0" weight="duotone" />
              <span>{error}</span>
            </div>
            {error.includes("mapping") && (
              <button className="text-xs underline text-muted-foreground" onClick={openSettings}>
                Go to Settings →
              </button>
            )}
          </CardContent>
        </Card>
      )}

      <SyncActivity isSyncing={isSyncing} progress={progress} steps={steps} />

      {!connected ? (
        <Card>
          <CardContent className="py-10">
            <EmptyPlaceholder
              icon={
                <div className="rounded-full bg-muted p-4">
                  <Icons.Wallet size={28} weight="duotone" />
                </div>
              }
              title="Connect your Monzo account"
              description="Link Monzo in Settings to sync your transactions into Wealthfolio. Accounts are created automatically. You can also import a Monzo CSV export."
            >
              <div className="mt-4 flex gap-2">
                <Button onClick={openSettings}>
                  <Icons.Link size={16} className="mr-1" weight="bold" />
                  Open Settings
                </Button>
                <Button variant="outline" onClick={openImport}>
                  <Icons.Import size={16} className="mr-1" weight="bold" />
                  Import CSV
                </Button>
              </div>
            </EmptyPlaceholder>
          </CardContent>
        </Card>
      ) : (
        <StatusCard connected={connected} lastSyncIso={lastSyncIso ?? null} result={lastResult} isSyncing={isSyncing} />
      )}
    </PageShell>
  );
}
