import type { AddonContext } from "@wealthfolio/addon-sdk";
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
  cn,
} from "@wealthfolio/ui";
import { useQuery } from "@tanstack/react-query";
import { getSymbolMap, getSyncState } from "../hooks/use-config";
import type { SyncResult, T212Connection } from "../types";
import { exchangeLabel, parseSymbolMap, relativeTime } from "../lib/format";
import { ConnectionHealth } from "./connection-status";
import { StatTiles, type Stat } from "./stat-tiles";

interface ConnectionCardProps {
  ctx: AddonContext;
  settings: { proxyUrl: string; env: "live" | "demo" } | undefined;
  conn: T212Connection;
  result?: SyncResult;
  isSyncing: boolean;
}

const TYPE_ICON = {
  BUY: "TrendingUp", SELL: "TrendingDown", DIVIDEND: "HandCoins", INTEREST: "Percent",
  DEPOSIT: "ArrowDown", WITHDRAWAL: "ArrowUp", FEE: "Receipt", TRANSFER_IN: "ArrowDownLeft",
  TRANSFER_OUT: "ArrowUpRight", Card: "CreditCard",
} as const;

export function ConnectionCard({ ctx, settings, conn, result, isSyncing }: ConnectionCardProps) {
  const { data: syncState } = useQuery({
    queryKey: ["t212_sync_state", conn.id, isSyncing, result?.finishedAt],
    queryFn: () => getSyncState(ctx, conn.id),
  });
  const lastSync = syncState?.lastSync;
  const cardLastSync = syncState?.cardLastSync;

  const mode = conn.trackingMode ?? "TRANSACTIONS";
  const stats: Stat[] = result
    ? buildStats(result)
    : [];

  return (
    <Card>
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{conn.name}</CardTitle>
          <Badge variant={mode === "HOLDINGS" ? "info" : "secondary"} className="gap-1">
            <Icons.Activity size={11} weight="duotone" />
            {mode === "HOLDINGS" ? "Holdings" : "Transactions"}
          </Badge>
          {conn.cardAccountId && (
            <Badge variant="outline" className="gap-1">
              <Icons.CreditCard size={11} weight="duotone" />
              Card account
            </Badge>
          )}
          <div className="ml-auto">
            <ConnectionHealth ctx={ctx} settings={settings} conn={conn} />
          </div>
        </div>
        <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <LastSync label="Last sync" iso={lastSync ?? null} />
          {conn.cardAccountId && <LastSync label="Card" iso={cardLastSync ?? null} />}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {result?.error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <Icons.AlertTriangle size={16} className="mt-0.5 shrink-0" weight="duotone" />
            <span>{result.error}</span>
          </div>
        )}
        {!result && !isSyncing && (
          <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <Icons.Clock size={14} weight="duotone" />
            Ready to sync.
          </p>
        )}
        {stats.length > 0 && <StatTiles stats={stats} />}
        {result && !result.error && <DetailTabs ctx={ctx} result={result} />}
      </CardContent>
    </Card>
  );
}

function LastSync({ label, iso }: { label: string; iso: string | null }) {
  if (!iso) {
    return (
      <span className="text-muted-foreground flex items-center gap-1">
        <Icons.Clock size={11} weight="duotone" /> {label}: Never
      </span>
    );
  }
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-muted-foreground flex items-center gap-1 cursor-default">
            <Icons.Clock size={11} weight="duotone" /> {label}: {relativeTime(iso)}
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
  if (r.unresolved > 0)
    out.push({ label: "Unmatched", value: r.unresolved, icon: "AlertTriangle", tone: "warning" });
  if (r.card && r.card.imported > 0)
    out.push({ label: "Card", value: r.card.imported, icon: "CreditCard" });
  return out;
}

function DetailTabs({ ctx, result }: { ctx: AddonContext; result: SyncResult }) {
  const hasBreakdown = result.breakdown && Object.keys(result.breakdown).length > 0;
  const hasLog = result.log && result.log.length > 0;
  return (
    <Tabs defaultValue={hasBreakdown ? "summary" : hasLog ? "log" : "symbols"}>
      <TabsList className="grid w-full grid-cols-3">
        <TabsTrigger value="summary" disabled={!hasBreakdown}>Summary</TabsTrigger>
        <TabsTrigger value="symbols">Symbols</TabsTrigger>
        <TabsTrigger value="log" disabled={!hasLog}>Log</TabsTrigger>
      </TabsList>
      <TabsContent value="summary" className="mt-3">
        {hasBreakdown ? <BreakdownList breakdown={result.breakdown!} /> : null}
      </TabsContent>
      <TabsContent value="symbols" className="mt-3">
        <SymbolsTable ctx={ctx} />
      </TabsContent>
      <TabsContent value="log" className="mt-3">
        {hasLog ? (
          <ScrollArea className="h-48 rounded-md border bg-muted/30">
            <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {result.log.join("\n")}
            </pre>
          </ScrollArea>
        ) : null}
      </TabsContent>
    </Tabs>
  );
}

function BreakdownList({ breakdown }: { breakdown: Record<string, number> }) {
  const rows = Object.entries(breakdown)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return <p className="text-muted-foreground text-sm">No activity.</p>;
  return (
    <div className="space-y-1">
      {rows.map(([type, count], i) => {
        const iconName = (TYPE_ICON as Record<string, string>)[type] ?? "Dot";
        const Icon = (Icons as Record<string, typeof Icons.Dot>)[iconName] ?? Icons.Dot;
        return (
          <div key={type}>
            {i > 0 && <Separator />}
            <div className="flex items-center justify-between py-1.5 text-sm">
              <span className="flex items-center gap-2">
                <Icon size={14} weight="duotone" className="text-muted-foreground" />
                {labelFor(type)}
              </span>
              <span className="tabular-nums font-medium">{count}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function labelFor(type: string): string {
  switch (type) {
    case "BUY": return "Buys";
    case "SELL": return "Sells";
    case "DIVIDEND": return "Dividends";
    case "INTEREST": return "Interest";
    case "DEPOSIT": return "Deposits";
    case "WITHDRAWAL": return "Withdrawals";
    case "FEE": return "Fees";
    case "TRANSFER_IN": return "Transfers in";
    case "TRANSFER_OUT": return "Transfers out";
    case "Card": return "Card transactions";
    default: return type;
  }
}

function SymbolsTable({ ctx }: { ctx: AddonContext }) {
  const { data: map } = useQuery({
    queryKey: ["t212_symbol_map"],
    queryFn: () => getSymbolMap(ctx),
  });
  if (!map) return <p className="text-muted-foreground text-sm">Loading…</p>;
  const entries = parseSymbolMap(map);
  if (entries.length === 0)
    return (
      <p className="text-muted-foreground text-sm">
        No ticker resolutions cached yet — sync once to populate this.
      </p>
    );
  const matched = entries.filter((e) => e.symbol);
  const missed = entries.filter((e) => !e.symbol);
  return (
    <ScrollArea className="h-56 rounded-md border">
      <div className="divide-y">
        {matched.map((e) => (
          <div key={e.ticker} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
            <span className="text-muted-foreground font-mono text-xs">{e.ticker}</span>
            <div className="flex items-center gap-2">
              <span className="font-medium">{e.symbol}</span>
              {e.exchangeMic && (
                <Badge variant="outline" className="font-mono text-[10px]">
                  {exchangeLabel(e.exchangeMic)}
                </Badge>
              )}
              <Icons.CheckCircle size={14} className="text-green-600 dark:text-green-500" weight="duotone" />
            </div>
          </div>
        ))}
        {missed.length > 0 && matched.length > 0 && <Separator />}
        {missed.map((e) => (
          <div key={e.ticker} className={cn("flex items-center justify-between gap-2 px-3 py-2 text-sm")}>
            <span className="text-muted-foreground font-mono text-xs">{e.ticker}</span>
            <span className="text-amber-600 dark:text-amber-500 flex items-center gap-1.5 text-xs">
              <Icons.AlertTriangle size={12} weight="duotone" /> No match
            </span>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
