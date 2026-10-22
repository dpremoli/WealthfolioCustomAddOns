import type { ActivityType, AddonContext, SpendCategory } from "@wealthfolio/addon-sdk";
import { escapeRegex, pickSpendCategory, spendingRulesNote, syncSpendingRules } from "./spending";

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

describe("syncSpendingRules pruneStale", () => {
  // The host names a rule `addon:<addon id>:<ruleKey>` and deletes it by that key.
  const ID = (key: string) => `addon:test-addon:${key}`;
  const rule = (id: string, name: string) => ({ id, name, pattern: "x", matchType: "regex", kind: "expense", categoryId: "c", priority: 0 });

  function host(initial: ReturnType<typeof rule>[]) {
    const rules = [...initial];
    const deleteRule = vi.fn(async (key: string) => {
      const i = rules.findIndex((r) => r.id === ID(key));
      if (i >= 0) rules.splice(i, 1);
    });
    const spending = {
      getCategories: async () => CATEGORIES,
      saveRule: vi.fn(async (r: { ruleKey: string; name: string }) => {
        let hit = rules.find((x) => x.id === ID(r.ruleKey));
        if (!hit) rules.push((hit = rule(ID(r.ruleKey), r.name)));
        return hit;
      }),
      getRules: vi.fn(async () => [...rules]),
      deleteRule,
      rerunRules: vi.fn(async () => 0),
    };
    return { ctx: { api: { spending } } as unknown as AddonContext, rules, deleteRule, spending };
  }
  const spec = { ruleKey: "g", name: "Monzo: Groceries", pattern: "x", kind: "expense" as const, categories: ["groceries"] };
  const PRUNE = { pruneStale: { addonId: "test-addon" } };

  it("removes the add-on's own rules that this run did not save, by key, and never the ones it just saved", async () => {
    const h = host([rule(ID("old-1"), "Monzo: Groceries"), rule(ID("old-2"), "Monzo: Finances")]);
    const out = await syncSpendingRules(h.ctx, [spec], PRUNE);
    expect(h.deleteRule.mock.calls.map((c) => c[0]).sort()).toEqual(["old-1", "old-2"]);
    expect(h.rules.map((r) => r.id)).toEqual([ID("g")]);
    expect(out).toMatchObject({ saved: 1, removed: 2 });
    expect(spendingRulesNote(out)).toMatch(/2 older rules removed/);
  });

  it("leaves a rule that is not this add-on's alone", async () => {
    const h = host([rule("monzo_fb_groceries", "Monzo: Groceries"), rule("addon:other-addon:x", "Other")]);
    const out = await syncSpendingRules(h.ctx, [spec], PRUNE);
    expect(h.deleteRule).not.toHaveBeenCalled();
    expect(out.removed).toBe(0);
    expect(h.rules.map((r) => r.id)).toEqual(["monzo_fb_groceries", "addon:other-addon:x", ID("g")]);
  });

  it("is idempotent: a second run saves in place, removes nothing and adds no duplicates", async () => {
    const h = host([rule(ID("old-1"), "Monzo: Groceries")]);
    await syncSpendingRules(h.ctx, [spec], PRUNE);
    const again = await syncSpendingRules(h.ctx, [spec], PRUNE);
    expect(again.removed).toBe(0);
    expect(h.rules).toHaveLength(1);
  });

  it("only prunes when asked", async () => {
    const h = host([rule(ID("old-1"), "Monzo: Groceries")]);
    const out = await syncSpendingRules(h.ctx, [spec]);
    expect(h.deleteRule).not.toHaveBeenCalled();
    expect(out.removed).toBeUndefined();
  });

  it("a refused lookup or delete never fails the sync, and is reported", async () => {
    const h = host([rule(ID("old-1"), "Monzo: Groceries")]);
    h.spending.getRules.mockRejectedValue(new Error("permission denied"));
    const refused = await syncSpendingRules(h.ctx, [spec], PRUNE);
    expect(refused.error).toBeUndefined();
    expect(refused.saved).toBe(1);
    expect(refused.pruneError).toBe("permission denied");
    expect(spendingRulesNote(refused)).toMatch(/older rules.*permission denied/s);

    const h2 = host([rule(ID("old-1"), "Monzo: Groceries")]);
    h2.deleteRule.mockRejectedValue(new Error("nope"));
    const out = await syncSpendingRules(h2.ctx, [spec], PRUNE);
    expect(out.saved).toBe(1);
    expect(out.pruneError).toBe("nope");
  });
});
