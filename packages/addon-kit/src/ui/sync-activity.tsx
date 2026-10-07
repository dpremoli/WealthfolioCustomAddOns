import { Card, CardContent, Icons, Progress, ScrollArea, cn } from "@wealthfolio/ui";
import type { IconName } from "@wealthfolio/ui";
import { useEffect, useRef } from "react";
import type { SyncProgress, SyncStep } from "../sync-steps";

export interface SyncPhase<P extends string = string> {
  phase: P;
  label: string;
  icon: IconName;
}

interface SyncActivityProps<P extends string> {
  /** Ordered phases for the stepper, e.g. Fetch → Import → Done. */
  phases: SyncPhase<P>[];
  isSyncing: boolean;
  progress: SyncProgress<P> | null;
  steps: SyncStep<P>[];
}

/**
 * Live sync view: a phase stepper, a determinate/indeterminate progress bar, and an
 * auto-scrolling feed of every progress event the sync emitted.
 */
export function SyncActivity<P extends string>({ phases, isSyncing, progress, steps }: SyncActivityProps<P>) {
  if (!isSyncing && steps.length === 0) return null;
  const currentPhase = progress?.phase ?? steps[steps.length - 1]?.phase ?? phases[0]?.phase;
  const reachedIndex = phases.findIndex((p) => p.phase === currentPhase);
  const iconFor = (phase: P): IconName => phases.find((p) => p.phase === phase)?.icon ?? "Info";

  const percent =
    progress?.total != null && progress.total > 0
      ? Math.min(100, Math.round(((progress.current ?? 0) / progress.total) * 100))
      : undefined;

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex items-center justify-between gap-2">
          {phases.map((p, i) => {
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
                  <div className={cn("text-xs font-medium", reached ? "text-foreground" : "text-muted-foreground")}>
                    {p.label}
                  </div>
                </div>
                {i < phases.length - 1 && (
                  <div className={cn("h-px flex-1", i < reachedIndex ? "bg-primary/50" : "bg-border")} />
                )}
              </div>
            );
          })}
        </div>

        {isSyncing && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate font-medium">{progress?.message ?? "Starting sync…"}</span>
              {progress?.total != null && (
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {Math.min(progress.current ?? 0, progress.total)}/{progress.total}
                </span>
              )}
            </div>
            <Progress value={percent} className={percent == null ? "animate-pulse" : ""} />
          </div>
        )}

        {steps.length > 0 && <ActivityFeed steps={steps} isSyncing={isSyncing} iconFor={iconFor} />}
      </CardContent>
    </Card>
  );
}

function ActivityFeed<P extends string>({
  steps,
  isSyncing,
  iconFor,
}: {
  steps: SyncStep<P>[];
  isSyncing: boolean;
  iconFor: (phase: P) => IconName;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [steps.length]);

  return (
    <div>
      <div className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs font-medium">
        <Icons.History size={12} weight="duotone" />
        Activity
      </div>
      <ScrollArea className="bg-muted/30 h-36 rounded-md border">
        <div className="space-y-1 p-2">
          {steps.map((s, i) => {
            const Icon = Icons[iconFor(s.phase)];
            const isLast = i === steps.length - 1;
            const showSpinner = isSyncing && isLast && s.status === "active";
            const done = s.status === "done" || (!isSyncing && isLast);
            return (
              <div key={i} className="flex items-start gap-2 text-xs">
                <div className={cn("mt-0.5 shrink-0", done ? "text-green-600 dark:text-green-500" : "text-muted-foreground")}>
                  {showSpinner ? (
                    <Icons.Spinner size={12} className="animate-spin" />
                  ) : done ? (
                    <Icons.CheckCircle size={12} weight="duotone" />
                  ) : (
                    <Icon size={12} weight="duotone" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-foreground">{s.message}</span>
                  {s.total != null && (
                    <span className="text-muted-foreground ml-2 tabular-nums">
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
