import type { AddonContext } from "@wealthfolio/addon-sdk";
import { Badge, Icons, cn } from "@wealthfolio/ui";
import { useQuery } from "@tanstack/react-query";
import { Trading212Client, isForbidden, isUnauthorized } from "../lib/t212-client";
import { connectionConfig } from "../hooks/use-config";
import type { T212Connection, T212Settings } from "../types";

export type HealthState = "checking" | "ok" | "auth" | "scope" | "err" | "creds";

/** Health probe — calls /account/summary and maps the outcome to a UI state. */
export function useConnectionHealth(
  ctx: AddonContext,
  settings: T212Settings | undefined,
  conn: T212Connection,
) {
  return useQuery({
    // Credentials can change without the connection id changing, so key on the last 4 too.
    queryKey: ["t212_status", conn.id, conn.keyIdLast4, !!conn.needsCredentials, settings?.env],
    queryFn: async (): Promise<HealthState> => {
      if (conn.needsCredentials) return "creds";
      if (!settings) return "err";
      try {
        await new Trading212Client(ctx, connectionConfig(settings, conn)).getAccountSummary();
        return "ok";
      } catch (err) {
        return isUnauthorized(err) ? "auth" : isForbidden(err) ? "scope" : "err";
      }
    },
    enabled: !!settings || !!conn.needsCredentials,
    // The account check is light and the result rarely changes — cache it briefly so
    // navigating between Settings and Dashboard doesn't refetch unnecessarily.
    staleTime: 30_000,
  });
}

const CONFIG: Record<
  HealthState,
  { label: string; variant: "default" | "success" | "warning" | "destructive" | "outline"; dot: string }
> = {
  checking: { label: "Checking…", variant: "outline", dot: "bg-muted-foreground" },
  ok: { label: "Connected", variant: "success", dot: "bg-green-500" },
  auth: { label: "Auth failed", variant: "destructive", dot: "bg-red-500" },
  scope: { label: "Missing permission", variant: "destructive", dot: "bg-red-500" },
  err: { label: "Unreachable", variant: "warning", dot: "bg-amber-500" },
  creds: { label: "Needs credentials", variant: "warning", dot: "bg-amber-500" },
};

/** Coloured pill matching the health state, using semantic Badge variants. */
export function HealthBadge({ state }: { state: HealthState }) {
  const c = CONFIG[state];
  return (
    <Badge variant={c.variant} className="gap-1.5">
      <span className={cn("h-1.5 w-1.5 rounded-full", c.dot)} />
      {c.label}
    </Badge>
  );
}

/** Lone status dot (no text) — used in tight headers. */
export function HealthDot({ state }: { state: HealthState }) {
  return (
    <span
      title={CONFIG[state].label}
      className={cn("inline-block h-2 w-2 rounded-full", CONFIG[state].dot)}
    />
  );
}

/** Convenience: render the health badge directly for a connection (does its own query). */
export function ConnectionHealth({
  ctx,
  settings,
  conn,
}: {
  ctx: AddonContext;
  settings: T212Settings | undefined;
  conn: T212Connection;
}) {
  const { data } = useConnectionHealth(ctx, settings, conn);
  return data ? <HealthBadge state={data} /> : <Badge variant="outline" className="gap-1.5"><Icons.Spinner size={10} className="animate-spin" /> Checking…</Badge>;
}
