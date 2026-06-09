import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Icons,
  ScrollArea,
  Separator,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui";
import type { SyncResult } from "../types";
import { relativeTime } from "../lib/format";
import { StatTiles, type Stat } from "./stat-tiles";

interface StatusCardProps {
  connected: boolean;
  lastSyncIso: string | null;
  result: SyncResult | null;
  isSyncing: boolean;
}

export function StatusCard({ connected, lastSyncIso, result, isSyncing }: StatusCardProps) {
  const stats: Stat[] = result ? buildStats(result) : [];

  return (
    <Card>
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">Status</CardTitle>
          <Badge variant={connected ? "success" : "warning"} className="gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-green-500" : "bg-amber-500"}`} />
            {connected ? "Connected" : "Not connected"}
          </Badge>
        </div>
        <CardDescription>
          <LastSync iso={lastSyncIso} />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!result && !isSyncing && connected && (
          <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <Icons.Clock size={14} weight="duotone" />
            Ready to sync — Monzo imports the last 90 days of transactions.
          </p>
        )}
        {stats.length > 0 && <StatTiles stats={stats} />}
        {result && <DetailTabs result={result} />}
      </CardContent>
    </Card>
  );
}

function LastSync({ iso }: { iso: string | null }) {
  if (!iso) {
    return (
      <span className="flex items-center gap-1">
        <Icons.Clock size={12} weight="duotone" /> Last sync: Never
      </span>
    );
  }
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex w-fit items-center gap-1 cursor-default">
            <Icons.Clock size={12} weight="duotone" /> Last sync: {relativeTime(iso)}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{new Date(iso).toLocaleString()}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function buildStats(r: SyncResult): Stat[] {
  const out: Stat[] = [
    { label: "Imported", value: r.imported, icon: "CheckCircle", tone: "success" },
    { label: "Duplicates", value: r.duplicates, icon: "Copy", tone: "muted" },
  ];
  if (r.skipped > 0) out.push({ label: "Skipped", value: r.skipped, icon: "AlertTriangle", tone: "warning" });
  return out;
}

function DetailTabs({ result }: { result: SyncResult }) {
  const hasCategories = result.breakdown && Object.keys(result.breakdown).length > 0;
  const hasLog = result.log && result.log.length > 0;
  if (!hasCategories && !hasLog) return null;
  return (
    <Tabs defaultValue={hasCategories ? "categories" : "log"}>
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="categories" disabled={!hasCategories}>Spending</TabsTrigger>
        <TabsTrigger value="log" disabled={!hasLog}>Log</TabsTrigger>
      </TabsList>
      <TabsContent value="categories" className="mt-3">
        {hasCategories ? <CategoryList breakdown={result.breakdown!} /> : null}
      </TabsContent>
      <TabsContent value="log" className="mt-3">
        {hasLog ? (
          <ScrollArea className="h-40 rounded-md border bg-muted/30">
            <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {result.log!.join("\n")}
            </pre>
          </ScrollArea>
        ) : null}
      </TabsContent>
    </Tabs>
  );
}

const CATEGORY_ICON: Record<string, string> = {
  "Eating Out": "Receipt", Groceries: "Store", Transport: "ArrowRightLeft", Shopping: "Package",
  Bills: "FileText", Entertainment: "Star", General: "Dot", Cash: "Coins", Holidays: "Globe",
  Transfers: "ArrowRightLeft", Income: "HandCoins", Personal_Care: "User", Family: "Users",
};

function CategoryList({ breakdown }: { breakdown: Record<string, number> }) {
  const rows = Object.entries(breakdown)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return <p className="text-muted-foreground text-sm">No spending in this sync.</p>;
  return (
    <div className="space-y-1">
      {rows.map(([label, count], i) => {
        const iconName = CATEGORY_ICON[label] ?? "Dot";
        const Icon = (Icons as Record<string, typeof Icons.Dot>)[iconName] ?? Icons.Dot;
        return (
          <div key={label}>
            {i > 0 && <Separator />}
            <div className="flex items-center justify-between py-1.5 text-sm">
              <span className="flex items-center gap-2">
                <Icon size={14} weight="duotone" className="text-muted-foreground" />
                {label}
              </span>
              <span className="tabular-nums font-medium">{count}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
