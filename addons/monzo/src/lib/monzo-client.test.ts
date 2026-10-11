import { describe, expect, it } from "vitest";
import { KEY_EXPIRES_AT, SECRET_ACCESS_TOKEN, SECRET_CLIENT_SECRET, SECRET_REFRESH_TOKEN, KEY_CLIENT_ID, KEY_REDIRECT_URL } from "../constants";
import { json, makeCtx, tx, type FakeRequest } from "../test-utils";
import { HISTORY_SLICE_MS, MonzoClient, PAGE_SIZE } from "./monzo-client";

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

/**
 * A fake Monzo `GET /transactions` over `all`: oldest first, `since` (a time or a transaction
 * id) and `before` both exclusive, `refuse` answering a request with an error status.
 */
function fakeMonzo(all: ReturnType<typeof tx>[], refuse: (u: URL) => number | null = () => null) {
  const sorted = [...all].sort((a, b) => a.created.localeCompare(b.created));
  return (req: FakeRequest) => {
    const u = new URL(req.url);
    const status = refuse(u);
    if (status) return json(status, { code: "refused" });
    const since = u.searchParams.get("since");
    const before = u.searchParams.get("before");
    let found = sorted;
    if (since?.startsWith("tx_")) found = found.slice(found.findIndex((x) => x.id === since) + 1);
    else if (since) found = found.filter((x) => x.created > since);
    if (before) found = found.filter((x) => x.created < before);
    return json(200, { transactions: found.slice(0, Number(u.searchParams.get("limit"))) });
  };
}

describe("MonzoClient.getHistory", () => {
  const now = new Date("2026-10-11T00:00:00.000Z");
  const from = new Date(now.getTime() - 2.5 * HISTORY_SLICE_MS);
  const at = (ms: number) => new Date(ms).toISOString();
  const sinceOf = (r: FakeRequest) => new URL(r.url).searchParams.get("since")!;
  const beforeOf = (r: FakeRequest) => new URL(r.url).searchParams.get("before");

  it("reads newest slice first and returns each transaction once, oldest first, including ones on a slice boundary", async () => {
    // Exactly on the two slice boundaries (now - 1 and 2 slices): with `since` and `before`
    // both exclusive, only the one-second overlap between neighbouring slices finds them.
    const times = [
      from.getTime() + 1000,
      now.getTime() - 2 * HISTORY_SLICE_MS,
      now.getTime() - 1.5 * HISTORY_SLICE_MS,
      now.getTime() - HISTORY_SLICE_MS,
      now.getTime() - 1000,
    ];
    const all = times.map((ms, i) => tx({ id: `tx_b${i}`, created: at(ms) }));
    const t = connectedCtx({ handler: fakeMonzo(all) });
    const got = await new MonzoClient(t.ctx).getHistory("acc_1", from, now);

    expect(got.complete).toBe(true);
    expect(got.transactions.map((x) => x.id)).toEqual(all.map((x) => x.id));
    expect(t.requests).toHaveLength(3);
    // Newest slice first and open-ended; older ones bounded by the slice above them.
    expect(t.requests.map(beforeOf)).toEqual([null, at(now.getTime() - HISTORY_SLICE_MS), at(now.getTime() - 2 * HISTORY_SLICE_MS)]);
    expect(t.requests.map(sinceOf)).toEqual([
      at(now.getTime() - HISTORY_SLICE_MS - 1000),
      at(now.getTime() - 2 * HISTORY_SLICE_MS - 1000),
      at(from.getTime() - 1000),
    ]);
    for (const r of t.requests.slice(1)) {
      expect(Date.parse(beforeOf(r)!) - Date.parse(sinceOf(r))).toBeLessThanOrEqual(HISTORY_SLICE_MS + 1000);
    }
  });

  it("returns the newer slices, marked incomplete, when an older slice is refused", async () => {
    const all = [0.5, 1.2, 2.2].map((k, i) =>
      tx({ id: `tx_r${i}`, created: at(now.getTime() - k * HISTORY_SLICE_MS) }),
    );
    for (const status of [403, 400]) {
      // Refuse anything reaching more than 2.2 slices back (only the oldest slice does).
      const t = connectedCtx({
        handler: fakeMonzo(all, (u) =>
          now.getTime() - Date.parse(u.searchParams.get("since")!) > 2.2 * HISTORY_SLICE_MS ? status : null,
        ),
      });
      const got = await new MonzoClient(t.ctx).getHistory("acc_1", from, now);
      expect(got.complete).toBe(false);
      expect(got.transactions.map((x) => x.id)).toEqual(["tx_r1", "tx_r0"]);
    }
  });

  it("throws when the first slice is refused, so the caller can fall back", async () => {
    const t = connectedCtx({ handler: fakeMonzo([tx()], () => 403) });
    await expect(new MonzoClient(t.ctx).getHistory("acc_1", from, now)).rejects.toMatchObject({ kind: "approval" });
    expect(t.requests).toHaveLength(1);

    const t400 = connectedCtx({ handler: fakeMonzo([tx()], () => 400) });
    await expect(new MonzoClient(t400.ctx).getHistory("acc_1", from, now)).rejects.toMatchObject({ status: 400 });
  });

  it("rethrows any other error, even after a slice succeeded", async () => {
    const t = connectedCtx({
      handler: fakeMonzo([], (u) => (beforeOfUrl(u) ? 404 : null)),
    });
    await expect(new MonzoClient(t.ctx).getHistory("acc_1", from, now)).rejects.toMatchObject({ status: 404 });
  });

  it("returns every transaction of a `before`-bounded slice that needs several pages", async () => {
    // 250 transactions in the second-newest slice: paged by transaction id, `before` kept.
    const base = now.getTime() - 1.9 * HISTORY_SLICE_MS;
    const all = Array.from({ length: 250 }, (_, i) =>
      tx({ id: `tx_p${String(i).padStart(3, "0")}`, created: at(base + i * 60_000) }),
    );
    const t = connectedCtx({ handler: fakeMonzo(all) });
    const got = await new MonzoClient(t.ctx).getHistory("acc_1", from, now);

    expect(got.transactions.map((x) => x.id)).toEqual(all.map((x) => x.id));
    const bounded = t.requests.filter((r) => beforeOf(r) === at(now.getTime() - HISTORY_SLICE_MS));
    expect(bounded.map((r) => sinceOf(r).startsWith("tx_"))).toEqual([false, true, true]);
    expect(bounded.every((r) => beforeOf(r) !== null)).toBe(true);
  });

  it("never goes back past 2015, whatever opening date it is given", async () => {
    const t = connectedCtx({ handler: fakeMonzo([]) });
    const got = await new MonzoClient(t.ctx).getHistory("acc_1", new Date("0001-01-01T00:00:00Z"), now);
    expect(got).toEqual({ transactions: [], complete: true });
    // About 4,300 days at 180 per request.
    expect(t.requests.length).toBeLessThanOrEqual(25);
    const oldest = Math.min(...t.requests.map((r) => Date.parse(sinceOf(r))));
    expect(oldest).toBeGreaterThanOrEqual(Date.UTC(2015, 0, 1) - 1000);
  });
});

const beforeOfUrl = (u: URL) => u.searchParams.get("before");

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
