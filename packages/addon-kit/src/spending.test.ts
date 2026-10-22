import { createHash } from "node:crypto";
import type { ActivityType, AddonContext, SpendCategory } from "@wealthfolio/addon-sdk";
import { deriveRuleId, escapeRegex, pickSpendCategory, spendingRulesNote, syncSpendingRules } from "./spending";

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

/** The real host's id for a rule: `addon:<addon id>:` + the first 24 hex chars of SHA-256(ruleKey). */
const hostId = (key: string, addonId = "test-addon") =>
  `addon:${addonId}:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;

describe("deriveRuleId", () => {
  it("matches the host's derivation (SHA-256, first 24 hex chars)", async () => {
    expect(await deriveRuleId("test-addon", "monzo-groceries")).toBe(hostId("monzo-groceries"));
    expect(await deriveRuleId("test-addon", "monzo-groceries")).toMatch(/^addon:test-addon:[0-9a-f]{24}$/);
  });
});

describe("syncSpendingRules pruneStale", () => {
  const KEYS = "test_rule_keys";
  const PRUNE = { pruneStale: { addonId: "test-addon", storageKey: KEYS, legacyKeys: ["legacy-x", "legacy-y"] } };
  const spec = { ruleKey: "g", name: "Monzo: Groceries", pattern: "x", kind: "expense" as const, categories: ["groceries"] };
  const rule = (id: string, name: string) => ({ id, name, pattern: "x", matchType: "regex", kind: "expense", categoryId: "c", priority: 0 });

  /**
   * A host that behaves like Wealthfolio's: a rule's id is derived from its key (SHA-256, 24 hex
   * chars), `getRules` returns ids only, and `deleteRule(ruleKey)` hashes its argument again, so
   * passing an id (or anything but the original key) deletes nothing.
   */
  function host(opts: { keys?: string[]; foreign?: string[]; stored?: string[] } = {}) {
    const rules = [
      ...(opts.keys ?? []).map((k) => rule(hostId(k), `Monzo: ${k}`)),
      ...(opts.foreign ?? []).map((id) => rule(id, "Monzo: Foreign")),
    ];
    const storage = new Map<string, string>();
    if (opts.stored) storage.set(KEYS, JSON.stringify(opts.stored));
    const deleteRule = vi.fn(async (key: string) => {
      const i = rules.findIndex((r) => r.id === hostId(key));
      if (i >= 0) rules.splice(i, 1);
    });
    const spending = {
      getCategories: async () => CATEGORIES,
      saveRule: vi.fn(async (r: { ruleKey: string; name: string }) => {
        let hit = rules.find((x) => x.id === hostId(r.ruleKey));
        if (!hit) rules.push((hit = rule(hostId(r.ruleKey), r.name)));
        return hit;
      }),
      getRules: vi.fn(async () => [...rules]),
      deleteRule,
      rerunRules: vi.fn(async () => 0),
    };
    const ctx = {
      api: {
        spending,
        storage: {
          get: async (k: string) => storage.get(k) ?? null,
          set: async (k: string, v: string) => void storage.set(k, v),
          delete: async (k: string) => void storage.delete(k),
        },
      },
    } as unknown as AddonContext;
    const stored = () => JSON.parse(storage.get(KEYS) ?? "null") as string[] | null;
    return { ctx, rules, deleteRule, spending, storage, stored };
  }

  it("remembers the keys it saves, in add-on storage", async () => {
    const h = host();
    await syncSpendingRules(h.ctx, [spec], PRUNE);
    expect(h.stored()).toEqual(["g"]);
  });

  it("removes a rule an earlier run saved but this one did not, deleting by its key", async () => {
    const h = host({ keys: ["old-1", "g"], stored: ["old-1", "g"] });
    const out = await syncSpendingRules(h.ctx, [spec], PRUNE);
    expect(h.deleteRule.mock.calls.map((c) => c[0])).toEqual(["old-1"]);
    expect(h.rules.map((r) => r.id)).toEqual([hostId("g")]);
    expect(out).toMatchObject({ saved: 1, removed: 1 });
    expect(spendingRulesNote(out)).toMatch(/1 older rule removed/);
    expect(h.stored()).toEqual(["g"]);
  });

  it("removes rules saved under keys earlier versions used, on an install with no stored keys", async () => {
    const h = host({ keys: ["legacy-x", "legacy-y"] });
    const out = await syncSpendingRules(h.ctx, [spec], PRUNE);
    expect(h.deleteRule.mock.calls.map((c) => c[0]).sort()).toEqual(["legacy-x", "legacy-y"]);
    expect(h.rules.map((r) => r.id)).toEqual([hostId("g")]);
    expect(out.removed).toBe(2);
  });

  it("never removes a rule it just saved, nor one created elsewhere, and does not call delete for keys the host does not hold", async () => {
    const h = host({ keys: ["g"], foreign: ["monzo_fb_groceries", "addon:other-addon:abcdef"], stored: ["g", "gone"] });
    const out = await syncSpendingRules(h.ctx, [{ ...spec }], { pruneStale: { ...PRUNE.pruneStale, legacyKeys: ["g", "legacy-x"] } });
    expect(h.deleteRule).not.toHaveBeenCalled();
    expect(out.removed).toBe(0);
    expect(h.rules.map((r) => r.id)).toEqual([hostId("g"), "monzo_fb_groceries", "addon:other-addon:abcdef"]);
  });

  it("is idempotent: a second run saves in place, removes nothing and adds no duplicates", async () => {
    const h = host({ keys: ["old-1"], stored: ["old-1"] });
    await syncSpendingRules(h.ctx, [spec], PRUNE);
    h.deleteRule.mockClear();
    const again = await syncSpendingRules(h.ctx, [spec], PRUNE);
    expect(again.removed).toBe(0);
    expect(h.deleteRule).not.toHaveBeenCalled();
    expect(h.rules).toHaveLength(1);
    expect(h.stored()).toEqual(["g"]);
  });

  it("only prunes, and only stores keys, when asked", async () => {
    const h = host({ keys: ["old-1"], stored: ["old-1"] });
    const out = await syncSpendingRules(h.ctx, [spec]);
    expect(h.deleteRule).not.toHaveBeenCalled();
    expect(out.removed).toBeUndefined();
    expect(h.stored()).toEqual(["old-1"]);
  });

  it("a refused lookup never fails the sync, is reported, and loses no remembered key", async () => {
    const h = host({ keys: ["old-1"], stored: ["old-1"] });
    h.spending.getRules.mockRejectedValue(new Error("permission denied"));
    const out = await syncSpendingRules(h.ctx, [spec], PRUNE);
    expect(out.error).toBeUndefined();
    expect(out.saved).toBe(1);
    expect(out.pruneError).toBe("permission denied");
    expect(spendingRulesNote(out)).toMatch(/older rules.*permission denied/s);
    expect(h.stored()?.sort()).toEqual(["g", "old-1"]);
  });

  it("a refused delete is reported and the key is kept to try again next time", async () => {
    const h = host({ keys: ["old-1"], stored: ["old-1"] });
    h.deleteRule.mockRejectedValueOnce(new Error("nope"));
    const out = await syncSpendingRules(h.ctx, [spec], PRUNE);
    expect(out.saved).toBe(1);
    expect(out.pruneError).toBe("nope");
    expect(h.stored()?.sort()).toEqual(["g", "old-1"]);
    const retry = await syncSpendingRules(h.ctx, [spec], PRUNE);
    expect(retry.removed).toBe(1);
    expect(h.stored()).toEqual(["g"]);
  });
});
