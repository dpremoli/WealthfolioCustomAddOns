import { describe, expect, it, vi } from "vitest";
import {
  KEY_AUTHENTICATED_AT,
  KEY_CATEGORY_LABELS,
  KEY_EXPIRES_AT,
  KEY_LAST_RESULT,
  KEY_LAST_RUN,
  KEY_LAST_SYNC,
  KEY_MAPPING,
  KEY_RECHECKED_90_DAYS,
  SECRET_ACCESS_TOKEN,
} from "../constants";
import { json, makeCtx, tx } from "../test-utils";
import type { MonzoTransaction } from "../types";
import {
  HISTORY_LIMIT_MS,
  isEligible,
  importNew,
  loadLastSyncView,
  normaliseLegacyCash,
  pendingHoldBack,
  resetSyncHistory,
  runSync,
  saveLastSyncView,
  syncSince,
  type LastSyncView,
} from "./sync";
import { mapTransactionToActivity } from "./mapper";
import { BUSY_MESSAGE, isBusy } from "./busy";
import { importCsvFiles } from "./csv-import";

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
    expect(comments[1]).toBe("Unexpanded | Eating Out");
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
    t.storage.set(KEY_RECHECKED_90_DAYS, "true");
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

  /** A connected add-on whose single Monzo account opened `openedDaysAgo` days ago. */
  function setupOpened(openedDaysAgo: number | undefined, handler: (u: URL) => ReturnType<typeof json>) {
    const created =
      openedDaysAgo === undefined ? undefined : new Date(Date.now() - openedDaysAgo * 86_400_000).toISOString();
    const t = makeCtx({
      wfAccounts: [{ id: WF_ACC, name: "Monzo Current" }],
      handler: (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/accounts") {
          return json(200, { accounts: [{ id: MONZO_ACC, type: "uk_retail", created }] });
        }
        return handler(u);
      },
    });
    t.secrets.set(SECRET_ACCESS_TOKEN, "acc");
    t.storage.set(KEY_EXPIRES_AT, String(Date.now() + 3_600_000));
    t.storage.set(KEY_MAPPING, JSON.stringify({ [MONZO_ACC]: WF_ACC }));
    return t;
  }
  const txParams = (t: ReturnType<typeof makeCtx>, name: string) =>
    t.requests.filter((r) => r.url.includes("/transactions")).map((r) => new URL(r.url).searchParams.get(name));
  const daysAgo = (iso: string | null) => (Date.now() - Date.parse(iso!)) / 86_400_000;

  it("asks for the whole history on a first sync and falls back to 90 days when refused", async () => {
    // Monzo outside the 5-minute window: 403 for anything 90 or more days back.
    const t = setupOpened(300, (u) =>
      daysAgo(u.searchParams.get("since")) >= 90
        ? json(403, { code: "forbidden.verification_required" })
        : json(200, { transactions: [tx()] }),
    );
    const result = await runSync(t.ctx);
    expect(result.imported).toBe(1);
    const sinces = txParams(t, "since");
    // The newest slice is read first and is refused outright; then the last 90 days.
    expect(daysAgo(sinces[0])).toBeCloseTo(180, 0);
    expect(daysAgo(sinces[1])).toBeLessThan(90);
    expect(sinces).toHaveLength(2);
    expect(result.log?.join("\n")).toMatch(/refused full history/);
  });

  it("never asks Monzo without `since`, which would return only the last 30 days", async () => {
    for (const opened of [300, 30, undefined]) {
      const t = setupOpened(opened, () => json(200, { transactions: [tx()] }));
      await runSync(t.ctx);
      const sinces = txParams(t, "since");
      expect(sinces.length).toBeGreaterThan(0);
      expect(sinces.every((s) => s !== null)).toBe(true);
    }
  });

  it("reads a long history in slices Monzo accepts when it is allowed to", async () => {
    const t = setupOpened(500, () => json(200, { transactions: [tx()] }));
    const result = await runSync(t.ctx);
    const sinces = txParams(t, "since");
    const befores = txParams(t, "before");
    expect(sinces).toHaveLength(3);
    // Newest slice first (open-ended), then older ones bounded by `before`.
    expect(daysAgo(sinces.at(-1)!)).toBeCloseTo(500, 0);
    expect(befores[0]).toBeNull();
    expect(daysAgo(sinces[0])).toBeLessThan(181);
    // Every slice is well under Monzo's one-year cap.
    befores.slice(1).forEach((b, i) => expect(daysAgo(sinces[i + 1]) - daysAgo(b)).toBeLessThanOrEqual(181));
    expect(result.log?.join("\n")).toMatch(/3 fetched \(back to \d{4}-\d{2}-\d{2}\)/);
  });

  it("after resetting the sync history, fetches the 31-89 day old transactions the old no-`since` request missed", async () => {
    // Monzo's three rules: no `since` -> last 30 days only; `since` 90+ days back -> 403;
    // otherwise everything from `since`, oldest first.
    const ages = [5, 20, 40, 60, 85, 95, 110, 120];
    const history = ages.map((d) =>
      tx({ id: `tx_age${d}`, description: `Shop ${d}d`, created: new Date(Date.now() - d * 86_400_000).toISOString() }),
    );
    const t = setupOpened(200, (u) => {
      const since = u.searchParams.get("since");
      if (since && daysAgo(since) >= 90) return json(403, { code: "forbidden.verification_required" });
      const from = since ? Date.parse(since) : Date.now() - 30 * 86_400_000;
      const found = history.filter((h) => Date.parse(h.created) >= from).sort((a, b) => a.created.localeCompare(b.created));
      return json(200, { transactions: found.slice(0, 100) });
    });
    const ageOf = (a: Record<string, unknown>) => Math.round(daysAgo((a.date as Date).toISOString()));

    // An earlier sync a few days ago left a watermark; this one fetches only what is newer.
    t.storage.set(KEY_LAST_SYNC, JSON.stringify(new Date(Date.now() - 10 * 86_400_000).toISOString()));
    t.storage.set(KEY_RECHECKED_90_DAYS, "true");
    expect((await runSync(t.ctx)).imported).toBe(1);
    await saveLastSyncView(t.ctx, { result: { imported: 1, skipped: 0, duplicates: 0 }, steps: [] });

    await resetSyncHistory(t.ctx);
    expect(t.storage.has(KEY_LAST_SYNC)).toBe(false);
    expect(t.storage.has(KEY_LAST_RESULT)).toBe(false);

    t.requests.length = 0;
    const result = await runSync(t.ctx);
    // 20, 40, 60 and 85 days old are new; 5 days old is already there; 95+ days is out of reach.
    expect(result.imported).toBe(4);
    expect(result.duplicates).toBe(1);
    expect(t.activities.get(WF_ACC)!.map(ageOf).sort((a, b) => a - b)).toEqual([5, 20, 40, 60, 85]);
    // Never a request without `since`, which Monzo would answer with the last 30 days.
    const sinces = txParams(t, "since");
    expect(sinces.length).toBeGreaterThan(0);
    expect(sinces.every((s) => s !== null)).toBe(true);
    expect(daysAgo(sinces.at(-1)!)).toBeLessThan(90);
  });

  it("logs how far back an incomplete history reached", async () => {
    // Monzo shares the two newest slices, then stops (the window closes part-way).
    const t = setupOpened(500, (u) =>
      daysAgo(u.searchParams.get("since")) > 400
        ? json(403, { code: "forbidden.verification_required" })
        : json(200, { transactions: [tx({ created: "2026-05-01T12:00:00.000Z" })] }),
    );
    const result = await runSync(t.ctx);
    expect(result.imported).toBe(2);
    expect(result.log?.join("\n")).toMatch(/stopped sharing history part-way, so only back to 2026-05-01 was fetched\. CSV import covers the rest/);
    expect(result.log?.join("\n")).not.toMatch(/refused full history/);
  });

  it("treats a 400 on the full-history request like the 403: last 90 days instead, and says so", async () => {
    const t = setupOpened(500, (u) =>
      daysAgo(u.searchParams.get("since")) >= 90
        ? json(400, { code: "bad_request.invalid_time_range" })
        : json(200, { transactions: [tx()] }),
    );
    const result = await runSync(t.ctx);
    expect(result.imported).toBe(1);
    expect(daysAgo(txParams(t, "since").at(-1)!)).toBeLessThan(90);
    expect(result.log?.join("\n")).toMatch(/refused full history/);
  });

  it("says when an account has no opening date and is limited to 90 days", async () => {
    const t = setupOpened(undefined, () => json(200, { transactions: [tx()] }));
    const result = await runSync(t.ctx);
    expect(result.log?.join("\n")).toMatch(/no opening date, so it is limited to the last 90 days/);
  });

  it("re-checks the last 90 days once for a watermark from an earlier version, then goes back to incremental", async () => {
    const watermark = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const t = setupOpened(300, () => json(200, { transactions: [tx()] }));
    t.storage.set(KEY_LAST_SYNC, JSON.stringify(watermark));
    expect(t.storage.has(KEY_RECHECKED_90_DAYS)).toBe(false);

    const first = await runSync(t.ctx);
    expect(daysAgo(txParams(t, "since")[0])).toBeCloseTo(89, 0);
    expect(txParams(t, "before")[0]).toBeNull();
    expect(first.log?.join("\n")).toMatch(/One-off re-check of the last 90 days/);
    expect(JSON.parse(t.storage.get(KEY_RECHECKED_90_DAYS)!)).toBe(true);

    t.requests.length = 0;
    const second = await runSync(t.ctx);
    expect(daysAgo(txParams(t, "since")[0])).toBeLessThan(1);
    expect(second.log?.join("\n")).not.toMatch(/re-check/);
  });

  it("does not set the re-check flag when the sync fails", async () => {
    const t = setupOpened(300, () => json(404, {}));
    t.storage.set(KEY_LAST_SYNC, JSON.stringify(new Date(Date.now() - 10 * 86_400_000).toISOString()));
    await expect(runSync(t.ctx)).rejects.toThrow();
    expect(t.storage.has(KEY_RECHECKED_90_DAYS)).toBe(false);
  });

  it("sets the re-check flag on a first sync, which already covers those 90 days", async () => {
    const t = setupOpened(300, () => json(200, { transactions: [tx()] }));
    await runSync(t.ctx);
    expect(JSON.parse(t.storage.get(KEY_RECHECKED_90_DAYS)!)).toBe(true);
    // Reset: the flag stays, and the next sync is a full one because the watermark is gone.
    await resetSyncHistory(t.ctx);
    expect(JSON.parse(t.storage.get(KEY_RECHECKED_90_DAYS)!)).toBe(true);
  });

  it("asks for the whole history right after authenticating, even with a watermark", async () => {
    const t = setupOpened(300, () => json(200, { transactions: [tx()] }));
    t.storage.set(KEY_LAST_SYNC, JSON.stringify(new Date(Date.now() - 10 * 86_400_000).toISOString()));
    t.storage.set(KEY_RECHECKED_90_DAYS, "true");
    t.storage.set(KEY_AUTHENTICATED_AT, String(Date.now() - 60_000));
    const result = await runSync(t.ctx);
    // Slices from the account's opening date (300 days ago): 180 days, then the other 120.
    expect(txParams(t, "since")).toHaveLength(2);
    expect(daysAgo(txParams(t, "since").at(-1)!)).toBeCloseTo(300, 0);
    expect(result.log?.join("\n")).toMatch(/You connected a moment ago/);
  });

  it("does not read the whole history again once the login is well over 15 minutes old", async () => {
    const watermark = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const t = setupOpened(300, () => json(200, { transactions: [tx()] }));
    t.storage.set(KEY_LAST_SYNC, JSON.stringify(watermark));
    t.storage.set(KEY_RECHECKED_90_DAYS, "true");
    t.storage.set(KEY_AUTHENTICATED_AT, String(Date.now() - 30 * 60_000));
    await runSync(t.ctx);
    expect(txParams(t, "since")).toEqual([watermark]);
  });

  it("does not treat a login time in the future (a clock that moved) as just logged in", async () => {
    const watermark = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const t = setupOpened(300, () => json(200, { transactions: [tx()] }));
    t.storage.set(KEY_LAST_SYNC, JSON.stringify(watermark));
    t.storage.set(KEY_RECHECKED_90_DAYS, "true");
    t.storage.set(KEY_AUTHENTICATED_AT, String(Date.now() + 3_600_000));
    await runSync(t.ctx);
    expect(txParams(t, "since")).toEqual([watermark]);
  });

  it("does not import the same transaction twice after its notes change", async () => {
    const before = tx({ id: "tx_same", notes: "" });
    const t = setup([before]);
    await runSync(t.ctx);
    t.state.handler = (req) =>
      new URL(req.url).pathname === "/accounts"
        ? json(200, { accounts: [{ id: MONZO_ACC, type: "uk_retail" }] })
        : json(200, { transactions: [{ ...before, notes: "split with Sam" }] });
    const result = await runSync(t.ctx);
    expect(result.imported).toBe(0);
    // The existing row is rewritten with the new note instead.
    expect(t.activities.get(WF_ACC)).toHaveLength(1);
    expect(t.activities.get(WF_ACC)![0].comment).toBe("Coffee | Eating Out | Note: split with Sam");
    expect(result.log?.join("\n")).toMatch(/1 updated/);
  });

  it("turns a refund an older version imported as a deposit into a REFUND credit", async () => {
    const refund = tx({ amount: 285, category: "holidays", description: "TRAINLINE", merchant: { name: "Trainline" } });
    const t = setup([refund]);
    t.activities.set(WF_ACC, [
      {
        id: "act-1",
        accountId: WF_ACC,
        activityType: "DEPOSIT",
        date: new Date(refund.created),
        amount: "2.85",
        currency: "GBP",
        comment: "Trainline | Holidays [ref:" + refund.id + "]",
        assetSymbol: "$CASH-GBP",
      },
    ]);
    const updates: { activityType?: string; subtype?: string | null }[] = [];
    const saveMany = t.ctx.api.activities.saveMany.bind(t.ctx.api.activities);
    (t.ctx.api.activities as unknown as Record<string, unknown>).saveMany = async (req: { updates?: [] }) => {
      updates.push(...(req.updates ?? []));
      return saveMany(req as never);
    };
    const result = await runSync(t.ctx);
    expect(result.imported).toBe(0);
    expect(updates.at(-1)).toMatchObject({ activityType: "CREDIT", subtype: "REFUND" });
  });

  it("renames a transfer imported by an older version after its payee, without importing it twice", async () => {
    const transfer = tx({
      description: "Dennis Premoli",
      category: "personal_care",
      merchant: null,
      counterparty: { name: "Sheffield Springers Volleyball Club" },
    });
    const t = setup([transfer]);
    t.activities.set(WF_ACC, [
      {
        id: "act-1",
        accountId: WF_ACC,
        activityType: "WITHDRAWAL",
        date: new Date(transfer.created),
        amount: String(Math.abs(transfer.amount) / 100),
        currency: "GBP",
        comment: "Dennis Premoli | Personal Care",
        assetSymbol: "$CASH-GBP",
      },
    ]);
    const result = await runSync(t.ctx);
    expect(result.imported).toBe(0);
    expect(t.activities.get(WF_ACC)).toHaveLength(1);
    expect(t.activities.get(WF_ACC)![0].comment).toMatch(/^Sheffield Springers Volleyball Club \| Personal Care/);
  });

  it("strips the [ref:…] tags older versions wrote, and still recognises those rows", async () => {
    const old = tx({ id: "tx_old" });
    const t = setup([old]);
    t.activities.set(WF_ACC, [
      {
        id: "act-1",
        accountId: WF_ACC,
        activityType: "WITHDRAWAL",
        date: new Date(old.created),
        amount: String(Math.abs(old.amount) / 100),
        currency: "GBP",
        comment: "Coffee | Eating Out [ref:tx_old]",
        assetSymbol: "$CASH-GBP",
      },
    ]);
    const result = await runSync(t.ctx);
    expect(t.activities.get(WF_ACC)![0].comment).toBe("Coffee | Eating Out");
    expect(result.imported).toBe(0);
    expect(result.log?.join("\n")).toMatch(/Removed the \[ref:…\] tag from 1/);
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

describe("runSync payee names", () => {
  it("drops a reference that is just the account holder's own name", async () => {
    const t = setup([
      tx({
        description: "Dennis Premoli",
        category: "personal_care",
        merchant: null,
        counterparty: { name: "Sheffield Springers Volleyball Club" },
      }),
    ]);
    t.state.handler = (req) =>
      new URL(req.url).pathname === "/accounts"
        ? json(200, {
            accounts: [{ id: MONZO_ACC, type: "uk_retail", owners: [{ user_id: "user_1", preferred_name: "Dennis Premoli" }] }],
          })
        : json(200, {
            transactions: [
              tx({ description: "Dennis Premoli", category: "personal_care", merchant: null, counterparty: { name: "Sheffield Springers Volleyball Club" } }),
            ],
          });
    await runSync(t.ctx);
    expect(t.importCalls[0][0].comment).toBe("Sheffield Springers Volleyball Club | Personal Care");
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

describe("runSync recreated accounts", () => {
  it("imports into a recreated account even though the transactions were imported before", async () => {
    const t = setup([tx({ id: "tx_a" }), tx({ id: "tx_b" })]);
    await runSync(t.ctx);
    expect(t.activities.get(WF_ACC)).toHaveLength(2);

    // The user deletes the Wealthfolio account; the add-on maps Monzo to a new one.
    t.wfAccounts.length = 0;
    t.wfAccounts.push({ id: "wf-new", name: "Monzo Current" });
    t.storage.set(KEY_MAPPING, JSON.stringify({ [MONZO_ACC]: "wf-new" }));
    t.storage.delete(KEY_LAST_SYNC);
    const result = await runSync(t.ctx);
    expect(result.imported).toBe(2);
    expect(t.activities.get("wf-new")).toHaveLength(2);
  });
});

describe("runSync account types", () => {
  it("warns when a mapped account is not a type Wealthfolio's Spending counts", async () => {
    const t = setup([tx()]);
    (t.wfAccounts[0] as unknown as Record<string, unknown>).accountType = "SECURITIES";
    const result = await runSync(t.ctx);
    expect(result.log?.join("\n")).toMatch(/Warning: "Monzo Current" is a Securities account.*Change it to Cash/);
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

describe("last sync view", () => {
  const view: LastSyncView = {
    result: { imported: 3, skipped: 0, duplicates: 1, breakdown: { Groceries: 2 }, log: ["x"], finishedAt: "2026-05-01T12:00:00.000Z" },
    steps: [
      { phase: "fetch", message: "Fetching transactions…", ts: "2026-05-01T12:00:00.000Z", status: "done" },
      { phase: "done", message: "Synced 3 transactions.", ts: "2026-05-01T12:00:01.000Z", status: "done" },
    ],
  };

  it("round-trips through storage", async () => {
    const t = makeCtx();
    expect(await loadLastSyncView(t.ctx)).toBeNull();
    await saveLastSyncView(t.ctx, view);
    expect(await loadLastSyncView(t.ctx)).toEqual(view);
  });

  it("ignores anything stored that is not a view", async () => {
    const t = makeCtx();
    for (const junk of ["not json", "null", "42", "{}", '{"result":{"imported":"3"},"steps":[]}', '{"result":{"imported":3}}', '{"steps":[]}']) {
      t.storage.set(KEY_LAST_RESULT, junk);
      expect(await loadLastSyncView(t.ctx)).toBeNull();
    }
  });

  it("never throws when storage fails, so a good sync stays a good sync", async () => {
    const t = makeCtx();
    t.ctx.api.storage.set = async () => {
      throw new Error("disk full");
    };
    await expect(saveLastSyncView(t.ctx, view)).resolves.toBeUndefined();
  });
});

/** Two Monzo accounts opened 300 days ago, mapped to two Wealthfolio accounts. */
function setupTwo(handler: (u: URL, account: string) => ReturnType<typeof json>) {
  const created = new Date(Date.now() - 300 * 86_400_000).toISOString();
  const events: string[] = [];
  const t = makeCtx({
    wfAccounts: [
      { id: "wf-1", name: "Current" },
      { id: "wf-2", name: "Joint" },
    ],
    handler: (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/accounts") {
        return json(200, {
          accounts: [
            { id: "acc_A", type: "uk_retail", created },
            { id: "acc_B", type: "uk_retail", created },
          ],
        });
      }
      events.push(`fetch:${u.searchParams.get("account_id")}`);
      return handler(u, u.searchParams.get("account_id")!);
    },
  });
  t.secrets.set(SECRET_ACCESS_TOKEN, "acc");
  t.storage.set(KEY_EXPIRES_AT, String(Date.now() + 3_600_000));
  t.storage.set(KEY_MAPPING, JSON.stringify({ acc_A: "wf-1", acc_B: "wf-2" }));
  const getAll = t.ctx.api.activities.getAll.bind(t.ctx.api.activities);
  t.ctx.api.activities.getAll = async (id) => {
    events.push(`getAll:${id}`);
    return getAll(id);
  };
  const imp = t.ctx.api.activities.import.bind(t.ctx.api.activities);
  t.ctx.api.activities.import = async (batch) => {
    events.push(`import:${batch[0].accountId}`);
    return imp(batch);
  };
  return { ...t, events };
}

const ageDays = (iso: string | null) => (Date.now() - Date.parse(iso!)) / 86_400_000;

describe("runSync with several accounts", () => {
  it("falls back to 90 days for both when Monzo refuses full history, asking for it only once", async () => {
    const t = setupTwo((u, acc) =>
      ageDays(u.searchParams.get("since")) >= 90
        ? json(403, { code: "forbidden.verification_required" })
        : json(200, { transactions: [tx({ description: `Shop ${acc}` })] }),
    );
    const result = await runSync(t.ctx);

    const txReqs = t.requests.filter((r) => r.url.includes("/transactions")).map((r) => new URL(r.url));
    expect(txReqs.every((u) => u.searchParams.get("since") !== null)).toBe(true);
    const forAccount = (acc: string) => txReqs.filter((u) => u.searchParams.get("account_id") === acc);
    // Account A tries its full history (refused), then 89 days; B goes straight to 89 days.
    expect(forAccount("acc_A").map((u) => Math.round(ageDays(u.searchParams.get("since")))).slice(-1)).toEqual([89]);
    expect(forAccount("acc_A")).toHaveLength(2);
    expect(forAccount("acc_B")).toHaveLength(1);
    expect(Math.round(ageDays(forAccount("acc_B")[0].searchParams.get("since")))).toBe(89);
    expect(t.activities.get("wf-1")).toHaveLength(1);
    expect(t.activities.get("wf-2")).toHaveLength(1);
    expect(result.log?.filter((l) => /refused full history/.test(l))).toHaveLength(1);
  });

  it("fetches every account before importing, tidying or reconciling any of them", async () => {
    const t = setupTwo(() => json(200, { transactions: [tx()] }));
    await runSync(t.ctx);
    const lastFetch = t.events.map((e) => e.startsWith("fetch:")).lastIndexOf(true);
    const firstOther = t.events.findIndex((e) => !e.startsWith("fetch:"));
    expect(lastFetch).toBeGreaterThanOrEqual(0);
    expect(firstOther).toBeGreaterThan(lastFetch);
    expect(t.events.filter((e) => e.startsWith("import:")).sort()).toEqual(["import:wf-1", "import:wf-2"]);
  });

  it("reports the fetch phase for all accounts, then the import phase", async () => {
    const t = setupTwo(() => json(200, { transactions: [tx()] }));
    const phases: string[] = [];
    await runSync(t.ctx, (p) => phases.push(`${p.phase}${p.current ? `:${p.current}/${p.total}` : ""}`));
    const lastFetch = phases.map((p) => p.startsWith("fetch")).lastIndexOf(true);
    expect(phases).toContain("fetch:1/2");
    expect(phases).toContain("fetch:2/2");
    expect(phases.findIndex((p) => p === "import")).toBeGreaterThan(lastFetch);
  });
});

describe("one sync or import at a time", () => {
  /** A connected add-on whose transactions call waits for `release()`. */
  function gated() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = makeCtx({
      wfAccounts: [{ id: WF_ACC, name: "Monzo Current" }],
      handler: async (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/accounts") return json(200, { accounts: [{ id: MONZO_ACC, type: "uk_retail" }] });
        await gate;
        return json(200, { transactions: [tx({ id: "tx_once" })] });
      },
    });
    t.secrets.set(SECRET_ACCESS_TOKEN, "acc");
    t.storage.set(KEY_EXPIRES_AT, String(Date.now() + 3_600_000));
    t.storage.set(KEY_MAPPING, JSON.stringify({ [MONZO_ACC]: WF_ACC }));
    return { ...t, release };
  }
  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };

  it("rejects a second sync while one runs, and imports nothing twice", async () => {
    const t = gated();
    const first = runSync(t.ctx);
    await waitFor(() => t.requests.some((r) => r.url.includes("/transactions")));
    expect(isBusy()).toBe(true);

    await expect(runSync(t.ctx)).rejects.toThrow(BUSY_MESSAGE);
    t.release();
    expect((await first).imported).toBe(1);
    expect(t.activities.get(WF_ACC)).toHaveLength(1);
    expect(t.importCalls).toHaveLength(1);
    expect(isBusy()).toBe(false);
  });

  it("rejects a CSV import while a sync runs, and a sync while a CSV import runs", async () => {
    const t = gated();
    const sync = runSync(t.ctx);
    await waitFor(() => t.requests.some((r) => r.url.includes("/transactions")));
    await expect(
      importCsvFiles(t.ctx, [{ name: "a.csv", accountId: WF_ACC, transactions: [tx()] }]),
    ).rejects.toThrow(BUSY_MESSAGE);
    t.release();
    await sync;
    expect(t.importCalls).toHaveLength(1);

    // And the other way round.
    const slow = makeCtx({ wfAccounts: [{ id: WF_ACC, name: "Monzo Current" }] });
    const realImport = slow.ctx.api.activities.import;
    let unblock!: () => void;
    const hold = new Promise<void>((r) => (unblock = r));
    slow.ctx.api.activities.import = async (batch) => {
      await hold;
      return realImport(batch);
    };
    const csv = importCsvFiles(slow.ctx, [{ name: "a.csv", accountId: WF_ACC, transactions: [tx()] }]);
    await waitFor(() => isBusy());
    await expect(runSync(slow.ctx)).rejects.toThrow(BUSY_MESSAGE);
    unblock();
    expect((await csv)[0].imported).toBe(1);
    expect(isBusy()).toBe(false);
  });

  it("clears the flag after a failure too, so the next run can start", async () => {
    const t = setup([tx()]);
    t.storage.delete(KEY_MAPPING);
    await expect(runSync(t.ctx)).rejects.toThrow(/mapping/i);
    expect(isBusy()).toBe(false);
    t.storage.set(KEY_MAPPING, JSON.stringify({ [MONZO_ACC]: WF_ACC }));
    expect((await runSync(t.ctx)).imported).toBe(1);
    expect(isBusy()).toBe(false);
  });
});
