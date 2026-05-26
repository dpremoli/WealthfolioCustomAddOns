import { describe, it, expect } from "vitest";
import {
  addConnection,
  clearAccountData,
  ensureProviderAccount,
  getConnections,
  migrateLegacyConfig,
  removeConnection,
  updateConnection,
} from "./use-config";

function makeCtx(initial: [string, string][] = []) {
  const secrets = new Map<string, string>(initial);
  let accountsCalled = false;
  return {
    ctx: {
      api: {
        secrets: {
          get: async (k: string) => secrets.get(k) ?? null,
          set: async (k: string, v: string) => void secrets.set(k, v),
          delete: async (k: string) => void secrets.delete(k),
        },
        accounts: {
          getAll: async () => {
            accountsCalled = true;
            return [];
          },
          create: async () => {
            accountsCalled = true;
            return { id: "x" };
          },
        },
      },
    },
    secrets,
    accountsCalled: () => accountsCalled,
  };
}

describe("connection CRUD", () => {
  it("adds, updates, and removes connections", async () => {
    const { ctx } = makeCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = ctx as any;

    await addConnection(c, { id: "a", name: "Invest", apiKey: "k1", accountId: "acc-1" });
    await addConnection(c, { id: "b", name: "ISA", apiKey: "k2", accountId: "acc-2" });
    expect((await getConnections(c)).map((x) => x.id)).toEqual(["a", "b"]);

    await updateConnection(c, "a", { name: "Renamed" });
    expect((await getConnections(c)).find((x) => x.id === "a")?.name).toBe("Renamed");

    await removeConnection(c, "a");
    expect((await getConnections(c)).map((x) => x.id)).toEqual(["b"]);
  });

  it("removeConnection deletes per-connection sync state but no Wealthfolio account", async () => {
    const ctxWrap = makeCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = ctxWrap.ctx as any;
    await addConnection(c, { id: "a", name: "Invest", apiKey: "k1", accountId: "acc-1" });
    ctxWrap.secrets.set("t212_sync_a", JSON.stringify({ lastSync: "x", importedRefs: ["r"] }));

    await removeConnection(c, "a");

    expect(ctxWrap.secrets.has("t212_sync_a")).toBe(false);
    expect(ctxWrap.accountsCalled()).toBe(false);
  });
});

describe("ensureProviderAccount", () => {
  it("creates the account in the requested tracking mode", async () => {
    let createdWith: { trackingMode?: string } | null = null;
    const ctx = {
      api: {
        accounts: {
          getAll: async () => [],
          create: async (a: { trackingMode?: string }) => {
            createdWith = a;
            return { id: "acc-new" };
          },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const id = await ensureProviderAccount(ctx, "Invest", { id: 1, currency: "GBP" }, "HOLDINGS");
    expect(id).toBe("acc-new");
    expect(createdWith!.trackingMode).toBe("HOLDINGS");
  });

  it("defaults to TRANSACTIONS when no mode is given", async () => {
    let createdWith: { trackingMode?: string } | null = null;
    const ctx = {
      api: {
        accounts: {
          getAll: async () => [],
          create: async (a: { trackingMode?: string }) => {
            createdWith = a;
            return { id: "acc-new" };
          },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await ensureProviderAccount(ctx, "Invest", { id: 1, currency: "GBP" });
    expect(createdWith!.trackingMode).toBe("TRANSACTIONS");
  });
});

describe("clearAccountData", () => {
  it("deletes all activities then resets sync state in TRANSACTIONS mode", async () => {
    const secrets = new Map<string, string>([
      ["t212_sync_c1", JSON.stringify({ lastSync: "2026-01-01", importedRefs: ["r1"] })],
    ]);
    const deleted: string[] = [];
    const ctx = {
      api: {
        secrets: {
          get: async (k: string) => secrets.get(k) ?? null,
          set: async (k: string, v: string) => void secrets.set(k, v),
          delete: async (k: string) => void secrets.delete(k),
        },
        activities: {
          getAll: async () => [{ id: "a1" }, { id: "a2" }, { id: undefined }],
          saveMany: async (req: { deleteIds?: string[] }) => {
            deleted.push(...(req.deleteIds ?? []));
            return {};
          },
        },
        snapshots: { getAll: async () => [], delete: async () => {} },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await clearAccountData(ctx, "c1", "acc-1", "TRANSACTIONS");

    expect(deleted).toEqual(["a1", "a2"]);
    expect(secrets.has("t212_sync_c1")).toBe(false);
  });

  it("deletes each snapshot date then resets sync state in HOLDINGS mode", async () => {
    const secrets = new Map<string, string>([
      ["t212_sync_c1", JSON.stringify({ lastSync: "2026-01-01", importedRefs: [] })],
    ]);
    const deletedDates: string[] = [];
    let activitiesTouched = false;
    const ctx = {
      api: {
        secrets: {
          get: async (k: string) => secrets.get(k) ?? null,
          set: async (k: string, v: string) => void secrets.set(k, v),
          delete: async (k: string) => void secrets.delete(k),
        },
        activities: {
          getAll: async () => {
            activitiesTouched = true;
            return [];
          },
          saveMany: async () => {
            activitiesTouched = true;
            return {};
          },
        },
        snapshots: {
          getAll: async () => [
            { snapshotDate: "2026-01-01" },
            { snapshotDate: "2026-02-01" },
          ],
          delete: async (_acc: string, date: string) => void deletedDates.push(date),
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await clearAccountData(ctx, "c1", "acc-1", "HOLDINGS");

    expect(deletedDates).toEqual(["2026-01-01", "2026-02-01"]);
    expect(activitiesTouched).toBe(false);
    expect(secrets.has("t212_sync_c1")).toBe(false);
  });
});

describe("migrateLegacyConfig", () => {
  const legacy: [string, string][] = [
    ["t212_config", JSON.stringify({ proxyUrl: "http://p", env: "live", apiKey: "k", apiSecret: "s" })],
    ["t212_account_id", "acc-legacy"],
    ["t212_last_sync", JSON.stringify("2026-01-01T00:00:00.000Z")],
    ["t212_imported_refs", JSON.stringify(["t212-order-9"])],
    ["t212_symbol_map", JSON.stringify({ AAPL_US_EQ: "AAPL" })],
  ];

  it("converts the single-account layout into one connection", async () => {
    const { ctx, secrets } = makeCtx(legacy);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = ctx as any;

    await migrateLegacyConfig(c);

    expect(JSON.parse(secrets.get("t212_settings")!)).toEqual({ proxyUrl: "http://p", env: "live" });
    const conns = await getConnections(c);
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({
      name: "Trading 212 (Invest)",
      apiKey: "k",
      apiSecret: "s",
      accountId: "acc-legacy",
    });

    const state = JSON.parse(secrets.get(`t212_sync_${conns[0].id}`)!);
    expect(state).toEqual({ lastSync: "2026-01-01T00:00:00.000Z", importedRefs: ["t212-order-9"] });

    // Legacy keys deleted, symbol map untouched.
    expect(secrets.has("t212_config")).toBe(false);
    expect(secrets.has("t212_account_id")).toBe(false);
    expect(secrets.has("t212_last_sync")).toBe(false);
    expect(secrets.has("t212_imported_refs")).toBe(false);
    expect(secrets.get("t212_symbol_map")).toBe(JSON.stringify({ AAPL_US_EQ: "AAPL" }));
  });

  it("is idempotent and a no-op when nothing to migrate", async () => {
    const { ctx, secrets } = makeCtx(legacy);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = ctx as any;

    await migrateLegacyConfig(c);
    const after = secrets.get("t212_connections");
    await migrateLegacyConfig(c); // second run
    expect(secrets.get("t212_connections")).toBe(after);

    const fresh = makeCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrateLegacyConfig(fresh.ctx as any);
    expect(fresh.secrets.has("t212_settings")).toBe(false);
  });
});
