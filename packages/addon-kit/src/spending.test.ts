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
  const rule = (id: string, name: string) => ({ id, name, pattern: "x", matchType: "regex", kind: "expense", categoryId: "c", priority: 25 });

  /** A host holding `rules`; saveRule adds (by ruleKey) and deleteRule removes by key or id. */
  function host(initial: ReturnType<typeof rule>[], opts: { deleteWorks?: boolean } = {}) {
    const rules = [...initial];
    const deleteRule = vi.fn(async (key: string) => {
      if (opts.deleteWorks === false) return;
      const i = rules.findIndex((r) => r.id === key);
      if (i >= 0) rules.splice(i, 1);
    });
    const spending = {
      getCategories: async () => CATEGORIES,
      saveRule: vi.fn(async (r: { ruleKey: string; name: string }) => {
        let hit = rules.find((x) => x.id === `id-${r.ruleKey}`);
        if (!hit) rules.push((hit = rule(`id-${r.ruleKey}`, r.name)));
        return hit;
      }),
      getRules: vi.fn(async () => [...rules]),
      deleteRule,
      rerunRules: vi.fn(async () => 0),
    };
    return { ctx: { api: { spending } } as unknown as AddonContext, rules, deleteRule, spending };
  }
  const spec = { ruleKey: "g", name: "Monzo: Groceries", pattern: "x", kind: "expense" as const, categories: ["groceries"] };

  it("removes the add-on's older rules that this run did not save, and never the ones it just saved", async () => {
    const h = host([rule("old-1", "Monzo: Groceries"), rule("old-2", "Monzo: Finances")]);
    const out = await syncSpendingRules(h.ctx, [spec], { pruneStale: true });
    expect(h.deleteRule.mock.calls.map((c) => c[0]).sort()).toEqual(["old-1", "old-2"]);
    expect(h.rules.map((r) => r.id)).toEqual(["id-g"]);
    expect(out).toMatchObject({ saved: 1, removed: 2, staleKept: [] });
  });

  it("reports the rules it could not remove instead of claiming it did", async () => {
    const h = host([rule("old-1", "Monzo: Groceries")], { deleteWorks: false });
    const out = await syncSpendingRules(h.ctx, [spec], { pruneStale: true });
    expect(out).toMatchObject({ removed: 0, staleKept: ["Monzo: Groceries"] });
    expect(spendingRulesNote(out)).toMatch(/could not remove.*Monzo: Groceries.*Settings/s);
  });

  it("is idempotent: a second run saves in place, removes nothing and adds no duplicates", async () => {
    const h = host([rule("old-1", "Monzo: Groceries")]);
    await syncSpendingRules(h.ctx, [spec], { pruneStale: true });
    const again = await syncSpendingRules(h.ctx, [spec], { pruneStale: true });
    expect(again).toMatchObject({ removed: 0, staleKept: [] });
    expect(h.rules).toHaveLength(1);
  });

  it("only prunes when asked, and a refused getRules/deleteRule never fails the sync", async () => {
    const h = host([rule("old-1", "Monzo: Groceries")]);
    await syncSpendingRules(h.ctx, [spec]);
    expect(h.deleteRule).not.toHaveBeenCalled();

    h.spending.getRules.mockRejectedValue(new Error("permission denied"));
    const out = await syncSpendingRules(h.ctx, [spec], { pruneStale: true });
    expect(out.error).toBeUndefined();
    expect(out.saved).toBe(1);
    expect(out.pruneError).toBe("permission denied");
    expect(spendingRulesNote(out)).toMatch(/older rules.*permission denied/s);
  });
});
