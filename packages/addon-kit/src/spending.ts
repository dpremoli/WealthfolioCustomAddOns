import type { ActivityType, AddonContext, SpendCategory, SpendCategoryKind } from "@wealthfolio/addon-sdk";

/**
 * One categorisation rule an add-on wants in Wealthfolio's Spending module: activities
 * whose notes match `pattern` get the first of `categories` that exists in the user's
 * Wealthfolio (category keys and names differ between installs, so they are looked up).
 */
export interface SpendingRuleSpec {
  /** Stable key; saving again with the same key updates the rule in place. */
  ruleKey: string;
  /** Shown in Wealthfolio's Settings → Spending → Rules. */
  name: string;
  pattern: string;
  matchType?: "contains" | "starts_with" | "exact" | "regex";
  kind: SpendCategoryKind;
  /** Candidate category keys or names, best first, e.g. ["restaurants", "dining"]. */
  categories: string[];
  /** e.g. "WITHDRAWAL" for spending, "DEPOSIT" for income. */
  activityType?: ActivityType;
  priority?: number;
}

export interface SpendingRulesOutcome {
  /** Rules created or updated. */
  saved: number;
  /** Rules skipped because none of their candidate categories exists. */
  unmatched: string[];
  /** Activities that existing rules categorised in the re-run (uncategorised only). */
  categorised: number;
  /** Set when the Spending API is unavailable or refused; nothing else was done. */
  error?: string;
  /** With `pruneStale`: older rules of this add-on that were removed. */
  removed?: number;
  /** With `pruneStale`: names of older rules that are still there after trying to remove them. */
  staleKept?: string[];
  /** With `pruneStale`: why the older rules could not be looked up. */
  pruneError?: string;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, " ");

/** The first candidate that names one of `available` (by key, name or last path segment). */
export function pickSpendCategory(
  available: SpendCategory[],
  kind: SpendCategoryKind,
  candidates: string[],
): SpendCategory | undefined {
  const pool = available.filter((c) => c.kind === kind);
  for (const want of candidates.map(norm)) {
    const hit = pool.find(
      (c) =>
        norm(c.key) === want ||
        norm(c.name) === want ||
        norm(c.path.split("/").pop() ?? "") === want,
    );
    if (hit) return hit;
  }
  return undefined;
}

/** Escapes text for use inside a regular expression. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Creates or updates the add-on's categorisation rules, then re-runs rules over
 * uncategorised activities so freshly imported ones get their category. Never throws: a
 * host without the Spending API (or a refused permission) only yields an `error`, since
 * categorising is a nicety and must not fail a sync.
 */
export async function syncSpendingRules(
  ctx: AddonContext,
  specs: SpendingRuleSpec[],
  opts: {
    /**
     * Also remove the add-on's own older rules that this run did not save (found through
     * `getRules()`, which lists only the add-on's rules): rules from earlier versions, saved under
     * keys the current ones no longer use, would otherwise keep applying. Needs the `getRules`
     * and `deleteRule` permissions. Checked afterwards, so the outcome says what is really gone.
     */
    pruneStale?: boolean;
  } = {},
): Promise<SpendingRulesOutcome> {
  const out: SpendingRulesOutcome = { saved: 0, unmatched: [], categorised: 0 };
  const spending = ctx.api.spending;
  if (!spending) return { ...out, error: "Wealthfolio's Spending API is not available." };
  try {
    const categories = await spending.getCategories();
    const savedIds = new Set<string>();
    for (const spec of specs) {
      const category = pickSpendCategory(categories, spec.kind, spec.categories);
      if (!category) {
        out.unmatched.push(spec.name);
        continue;
      }
      const rule = await spending.saveRule({
        ruleKey: spec.ruleKey,
        name: spec.name,
        pattern: spec.pattern,
        matchType: spec.matchType ?? "contains",
        kind: spec.kind,
        categoryId: category.categoryId,
        activityType: spec.activityType,
        priority: spec.priority ?? 0,
      });
      savedIds.add(rule.id);
      out.saved++;
    }
    if (opts.pruneStale) await pruneStaleRules(spending, savedIds, out);
    out.categorised = await spending.rerunRules(true);
  } catch (err) {
    out.error = describeSpendingError(err instanceof Error ? err.message : String(err));
  }
  return out;
}

/**
 * Deletes the add-on's rules that are not in `keep` (ids), then reads the rules again to see which
 * are really gone. The host deletes by the key a rule was saved under, which `getRules()` does not
 * give back, so the rule's id is what is tried; whatever remains is reported, never assumed gone.
 */
async function pruneStaleRules(
  spending: NonNullable<AddonContext["api"]["spending"]>,
  keep: ReadonlySet<string>,
  out: SpendingRulesOutcome,
): Promise<void> {
  try {
    const stale = (await spending.getRules()).filter((r) => !keep.has(r.id));
    for (const r of stale) await spending.deleteRule(r.id).catch(() => {});
    const left = new Set((await spending.getRules()).map((r) => r.id));
    out.removed = stale.filter((r) => !left.has(r.id)).length;
    out.staleKept = stale.filter((r) => left.has(r.id)).map((r) => r.name);
  } catch (err) {
    out.pruneError = err instanceof Error ? err.message : String(err);
  }
}

/**
 * Wealthfolio derives each rule's id with `crypto.subtle.digest`, which browsers only provide
 * on secure pages (HTTPS or localhost). Over plain http:// it fails with "reading 'digest'".
 */
function describeSpendingError(message: string): string {
  if (/digest|crypto\.subtle|subtle/i.test(message)) {
    return (
      "Wealthfolio can only save categorisation rules when it is opened over HTTPS (or on " +
      "localhost): browsers disable the crypto it needs on plain http:// pages. Open " +
      `Wealthfolio over https:// and sync again. (${message})`
    );
  }
  return message;
}

/** One log line summarising {@link syncSpendingRules}, or null when there is nothing to say. */
export function spendingRulesNote(o: SpendingRulesOutcome): string | null {
  if (o.error) return `Spending categories not updated: ${o.error}`;
  const parts = [`${o.saved} categorisation rule(s) up to date`];
  if (o.categorised) parts.push(`${o.categorised} activit${o.categorised === 1 ? "y" : "ies"} categorised`);
  if (o.unmatched.length) parts.push(`no matching Wealthfolio category for: ${o.unmatched.join(", ")}`);
  if (o.removed) parts.push(`${o.removed} older rule${o.removed === 1 ? "" : "s"} removed`);
  if (o.staleKept?.length) {
    parts.push(
      `could not remove ${o.staleKept.length} older rule${o.staleKept.length === 1 ? "" : "s"} ` +
        `(${o.staleKept.join(", ")}): delete them in Settings → Spending → Rules`,
    );
  }
  if (o.pruneError) parts.push(`could not check for older rules (${o.pruneError})`);
  return `Spending: ${parts.join("; ")}.`;
}
