// Small UI-only formatting helpers (no SDK/React deps; trivially unit-testable).

/** "2 hours ago" / "3 days ago" / "just now". Returns "Never" for null/invalid. */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "Never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "Never";
  const diffMs = now.getTime() - t;
  if (diffMs < 0) return new Date(iso).toLocaleString();
  const s = Math.floor(diffMs / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}
