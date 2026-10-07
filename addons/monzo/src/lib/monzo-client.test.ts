import { describe, expect, it } from "vitest";
import { KEY_EXPIRES_AT, SECRET_ACCESS_TOKEN, SECRET_CLIENT_SECRET, SECRET_REFRESH_TOKEN, KEY_CLIENT_ID, KEY_REDIRECT_URL } from "../constants";
import { json, makeCtx, tx, type FakeRequest } from "../test-utils";
import { MonzoClient, PAGE_SIZE } from "./monzo-client";

function connectedCtx(handler: Parameters<typeof makeCtx>[0]) {
  const t = makeCtx(handler);
  t.secrets.set(SECRET_ACCESS_TOKEN, "acc");
  t.secrets.set(SECRET_REFRESH_TOKEN, "ref");
  t.secrets.set(SECRET_CLIENT_SECRET, "sec");
  t.storage.set(KEY_CLIENT_ID, "cid");
  t.storage.set(KEY_REDIRECT_URL, "https://localhost/cb");
  t.storage.set(KEY_EXPIRES_AT, String(Date.now() + 3_600_000));
  return t;
}

/** n transactions with strictly increasing created times and ids. */
function makeTxs(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => {
    const k = offset + i;
    return tx({
      id: `tx_${String(k).padStart(6, "0")}`,
      created: new Date(Date.UTC(2026, 0, 1) + k * 60_000).toISOString(),
    });
  });
}

describe("MonzoClient.getAccounts", () => {
  it("lists open accounts through the broker with a bearer secretKey (no Authorization header)", async () => {
    const t = connectedCtx({
      handler: () =>
        json(200, {
          accounts: [
            { id: "acc_1", type: "uk_retail" },
            { id: "acc_2", type: "uk_monzo_flex" },
            { id: "acc_3", type: "uk_retail", closed: true },
            { id: "acc_4", type: "uk_monzo_flex_backing_loan" },
          ],
        }),
    });
    const accounts = await new MonzoClient(t.ctx).getAccounts();
    expect(accounts.map((a) => a.id)).toEqual(["acc_1", "acc_2"]);
    // The API names the field `type`; it is copied to `account_type` for the rest of the add-on.
    expect(accounts.map((a) => a.account_type)).toEqual(["uk_retail", "uk_monzo_flex"]);
    const req = t.requests[0];
    expect(req.url).toBe("https://api.monzo.com/accounts");
    expect(req.auth).toEqual({ type: "bearer", secretKey: "monzo_access_token" });
    expect(Object.keys(req.headers ?? {}).map((h) => h.toLowerCase())).not.toContain("authorization");
  });

  it("refuses to call Monzo when not connected", async () => {
    const t = makeCtx({ handler: () => json(200, {}) });
    await expect(new MonzoClient(t.ctx).getAccounts()).rejects.toMatchObject({ kind: "not-connected" });
    expect(t.requests).toHaveLength(0);
  });
});

describe("MonzoClient.getTransactions pagination", () => {
  it("pages 100 at a time, advancing `since` to the newest id, and expands the merchant", async () => {
    const all = makeTxs(250);
    const t = connectedCtx({
      handler: (req: FakeRequest) => {
        const u = new URL(req.url);
        expect(u.pathname).toBe("/transactions");
        const since = u.searchParams.get("since");
        const start = since ? all.findIndex((x) => x.id === since) + 1 : 0;
        return json(200, { transactions: all.slice(start, start + Number(u.searchParams.get("limit"))) });
      },
    });
    const pages: number[] = [];
    const got = await new MonzoClient(t.ctx).getTransactions("acc_1", undefined, (n) => pages.push(n));

    expect(got.map((x) => x.id)).toEqual(all.map((x) => x.id));
    expect(t.requests).toHaveLength(3);
    expect(pages).toEqual([100, 200, 250]);

    const urls = t.requests.map((r) => new URL(r.url));
    expect(urls.map((u) => u.searchParams.get("since"))).toEqual([null, all[99].id, all[199].id]);
    for (const u of urls) {
      expect(u.searchParams.get("account_id")).toBe("acc_1");
      expect(u.searchParams.get("limit")).toBe(String(PAGE_SIZE));
      expect(u.searchParams.get("expand[]")).toBe("merchant");
    }
  });

  it("starts from a timestamp watermark when given one", async () => {
    const t = connectedCtx({ handler: () => json(200, { transactions: makeTxs(3) }) });
    await new MonzoClient(t.ctx).getTransactions("acc_1", "2026-04-01T00:00:00.000Z");
    expect(new URL(t.requests[0].url).searchParams.get("since")).toBe("2026-04-01T00:00:00.000Z");
    expect(t.requests).toHaveLength(1);
  });

  it("stops after a full page followed by an empty one", async () => {
    const page = makeTxs(100);
    let calls = 0;
    const t = connectedCtx({ handler: () => json(200, { transactions: calls++ === 0 ? page : [] }) });
    const got = await new MonzoClient(t.ctx).getTransactions("acc_1");
    expect(got).toHaveLength(100);
    expect(t.requests).toHaveLength(2);
  });

  it("does not loop forever if the cursor stops advancing", async () => {
    const page = makeTxs(100);
    const t = connectedCtx({ handler: () => json(200, { transactions: page }) });
    const got = await new MonzoClient(t.ctx).getTransactions("acc_1");
    expect(got).toHaveLength(100);
    expect(t.requests).toHaveLength(2);
  });
});

describe("MonzoClient auth handling", () => {
  it("refreshes once on 401, then retries the call", async () => {
    let apiCalls = 0;
    const t = connectedCtx({
      handler: (req) => {
        if (req.url.endsWith("/oauth2/token")) {
          return json(200, { access_token: "acc-2", refresh_token: "ref-2", expires_in: 21600 });
        }
        return apiCalls++ === 0 ? json(401, { code: "unauthorized" }) : json(200, { accounts: [{ id: "a", type: "uk_retail" }] });
      },
    });
    const accounts = await new MonzoClient(t.ctx).getAccounts();
    expect(accounts).toHaveLength(1);
    expect(t.requests.map((r) => r.url)).toEqual([
      "https://api.monzo.com/accounts",
      "https://api.monzo.com/oauth2/token",
      "https://api.monzo.com/accounts",
    ]);
    expect(t.secrets.get(SECRET_ACCESS_TOKEN)).toBe("acc-2");
    expect(t.secrets.get(SECRET_REFRESH_TOKEN)).toBe("ref-2");
  });

  it("asks to reconnect when the retry is still 401", async () => {
    const t = connectedCtx({
      handler: (req) =>
        req.url.endsWith("/oauth2/token")
          ? json(200, { access_token: "acc-2", refresh_token: "ref-2", expires_in: 100 })
          : json(401, {}),
    });
    await expect(new MonzoClient(t.ctx).getAccounts()).rejects.toMatchObject({ kind: "reconnect" });
    expect(t.requests.filter((r) => r.url.endsWith("/oauth2/token"))).toHaveLength(1);
  });

  it("maps 403 to an actionable Monzo-app-approval error", async () => {
    const t = connectedCtx({ handler: () => json(403, { code: "forbidden.insufficient_permissions" }) });
    const err = await new MonzoClient(t.ctx).getAccounts().catch((e) => e);
    expect(err.kind).toBe("approval");
    expect(err.message).toMatch(/Monzo app.*approve/i);
  });

  it("refreshes ahead of time when the token is about to expire", async () => {
    const t = connectedCtx({
      handler: (req) =>
        req.url.endsWith("/oauth2/token")
          ? json(200, { access_token: "fresh", refresh_token: "ref-2", expires_in: 21600 })
          : json(200, { accounts: [] }),
    });
    t.storage.set(KEY_EXPIRES_AT, String(Date.now() + 60_000));
    await new MonzoClient(t.ctx).getAccounts();
    expect(t.requests.map((r) => r.url)).toEqual([
      "https://api.monzo.com/oauth2/token",
      "https://api.monzo.com/accounts",
    ]);
  });
});
