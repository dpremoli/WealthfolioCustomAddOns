import { useQuery } from "@tanstack/react-query";
import { Button, Card, CardContent, EmptyPlaceholder, Icons } from "@wealthfolio/ui";
import { addonRoute, jsonStore, type AddonPageProps } from "@wf-addons/kit";
import { PageShell, SyncActivity, type SyncPhase } from "@wf-addons/kit/ui";
import { StatusCard } from "../components/status-card";
import { ADDON_ID, KEY_LAST_RUN, KEY_LAST_SYNC } from "../constants";
import { getConnectionStatus } from "../lib/auth";
import { ensureMigrated } from "../lib/migrate";
import { useSync } from "../hooks/use-sync";
import type { SyncPhaseId } from "../types";

const PHASES: SyncPhase<SyncPhaseId>[] = [
  { phase: "fetch", label: "Fetching", icon: "Download" },
  { phase: "import", label: "Importing", icon: "Import" },
  { phase: "done", label: "Done", icon: "CheckCircle" },
];

export default function DashboardPage({ ctx }: AddonPageProps) {
  const { isSyncing, lastResult, error, progress, steps, sync } = useSync(ctx);

  const { data: status } = useQuery({
    queryKey: ["monzo_status", isSyncing],
    queryFn: async () => {
      await ensureMigrated(ctx);
      return getConnectionStatus(ctx);
    },
  });

  const { data: lastSyncIso } = useQuery({
    queryKey: ["monzo_last_run", isSyncing],
    queryFn: async () => {
      const store = jsonStore(ctx.api.storage);
      // KEY_LAST_RUN is when the sync finished; the watermark is the fallback (v1 data).
      return (
        (await store.get<string | null>(KEY_LAST_RUN, null)) ??
        (await store.get<string | null>(KEY_LAST_SYNC, null))
      );
    },
  });

  const openSettings = () => ctx.api.navigation.navigate(addonRoute(ADDON_ID, "settings"));
  const openImport = () => ctx.api.navigation.navigate(addonRoute(ADDON_ID, "import"));

  const connected = !!status?.connected;
  const canSync = connected && !isSyncing;
  const needsSettings = /mapping|settings|reconnect|client|approve|connect/i.test(error ?? "");

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
          <CardContent className="space-y-2 pt-6 text-sm text-destructive">
            <div className="flex items-start gap-2">
              <Icons.AlertTriangle size={18} className="shrink-0" weight="duotone" />
              <span>{error}</span>
            </div>
            {needsSettings && (
              <button className="text-muted-foreground text-xs underline" onClick={openSettings}>
                Go to Settings →
              </button>
            )}
          </CardContent>
        </Card>
      )}

      <SyncActivity phases={PHASES} isSyncing={isSyncing} progress={progress} steps={steps} />

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
              description="Add your Monzo OAuth client in Settings and link your account to sync transactions into Wealthfolio. Cash accounts are created automatically. You can also import a Monzo CSV export."
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
        <StatusCard
          connected={connected}
          lastSyncIso={lastSyncIso ?? null}
          result={lastResult}
          isSyncing={isSyncing}
        />
      )}
    </PageShell>
  );
}
