import type { ActivityType, AddonContext, SpendCategory, SpendCategoryKind } from "@wealthfolio/addon-sdk";
import { jsonStore } from "./storage";

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
  /** With `pruneStale`: why the older rules could not be looked up or removed. */
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
     * Also remove the add-on's own rules that this run did not save: a rule from an earlier version,
     * saved under a key the current ones no longer use, would otherwise keep applying.
     *
     * The host derives a rule's id from its key (see {@link deriveRuleId}) and deletes by hashing
     * the key it is given, so a rule can only be deleted by its original key, which cannot be read
     * back from the id. The keys saved are therefore kept in add-on storage (`storageKey`), and
     * `legacyKeys` lists the keys earlier versions used (for installs that predate that list). The
     * rules to remove are those keys, minus the ones saved this run, that really exist in
     * `getRules()`; rules with any other id (created elsewhere) are never touched. Needs the
     * `getRules` and `deleteRule` permissions.
     */
    pruneStale?: { addonId: string; storageKey: string; legacyKeys?: string[] };
  } = {},
): Promise<SpendingRulesOutcome> {
  const out: SpendingRulesOutcome = { saved: 0, unmatched: [], categorised: 0 };
  const spending = ctx.api.spending;
  if (!spending) return { ...out, error: "Wealthfolio's Spending API is not available." };
  try {
    const categories = await spending.getCategories();
    const savedKeys = new Set<string>();
    for (const spec of specs) {
      const category = pickSpendCategory(categories, spec.kind, spec.categories);
      if (!category) {
        out.unmatched.push(spec.name);
        continue;
      }
      await spending.saveRule({
        ruleKey: spec.ruleKey,
        name: spec.name,
        pattern: spec.pattern,
        matchType: spec.matchType ?? "contains",
        kind: spec.kind,
        categoryId: category.categoryId,
        activityType: spec.activityType,
        priority: spec.priority ?? 0,
      });
      savedKeys.add(spec.ruleKey);
      out.saved++;
    }
    if (opts.pruneStale) await pruneStaleRules(ctx, spending, opts.pruneStale, savedKeys, out);
    out.categorised = await spending.rerunRules(true);
  } catch (err) {
    out.error = describeSpendingError(err instanceof Error ? err.message : String(err));
  }
  return out;
}

/** The id Wealthfolio gives an add-on's rule: `addon:<addon id>:` + the first 24 hex chars of SHA-256(ruleKey). */
export async function deriveRuleId(addonId: string, ruleKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ruleKey));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `addon:${addonId}:${hex.slice(0, 24)}`;
}

/**
 * Deletes the rules this add-on saved under a key it no longer uses: the remembered keys plus
 * `legacyKeys`, minus `savedKeys`, whose derived id is really in `getRules()`. Remembers the keys
 * saved this run (plus any whose delete failed, to try again, or all the old ones if the lookup
 * failed, so none is lost).
 */
async function pruneStaleRules(
  ctx: AddonContext,
  spending: NonNullable<AddonContext["api"]["spending"]>,
  cfg: { addonId: string; storageKey: string; legacyKeys?: string[] },
  savedKeys: ReadonlySet<string>,
  out: SpendingRulesOutcome,
): Promise<void> {
  out.removed = 0;
  const store = jsonStore(ctx.api.storage);
  let stored: string[] = [];
  try {
    stored = await store.get<string[]>(cfg.storageKey, []);
  } catch {
    /* start from the saved keys alone */
  }
  let remember = new Set([...stored, ...savedKeys]);
  try {
    const candidates = new Set([...stored, ...(cfg.legacyKeys ?? [])]);
    savedKeys.forEach((k) => candidates.delete(k));
    const existing = new Set((await spending.getRules()).map((r) => r.id));
    remember = new Set(savedKeys);
    for (const key of candidates) {
      if (!existing.has(await deriveRuleId(cfg.addonId, key))) continue; // not there: nothing to remove
      try {
        await spending.deleteRule(key);
        out.removed++;
      } catch (err) {
        remember.add(key);
        out.pruneError ??= err instanceof Error ? err.message : String(err);
      }
    }
  } catch (err) {
    out.pruneError = err instanceof Error ? err.message : String(err);
  }
  await store.set(cfg.storageKey, [...remember]).catch(() => {});
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
  if (o.pruneError) parts.push(`could not remove older rules (${o.pruneError})`);
  return `Spending: ${parts.join("; ")}.`;
}
