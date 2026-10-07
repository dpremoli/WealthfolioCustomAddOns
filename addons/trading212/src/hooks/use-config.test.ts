import { describe, it, expect } from "vitest";
import {
  addConnection,
  clearAccountData,
  connectionConfig,
  encodeCredentials,
  ensureCardAccount,
  ensureMigrated,
  ensureProviderAccount,
  getConnections,
  getSettings,
  getSymbolMap,
  getSyncState,
  migrateV1ToV2,
  removeConnection,
  saveCredentials,
  setLastSync,
  updateConnection,
  verifyCredentials,
} from "./use-config";

/** Two in-memory key/value areas, mirroring `ctx.api.storage` and `ctx.api.secrets`. */
function makeCtx(initial: { secrets?: [string, string][]; storage?: [string, string][] } = {}) {
  const secrets = new Map<string, string>(initial.secrets ?? []);
  const storage = new Map<string, string>(initial.storage ?? []);
  let accountsCalled = false;
  const kv = (m: Map<string, string>) => ({
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  });
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx: {
      api: {
        secrets: kv(secrets),
        storage: kv(storage),
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
    } as any,
    secrets,
    storage,
    accountsCalled: () => accountsCalled,
  };
}

describe("connection CRUD (storage layout)", () => {
  it("adds, updates, and removes connections in storage, never in secrets", async () => {
    const { ctx, storage, secrets } = makeCtx();

    await addConnection(ctx, { id: "a", name: "Invest", accountId: "acc-1", keyIdLast4: "1111" });
    await addConnection(ctx, { id: "b", name: "ISA", accountId: "acc-2", keyIdLast4: "2222" });
    expect((await getConnections(ctx)).map((x) => x.id)).toEqual(["a", "b"]);
    expect(storage.has("t212_connections")).toBe(true);
    expect(secrets.has("t212_connections")).toBe(false);

    await updateConnection(ctx, "a", { name: "Renamed" });
    expect((await getConnections(ctx)).find((x) => x.id === "a")?.name).toBe("Renamed");

    await removeConnection(ctx, "a");
    expect((await getConnections(ctx)).map((x) => x.id)).toEqual(["b"]);
  });

  it("removeConnection deletes sync state and credentials but no Wealthfolio account", async () => {
    const w = makeCtx();
    await addConnection(w.ctx, { id: "a", name: "Invest", accountId: "acc-1" });
    w.storage.set("t212_sync_a", JSON.stringify({ lastSync: "x", importedRefs: ["r"] }));
    w.secrets.set("t212_auth_a", "Zm9vOmJhcg==");

    await removeConnection(w.ctx, "a");

    expect(w.storage.has("t212_sync_a")).toBe(false);
    expect(w.secrets.has("t212_auth_a")).toBe(false);
    expect(w.accountsCalled()).toBe(false);
  });

  it("keeps sync state in storage", async () => {
    const { ctx, storage, secrets } = makeCtx();
    await setLastSync(ctx, "a", "2026-01-01T00:00:00.000Z");
    expect((await getSyncState(ctx, "a")).lastSync).toBe("2026-01-01T00:00:00.000Z");
    expect(storage.has("t212_sync_a")).toBe(true);
    expect(secrets.size).toBe(0);
  });
});

describe("credentials", () => {
  it("encodes keyId:secret as base64 for the broker's basic auth", () => {
    expect(encodeCredentials(" key ", " secret ")).toBe(btoa("key:secret"));
    expect(() => encodeCredentials("key", "")).toThrow(/both/i);
  });

  it("connectionConfig points the client at the per-connection secret", () => {
    expect(connectionConfig({ env: "demo" }, { id: "c1", name: "x", accountId: "a" })).toEqual({
      env: "demo",
      secretKey: "t212_auth_c1",
    });
  });

  it("saveCredentials stores the secret under t212_auth_<id>, updates the last-4 and clears the flag", async () => {
    const { ctx, secrets } = makeCtx();
    await addConnection(ctx, { id: "c1", name: "Old", accountId: "a", keyIdLast4: "9999", needsCredentials: true });

    await saveCredentials(ctx, "c1", "AKID-abcd", "s3cret");

    expect(secrets.get("t212_auth_c1")).toBe(btoa("AKID-abcd:s3cret"));
    const [c] = await getConnections(ctx);
    expect(c.keyIdLast4).toBe("abcd");
    expect(c.needsCredentials).toBeUndefined();
    // The stored connection never carries the key or secret.
    expect(JSON.stringify(c)).not.toContain("s3cret");
  });

  it("verifyCredentials validates under a temporary secret and always removes it", async () => {
    const w = makeCtx();
    const calls: { secretKey?: string; stored?: string | undefined }[] = [];
    w.ctx.api.network = {
      request: async (req: { auth?: { secretKey: string } }) => {
        calls.push({ secretKey: req.auth?.secretKey, stored: w.secrets.get(req.auth?.secretKey ?? "") });
        return { status: 200, headers: {}, body: JSON.stringify({ id: 7, currency: "GBP" }) };
      },
    };

    const summary = await verifyCredentials(w.ctx, "demo", "c1", "kid", "sec");

    expect(summary).toEqual({ id: 7, currency: "GBP" });
    expect(calls[0].secretKey).toBe("t212_auth_pending_c1");
    expect(calls[0].stored).toBe(btoa("kid:sec")); // present while the request ran
    expect(w.secrets.has("t212_auth_pending_c1")).toBe(false); // gone afterwards
    expect(w.secrets.has("t212_auth_c1")).toBe(false); // working credentials untouched

    w.ctx.api.network.request = async () => ({ status: 401, headers: {}, body: "no" });
    await expect(verifyCredentials(w.ctx, "demo", "c1", "kid", "sec")).rejects.toThrow("UNAUTHORIZED");
    expect(w.secrets.has("t212_auth_pending_c1")).toBe(false);
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

describe("ensureCardAccount", () => {
  function makeCardCtx() {
    const accounts: { id: string; providerAccountId?: string }[] = [];
    const storage = new Map<string, string>();
    let created: { accountType?: string; providerAccountId?: string; name?: string } | null = null;
    const ctx = {
      api: {
        accounts: {
          getAll: async () => accounts,
          create: async (a: { providerAccountId?: string }) => {
            created = a;
            const acc = { id: "card-1", ...a };
            accounts.push(acc);
            return acc;
          },
        },
        storage: {
          get: async (k: string) => storage.get(k) ?? null,
          set: async (k: string, v: string) => void storage.set(k, v),
          delete: async (k: string) => void storage.delete(k),
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    return { ctx, getCreated: () => created, setCreated: (v: null) => (created = v) };
  }

  it("creates a CASH card account suffixed by `${id}-card`, names it, and links it", async () => {
    const { ctx, getCreated } = makeCardCtx();
    const conn = { id: "c1", name: "Trading 212 (Invest)", accountId: "acc-1" };
    await addConnection(ctx, conn);

    const id = await ensureCardAccount(ctx, conn, { id: 42, currency: "GBP" });

    expect(id).toBe("card-1");
    expect(getCreated()!.accountType).toBe("CASH");
    expect(getCreated()!.providerAccountId).toBe("42-card");
    expect(getCreated()!.name).toBe("Trading 212 (Invest) Card");
    expect((await getConnections(ctx))[0].cardAccountId).toBe("card-1");
  });

  it("creates the card account as the requested type (Credit Card)", async () => {
    const { ctx, getCreated } = makeCardCtx();
    const conn = { id: "c1", name: "Trading 212 (Invest)", accountId: "acc-1" };
    await addConnection(ctx, conn);

    await ensureCardAccount(ctx, conn, { id: 42, currency: "GBP" }, "CREDIT_CARD");

    expect(getCreated()!.accountType).toBe("CREDIT_CARD");
  });

  it("dedupes on a second run (no new account created)", async () => {
    const { ctx, getCreated, setCreated } = makeCardCtx();
    const conn = { id: "c1", name: "Trading 212 (Invest)", accountId: "acc-1" };
    await addConnection(ctx, conn);
    await ensureCardAccount(ctx, conn, { id: 42, currency: "GBP" });

    setCreated(null);
    const id2 = await ensureCardAccount(
      ctx,
      { ...conn, cardAccountId: "card-1" },
      { id: 42, currency: "GBP" },
    );
    expect(id2).toBe("card-1");
    expect(getCreated()).toBeNull();
  });
});

describe("clearAccountData", () => {
  it("deletes all activities then resets sync state in TRANSACTIONS mode", async () => {
    const { ctx, storage } = makeCtx({
      storage: [["t212_sync_c1", JSON.stringify({ lastSync: "2026-01-01", importedRefs: ["r1"] })]],
    });
    const deleted: string[] = [];
    ctx.api.activities = {
      getAll: async () => [{ id: "a1" }, { id: "a2" }, { id: undefined }],
      saveMany: async (req: { deleteIds?: string[] }) => {
        deleted.push(...(req.deleteIds ?? []));
        return {};
      },
    };
    ctx.api.snapshots = { getAll: async () => [], delete: async () => {} };

    await clearAccountData(ctx, "c1", "acc-1", "TRANSACTIONS");

    expect(deleted).toEqual(["a1", "a2"]);
    expect(storage.has("t212_sync_c1")).toBe(false);
  });

  it("deletes each snapshot date then resets sync state in HOLDINGS mode", async () => {
    const { ctx, storage } = makeCtx({
      storage: [["t212_sync_c1", JSON.stringify({ lastSync: "2026-01-01", importedRefs: [] })]],
    });
    const deletedDates: string[] = [];
    let activitiesTouched = false;
    ctx.api.activities = {
      getAll: async () => {
        activitiesTouched = true;
        return [];
      },
      saveMany: async () => {
        activitiesTouched = true;
        return {};
      },
    };
    ctx.api.snapshots = {
      getAll: async () => [{ snapshotDate: "2026-01-01" }, { snapshotDate: "2026-02-01" }],
      delete: async (_acc: string, date: string) => void deletedDates.push(date),
    };

    await clearAccountData(ctx, "c1", "acc-1", "HOLDINGS");

    expect(deletedDates).toEqual(["2026-01-01", "2026-02-01"]);
    expect(activitiesTouched).toBe(false);
    expect(storage.has("t212_sync_c1")).toBe(false);
  });
});

describe("migrateV1ToV2 (v1 keyring layout → storage + per-connection auth secret)", () => {
  const v1: [string, string][] = [
    ["t212_settings", JSON.stringify({ proxyUrl: "http://p", env: "live", autoSync: false, extractCard: true })],
    [
      "t212_connections",
      JSON.stringify([
        { id: "c1", name: "Invest", apiKey: "AKID1234", apiSecret: "shh", accountId: "acc-1", trackingMode: "HOLDINGS", kind: "invest", cardAccountId: "card-1" },
        // Legacy single-key connection: no secret.
        { id: "c2", name: "ISA", apiKey: "OLDKEY9876", accountId: "acc-2", kind: "isa" },
      ]),
    ],
    ["t212_sync_c1", JSON.stringify({ lastSync: "2026-01-01T00:00:00.000Z", importedRefs: ["t212-order-1"] })],
    ["t212_sync_c2", JSON.stringify({ lastSync: null, importedRefs: [] })],
    ["t212_symbol_map_v6", JSON.stringify({ AAPL_US_EQ: "AAPL|XNAS" })],
    ["t212_symbol_map_v5", JSON.stringify({ x: "y" })],
    ["t212_symbol_map", JSON.stringify({ x: "y" })],
  ];

  it("moves connections (without credentials), settings, sync state and symbol map to storage", async () => {
    const { ctx, secrets, storage } = makeCtx({ secrets: v1 });

    const report = await migrateV1ToV2(ctx);

    expect(report).toEqual({ migrated: true, needsCredentials: 1 });

    // Connections: no key/secret, masked last-4 kept, legacy single-key flagged.
    const conns = await getConnections(ctx);
    expect(conns).toHaveLength(2);
    expect(conns[0]).toEqual({
      id: "c1",
      name: "Invest",
      accountId: "acc-1",
      trackingMode: "HOLDINGS",
      kind: "invest",
      cardAccountId: "card-1",
      keyIdLast4: "1234",
    });
    expect(conns[1]).toMatchObject({ id: "c2", keyIdLast4: "9876", needsCredentials: true });
    const raw = storage.get("t212_connections")!;
    expect(raw).not.toContain("shh");
    expect(raw).not.toContain("AKID1234");
    expect(raw).not.toContain("apiKey");

    // Credentials: only the connection with a secret gets one, base64(keyId:secret).
    expect(secrets.get("t212_auth_c1")).toBe(btoa("AKID1234:shh"));
    expect(secrets.has("t212_auth_c2")).toBe(false);

    // Settings: proxyUrl dropped, the rest carried over.
    expect(await getSettings(ctx)).toEqual({ env: "live", autoSync: false, extractCard: true });

    // Sync state + symbol map moved to storage.
    expect((await getSyncState(ctx, "c1")).importedRefs).toEqual(["t212-order-1"]);
    expect(await getSymbolMap(ctx)).toEqual({ AAPL_US_EQ: "AAPL|XNAS" });

    // Everything moved is gone from the keyring (including superseded caches).
    expect([...secrets.keys()].sort()).toEqual(["t212_auth_c1"]);
  });

  it("is idempotent: a second run changes nothing and never overwrites v2 state", async () => {
    const { ctx, secrets, storage } = makeCtx({ secrets: v1 });
    await migrateV1ToV2(ctx);
    await setLastSync(ctx, "c1", "2026-06-01T00:00:00.000Z"); // v2 state evolves after migrating
    const snapshot = JSON.stringify([...storage.entries()].sort());
    const secretSnapshot = JSON.stringify([...secrets.entries()].sort());

    const second = await migrateV1ToV2(ctx);

    expect(second.migrated).toBe(false);
    expect(JSON.stringify([...storage.entries()].sort())).toBe(snapshot);
    expect(JSON.stringify([...secrets.entries()].sort())).toBe(secretSnapshot);
  });

  it("recovers from an interrupted run without clobbering what is already in storage", async () => {
    // A previous run wrote the v2 connections + updated sync state, then died before
    // deleting the keyring copies.
    const { ctx, secrets, storage } = makeCtx({
      secrets: v1,
      storage: [
        ["t212_connections", JSON.stringify([{ id: "c1", name: "Renamed", accountId: "acc-1", keyIdLast4: "1234" }])],
        ["t212_sync_c1", JSON.stringify({ lastSync: "2026-06-01T00:00:00.000Z", importedRefs: ["newer"] })],
      ],
    });

    await migrateV1ToV2(ctx);

    expect((await getConnections(ctx))[0].name).toBe("Renamed");
    expect((await getSyncState(ctx, "c1")).importedRefs).toEqual(["newer"]);
    expect(secrets.has("t212_connections")).toBe(false);
    expect(secrets.has("t212_sync_c1")).toBe(false);
    expect(storage.has("t212_settings")).toBe(true);
    expect(secrets.get("t212_auth_c1")).toBe(btoa("AKID1234:shh"));
  });

  it("converts the older single-account layout (connection flagged when it had no secret)", async () => {
    const legacy: [string, string][] = [
      ["t212_config", JSON.stringify({ proxyUrl: "http://p", env: "demo", apiKey: "SINGLEKEY0001" })],
      ["t212_account_id", "acc-legacy"],
      ["t212_last_sync", JSON.stringify("2026-01-01T00:00:00.000Z")],
      ["t212_imported_refs", JSON.stringify(["t212-order-9"])],
      ["t212_symbol_map_v4", JSON.stringify({ RR_GB_EQ: "RRL|CXE" })],
    ];
    const { ctx, secrets } = makeCtx({ secrets: legacy });

    const report = await migrateV1ToV2(ctx);

    expect(report).toEqual({ migrated: true, needsCredentials: 1 });
    const conns = await getConnections(ctx);
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({
      name: "Trading 212 (Invest)",
      accountId: "acc-legacy",
      keyIdLast4: "0001",
      needsCredentials: true,
    });
    expect(await getSettings(ctx)).toEqual({ env: "demo" });
    expect(await getSyncState(ctx, conns[0].id)).toEqual({
      lastSync: "2026-01-01T00:00:00.000Z",
      importedRefs: ["t212-order-9"],
    });
    expect(secrets.size).toBe(0); // all four legacy keys + old symbol cache deleted
  });

  it("the older single-account layout with key + secret gets credentials and no flag", async () => {
    const legacy: [string, string][] = [
      ["t212_config", JSON.stringify({ proxyUrl: "http://p", env: "live", apiKey: "KID", apiSecret: "SEC" })],
      ["t212_account_id", "acc-legacy"],
    ];
    const { ctx, secrets } = makeCtx({ secrets: legacy });

    const report = await migrateV1ToV2(ctx);

    expect(report.needsCredentials).toBe(0);
    const [c] = await getConnections(ctx);
    expect(c.needsCredentials).toBeUndefined();
    expect(secrets.get(`t212_auth_${c.id}`)).toBe(btoa("KID:SEC"));
  });

  it("is a no-op on a fresh install", async () => {
    const { ctx, storage, secrets } = makeCtx();
    const report = await migrateV1ToV2(ctx);
    expect(report).toEqual({ migrated: false, needsCredentials: 0 });
    expect(storage.size).toBe(0);
    expect(secrets.size).toBe(0);
  });

  it("ensureMigrated runs the migration once per context and shares the result", async () => {
    const { ctx, secrets } = makeCtx({ secrets: v1 });
    const [a, b] = await Promise.all([ensureMigrated(ctx), ensureMigrated(ctx)]);
    expect(a).toBe(b);
    expect(a.migrated).toBe(true);
    expect(secrets.has("t212_connections")).toBe(false);
  });
});
