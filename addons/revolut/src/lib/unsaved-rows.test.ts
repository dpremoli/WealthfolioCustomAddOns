/**
 * Wealthfolio 3.11's `activities.import` answers 200 even when it stores nothing (see the kit's
 * `host-import.ts`). These run the Revolut import against the kit's fake 3.11 host and check that
 * a row the host did not store is reported and not remembered as imported, so the next import
 * stores it.
 */
import type { ActivityImport } from "@wealthfolio/addon-sdk";
import type { ImportLedger } from "@wf-addons/kit";
import { FakeWealthfolio } from "@wf-addons/kit/testing";
import { describe, expect, it } from "vitest";
import { KEY_IMPORTED_IDS, KEY_REFUSED } from "../constants";
import { parseRevolutCsv } from "./csv-parser";
import { importStatement } from "./import";

const HEADER = "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance";
const row = (type: string, when: string, description: string, amount: number, balance: number) =>
  `${type},Current,${when},${when},${description},${amount},0,GBP,COMPLETED,${balance}`;
const statement = () =>
  parseRevolutCsv(
    [
      HEADER,
      row("Topup", "2024-01-02 09:00:00", "Payment from Employer", 2000, 2100),
      row("Card Payment", "2024-01-05 12:00:00", "Coffee", -3, 2097),
      row("Card Payment", "2024-01-06 10:00:00", "Tesco", -20, 2077),
    ].join("\n"),
  );
const MAPPING = { GBP: "wf-gbp" };
const host = () => new FakeWealthfolio([{ id: "wf-gbp", name: "Revolut GBP", currency: "GBP" }]);
const ledgerOf = (h: FakeWealthfolio) => JSON.parse(h.storage.get(KEY_IMPORTED_IDS) ?? "{}") as ImportLedger;
const isTesco = (a: ActivityImport) => Number(a.amount) === 20;
const idsOf = (h: FakeWealthfolio) => Object.keys(ledgerOf(h));

describe("importStatement when the host does not store every row", () => {
  it("a call refused as a whole: the rest is stored, the bad row is reported and not recorded, and the next import stores it", async () => {
    const h = host();
    h.importValidation = (a) => (isTesco(a) ? "Invalid date" : null);

    const first = await importStatement(h.ctx, statement(), MAPPING);
    const stored = h.rows("wf-gbp").length;
    expect(first.unsaved).toHaveLength(1);
    expect(first.unsaved[0].reason).toBe("Invalid date");
    expect(first.error).toMatch(/1 row is refused by Wealthfolio/);
    expect(first.imported).toBe(stored);
    expect(idsOf(h)).toHaveLength(stored); // every recorded id is a stored row
    expect(idsOf(h)).not.toContain(first.unsaved[0].activity.id);

    h.importValidation = () => null;
    const second = await importStatement(h.ctx, statement(), MAPPING);
    expect(second).toMatchObject({ imported: 1, unsaved: [] });
    expect(second.error).toBeUndefined();
    expect(h.rows("wf-gbp")).toHaveLength(stored + 1);
  });

  it("a row the writer policy refuses is reported and imported by the next import", async () => {
    const h = host();
    h.policy = (a) => (isTesco(a) ? "Preparation failed" : null);

    const first = await importStatement(h.ctx, statement(), MAPPING);
    expect(first.unsaved.map((u) => u.reason)).toEqual(["Preparation failed"]);
    expect(first.error).toContain("Preparation failed");

    h.policy = () => null;
    expect(await importStatement(h.ctx, statement(), MAPPING)).toMatchObject({ imported: 1, unsaved: [] });
  });

  it("a 200 that stored nothing is an error with nothing recorded, and the next import stores everything", async () => {
    const h = host();
    h.storeNothing = true;

    const first = await importStatement(h.ctx, statement(), MAPPING);
    expect(first.imported).toBe(0);
    expect(first.unsaved.length).toBeGreaterThan(0);
    expect(first.error).toMatch(/rows are refused by Wealthfolio/);
    expect(ledgerOf(h)).toEqual({});

    h.storeNothing = false;
    const second = await importStatement(h.ctx, statement(), MAPPING);
    expect(second.imported).toBe(first.unsaved.length);
    expect(second.unsaved).toEqual([]);
  });
});

const refusedOf = (h: FakeWealthfolio) => JSON.parse(h.storage.get(KEY_REFUSED) ?? '{"entries":[]}') as { entries: { id: string; attempts: number }[] };
const later = () =>
  parseRevolutCsv([HEADER, row("Card Payment", "2024-02-03 18:00:00", "Uber", -8.5, 2068.5)].join("\n"));

describe("importStatement when the host refuses a row on every call", () => {
  it("keeps the row in its own list, sends it again with every import (alone when the statement has nothing new), keeps the error, and stores it once the host accepts it", async () => {
    const h = host();
    h.policy = (a) => (isTesco(a) ? "Preparation failed" : null);

    const first = await importStatement(h.ctx, statement(), MAPPING);
    const refusedId = first.unsaved[0].activity.id;
    expect(refusedOf(h).entries.map((e) => [e.id, e.attempts])).toEqual([[refusedId, 1]]);

    // A statement with other rows: the refused one rides along.
    const calls = h.importCalls.length;
    const second = await importStatement(h.ctx, later(), MAPPING);
    expect(h.importCalls).toHaveLength(calls + 1);
    expect(h.importCalls.at(-1)!.sentIds).toContain(refusedId);
    expect(h.importCalls.at(-1)!.sentIds.length).toBeGreaterThan(1); // the new rows, with the refused one
    expect(second.error).toMatch(/1 row is refused by Wealthfolio/);
    expect(refusedOf(h).entries[0].attempts).toBe(2);

    // The same statement again: only the refused row is sent.
    const third = await importStatement(h.ctx, later(), MAPPING);
    expect(h.importCalls.at(-1)!.sentIds).toEqual([refusedId]);
    expect(third.error).toBeDefined();
    expect(refusedOf(h).entries[0].attempts).toBe(3);

    h.policy = () => null;
    const stored = h.rows("wf-gbp").length;
    const fixed = await importStatement(h.ctx, later(), MAPPING);
    expect(fixed.imported).toBe(1);
    expect(fixed.error).toBeUndefined();
    expect(h.storage.has(KEY_REFUSED)).toBe(false);
    expect(h.rows("wf-gbp")).toHaveLength(stored + 1);
  });

  it("retries a refused row of a currency the statement does not contain", async () => {
    const h = new FakeWealthfolio([
      { id: "wf-gbp", name: "Revolut GBP", currency: "GBP" },
      { id: "wf-eur", name: "Revolut EUR", currency: "EUR" },
    ]);
    h.policy = (a) => (isTesco(a) ? "Preparation failed" : null);
    await importStatement(h.ctx, statement(), { GBP: "wf-gbp", EUR: "wf-eur" });
    expect(refusedOf(h).entries).toHaveLength(1);

    h.policy = () => null;
    const eur = parseRevolutCsv([HEADER, "Card Payment,Current,2024-03-01 10:00:00,2024-03-01 10:00:00,Carrefour,-5,0,EUR,COMPLETED,95"].join("\n"));
    const out = await importStatement(h.ctx, eur, { GBP: "wf-gbp", EUR: "wf-eur" });
    expect(out.error).toBeUndefined();
    expect(h.storage.has(KEY_REFUSED)).toBe(false);
    expect(h.rows("wf-gbp").some((r) => r.amount === 20)).toBe(true);
  });
});
