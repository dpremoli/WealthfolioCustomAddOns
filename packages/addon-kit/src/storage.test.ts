import type { AddonContext } from "@wealthfolio/addon-sdk";
import { jsonStore, migrateSecretsToStorage } from "./storage";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: vi.fn(async (k: string) => data.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => void data.set(k, v)),
    delete: vi.fn(async (k: string) => void data.delete(k)),
  };
}

describe("jsonStore", () => {
  it("round-trips JSON and falls back on missing or corrupt values", async () => {
    const api = memory({ bad: "{not json" });
    const store = jsonStore(api);
    await store.set("k", { a: 1 });
    expect(await store.get("k", null)).toEqual({ a: 1 });
    expect(await store.get("missing", 5)).toBe(5);
    expect(await store.get("bad", "fallback")).toBe("fallback");
  });
});

describe("migrateSecretsToStorage", () => {
  it("moves values once and never overwrites existing storage", async () => {
    const secrets = memory({ a: '"x"', b: '"old"' });
    const storage = memory({ b: '"new"' });
    const ctx = { api: { secrets, storage } } as unknown as AddonContext;
    expect(await migrateSecretsToStorage(ctx, ["a", "b", "c"])).toEqual(["a"]);
    expect(storage.data.get("a")).toBe('"x"');
    expect(storage.data.get("b")).toBe('"new"');
    expect(secrets.data.size).toBe(0);
  });
});
