import type { ActivityType, AddonContext, SpendCategory } from "@wealthfolio/addon-sdk";
import { escapeRegex, pickSpendCategory, syncSpendingRules } from "./spending";

const cat = (kind: SpendCategory["kind"], key: string, name: string, path = name): SpendCategory => ({
  kind,
  taxonomyId: `tx-${kind}`,
  categoryId: `c-${key}`,
  key,
  name,
  path,
});

const CATEGORIES = [
  cat("expense", "groceries", "Groceries", "Food & Dining / Groceries"),
  cat("expense", "restaurants", "Restaurants", "Food & Dining / Restaurants"),
  cat("income", "salary", "Salary"),
];

describe("pickSpendCategory", () => {
  it("matches by key, name or last path segment, best candidate first, within the kind", () => {
    expect(pickSpendCategory(CATEGORIES, "expense", ["dining", "restaurants"])?.categoryId).toBe("c-restaurants");
    expect(pickSpendCategory(CATEGORIES, "expense", ["Groceries"])?.categoryId).toBe("c-groceries");
    expect(pickSpendCategory(CATEGORIES, "expense", ["salary"])).toBeUndefined();
    expect(pickSpendCategory(CATEGORIES, "income", ["salary"])?.categoryId).toBe("c-salary");
  });
});

describe("syncSpendingRules", () => {
  function ctxWith(spending: Record<string, unknown> | undefined) {
    return { api: { spending } } as unknown as AddonContext;
  }

  it("saves a rule per matched spec, skips unmatched ones and re-runs rules", async () => {
    const saveRule = vi.fn(async (r: unknown) => r);
    const rerunRules = vi.fn(async () => 7);
    const ctx = ctxWith({ getCategories: async () => CATEGORIES, saveRule, rerunRules });
    const out = await syncSpendingRules(ctx, [
      { ruleKey: "g", name: "Groceries", pattern: "x", kind: "expense", categories: ["groceries"], activityType: "WITHDRAWAL" as ActivityType },
      { ruleKey: "t", name: "Taxes", pattern: "y", kind: "expense", categories: ["taxes"] },
    ]);
    expect(out).toEqual({ saved: 1, unmatched: ["Taxes"], categorised: 7 });
    expect(saveRule).toHaveBeenCalledWith(
      expect.objectContaining({ ruleKey: "g", categoryId: "c-groceries", matchType: "contains", activityType: "WITHDRAWAL" }),
    );
    expect(rerunRules).toHaveBeenCalledWith(true);
  });

  it("never throws: a missing API or a refusal is reported as an error", async () => {
    expect((await syncSpendingRules(ctxWith(undefined), [])).error).toMatch(/not available/);
    const refused = ctxWith({ getCategories: async () => Promise.reject(new Error("permission denied")) });
    expect((await syncSpendingRules(refused, [])).error).toBe("permission denied");
  });

  it("explains the HTTPS requirement when Wealthfolio cannot hash rule ids", async () => {
    const ctx = ctxWith({
      getCategories: async () => CATEGORIES,
      saveRule: async () => Promise.reject(new TypeError("Cannot read properties of undefined (reading 'digest')")),
    });
    const out = await syncSpendingRules(ctx, [
      { ruleKey: "g", name: "Groceries", pattern: "x", kind: "expense", categories: ["groceries"] },
    ]);
    expect(out.error).toMatch(/opened over HTTPS/);
  });

  it("escapeRegex escapes metacharacters", () => {
    expect(new RegExp(`^${escapeRegex("Bills (x) | a.b")}$`).test("Bills (x) | a.b")).toBe(true);
  });
});
