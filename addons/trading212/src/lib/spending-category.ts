// Maps Trading 212's card "Merchant category" values onto Wealthfolio spending-category
// labels. T212 emits a small MCC-derived set on `Card debit` rows (RETAIL_STORES, TRANSPORT,
// RESTAURANTS, …). The add-on SDK (3.3.0) has no structured spending-category field, so this
// label is surfaced in the activity comment; Wealthfolio 3.5.0's own categorisation engine
// remains authoritative. Keep the target labels below aligned with your Wealthfolio spending
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
