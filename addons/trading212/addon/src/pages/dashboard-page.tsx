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
  CardDescription,
  CardHeader,
  CardTitle,
  Progress,
} from "@wealthfolio/ui";
import { useEffect, useState } from "react";
import { useSync } from "../hooks/use-sync";
import { getConnections, getSyncState, migrateLegacyConfig } from "../hooks/use-config";
import type { SyncResult, T212TrackingMode } from "../types";

interface ModeDrift {
  id: string;
  name: string;
  from: T212TrackingMode;
  to: T212TrackingMode;
}

const modeLabel = (m: T212TrackingMode) => (m === "HOLDINGS" ? "Holdings" : "Transactions");

export default function DashboardPage({ ctx }: { ctx: AddonContext }) {
  const { isSyncing, results, error, progress, syncAll } = useSync(ctx);
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

  const { data: syncStates } = useQuery({
    queryKey: ["t212_sync_states", connections?.length, isSyncing],
    queryFn: async () => {
      const out: Record<string, string | null> = {};
      for (const c of connections ?? []) out[c.id] = (await getSyncState(ctx, c.id)).lastSync;
      return out;
    },
    enabled: !!connections,
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
    <div className="space-y-6 p-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Trading 212 Sync</h1>
          <p className="text-muted-foreground mt-1">
            Sync your Trading 212 investment activity into Wealthfolio.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="lg" onClick={openSettings}>
            Settings
          </Button>
          <Button onClick={handleSync} disabled={!canSync} size="lg">
            {isSyncing ? "Syncing…" : "Sync All"}
          </Button>
        </div>
      </div>

      {!connected && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="pt-6">
            <p className="text-sm text-amber-800">
              ⚠️ No accounts connected.{" "}
              <button className="underline font-medium" onClick={openSettings}>
                Open Settings
              </button>{" "}
              to add a Trading 212 API key.
            </p>
          </CardContent>
        </Card>
      )}

      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      {isSyncing && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium">
              {progress?.accountName ? `${progress.accountName}: ` : ""}
              {progress?.message ?? "Starting sync…"}
            </span>
            {progress?.total ? (
              <span className="text-muted-foreground tabular-nums">
                {Math.min(progress.current ?? 0, progress.total)}/{progress.total}
              </span>
            ) : null}
          </div>
          <Progress
            value={
              progress?.total
                ? Math.min(100, Math.round(((progress.current ?? 0) / progress.total) * 100))
                : undefined
            }
            className={progress?.total ? "" : "animate-pulse"}
          />
          <p className="text-xs text-muted-foreground">
            A first full-history sync walks back year by year and can take a few
            minutes — Trading 212 is rate-limited, so this is normal. You can leave
            this open; it'll finish on its own.
          </p>
        </div>
      )}

      {connections?.map((conn) => {
        const last = syncStates?.[conn.id];
        const r = resultFor(conn.id);
        return (
          <Card key={conn.id}>
            <CardHeader>
              <CardTitle>{conn.name}</CardTitle>
              <CardDescription>
                Last sync: {last ? new Date(last).toLocaleString() : "Never"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {r?.error && <p className="text-sm text-destructive">{r.error}</p>}
              {r && !r.error && (
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">{r.imported} imported</Badge>
                  <Badge variant="outline">{r.duplicates} duplicates skipped</Badge>
                  {r.unresolved > 0 && (
                    <Badge variant="outline" className="text-amber-600 border-amber-600">
                      {r.unresolved} unmatched symbols
                    </Badge>
                  )}
                </div>
              )}
              {!r && !isSyncing && (
                <p className="text-sm text-muted-foreground">Ready to sync.</p>
              )}
              {r && r.log && r.log.length > 0 && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer select-none">Details</summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
                    {r.log.join("\n")}
                  </pre>
                </details>
              )}
            </CardContent>
          </Card>
        );
      })}

      {results && results.perAccount.length > 1 && (
        <p className="text-sm text-muted-foreground">
          Totals: {results.totals.imported} imported, {results.totals.duplicates} duplicates,{" "}
          {results.totals.unresolved} unmatched.
        </p>
      )}
    </div>
    </>
  );
}
