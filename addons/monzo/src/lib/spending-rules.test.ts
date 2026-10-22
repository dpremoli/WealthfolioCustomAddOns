import { describe, expect, it } from "vitest";
import { mapTransactionToActivity } from "./mapper";
import { LEGACY_RULE_KEYS, monzoSpendingRules } from "./spending-rules";
import { tx } from "../test-utils";

const rule = (labels: Record<string, string>, key: string) => {
  const r = monzoSpendingRules(labels).find((x) => x.ruleKey === key)!;
  return new RegExp(r.pattern);
};
const comment = (over: Parameters<typeof tx>[0]) => mapTransactionToActivity(tx(over), "wf").comment!;

describe("monzoSpendingRules", () => {
  it("matches the category label in the comment the mapper writes", () => {
    const groceries = rule({}, "monzo-groceries");
    expect(groceries.test(comment({ category: "groceries", description: "TESCO", merchant: { name: "Tesco" } }))).toBe(true);
    expect(groceries.test("Tesco | Groceries")).toBe(true);
    expect(groceries.test("Tesco | Groceries | London, GB | Note: weekly shop [ref:tx_1]")).toBe(true);
    // A merchant that happens to be called "Groceries" is not the category.
    expect(groceries.test(comment({ category: "shopping", merchant: { name: "Groceries" } }))).toBe(false);
    expect(rule({}, "monzo-eating_out").test(comment({ category: "groceries" }))).toBe(false);
  });

  it("uses the user's own category labels", () => {
    const r = monzoSpendingRules({ eating_out: "Dining (out)" }).find((x) => x.ruleKey === "monzo-eating_out")!;
    expect(r.name).toBe("Monzo: Dining (out)");
    expect(new RegExp(r.pattern).test(comment({ category: "eating_out" }))).toBe(false);
    expect(new RegExp(r.pattern).test("Pizza Place | Dining (out) [ref:tx_1]")).toBe(true);
  });

  it("files spending as expense on withdrawals only, and refunds of it on credits only", () => {
    const rules = monzoSpendingRules({});
    expect(rules.find((r) => r.ruleKey === "monzo-groceries")).toMatchObject({
      kind: "expense",
      priority: 0,
      activityType: "WITHDRAWAL",
    });
    expect(rules.find((r) => r.ruleKey === "monzo-groceries-refund")).toMatchObject({
      kind: "expense",
      name: "Monzo: Groceries (refunds)",
      pattern: rules.find((r) => r.ruleKey === "monzo-groceries")!.pattern,
      categories: rules.find((r) => r.ruleKey === "monzo-groceries")!.categories,
      activityType: "CREDIT",
    });
  });

  it("never lets a spending rule match income or transfers", () => {
    const rules = monzoSpendingRules({});
    for (const r of rules.filter((x) => x.kind === "expense")) {
      expect(["WITHDRAWAL", "CREDIT"]).toContain(r.activityType);
    }
    // "General" credits are deposits, not refunds, so General has no refund rule.
    expect(rules.some((r) => r.ruleKey === "monzo-general-refund")).toBe(false);
    expect(rules.find((r) => r.ruleKey === "monzo-general")!.activityType).toBe("WITHDRAWAL");
  });

  it("files Income deposits as income, above Wealthfolio's merchant presets", () => {
    const income = monzoSpendingRules({}).find((r) => r.ruleKey === "monzo-income")!;
    expect(income).toMatchObject({ kind: "income", activityType: "DEPOSIT" });
    // The presets (priority 80) match merchant names such as "University of …", which would
    // otherwise file a salary under Education.
    expect(income.priority).toBeGreaterThan(80);
    expect(new RegExp(income.pattern).test("University of Sheffield | Income")).toBe(true);
  });

  it("targets Wealthfolio's own category keys", () => {
    const rules = monzoSpendingRules({});
    expect(rules.find((r) => r.ruleKey === "monzo-eating_out")!.categories[0]).toBe("food_restaurants");
    expect(rules.find((r) => r.ruleKey === "monzo-rent")!.categories[0]).toBe("housing_rent");
    expect(rules.find((r) => r.ruleKey === "monzo-income")!.categories[0]).toBe("income_other");
  });

  it("files General as Other Expenses, below every other rule", () => {
    const general = monzoSpendingRules({}).find((r) => r.ruleKey === "monzo-general")!;
    expect(general).toMatchObject({ priority: -10, categories: ["other_expense", "other expenses"] });
    expect(new RegExp(general.pattern).test(comment({ category: "general", description: "Flex" }))).toBe(true);
  });

  it("never categorises savings moves: no rule matches a Savings row of any direction", () => {
    const rules = monzoSpendingRules({});
    const rows = [
      mapTransactionToActivity(tx({ category: "savings", description: "Trading 212", amount: -30000 }), "wf"),
      mapTransactionToActivity(tx({ category: "savings", description: "Trading 212", amount: 30000 }), "wf"),
    ];
    for (const row of rows) {
      expect(row.comment).toBe("Trading 212 | Savings");
      expect(rules.filter((r) => new RegExp(r.pattern).test(row.comment!))).toEqual([]);
    }
  });

  it("lists every rule key it has ever saved, so an older rule can still be found and removed", () => {
    for (const r of monzoSpendingRules({})) expect(LEGACY_RULE_KEYS).toContain(r.ruleKey);
    // Keys from earlier versions: 2.2.0 saved monzo-<category> and monzo-income, 2.5.0 added -refund.
    expect(LEGACY_RULE_KEYS).toEqual(expect.arrayContaining(["monzo-eating_out", "monzo-income", "monzo-rent-refund", "monzo-general"]));
    expect(new Set(LEGACY_RULE_KEYS).size).toBe(LEGACY_RULE_KEYS.length);
  });
});
