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
import { useSync } from "../hooks/use-sync";
import { getConfig, getLastSync } from "../hooks/use-config";

export default function DashboardPage({ ctx }: { ctx: AddonContext }) {
  const { isSyncing, lastResult, error, sync } = useSync(ctx);

  const { data: config } = useQuery({
    queryKey: ["t212_config"],
    queryFn: () => getConfig(ctx),
  });

  const { data: lastSyncIso } = useQuery({
    queryKey: ["t212_last_sync"],
    queryFn: () => getLastSync(ctx),
  });

  const lastSyncDisplay = lastSyncIso ? new Date(lastSyncIso).toLocaleString() : "Never";
  const connected = !!config;
  const canSync = connected && !isSyncing;

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
          <Button onClick={sync} disabled={!canSync} size="lg">
            {isSyncing ? "Syncing…" : "Sync Now"}
          </Button>
        </div>
      </div>

      {!connected && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="pt-6">
            <p className="text-sm text-amber-800">
              ⚠️ Not connected.{" "}
              <button className="underline font-medium" onClick={openSettings}>
                Open Settings
              </button>{" "}
              to add your Trading 212 API key.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
          <CardDescription>Last sync: {lastSyncDisplay}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {isSyncing && (
            <p className="text-sm text-muted-foreground animate-pulse">
              Syncing activity… (Trading 212 is rate-limited, this can take a moment)
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {!error && !isSyncing && !lastResult && connected && (
            <p className="text-sm text-muted-foreground">Ready to sync.</p>
          )}
          {lastResult && !isSyncing && (
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{lastResult.imported} imported</Badge>
              <Badge variant="outline">{lastResult.duplicates} duplicates skipped</Badge>
              {lastResult.unresolved > 0 && (
                <Badge variant="outline" className="text-amber-600 border-amber-600">
                  {lastResult.unresolved} unmatched symbols
                </Badge>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
