import type { ActivityType } from "@wealthfolio/addon-sdk";
import { escapeRegex, type SpendingRuleSpec } from "@wf-addons/kit";

// Maps Trading 212's card "Merchant category" values onto Wealthfolio spending-category
// labels. T212 emits a small MCC-derived set on `Card debit` rows (RETAIL_STORES, TRANSPORT,
// RESTAURANTS, …). The label is written into the activity comment, and
// {@link cardSpendingRules} turns it into Wealthfolio categorisation rules (SDK 3.9
// `spending` API) that file the activity under the matching spend category. Keep the target labels below aligned with your Wealthfolio spending
// categories if you want the comment text to match them exactly — this is the one place to edit.
const T212_TO_WEALTHFOLIO: Record<string, string> = {
  // Observed in real exports.
  RETAIL_STORES: "Shopping",
  TRANSPORT: "Transport",
  RESTAURANTS: "Eating Out",
  MEMBERSHIPS: "Subscriptions",
  PERSONAL_SERVICES: "Personal Care",
  ENTERTAINMENT: "Entertainment",
  MISCELLANEOUS: "Miscellaneous",
  // Forward-compat stubs for other MCC groups T212 may emit.
  GROCERIES: "Groceries",
  SUPERMARKETS: "Groceries",
  TRAVEL: "Travel",
  HEALTH: "Health",
  BILLS: "Bills",
  UTILITIES: "Bills",
  EDUCATION: "Education",
};

/** Fallback label for an unmapped (but present) T212 category. */
export const FALLBACK_CATEGORY = "Miscellaneous";

/**
 * Maps a Trading 212 `Merchant category` to a Wealthfolio spending label.
 * Returns `undefined` for empty/missing input (e.g. card refunds carry no category);
 * an unrecognised-but-present category falls back to {@link FALLBACK_CATEGORY}.
 */
export function mapSpendingCategory(t212Cat?: string | null): string | undefined {
  if (!t212Cat) return undefined;
  const key = t212Cat.trim().toUpperCase();
  if (!key) return undefined;
  return T212_TO_WEALTHFOLIO[key] ?? FALLBACK_CATEGORY;
}

/**
 * Wealthfolio spend categories to try (key or name, best first) for each card label above.
 * "Miscellaneous" deliberately gets no rule.
 */
const LABEL_CANDIDATES: Record<string, string[]> = {
  Shopping: ["shopping"],
  Transport: ["transport", "transportation", "auto and transport", "auto & transport"],
  "Eating Out": ["restaurants", "dining", "eating out", "food and dining", "food & dining"],
  Subscriptions: ["subscriptions", "memberships"],
  "Personal Care": ["personal care", "beauty"],
  Entertainment: ["entertainment"],
  Groceries: ["groceries", "supermarket"],
  Travel: ["travel"],
  Health: ["health", "healthcare", "medical", "health and fitness", "health & fitness"],
  Bills: ["bills", "bills and utilities", "bills & utilities", "utilities"],
  Education: ["education"],
};

/**
 * Categorisation rules for card spending: the card comment is `MERCHANT · Label` (or just
 * `Label`), so each rule matches its label at the end of the comment.
 */
export function cardSpendingRules(): SpendingRuleSpec[] {
  return Object.entries(LABEL_CANDIDATES).map(([label, categories]) => ({
    ruleKey: `t212-card-${label.toLowerCase().replace(/\s+/g, "-")}`,
    name: `Trading 212 card: ${label}`,
    pattern: `(?:^| · )${escapeRegex(label)}$`,
    matchType: "regex" as const,
    kind: "expense" as const,
    categories,
    activityType: "WITHDRAWAL" as ActivityType,
  }));
}
