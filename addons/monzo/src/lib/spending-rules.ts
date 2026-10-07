import type { ActivityType } from "@wealthfolio/addon-sdk";
import { escapeRegex, type SpendingRuleSpec } from "@wf-addons/kit";
import { resolveCategory } from "./category-map";

/**
 * Monzo category -> Wealthfolio spend categories to try (key or name, best first). Category
 * keys differ between Wealthfolio installs, so the first one that exists is used; a Monzo
 * category with no match is left for Wealthfolio's own engine (or the user) to categorise.
 * `general`, `transfers` and `savings` deliberately get no rule.
 */
const EXPENSE_CANDIDATES: Record<string, string[]> = {
  eating_out: ["restaurants", "dining", "eating out", "food and dining", "food & dining"],
  entertainment: ["entertainment"],
  groceries: ["groceries", "supermarket"],
  personal_care: ["personal care", "beauty"],
  shopping: ["shopping"],
  transport: ["transport", "transportation", "auto and transport", "auto & transport"],
  travel: ["travel"],
  holidays: ["holidays", "travel", "vacation"],
  utilities: ["utilities", "bills and utilities", "bills & utilities", "bills"],
  bills: ["bills", "bills and utilities", "bills & utilities", "utilities"],
  cash: ["cash", "atm", "cash and atm", "cash & atm"],
  charity: ["charity", "donations", "gifts and donations", "gifts & donations"],
  education: ["education"],
  expenses: ["business expenses", "business", "expenses"],
  family: ["family", "kids", "childcare"],
  gifts: ["gifts", "gifts and donations", "gifts & donations"],
  health: ["health", "healthcare", "medical", "health and fitness", "health & fitness"],
  rent: ["rent", "housing", "rent and mortgage", "mortgage"],
  taxes: ["taxes", "tax"],
  loan_repayments: ["loan repayments", "loans", "loan", "debt"],
};

const INCOME_CANDIDATES = ["salary", "income", "wages", "paycheck"];

/**
 * The comment the mapper writes is `<name> | <category label> | …`, with optional `[ref:…]`
 * tags at the end. Match the label in second position only, so a merchant called
 * "Groceries" is not mistaken for the category. (Monzo transactions virtually always carry a
 * merchant name or description; one without is left uncategorised.)
 */
function labelPattern(label: string): string {
  return `^[^|]*\\| ${escapeRegex(label)}(?: \\||\\s*\\[|$)`;
}

/** Categorisation rules for Monzo activities, using the user's category labels. */
export function monzoSpendingRules(categoryLabels: Record<string, string>): SpendingRuleSpec[] {
  const rules: SpendingRuleSpec[] = Object.entries(EXPENSE_CANDIDATES).map(([cat, categories]) => {
    const label = resolveCategory(cat, categoryLabels);
    return {
      ruleKey: `monzo-${cat}`,
      name: `Monzo: ${label}`,
      pattern: labelPattern(label),
      matchType: "regex",
      kind: "expense",
      categories,
      activityType: "WITHDRAWAL" as ActivityType,
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
