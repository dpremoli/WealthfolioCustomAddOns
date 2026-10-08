import type { AddonContext } from "@wealthfolio/addon-sdk";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Icons } from "@wealthfolio/ui";
import { StatTiles } from "@wf-addons/kit/ui";
import type { SyncResult, T212Connection } from "../types";
import { LastSync, useConnectionSyncState } from "./connection-card";

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
  const { data: syncState } = useConnectionSyncState(ctx, conn, isSyncing, result);
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
  name,
  lastImport,
  onImport,
}: {
  name: string;
  lastImport: string | null;
  onImport: () => void;
}) {
  return (
    <Card>
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{name}</CardTitle>
          <CashIsaBadges size={11} />
          <div className="ml-auto">
            <Button variant="outline" size="sm" onClick={onImport}>
              <Icons.Import size={14} className="mr-1" weight="bold" />
              Import CSV
            </Button>
          </div>
        </div>
        <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <LastSync label="Last import" iso={lastImport} />
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

/** "Cash ISA" + "CSV import": what sets the Cash ISA apart from the API connections. */
export function CashIsaBadges({ size }: { size: number }) {
  return (
    <>
      <Badge variant="info" className="gap-1">
        <Icons.PiggyBank size={size} weight="duotone" />
        Cash ISA
      </Badge>
      <Badge variant="outline" className="gap-1">
        <Icons.FileText size={size} weight="duotone" />
        CSV import
      </Badge>
    </>
  );
}
