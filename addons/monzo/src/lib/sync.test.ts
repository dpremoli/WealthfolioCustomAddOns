import { describe, expect, it, vi } from "vitest";
import {
  KEY_CATEGORY_LABELS,
  KEY_EXPIRES_AT,
  KEY_LAST_RUN,
  KEY_LAST_SYNC,
  KEY_MAPPING,
  SECRET_ACCESS_TOKEN,
} from "../constants";
import { json, makeCtx, tx } from "../test-utils";
import type { MonzoTransaction } from "../types";
import {
  HISTORY_LIMIT_MS,
  isEligible,
  importNew,
  normaliseLegacyCash,
  pendingHoldBack,
  runSync,
  syncSince,
} from "./sync";
import { mapTransactionToActivity } from "./mapper";

const MONZO_ACC = "acc_00001";
const WF_ACC = "wf-1";

/** A connected add-on whose Monzo API serves `txs` for the single mapped account. */
function setup(txs: MonzoTransaction[], accountType = "uk_retail") {
  const t = makeCtx({
    wfAccounts: [{ id: WF_ACC, name: "Monzo Current" }],
    handler: (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/accounts") return json(200, { accounts: [{ id: MONZO_ACC, type: accountType }] });
      return json(200, { transactions: txs });
    },
  });
  t.secrets.set(SECRET_ACCESS_TOKEN, "acc");
  t.storage.set(KEY_EXPIRES_AT, String(Date.now() + 3_600_000));
  t.storage.set(KEY_MAPPING, JSON.stringify({ [MONZO_ACC]: WF_ACC }));
  return t;
}

describe("runSync reconcile", () => {
  it("imports cash activities with the $CASH-<ccy> symbol, never a bare currency code", async () => {
    const t = setup([tx({ amount: -350 }), tx({ amount: 150000, category: "income", description: "Salary" })]);
    const result = await runSync(t.ctx);
    expect(result.imported).toBe(2);
    const batch = t.importCalls[0];
    expect(batch.map((a) => a.symbol)).toEqual(["$CASH-GBP", "$CASH-GBP"]);
    expect(batch.every((a) => a.symbol !== "GBP")).toBe(true);
    expect(batch.map((a) => a.activityType)).toEqual(["WITHDRAWAL", "DEPOSIT"]);
  });

  it("force-imports genuine identical same-day transactions instead of collapsing them", async () => {
    const same = { created: "2026-05-01T08:00:00.000Z", amount: -350, description: "Coffee" };
    const t = setup([tx({ ...same }), tx({ ...same, created: "2026-05-01T15:00:00.000Z" })]);
    const result = await runSync(t.ctx);
    expect(result.imported).toBe(2);
    expect(t.importCalls[0]).toHaveLength(2);
    expect(t.importCalls[0].every((a) => a.forceImport === true)).toBe(true);
  });

  it("adds nothing when the same data is synced again", async () => {
    const txs = [tx({ amount: -350 }), tx({ amount: -350 }), tx({ amount: -1200, description: "Lunch" })];
    const t = setup(txs);
    await runSync(t.ctx);
    expect(t.importCalls).toHaveLength(1);

    const second = await runSync(t.ctx);
    expect(second.imported).toBe(0);
    expect(second.duplicates).toBe(3);
    expect(t.importCalls).toHaveLength(1); // no second import call
    expect(t.activities.get(WF_ACC)).toHaveLength(3);
  });

  it("imports only the surplus when the fetch overlaps what is already there", async () => {
    const first = [tx({ amount: -350 })];
    const t = setup(first);
    await runSync(t.ctx);
    // Now Monzo reports the original plus a second identical coffee and a new one.
    const handlerTxs = [...first, tx({ amount: -350 }), tx({ amount: -99, description: "Paper" })];
    t.state.handler = (req) => {
      const u = new URL(req.url);
      return u.pathname === "/accounts"
        ? json(200, { accounts: [{ id: MONZO_ACC, type: "uk_retail" }] })
        : json(200, { transactions: handlerTxs });
    };
    const result = await runSync(t.ctx);
    expect(result.imported).toBe(2);
    expect(result.duplicates).toBe(1);
    expect(t.activities.get(WF_ACC)).toHaveLength(3);
  });

  it("reconciles against v1 rows that were imported with a bare currency symbol", async () => {
    const t = setup([]);
    const legacy = mapTransactionToActivity(tx({ amount: -350 }), WF_ACC);
    t.activities.set(WF_ACC, [
      {
        activityType: legacy.activityType,
        date: new Date(legacy.date as string),
        amount: "3.5",
        currency: "GBP",
        comment: legacy.comment,
        assetSymbol: "GBP",
      },
    ]);
    const outcome = await importNew(t.ctx, WF_ACC, [legacy]);
    expect(outcome.imported).toBe(0);
    expect(outcome.duplicates).toBe(1);
  });

  it("skips pending, declined, zero, pot, Flex-repayment and savings transactions", async () => {
    const t = setup([
      tx({ amount: -100 }),
      tx({ amount: -200, settled: "" }), // pending
      tx({ amount: -300, metadata: { provider_category: "uk_retail_pot" } }),
      tx({ amount: -400, category: "transfers", description: "Monzo Flex" }),
      tx({ amount: -500, category: "savings" }),
      tx({ amount: -600, scheme: "uk_retail_pot" }),
      tx({ amount: -700, metadata: { pot_id: "pot_1" } }),
      tx({ amount: -800, decline_reason: "INSUFFICIENT_FUNDS" }),
      tx({ amount: 0 }), // card check
    ]);
    const result = await runSync(t.ctx);
    expect(result.imported).toBe(1);
    expect(t.importCalls[0]).toHaveLength(1);
  });

  it("keeps pending Flex transactions (they never settle)", async () => {
    const t = setup([tx({ amount: -2500, settled: "", description: "Argos" })], "uk_monzo_flex");
    const result = await runSync(t.ctx);
    expect(result.imported).toBe(1);
  });

  it("uses merchant names only when the merchant is expanded", async () => {
    const t = setup([
      tx({ description: "TESCO 123", merchant: { name: "Tesco", address: { city: "Leeds", country: "GB" } } }),
      tx({ amount: -111, description: "Unexpanded", merchant: "merch_0000abc" }),
    ]);
    await runSync(t.ctx);
    const comments = t.importCalls[0].map((a) => a.comment);
    expect(comments[0]).toContain("Tesco | Eating Out | Leeds, GB");
    expect(comments[1]).toMatch(/^Unexpanded \| Eating Out \[ref:tx_\w+\]$/);
  });

  it("applies saved category labels to comments and the breakdown", async () => {
    const t = setup([tx({ category: "eating_out" })]);
    t.storage.set(KEY_CATEGORY_LABELS, JSON.stringify({ eating_out: "Dining" }));
    const result = await runSync(t.ctx);
    expect(t.importCalls[0][0].comment).toContain("Dining");
    expect(result.breakdown).toEqual({ Dining: 1 });
  });
});

describe("runSync watermark", () => {
  it("sends the saved watermark as `since` and rewrites it", async () => {
    const lastSync = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const t = setup([tx()]);
    t.storage.set(KEY_LAST_SYNC, JSON.stringify(lastSync));
    await runSync(t.ctx);
    const txReq = t.requests.find((r) => r.url.includes("/transactions"))!;
    expect(new URL(txReq.url).searchParams.get("since")).toBe(lastSync);
    const written = JSON.parse(t.storage.get(KEY_LAST_SYNC)!);
    expect(Date.parse(written)).toBeGreaterThan(Date.parse(lastSync));
    expect(JSON.parse(t.storage.get(KEY_LAST_RUN)!)).toBeTruthy();
  });

  it("never asks for more than the 90 days Monzo allows on an incremental sync", () => {
    const now = new Date("2026-10-01T00:00:00.000Z");
    expect(syncSince(undefined, now)).toEqual({ since: undefined, clamped: false });
    expect(syncSince("2026-09-01T00:00:00.000Z", now)).toEqual({
      since: "2026-09-01T00:00:00.000Z",
      clamped: false,
    });
    const old = syncSince("2026-01-01T00:00:00.000Z", now);
    expect(old.clamped).toBe(true);
    expect(old.since).toBe(new Date(now.getTime() - HISTORY_LIMIT_MS).toISOString());
  });

  it("tries for full history on a first sync and falls back to 90 days when refused", async () => {
    let first = true;
    const t = makeCtx({
      wfAccounts: [{ id: WF_ACC, name: "Monzo Current" }],
      handler: (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/accounts") return json(200, { accounts: [{ id: MONZO_ACC, type: "uk_retail" }] });
        if (first && !u.searchParams.get("since")) {
          first = false;
          return json(403, { code: "forbidden.verification_required" });
        }
        return json(200, { transactions: [tx()] });
      },
    });
    t.secrets.set(SECRET_ACCESS_TOKEN, "acc");
    t.storage.set(KEY_EXPIRES_AT, String(Date.now() + 3_600_000));
    t.storage.set(KEY_MAPPING, JSON.stringify({ [MONZO_ACC]: WF_ACC }));
    const result = await runSync(t.ctx);
    expect(result.imported).toBe(1);
    const sinces = t.requests
      .filter((r) => r.url.includes("/transactions"))
      .map((r) => new URL(r.url).searchParams.get("since"));
    expect(sinces[0]).toBeNull();
    expect(Date.parse(sinces[1]!)).toBeGreaterThan(Date.now() - 90 * 86_400_000);
    expect(result.log?.join("\n")).toMatch(/refused full history/);
  });

  it("does not import the same transaction twice after its notes change", async () => {
    const before = tx({ id: "tx_same", notes: "" });
    const t = setup([{ ...before, notes: "split with Sam" }]);
    t.activities.set(WF_ACC, [
      {
        activityType: "WITHDRAWAL",
        date: new Date(before.created),
        amount: String(Math.abs(before.amount) / 100),
        currency: "GBP",
        comment: mapTransactionToActivity(before, WF_ACC).comment,
        assetSymbol: "$CASH-GBP",
      },
    ]);
    const result = await runSync(t.ctx);
    expect(result.imported).toBe(0);
    expect(result.duplicates).toBe(1);
  });

  it("holds the watermark back to a still-pending transaction so it is picked up once settled", async () => {
    const pendingCreated = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const t = setup([tx({ settled: "", created: pendingCreated })]);
    await runSync(t.ctx);
    expect(JSON.parse(t.storage.get(KEY_LAST_SYNC)!)).toBe(pendingCreated);
  });

  it("ignores stale or declined pending transactions when holding back", () => {
    const now = new Date("2026-05-20T12:00:00.000Z");
    const stale = tx({ settled: "", created: "2026-05-01T00:00:00.000Z" });
    const declined = tx({ settled: "", created: "2026-05-19T00:00:00.000Z", decline_reason: "INSUFFICIENT_FUNDS" });
    const live = tx({ settled: "", created: "2026-05-18T00:00:00.000Z" });
    expect(pendingHoldBack([stale, declined], now)).toBeNull();
    expect(pendingHoldBack([stale, declined, live], now)).toBe("2026-05-18T00:00:00.000Z");
  });
});

describe("runSync spending categories", () => {
  it("keeps Wealthfolio's categorisation rules in step after importing", async () => {
    const t = setup([tx({ category: "groceries" })]);
    const saveRule = vi.fn(async (r: unknown) => r);
    const rerunRules = vi.fn(async () => 1);
    (t.ctx.api as unknown as Record<string, unknown>).spending = {
      getCategories: async () => [
        { kind: "expense", taxonomyId: "e", categoryId: "c-groc", key: "groceries", name: "Groceries", path: "Groceries" },
      ],
      saveRule,
      rerunRules,
    };
    const result = await runSync(t.ctx);
    expect(saveRule).toHaveBeenCalledWith(expect.objectContaining({ ruleKey: "monzo-groceries", categoryId: "c-groc" }));
    expect(rerunRules).toHaveBeenCalledWith(true);
    expect(result.log?.join("\n")).toMatch(/1 activity categorised/);
  });

  it("still syncs when the Spending API is unavailable", async () => {
    const t = setup([tx()]);
    const result = await runSync(t.ctx);
    expect(result.imported).toBe(1);
    expect(result.log?.join("\n")).toMatch(/Spending categories not updated/);
  });
});

describe("runSync guards", () => {
  it("requires a connection", async () => {
    const t = setup([]);
    t.storage.delete(KEY_EXPIRES_AT);
    await expect(runSync(t.ctx)).rejects.toMatchObject({ kind: "not-connected" });
  });

  it("requires an account mapping", async () => {
    const t = setup([]);
    t.storage.delete(KEY_MAPPING);
    await expect(runSync(t.ctx)).rejects.toThrow(/mapping/i);
  });

  it("fails before importing when a mapped Wealthfolio account was deleted", async () => {
    const t = setup([tx()]);
    t.wfAccounts.length = 0;
    await expect(runSync(t.ctx)).rejects.toThrow(/mapping is out of date/);
    expect(t.importCalls).toHaveLength(0);
  });
});

describe("isEligible / normaliseLegacyCash", () => {
  it("treats a Flex repayment as ineligible but a Flex purchase as eligible", () => {
    expect(isEligible(tx({ category: "transfers", description: "Flex" }), false)).toBe(false);
    expect(isEligible(tx({ category: "shopping", settled: "" }), true)).toBe(true);
    expect(isEligible(tx({ category: "shopping", settled: "" }), false)).toBe(false);
  });

  it("never treats a declined Flex attempt as spending", () => {
    expect(isEligible(tx({ settled: "", decline_reason: "CARD_BLOCKED" }), true)).toBe(false);
  });

  it("only rewrites symbols that equal the row's own currency", () => {
    const out = normaliseLegacyCash([
      { activityType: "DEPOSIT", date: "2026-01-01", currency: "GBP", assetSymbol: "GBP" },
      { activityType: "BUY", date: "2026-01-01", currency: "USD", assetSymbol: "VOO" },
      { activityType: "BUY", date: "2026-01-01", currency: "GBP", assetSymbol: "$CASH-GBP" },
    ]);
    expect(out.map((o) => o.assetSymbol)).toEqual([null, "VOO", "$CASH-GBP"]);
  });
});
