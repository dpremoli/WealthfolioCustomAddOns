import type { AddonContext } from "@wealthfolio/addon-sdk";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Icons } from "@wealthfolio/ui";
import { useQuery } from "@tanstack/react-query";
import { StatTiles } from "@wf-addons/kit/ui";
import { getSyncState } from "../hooks/use-config";
import { getCashIsaState } from "../lib/cash-isa";
import type { SyncResult, T212Connection } from "../types";
import { LastSync } from "./connection-card";

/** The "<name> Card" account a connection's card spending is synced into. */
export function CardAccountCard({
  ctx,
  conn,
  name,
  accountType,
  result,
  isSyncing,
}: {
  ctx: AddonContext;
  conn: T212Connection;
  /** The Wealthfolio account's name (it may have been renamed there). */
  name: string;
  accountType?: string;
  result?: SyncResult;
  isSyncing: boolean;
}) {
  const { data: syncState } = useQuery({
    queryKey: ["t212_sync_state", conn.id, isSyncing, result?.finishedAt],
    queryFn: () => getSyncState(ctx, conn.id),
  });
  const card = result?.card;

  return (
    <Card>
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{name}</CardTitle>
          <Badge variant="outline" className="gap-1">
            <Icons.CreditCard size={11} weight="duotone" />
            Card
          </Badge>
          <Badge variant="secondary" className="gap-1">
            <Icons.Wallet size={11} weight="duotone" />
            {accountType === "CREDIT_CARD" ? "Credit card" : "Cash"}
          </Badge>
        </div>
        <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <LastSync label="Last sync" iso={syncState?.cardLastSync ?? null} />
          <span className="text-muted-foreground flex items-center gap-1">
            <Icons.Link size={11} weight="duotone" /> Synced with {conn.name}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {card ? (
          <StatTiles
            stats={[
              { label: "Imported", value: card.imported, icon: "CheckCircle", tone: "success" },
              { label: "Duplicates", value: card.duplicates, icon: "Copy", tone: "muted" },
            ]}
          />
        ) : (
          <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <Icons.Clock size={14} weight="duotone" />
            Card spending syncs with {conn.name}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** The Cash ISA, which has no API access and is kept up to date from its CSV exports. */
export function CashIsaCard({
  ctx,
  name,
  onImport,
}: {
  ctx: AddonContext;
  name: string;
  onImport: () => void;
}) {
  const { data: state } = useQuery({
    queryKey: ["t212_cash_isa", "state"],
    queryFn: () => getCashIsaState(ctx),
  });

  return (
    <Card>
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{name}</CardTitle>
          <Badge variant="outline" className="gap-1">
            <Icons.PiggyBank size={11} weight="duotone" />
            Cash ISA
          </Badge>
          <Badge variant="secondary" className="gap-1">
            <Icons.FileText size={11} weight="duotone" />
            CSV import
          </Badge>
          <div className="ml-auto">
            <Button variant="outline" size="sm" onClick={onImport}>
              <Icons.Import size={14} className="mr-1" weight="bold" />
              Import CSV
            </Button>
          </div>
        </div>
        <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <LastSync label="Last import" iso={state?.lastImport ?? null} />
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
          <Icons.Info size={14} weight="duotone" />
          Not covered by Trading 212's API — import new CSV exports to bring it up to date.
        </p>
      </CardContent>
    </Card>
  );
}
