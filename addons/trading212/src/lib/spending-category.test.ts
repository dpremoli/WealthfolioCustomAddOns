import { describe, it, expect } from "vitest";
import { cardSpendingRules, mapSpendingCategory, FALLBACK_CATEGORY } from "./spending-category";

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

describe("cardSpendingRules", () => {
  const re = (label: string) =>
    new RegExp(cardSpendingRules().find((r) => r.name === `Trading 212 card: ${label}`)!.pattern);

  it("matches the label at the end of a card comment, with or without a merchant", () => {
    expect(re("Eating Out").test("PRET A MANGER · Eating Out")).toBe(true);
    expect(re("Eating Out").test("Eating Out")).toBe(true);
    expect(re("Shopping").test("PRET A MANGER · Eating Out")).toBe(false);
    // A merchant that merely contains the label is not the category.
    expect(re("Travel").test("TRAVEL LODGE · Shopping")).toBe(false);
  });

  it("files card spending as expense withdrawals and leaves Miscellaneous alone", () => {
    const rules = cardSpendingRules();
    expect(rules.every((r) => r.kind === "expense" && r.activityType === "WITHDRAWAL")).toBe(true);
    expect(rules.some((r) => r.name.endsWith("Miscellaneous"))).toBe(false);
  });
});
