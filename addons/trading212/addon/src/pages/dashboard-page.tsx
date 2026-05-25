import { useQuery } from "@tanstack/react-query";
import type { AddonContext } from "@wealthfolio/addon-sdk";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui";
import { useEffect, useState } from "react";
import { useSync } from "../hooks/use-sync";
import { getConnections, getSyncState, migrateLegacyConfig } from "../hooks/use-config";
import type { SyncResult } from "../types";

export default function DashboardPage({ ctx }: { ctx: AddonContext }) {
  const { isSyncing, results, error, syncAll } = useSync(ctx);
  const [migrated, setMigrated] = useState(false);

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

  return (
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
          <Button onClick={syncAll} disabled={!canSync} size="lg">
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
        <p className="text-sm text-muted-foreground animate-pulse">
          Syncing activity… (Trading 212 is rate-limited, this can take a moment)
        </p>
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
  );
}
