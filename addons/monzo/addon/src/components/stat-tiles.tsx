import { Icons, cn } from "@wealthfolio/ui";
import type { IconName } from "@wealthfolio/ui";

export interface Stat {
  label: string;
  value: number | string;
  icon: IconName;
  tone?: "default" | "success" | "warning" | "muted";
}

interface StatTilesProps {
  stats: Stat[];
  className?: string;
}

const TONE_CLASSES: Record<NonNullable<Stat["tone"]>, string> = {
  default: "text-foreground",
  success: "text-green-600 dark:text-green-500",
  warning: "text-amber-600 dark:text-amber-500",
  muted: "text-muted-foreground",
};

/** Compact tile row showing key numbers from a sync (imported, duplicates, card, …). */
export function StatTiles({ stats, className }: StatTilesProps) {
  return (
    <div className={cn("grid gap-2", gridCols(stats.length), className)}>
      {stats.map((s) => {
        const Icon = Icons[s.icon];
        return (
          <div
            key={s.label}
            className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
          >
            <div className={cn("rounded-md bg-muted p-1.5", TONE_CLASSES[s.tone ?? "default"])}>
              <Icon size={16} weight="duotone" />
            </div>
            <div className="min-w-0">
              <div className={cn("text-base font-semibold leading-none tabular-nums", TONE_CLASSES[s.tone ?? "default"])}>
                {s.value}
              </div>
              <div className="text-muted-foreground mt-1 truncate text-xs">{s.label}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function gridCols(n: number): string {
  if (n <= 2) return "grid-cols-2";
  if (n === 3) return "grid-cols-3";
  return "grid-cols-2 sm:grid-cols-4";
}
