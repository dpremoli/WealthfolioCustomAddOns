import { describe, expect, it } from "vitest";
import { mapTransactionToActivity } from "./mapper";
import { monzoSpendingRules } from "./spending-rules";
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

  it("files spending as expense withdrawals and income as income deposits; general gets no rule", () => {
    const rules = monzoSpendingRules({});
    expect(rules.find((r) => r.ruleKey === "monzo-groceries")).toMatchObject({ kind: "expense", activityType: "WITHDRAWAL" });
    expect(rules.find((r) => r.ruleKey === "monzo-income")).toMatchObject({ kind: "income", activityType: "DEPOSIT" });
    expect(rules.some((r) => r.ruleKey === "monzo-general")).toBe(false);
  });
});
