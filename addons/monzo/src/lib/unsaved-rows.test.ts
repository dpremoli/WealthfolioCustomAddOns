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
  SECRET_ACCESS_TOKEN,
} from "../constants";
import { json, tx } from "../test-utils";
import type { MonzoTransaction } from "../types";
import { importCsvFiles } from "./csv-import";
import { mapTransactionToActivity } from "./mapper";
import { importNew, runSync } from "./sync";

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

/** A connected add-on whose Monzo API serves `list` for the one mapped account. */
function connected(h: FakeWealthfolio, list: MonzoTransaction[]) {
  (h.ctx.api.network as { request: unknown }).request = async (req: { url: string }) => {
    const r = new URL(req.url).pathname === "/accounts" ? json(200, { accounts: [{ id: "acc_00001", type: "uk_retail" }] }) : json(200, { transactions: list });
    return { status: r.status, headers: {}, body: r.body ?? "" };
  };
  h.secrets.set(SECRET_ACCESS_TOKEN, "acc");
  h.storage.set(KEY_EXPIRES_AT, String(Date.now() + 3_600_000));
  h.storage.set(KEY_AUTHENTICATED_AT, "0");
  h.storage.set(KEY_MAPPING, JSON.stringify({ acc_00001: ACC }));
}

describe("runSync when the host does not store every row", () => {
  it("reports the unsaved row in the result and log, holds the watermark, and the next sync imports it", async () => {
    const h = host();
    h.importValidation = (a) => (isBad(a) ? "Invalid date" : null);
    const list = txs();
    connected(h, list);

    const first = await runSync(h.ctx);
    expect(first.imported).toBe(2);
    expect(first.error).toMatch(/1 row was not saved by Wealthfolio/);
    expect(first.error).toContain("Invalid date");
    expect(first.log!.join("\n")).toContain("Invalid date");
    // The watermark did not move, so what is missing is read again.
    expect(h.storage.get(KEY_LAST_SYNC)).toBeUndefined();
    expect(h.storage.get(KEY_RECHECKED_90_DAYS)).toBeUndefined();

    h.importValidation = () => null;
    const second = await runSync(h.ctx);
    expect(second.error).toBeUndefined();
    expect(second.imported).toBe(1);
    expect(h.rows(ACC)).toHaveLength(3);
    expect(h.storage.get(KEY_LAST_SYNC)).toBeDefined();
  });

  it("a host that answers 200 and stores nothing is an error, never a successful sync", async () => {
    const h = host();
    h.storeNothing = true;
    connected(h, txs());

    const result = await runSync(h.ctx);
    expect(result.imported).toBe(0);
    expect(result.error).toMatch(/3 rows were not saved/);
    expect(h.storage.get(KEY_LAST_SYNC)).toBeUndefined();
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
