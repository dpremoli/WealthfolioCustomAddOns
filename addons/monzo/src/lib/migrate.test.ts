import { describe, expect, it } from "vitest";
import {
  KEY_CATEGORY_LABELS,
  KEY_EXPIRES_AT,
  KEY_LAST_SYNC,
  KEY_MAPPING,
  LEGACY_PROXY_URL_KEY,
  LEGACY_TOKENS_KEY,
  SECRET_ACCESS_TOKEN,
  SECRET_REFRESH_TOKEN,
} from "../constants";
import { makeCtx } from "../test-utils";
import { getConnectionStatus } from "./auth";
import { ensureMigrated, migrateFromV1 } from "./migrate";

function v1() {
  const t = makeCtx();
  t.secrets.set(LEGACY_PROXY_URL_KEY, "http://192.168.1.5:8001");
  t.secrets.set(KEY_MAPPING, JSON.stringify({ acc_1: "wf-1" }));
  t.secrets.set(KEY_LAST_SYNC, JSON.stringify("2026-05-01T00:00:00.000Z"));
  t.secrets.set(KEY_CATEGORY_LABELS, JSON.stringify({ eating_out: "Dining" }));
  t.secrets.set(
    LEGACY_TOKENS_KEY,
    JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_at: 1_800_000_000_000, token_type: "Bearer", user_id: "u" }),
  );
  return t;
}

describe("migrateFromV1", () => {
  it("moves non-secrets to storage and splits the tokens blob", async () => {
    const t = v1();
    await migrateFromV1(t.ctx);

    expect(t.storage.get(KEY_MAPPING)).toBe(JSON.stringify({ acc_1: "wf-1" }));
    expect(JSON.parse(t.storage.get(KEY_LAST_SYNC)!)).toBe("2026-05-01T00:00:00.000Z");
    expect(JSON.parse(t.storage.get(KEY_CATEGORY_LABELS)!)).toEqual({ eating_out: "Dining" });
    expect(t.secrets.has(KEY_MAPPING)).toBe(false);
    expect(t.secrets.has(KEY_LAST_SYNC)).toBe(false);
    expect(t.secrets.has(KEY_CATEGORY_LABELS)).toBe(false);

    expect(t.secrets.get(SECRET_ACCESS_TOKEN)).toBe("a1");
    expect(t.secrets.get(SECRET_REFRESH_TOKEN)).toBe("r1");
    expect(t.storage.get(KEY_EXPIRES_AT)).toBe("1800000000000");
    expect(t.secrets.has(LEGACY_TOKENS_KEY)).toBe(false);
    expect(t.secrets.has(LEGACY_PROXY_URL_KEY)).toBe(false);
  });

  it("leaves the add-on connected but needing the client id/secret to refresh", async () => {
    const t = v1();
    await migrateFromV1(t.ctx);
    expect(await getConnectionStatus(t.ctx)).toMatchObject({
      connected: true,
      hasRefreshToken: true,
      hasCredentials: false,
    });
  });

  it("is idempotent and never clobbers a v2 connection or newer storage", async () => {
    const t = v1();
    await migrateFromV1(t.ctx);
    t.secrets.set(SECRET_ACCESS_TOKEN, "v2-access");
    t.storage.set(KEY_EXPIRES_AT, "42");
    t.storage.set(KEY_MAPPING, JSON.stringify({ acc_1: "wf-9" }));
    t.secrets.set(LEGACY_TOKENS_KEY, JSON.stringify({ access_token: "old", refresh_token: "old", expires_at: 1 }));
    t.secrets.set(KEY_MAPPING, JSON.stringify({ stale: "x" }));

    await migrateFromV1(t.ctx);
    expect(t.secrets.get(SECRET_ACCESS_TOKEN)).toBe("v2-access");
    expect(t.storage.get(KEY_EXPIRES_AT)).toBe("42");
    expect(t.storage.get(KEY_MAPPING)).toBe(JSON.stringify({ acc_1: "wf-9" }));
    expect(t.secrets.has(LEGACY_TOKENS_KEY)).toBe(false);
    expect(t.secrets.has(KEY_MAPPING)).toBe(false);
  });

  it("drops an unreadable tokens blob instead of failing", async () => {
    const t = makeCtx();
    t.secrets.set(LEGACY_TOKENS_KEY, "not json");
    await migrateFromV1(t.ctx);
    expect(t.secrets.has(LEGACY_TOKENS_KEY)).toBe(false);
    expect(t.storage.has(KEY_EXPIRES_AT)).toBe(false);
  });

  it("is a no-op on a fresh install", async () => {
    const t = makeCtx();
    await migrateFromV1(t.ctx);
    expect(t.storage.size).toBe(0);
    expect(t.secrets.size).toBe(0);
  });
});

describe("ensureMigrated", () => {
  it("runs once per context and shares the promise", async () => {
    const t = v1();
    const a = ensureMigrated(t.ctx);
    const b = ensureMigrated(t.ctx);
    expect(a).toBe(b);
    await a;
    expect(t.secrets.has(LEGACY_TOKENS_KEY)).toBe(false);
  });
});
