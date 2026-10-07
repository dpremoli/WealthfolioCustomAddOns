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
 * Categorisation rules for Monzo activities, using the user's category labels. Spending rules
 * match any activity type, so a refund (a `CREDIT`) lands in the same category and reduces
 * that spending. They sit below Wealthfolio's own merchant presets (priority 80), which are
 * more specific; "General" is only a last resort.
 */
export function monzoSpendingRules(categoryLabels: Record<string, string>): SpendingRuleSpec[] {
  const rules: SpendingRuleSpec[] = Object.entries(SPENDING_CATEGORY_CANDIDATES).map(([cat, categories]) => {
    const label = resolveCategory(cat, categoryLabels);
    return {
      ruleKey: `monzo-${cat}`,
      name: `Monzo: ${label}`,
      pattern: labelPattern(label),
      matchType: "regex",
      kind: "expense",
      categories,
      priority: cat === "general" ? -10 : 0,
    };
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
  });
  return rules;
}
