import { Card, CardContent, Icons, Progress, ScrollArea, cn } from "@wealthfolio/ui";
import type { IconName } from "@wealthfolio/ui";
import { useEffect, useRef } from "react";
import type { SyncProgress, SyncStep } from "../types";

interface SyncActivityProps {
  isSyncing: boolean;
  progress: SyncProgress | null;
  steps: SyncStep[];
}

type Phase = SyncProgress["phase"];

const PHASES: { phase: Phase; label: string; icon: IconName }[] = [
  { phase: "export", label: "Fetching", icon: "Download" },
  { phase: "map", label: "Matching", icon: "Search" },
  { phase: "import", label: "Importing", icon: "Import" },
  { phase: "done", label: "Done", icon: "CheckCircle" },
];

const PHASE_ICON: Record<Phase, IconName> = {
  export: "Download",
  map: "Search",
  import: "Import",
  done: "CheckCircle",
};

/**
 * Live sync view: a 4-node phase stepper, a determinate/indeterminate progress bar,
 * and an auto-scrolling feed of every progress event (one row per step, with the latest
 * spinning). Powers the "what's the sync doing right now?" experience the user asked for.
 */
export function SyncActivity({ isSyncing, progress, steps }: SyncActivityProps) {
  if (!isSyncing && steps.length === 0) return null;
  const currentPhase = progress?.phase ?? steps[steps.length - 1]?.phase ?? "export";
  const reachedIndex = PHASES.findIndex((p) => p.phase === currentPhase);

  const percent =
    progress?.total != null && progress.total > 0
      ? Math.min(100, Math.round(((progress.current ?? 0) / progress.total) * 100))
      : undefined;

  return (
    <Card>
      <CardContent className="pt-6 space-y-4">
        {/* Phase stepper */}
        <div className="flex items-center justify-between gap-2">
          {PHASES.map((p, i) => {
            const Icon = Icons[p.icon];
            const reached = i <= reachedIndex;
            const isCurrent = isSyncing && i === reachedIndex;
            return (
              <div key={p.phase} className="flex flex-1 items-center gap-2">
                <div
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
                    reached ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground",
                  )}
                >
                  {isCurrent ? (
                    <Icons.Spinner size={16} className="animate-spin" weight="bold" />
                  ) : (
                    <Icon size={16} weight={reached ? "duotone" : "regular"} />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      "text-xs font-medium",
                      reached ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {p.label}
                  </div>
                </div>
                {i < PHASES.length - 1 && (
                  <div
                    className={cn(
                      "h-px flex-1",
                      i < reachedIndex ? "bg-primary/50" : "bg-border",
                    )}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Live message + progress bar */}
        {isSyncing && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium truncate">
                {progress?.accountName ? `${progress.accountName}: ` : ""}
                {progress?.message ?? "Starting sync…"}
              </span>
              {progress?.total != null && (
                <span className="text-muted-foreground tabular-nums shrink-0">
                  {Math.min(progress.current ?? 0, progress.total)}/{progress.total}
                </span>
              )}
            </div>
            <Progress value={percent} className={percent == null ? "animate-pulse" : ""} />
          </div>
        )}

        {/* Activity feed */}
        {steps.length > 0 && <ActivityFeed steps={steps} isSyncing={isSyncing} />}
      </CardContent>
    </Card>
  );
}

function ActivityFeed({ steps, isSyncing }: { steps: SyncStep[]; isSyncing: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [steps.length]);

  return (
    <div>
      <div className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs font-medium">
        <Icons.History size={12} weight="duotone" />
        Activity
      </div>
      <ScrollArea className="h-40 rounded-md border bg-muted/30">
        <div className="space-y-1 p-2">
          {steps.map((s, i) => {
            const Icon = Icons[PHASE_ICON[s.phase]];
            const isLast = i === steps.length - 1;
            const showSpinner = isSyncing && isLast && s.status === "active";
            const done = s.status === "done" || (!isSyncing && isLast);
            return (
              <div key={i} className="flex items-start gap-2 text-xs">
                <div
                  className={cn(
                    "mt-0.5 shrink-0",
                    done ? "text-green-600 dark:text-green-500" : "text-muted-foreground",
                  )}
                >
                  {showSpinner ? (
                    <Icons.Spinner size={12} className="animate-spin" />
                  ) : done ? (
                    <Icons.CheckCircle size={12} weight="duotone" />
                  ) : (
                    <Icon size={12} weight="duotone" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-foreground">
                    {s.accountName && <span className="text-muted-foreground">{s.accountName}: </span>}
                    {s.message}
                  </span>
                  {s.total != null && (
                    <span className="text-muted-foreground tabular-nums ml-2">
                      {Math.min(s.current ?? 0, s.total)}/{s.total}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  );
}
