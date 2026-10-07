import { useQuery } from "@tanstack/react-query";
import type { AddonContext } from "@wealthfolio/addon-sdk";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  CardContent,
  EmptyPlaceholder,
  Icons,
} from "@wealthfolio/ui";
import { useEffect, useState } from "react";
import { useSync } from "../hooks/use-sync";
import { getConnections, getSettings, migrateLegacyConfig } from "../hooks/use-config";
import type { SyncResult, T212TrackingMode } from "../types";
import { PageShell } from "../components/page-shell";
import { SyncActivity } from "../components/sync-activity";
import { ConnectionCard } from "../components/connection-card";

interface ModeDrift {
  id: string;
  name: string;
  from: T212TrackingMode;
  to: T212TrackingMode;
}

const modeLabel = (m: T212TrackingMode) => (m === "HOLDINGS" ? "Holdings" : "Transactions");

export default function DashboardPage({ ctx }: { ctx: AddonContext }) {
  const { isSyncing, results, error, progress, steps, syncAll } = useSync(ctx);
  const [migrated, setMigrated] = useState(false);
  const [pendingDrifts, setPendingDrifts] = useState<ModeDrift[]>([]);

  useEffect(() => {
    migrateLegacyConfig(ctx).finally(() => setMigrated(true));
  }, [ctx]);

  const { data: connections } = useQuery({
    queryKey: ["t212_connections", migrated, isSyncing],
    queryFn: () => getConnections(ctx),
    enabled: migrated,
  });

  const { data: settings } = useQuery({
    queryKey: ["t212_settings", migrated],
    queryFn: () => getSettings(ctx),
    enabled: migrated,
  });

  const connected = (connections?.length ?? 0) > 0;
  const canSync = connected && !isSyncing;
  const resultFor = (id: string): SyncResult | undefined =>
    results?.perAccount.find((r) => r.connectionId === id);

  function openSettings() {
    ctx.api.navigation.navigate("/addons/trading212/settings");
  }

  // Detect accounts whose tracking mode was changed in Wealthfolio after setup. The
  // add-on can't change it back, so re-syncing means clearing the old mode's data —
  // confirm that destructive step before running.
  async function handleSync() {
    const conns = connections ?? [];
    const accounts = await ctx.api.accounts.getAll();
    const drifts: ModeDrift[] = [];
    for (const c of conns) {
      const live = accounts.find((a) => a.id === c.accountId)?.trackingMode;
      const current = (c.trackingMode ?? "TRANSACTIONS") as T212TrackingMode;
      if (live && live !== "NOT_SET" && live !== current) {
        drifts.push({ id: c.id, name: c.name, from: current, to: live });
      }
    }
    if (drifts.length > 0) {
      setPendingDrifts(drifts);
      return;
    }
    syncAll();
  }

  function confirmDrifts() {
    const ids = new Set(pendingDrifts.map((d) => d.id));
    setPendingDrifts([]);
    syncAll(ids);
  }

  function cancelDrifts() {
    setPendingDrifts([]);
    syncAll(new Set());
  }

  return (
    <>
      <AlertDialog open={pendingDrifts.length > 0} onOpenChange={(o) => !o && setPendingDrifts([])}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Tracking mode changed</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  The tracking mode of {pendingDrifts.length > 1 ? "these accounts was" : "this account was"}{" "}
                  changed in Wealthfolio. Re-syncing will <strong>delete</strong> the data synced under
                  the previous mode and rebuild it in the new one:
                </p>
                <ul className="list-disc pl-5">
                  {pendingDrifts.map((d) => (
                    <li key={d.id}>
                      <strong>{d.name}</strong>: {modeLabel(d.from)} → {modeLabel(d.to)}
                    </li>
                  ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelDrifts}>Skip these</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDrifts}>Clear and re-sync</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <PageShell
        iconName="TrendingUp"
        heading="Trading 212"
        description="Sync your Trading 212 activity into Wealthfolio."
        actions={
          <>
            <Button variant="outline" size="lg" onClick={openSettings}>
              <Icons.Settings size={16} className="mr-1" weight="duotone" />
              Settings
            </Button>
            <Button onClick={handleSync} disabled={!canSync} size="lg">
              <Icons.Refresh size={16} className={`mr-1 ${isSyncing ? "animate-spin" : ""}`} weight="bold" />
              {isSyncing ? "Syncing…" : "Sync All"}
            </Button>
          </>
        }
      >
        {error && (
          <Card className="border-destructive">
            <CardContent className="pt-6 flex items-start gap-2 text-sm text-destructive">
              <Icons.AlertTriangle size={18} className="shrink-0" weight="duotone" />
              <span>{error}</span>
            </CardContent>
          </Card>
        )}

        <SyncActivity isSyncing={isSyncing} progress={progress} steps={steps} />

        {!connected && migrated && (
          <Card>
            <CardContent className="py-10">
              <EmptyPlaceholder
                icon={
                  <div className="rounded-full bg-muted p-4">
                    <Icons.TrendingUp size={28} weight="duotone" />
                  </div>
                }
                title="Connect a Trading 212 account"
                description="Add your API key in Settings to sync trades, dividends, deposits, withdrawals, fees and (optionally) card spending."
              >
                <Button className="mt-4" onClick={openSettings}>
                  <Icons.Plus size={16} className="mr-1" weight="bold" />
                  Open Settings
                </Button>
              </EmptyPlaceholder>
            </CardContent>
          </Card>
        )}

        {connections?.map((conn) => (
          <ConnectionCard
            key={conn.id}
            ctx={ctx}
            settings={settings ?? undefined}
            conn={conn}
            result={resultFor(conn.id)}
            isSyncing={isSyncing}
          />
        ))}

        {results && results.perAccount.length > 1 && (
          <div className="text-muted-foreground flex flex-wrap justify-center gap-3 text-sm">
            <Badge variant="success" className="gap-1">
              <Icons.CheckCircle size={11} weight="duotone" />
              {results.totals.imported} imported
            </Badge>
            <Badge variant="secondary" className="gap-1">
              <Icons.Copy size={11} weight="duotone" />
              {results.totals.duplicates} duplicates
            </Badge>
            {results.totals.unresolved > 0 && (
              <Badge variant="warning" className="gap-1">
                <Icons.AlertTriangle size={11} weight="duotone" />
                {results.totals.unresolved} unmatched
              </Badge>
            )}
          </div>
        )}
      </PageShell>
    </>
  );
}
