/**
 * Wealthfolio 3.11's `activities.import` answers 200 even when it saves nothing (see the kit's
 * `host-import.ts`). These run the Monzo import and sync against the kit's fake 3.11 host, which
 * stores only what a real one would, and check that a row the host did not store is reported and
 * not remembered as imported, so the next sync imports it.
 */
import type { ActivityImport } from "@wealthfolio/addon-sdk";
import type { ImportLedger } from "@wf-addons/kit";
import { FakeWealthfolio } from "@wf-addons/kit/testing";
import { describe, expect, it } from "vitest";
import {
  KEY_AUTHENTICATED_AT,
  KEY_EXPIRES_AT,
  KEY_IMPORTED_IDS,
  KEY_LAST_SYNC,
  KEY_MAPPING,
  KEY_RECHECKED_90_DAYS,
  KEY_REFUSED,
  SECRET_ACCESS_TOKEN,
} from "../constants";
import { json, tx } from "../test-utils";
import type { MonzoTransaction } from "../types";
import { importCsvFiles } from "./csv-import";
import { mapTransactionToActivity } from "./mapper";
import { importNew, resetSyncHistory, runSync } from "./sync";

const ACC = "wf-1";
const host = () => new FakeWealthfolio([{ id: ACC, name: "Monzo Current", currency: "GBP" }]);
const ledgerOf = (h: FakeWealthfolio) => JSON.parse(h.storage.get(KEY_IMPORTED_IDS) ?? "{}") as ImportLedger;
const BAD = 777; // pence: the row the host refuses in these tests
const isBad = (a: ActivityImport) => Number(a.amount) === 7.77;

const txs = () => [
  tx({ amount: -350, description: "Coffee" }),
  tx({ amount: -BAD, description: "Bad row" }),
  tx({ amount: -1200, description: "Lunch" }),
];
const rowsOf = (list: MonzoTransaction[]) => list.map((t) => mapTransactionToActivity(t, ACC));

describe("importNew when the host does not store every row", () => {
  it("a call refused as a whole: the rest is stored, the bad row is reported and absent from the ledger, and the next import stores it", async () => {
    const h = host();
    h.importValidation = (a) => (isBad(a) ? "Invalid date" : null);
    const list = txs();

    const first = await importNew(h.ctx, ACC, rowsOf(list));
    expect(first.imported).toBe(2);
    expect(first.unsaved.map((u) => [u.activity.id, u.reason])).toEqual([[list[1].id, "Invalid date"]]);
    expect(Object.keys(ledgerOf(h)).sort()).toEqual([list[0].id, list[2].id].sort());
    expect(h.rows(ACC)).toHaveLength(2);

    h.importValidation = () => null;
    const second = await importNew(h.ctx, ACC, rowsOf(list));
    expect(second).toMatchObject({ imported: 1, duplicates: 2, unsaved: [] });
    expect(h.rows(ACC)).toHaveLength(3);
    expect(Object.keys(ledgerOf(h))).toHaveLength(3);
  });

  it("a row the writer policy refuses is reported and not recorded, and is imported once the host accepts it", async () => {
    const h = host();
    h.policy = (a) => (isBad(a) ? "Preparation failed" : null);
    const list = txs();

    const first = await importNew(h.ctx, ACC, rowsOf(list));
    expect(first.imported).toBe(2);
    expect(first.unsaved).toHaveLength(1);
    expect(first.unsaved[0].reason).toBe("Preparation failed");
    expect(ledgerOf(h)[list[1].id]).toBeUndefined();

    h.policy = () => null;
    expect(await importNew(h.ctx, ACC, rowsOf(list))).toMatchObject({ imported: 1, unsaved: [] });
    expect(h.rows(ACC)).toHaveLength(3);
  });

  it("a 200 that stored nothing records nothing and reports every row", async () => {
    const h = host();
    h.storeNothing = true;
    const list = txs();

    const first = await importNew(h.ctx, ACC, rowsOf(list));
    expect(first.imported).toBe(0);
    expect(first.unsaved).toHaveLength(3);
    expect(ledgerOf(h)).toEqual({});

    h.storeNothing = false;
    expect(await importNew(h.ctx, ACC, rowsOf(list))).toMatchObject({ imported: 3, unsaved: [] });
    expect(h.rows(ACC)).toHaveLength(3);
  });
});

/**
 * A connected add-on whose Monzo API serves `list`, like the real one: only what was created
 * since the `since` it is asked for. `asked` records every `since`.
 */
function connected(h: FakeWealthfolio, list: MonzoTransaction[]) {
  const asked: (string | null)[] = [];
  (h.ctx.api.network as { request: unknown }).request = async (req: { url: string }) => {
    const url = new URL(req.url);
    if (url.pathname === "/accounts") {
      const r = json(200, { accounts: [{ id: "acc_00001", type: "uk_retail" }] });
      return { status: r.status, headers: {}, body: r.body ?? "" };
    }
    const since = url.searchParams.get("since");
    asked.push(since);
    const from = since ? Date.parse(since) : 0;
    const r = json(200, { transactions: list.filter((t) => Number.isNaN(from) || Date.parse(t.created) >= from) });
    return { status: r.status, headers: {}, body: r.body ?? "" };
  };
  h.secrets.set(SECRET_ACCESS_TOKEN, "acc");
  h.storage.set(KEY_EXPIRES_AT, String(Date.now() + 3_600_000));
  h.storage.set(KEY_AUTHENTICATED_AT, "0");
  h.storage.set(KEY_MAPPING, JSON.stringify({ acc_00001: ACC }));
  return asked;
}

const recent = () => {
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  return [
    tx({ amount: -350, description: "Coffee", created: day(3) }),
    tx({ amount: -BAD, description: "Bad row", created: day(3) }),
    tx({ amount: -1200, description: "Lunch", created: day(2) }),
  ];
};
const refusedOf = (h: FakeWealthfolio) => JSON.parse(h.storage.get(KEY_REFUSED) ?? '{"entries":[]}') as { entries: { id: string; attempts: number; reason: string }[] };

describe("runSync when the host refuses a row on every call", () => {
  it("moves the watermark on, keeps the row in its own list and retries only it, keeps the error until the host accepts it, then imports it once", async () => {
    const h = host();
    h.policy = (a) => (isBad(a) ? "Preparation failed" : null);
    const list = recent();
    const asked = connected(h, list);

    const first = await runSync(h.ctx);
    expect(first.imported).toBe(2);
    expect(first.error).toMatch(/1 row is refused by Wealthfolio/);
    expect(first.error).toContain("Preparation failed");
    expect(first.log!.join("\n")).toContain("Preparation failed");
    // The watermark and the 90-day re-check moved on: nothing holds them back.
    const watermark = JSON.parse(h.storage.get(KEY_LAST_SYNC) ?? "null") as string | null;
    expect(watermark).not.toBeNull();
    expect(h.storage.get(KEY_RECHECKED_90_DAYS)).toBe("true");
    expect(refusedOf(h).entries.map((e) => [e.id, e.attempts])).toEqual([[list[1].id, 1]]);

    for (const attempts of [2, 3]) {
      const calls = h.importCalls.length;
      const again = await runSync(h.ctx);
      // The history is not read again, and only the refused row is sent.
      expect(Date.parse(asked.at(-1)!)).toBeGreaterThanOrEqual(Date.parse(watermark!));
      expect(h.importCalls.slice(calls).map((c) => c.sentIds)).toEqual([[list[1].id]]);
      expect(again.imported).toBe(0);
      expect(again.error).toMatch(/1 row is refused by Wealthfolio/);
      expect(refusedOf(h).entries[0].attempts).toBe(attempts);
    }
    expect(h.rows(ACC)).toHaveLength(2);

    h.policy = () => null;
    const fixed = await runSync(h.ctx);
    expect(fixed.imported).toBe(1);
    expect(fixed.error).toBeUndefined();
    expect(h.storage.has(KEY_REFUSED)).toBe(false);
    expect(h.rows(ACC)).toHaveLength(3);

    const calls = h.importCalls.length;
    await runSync(h.ctx);
    expect(h.importCalls).toHaveLength(calls); // nothing left to send
    expect(h.rows(ACC)).toHaveLength(3);
  });

  it("a host that answers 200 and stores nothing is an error, and every row waits in the list", async () => {
    const h = host();
    h.storeNothing = true;
    connected(h, recent());

    const result = await runSync(h.ctx);
    expect(result.imported).toBe(0);
    expect(result.error).toMatch(/3 rows are refused by Wealthfolio/);
    expect(refusedOf(h).entries).toHaveLength(3);
    expect(h.storage.get(KEY_LAST_SYNC)).toBeDefined();

    h.storeNothing = false;
    const next = await runSync(h.ctx);
    expect(next.imported).toBe(3);
    expect(next.error).toBeUndefined();
    expect(h.storage.has(KEY_REFUSED)).toBe(false);
  });

  it("Reset forgets the list with the watermark", async () => {
    const h = host();
    h.storeNothing = true;
    connected(h, recent());
    await runSync(h.ctx);
    expect(h.storage.has(KEY_REFUSED)).toBe(true);
    await resetSyncHistory(h.ctx);
    expect(h.storage.has(KEY_REFUSED)).toBe(false);
  });
});

describe("importCsvFiles when the host does not store every row", () => {
  it("reports the unsaved rows as the file's error and keeps them out of the ledger", async () => {
    const h = host();
    h.policy = (a) => (isBad(a) ? "Preparation failed" : null);
    const list = txs();

    const [out] = await importCsvFiles(h.ctx, [{ name: "march.csv", accountId: ACC, transactions: list }]);
    expect(out.imported).toBe(2);
    expect(out.error).toMatch(/1 row was not saved by Wealthfolio/);
    expect(out.error).toContain("Preparation failed");
    expect(ledgerOf(h)[list[1].id]).toBeUndefined();

    h.policy = () => null;
    const [again] = await importCsvFiles(h.ctx, [{ name: "march.csv", accountId: ACC, transactions: list }]);
    expect(again).toMatchObject({ imported: 1, duplicates: 2 });
    expect(again.error).toBeUndefined();
  });
});
