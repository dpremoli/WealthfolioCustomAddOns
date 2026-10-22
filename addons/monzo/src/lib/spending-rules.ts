import type { ActivityType } from "@wealthfolio/addon-sdk";
import { escapeRegex, type SpendingRuleSpec } from "@wf-addons/kit";
import { resolveCategory } from "./category-map";

/**
 * Monzo spending category -> Wealthfolio spend categories to try (key or name, best first).
 * Keys are those Wealthfolio seeds (`food_restaurants`, `housing_rent`, …), with names as a
 * fallback for installs that renamed them; a category with no match gets no rule.
 * `transfers` and `savings` are not spending and get no rule.
 */
export const SPENDING_CATEGORY_CANDIDATES: Record<string, string[]> = {
  eating_out: ["food_restaurants", "restaurants", "food", "food & dining"],
  entertainment: ["entertainment"],
  groceries: ["groceries"],
  personal_care: ["personal", "personal care"],
  shopping: ["shopping"],
  transport: ["transport", "transportation"],
  travel: ["travel"],
  holidays: ["travel"],
  utilities: ["housing_utilities", "utilities", "bills"],
  bills: ["bills", "bills & utilities"],
  // No cash category in Wealthfolio: a withdrawal is spending of an unknown kind.
  cash: ["other_expense", "other expenses"],
  charity: ["gifts", "gifts & donations"],
  education: ["education"],
  expenses: ["other_expense", "other expenses"],
  family: ["other_expense", "other expenses"],
  gifts: ["gifts", "gifts & donations"],
  health: ["health", "health & wellness"],
  rent: ["housing_rent", "rent/mortgage", "housing"],
  taxes: ["fees", "fees & charges", "other_expense"],
  loan_repayments: ["other_expense", "other expenses"],
  general: ["other_expense", "other expenses"],
};

/**
 * Every Monzo category a rule was ever saved for. Versions 2.2.0 to 2.4.x saved `monzo-<category>`
 * for the first twenty and `monzo-income`; 2.3.0 added `monzo-general`; 2.5.0 added
 * `monzo-<category>-refund`. Kept as its own list (not derived from the candidates above) so a
 * category dropped or renamed later still has its older rule found and removed.
 */
const RULE_CATEGORIES_EVER = [
  "eating_out", "entertainment", "groceries", "personal_care", "shopping", "transport", "travel",
  "holidays", "utilities", "bills", "cash", "charity", "education", "expenses", "family", "gifts",
  "health", "rent", "taxes", "loan_repayments", "general",
];

/** Every rule key the add-on has ever saved, for removing rules the current version no longer saves. */
export const LEGACY_RULE_KEYS: string[] = [
  ...RULE_CATEGORIES_EVER.map((c) => `monzo-${c}`),
  ...RULE_CATEGORIES_EVER.filter((c) => c !== "general").map((c) => `monzo-${c}-refund`),
  "monzo-income",
];

const INCOME_CANDIDATES = ["income_other", "other income", "income"];

/**
 * The comment the mapper writes is `<name> | <category label> | …`, with optional `[ref:…]`
 * tags at the end. Match the label in second position only, so a merchant called
 * "Groceries" is not mistaken for the category. (Monzo transactions virtually always carry a
 * merchant name or description; one without is left uncategorised.)
 */
function labelPattern(label: string): string {
  return `^[^|]*\\| ${escapeRegex(label)}(?: \\||\\s*\\[|$)`;
}

/**
 * Wealthfolio's own merchant presets run at this priority (so their category wins over a
 * Monzo one for the same activity), and match on merchant names such as "University of …".
 */
const PRESET_PRIORITY = 80;

/**
 * Categorisation rules for Monzo activities, using the user's category labels.
 *
 * Spending rules are restricted by activity type, so they never touch income or transfers
 * (an unrestricted rule filed salaries and friends' repayments under spending categories):
 * one rule per category for `WITHDRAWAL`, and one for `CREDIT` so a refund lands in the same
 * category and reduces that spending. They sit below the presets, which are more specific;
 * "General" is only a last resort, and has no refund rule because a General credit is a
 * deposit, not a refund (see `isRefund`). Monzo's "Income" deposits go to the income
 * taxonomy, above the presets, so a salary paid by "University of …" is not filed as
 * Education.
 */
export function monzoSpendingRules(categoryLabels: Record<string, string>): SpendingRuleSpec[] {
  const rules: SpendingRuleSpec[] = Object.entries(SPENDING_CATEGORY_CANDIDATES).flatMap(([cat, categories]) => {
    const label = resolveCategory(cat, categoryLabels);
    const spending: SpendingRuleSpec = {
      ruleKey: `monzo-${cat}`,
      name: `Monzo: ${label}`,
      pattern: labelPattern(label),
      matchType: "regex",
      kind: "expense",
      categories,
      activityType: "WITHDRAWAL" as ActivityType,
      priority: cat === "general" ? -10 : 0,
    };
    if (cat === "general") return [spending];
    return [
      spending,
      {
        ...spending,
        ruleKey: `monzo-${cat}-refund`,
        name: `Monzo: ${label} (refunds)`,
        activityType: "CREDIT" as ActivityType,
      },
    ];
  });
  const income = resolveCategory("income", categoryLabels);
  rules.push({
    ruleKey: "monzo-income",
    name: `Monzo: ${income}`,
    pattern: labelPattern(income),
    matchType: "regex",
    kind: "income",
    categories: INCOME_CANDIDATES,
    activityType: "DEPOSIT" as ActivityType,
    priority: PRESET_PRIORITY + 10,
  });
  return rules;
}
