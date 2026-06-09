import { describe, it, expect } from "vitest";
import { mapSpendingCategory, FALLBACK_CATEGORY } from "./spending-category";

describe("mapSpendingCategory", () => {
  it("maps the categories T212 emits on card debits", () => {
    expect(mapSpendingCategory("RETAIL_STORES")).toBe("Shopping");
    expect(mapSpendingCategory("TRANSPORT")).toBe("Transport");
    expect(mapSpendingCategory("RESTAURANTS")).toBe("Eating Out");
    expect(mapSpendingCategory("MEMBERSHIPS")).toBe("Subscriptions");
    expect(mapSpendingCategory("PERSONAL_SERVICES")).toBe("Personal Care");
    expect(mapSpendingCategory("ENTERTAINMENT")).toBe("Entertainment");
    expect(mapSpendingCategory("MISCELLANEOUS")).toBe("Miscellaneous");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(mapSpendingCategory("  retail_stores ")).toBe("Shopping");
    expect(mapSpendingCategory("Transport")).toBe("Transport");
  });

  it("falls back for a present-but-unknown category", () => {
    expect(mapSpendingCategory("SOME_NEW_MCC_GROUP")).toBe(FALLBACK_CATEGORY);
  });

  it("returns undefined for empty/missing input", () => {
    expect(mapSpendingCategory("")).toBeUndefined();
    expect(mapSpendingCategory("   ")).toBeUndefined();
    expect(mapSpendingCategory(undefined)).toBeUndefined();
    expect(mapSpendingCategory(null)).toBeUndefined();
  });
});
