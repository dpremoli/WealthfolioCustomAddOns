export const MONZO_CATEGORIES = [
  "eating_out",
  "entertainment",
  "general",
  "groceries",
  "personal_care",
  "shopping",
  "transport",
  "travel",
  "utilities",
  "bills",
  "cash",
  "savings",
  "charity",
  "education",
  "expenses",
  "family",
  "gifts",
  "health",
  "holidays",
  "income",
  "loan_repayments",
  "monzo",
  "rent",
  "taxes",
  "pension",
] as const;

export type MonzoCategory = (typeof MONZO_CATEGORIES)[number];

export const DEFAULT_CATEGORY_LABELS: Record<string, string> = {
  eating_out: "Eating Out",
  entertainment: "Entertainment",
  general: "General",
  groceries: "Groceries",
  personal_care: "Personal Care",
  shopping: "Shopping",
  transport: "Transport",
  travel: "Travel",
  utilities: "Utilities",
  bills: "Bills",
  cash: "Cash",
  savings: "Savings",
  charity: "Charity",
  education: "Education",
  expenses: "Expenses",
  family: "Family",
  gifts: "Gifts",
  health: "Health",
  holidays: "Holidays",
  income: "Income",
  loan_repayments: "Loan Repayments",
  monzo: "Monzo",
  rent: "Rent",
  taxes: "Taxes",
  pension: "Pension",
};

/** Returns the display label for a Monzo category, applying user overrides first. */
export function resolveCategory(
  monzoCategory: string,
  userOverrides: Record<string, string> = {},
): string {
  return (
    userOverrides[monzoCategory] ||
    DEFAULT_CATEGORY_LABELS[monzoCategory] ||
    monzoCategory.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
  );
}
