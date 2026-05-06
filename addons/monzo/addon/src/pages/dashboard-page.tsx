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
import { getTokens } from "../hooks/use-tokens";

const LAST_SYNC_KEY = "monzo_last_sync";

export default function DashboardPage({ ctx }: { ctx: AddonContext }) {
  const { isSyncing, lastResult, error, sync } = useSync(ctx);

  const { data: tokens } = useQuery({
    queryKey: ["monzo_tokens"],
    queryFn: () => getTokens(ctx),
  });

  const { data: lastSyncIso } = useQuery({
    queryKey: ["monzo_last_sync"],
    queryFn: async () => {
      const raw = await ctx.api.secrets.get(LAST_SYNC_KEY);
      return raw ? (JSON.parse(raw) as string) : null;
    },
  });

  const lastSyncDisplay = lastSyncIso ? new Date(lastSyncIso).toLocaleString() : "Never";

  function openSettings() {
    ctx.api.navigation.navigate("/addons/monzo/settings");
  }

  const canSync = !!tokens && !isSyncing;

  return (
    <div className="space-y-6 p-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Monzo Sync</h1>
          <p className="text-muted-foreground mt-1">Sync Monzo transactions into Wealthfolio.</p>
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

      {!tokens && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="pt-6">
            <p className="text-sm text-amber-800">
              ⚠️ Not connected to Monzo.{" "}
              <button className="underline font-medium" onClick={openSettings}>
                Open Settings
              </button>{" "}
              to connect your account.
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
            <p className="text-sm text-muted-foreground animate-pulse">Syncing transactions…</p>
          )}
          {error && (
            <div className="space-y-1">
              <p className="text-sm text-destructive">{error}</p>
              {error.includes("mapping") && (
                <button className="text-xs underline text-muted-foreground" onClick={openSettings}>
                  Go to Settings →
                </button>
              )}
            </div>
          )}
          {!error && !isSyncing && !lastResult && tokens && (
            <p className="text-sm text-muted-foreground">
              Ready to sync. Monzo syncs the last 90 days of transactions.
            </p>
          )}
          {lastResult && !isSyncing && (
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{lastResult.imported} imported</Badge>
              <Badge variant="outline">{lastResult.duplicates} duplicates skipped</Badge>
              {lastResult.skipped > 0 && (
                <Badge variant="outline">{lastResult.skipped} skipped</Badge>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
