import { describe, expect, it } from "vitest";
import { ledgerEntry, selectNewActivities, type ImportLedger } from "@wf-addons/kit";
import { KEY_IMPORTED_IDS } from "../constants";
import { makeCtx, type FakeAccount } from "../test-utils";
import type { RevolutTransaction } from "../types";
import { parseRevolutCsv } from "./csv-parser";
import { importRows, importStatement, revolutAccountIds } from "./import";
import { mapTransactionToActivity, openingBalanceActivity } from "./mapper";

const HEADER = "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance";
const statement = (...rows: string[]) => parseRevolutCsv([HEADER, ...rows].join("\n"));
/** One completed row: `when` is "YYYY-MM-DD HH:MM:SS". */
const row = (type: string, when: string, description: string, amount: number, currency: string, balance: number) =>
  `${type},Current,${when},${when},${description},${amount},0,${currency},COMPLETED,${balance}`;

const MAPPING = { GBP: "wf-gbp", EUR: "wf-eur" };
const ACCOUNTS: FakeAccount[] = [
  { id: "wf-gbp", name: "Revolut GBP", currency: "GBP" },
  { id: "wf-eur", name: "Revolut EUR", currency: "EUR" },
];
const accounts = (...more: FakeAccount[]) => [...ACCOUNTS, ...more];

const JAN = [
  row("Topup", "2024-01-02 09:00:00", "Payment from Employer", 2000, "GBP", 2100),
  row("Card Payment", "2024-01-05 12:00:00", "Coffee", -3, "GBP", 2097),
  row("Card Payment", "2024-01-05 12:00:00", "Coffee", -3, "GBP", 2094),
  row("Card Payment", "2024-01-06 10:00:00", "Carrefour", -12.3, "EUR", 87.7),
];
const FEB = [
  row("Card Payment", "2024-02-01 08:00:00", "Tesco", -20, "GBP", 2074),
  row("Card Payment", "2024-02-03 18:00:00", "Uber", -8.5, "GBP", 2065.5),
];

/** What versions before 2.1 did: match by content against the account, force-import the rest. */
async function legacyImport(t: ReturnType<typeof makeCtx>, txs: RevolutTransaction[]) {
  for (const [currency, accountId] of Object.entries(MAPPING)) {
    const subset = txs.filter((tx) => tx.currency === currency);
    if (subset.length === 0) continue;
    const opening = openingBalanceActivity(subset, accountId);
    const movements = subset.flatMap((tx) => mapTransactionToActivity(tx, accountId));
    const desired = opening ? [opening, ...movements] : movements;
    const toImport = selectNewActivities(desired, await t.ctx.api.activities.getAll(accountId));
    if (toImport.length > 0) await t.ctx.api.activities.import(toImport);
  }
}

const ledgerOf = (t: ReturnType<typeof makeCtx>) => JSON.parse(t.storage.get(KEY_IMPORTED_IDS) ?? "{}") as ImportLedger;
const rowsIn = (t: ReturnType<typeof makeCtx>, accountId: string) => t.activities.get(accountId) ?? [];

describe("importStatement", () => {
  it("imports each currency into its own account, keeping genuine repeats", async () => {
    const t = makeCtx({ wfAccounts: accounts() });
    const out = await importStatement(t.ctx, statement(...JAN), MAPPING);
    // GBP: opening balance + top-up + two coffees; EUR: opening balance + one payment.
    expect(out).toMatchObject({ imported: 6, updated: 0, duplicates: 0 });
    expect(rowsIn(t, "wf-gbp").filter((r) => r.comment === "Coffee")).toHaveLength(2);
    expect(rowsIn(t, "wf-eur")).toHaveLength(2);
    expect(Object.keys(ledgerOf(t))).toHaveLength(6);
    expect(t.importCalls.flat().every((a) => a.forceImport)).toBe(true);
  });

  it("adds nothing when the same or an overlapping statement is imported again", async () => {
    const t = makeCtx({ wfAccounts: accounts() });
    await importStatement(t.ctx, statement(...JAN), MAPPING);
    expect(await importStatement(t.ctx, statement(...JAN), MAPPING)).toMatchObject({ imported: 0, duplicates: 6 });
    const overlap = await importStatement(t.ctx, statement(...JAN.slice(1), ...FEB), MAPPING);
    // Tesco and Uber; the GBP part starts later, so it also seeds a different opening balance (a
    // known caveat of opening balances), while the EUR part starts where it did and adds nothing.
    expect(overlap.imported).toBe(3);
    expect(rowsIn(t, "wf-gbp").filter((r) => r.comment === "Tesco")).toHaveLength(1);
  });

  it("recognises rows imported by older versions (no ledger yet) instead of duplicating them", async () => {
    const t = makeCtx({ wfAccounts: accounts() });
    await legacyImport(t, statement(...JAN));
    expect(t.storage.has(KEY_IMPORTED_IDS)).toBe(false);
    const before = rowsIn(t, "wf-gbp").length + rowsIn(t, "wf-eur").length;

    const out = await importStatement(t.ctx, statement(...JAN, ...FEB), MAPPING);
    expect(out).toMatchObject({ imported: 2, updated: 0, duplicates: 6 });
    expect(rowsIn(t, "wf-gbp").length + rowsIn(t, "wf-eur").length).toBe(before + 2);
    // Every row is in the ledger now, so the next import matches by id.
    expect(Object.keys(ledgerOf(t))).toHaveLength(8);
    expect(await importStatement(t.ctx, statement(...JAN, ...FEB), MAPPING)).toMatchObject({ imported: 0 });
  });

  it("does not re-import a row after it was converted to a transfer and linked", async () => {
    const t = makeCtx({ wfAccounts: accounts() });
    const txs = statement(...JAN);
    await importStatement(t.ctx, txs, MAPPING);
    const coffee = rowsIn(t, "wf-gbp").find((r) => r.comment === "Coffee")!;
    coffee.activityType = "TRANSFER_OUT";
    t.links.push([coffee.id, "elsewhere"]);
    expect(await importStatement(t.ctx, txs, MAPPING)).toMatchObject({ imported: 0, updated: 0 });
    expect(coffee.activityType).toBe("TRANSFER_OUT"); // left as the user made it
  });

  it("takes an old row converted to a transfer before the ledger existed for the same move", async () => {
    const t = makeCtx({ wfAccounts: accounts() });
    const txs = statement(
      row("Card Payment", "2024-01-10 09:00:00", "Trading 212", -500, "GBP", 1500),
      row("Card Payment", "2024-01-11 09:00:00", "Gym", -30, "GBP", 1470),
    );
    await legacyImport(t, txs);
    const move = rowsIn(t, "wf-gbp").find((r) => r.comment === "Trading 212")!;
    move.activityType = "TRANSFER_OUT"; // linked to Trading 212 by hand or by another add-on
    const out = await importStatement(t.ctx, txs, MAPPING);
    expect(out).toMatchObject({ imported: 0, duplicates: 3 });
    expect(rowsIn(t, "wf-gbp")).toHaveLength(3);
  });

  it("takes a transfer the user entered by hand for a move instead of importing it again", async () => {
    const t = makeCtx({ wfAccounts: accounts() });
    t.addRow({ accountId: "wf-gbp", activityType: "TRANSFER_OUT", amount: 200, currency: "GBP", date: "2024-01-11T00:00:00.000Z", comment: "Savings" });
    const out = await importStatement(
      t.ctx,
      statement(row("Savings", "2024-01-10 09:00:00", "Depositing savings", -200, "GBP", 800)),
      MAPPING,
    );
    // The opening balance is new; the savings move is the hand-made transfer.
    expect(out).toMatchObject({ imported: 1, duplicates: 1 });
    expect(rowsIn(t, "wf-gbp").filter((r) => Number(r.amount) === 200)).toHaveLength(1);
  });

  it("still imports an ordinary payment that happens to match an untracked transfer", async () => {
    const t = makeCtx({ wfAccounts: accounts() });
    t.addRow({ accountId: "wf-gbp", activityType: "TRANSFER_OUT", amount: 30, currency: "GBP", date: "2024-01-11T00:00:00.000Z", comment: "To Sam" });
    const out = await importStatement(t.ctx, statement(row("Card Payment", "2024-01-11 09:00:00", "Gym", -30, "GBP", 0)), MAPPING);
    expect(out.imported).toBe(2);
  });

  it("rewrites a row the add-on now maps differently (stale), and leaves a row the user edited", async () => {
    const t = makeCtx({ wfAccounts: accounts() });
    const [tesco, uber] = statement(...FEB);
    const [want] = mapTransactionToActivity(tesco, "wf-gbp");
    // As an older version would have written it, and the ledger recorded it.
    const old = { ...want, comment: "TESCO STORES" };
    const oldRow = t.addRow(old);
    const [uberWant] = mapTransactionToActivity(uber, "wf-gbp");
    const edited = t.addRow({ ...uberWant, comment: "Taxi home" });
    t.storage.set(
      KEY_IMPORTED_IDS,
      JSON.stringify({ [tesco.id]: ledgerEntry("wf-gbp", old), [uber.id]: ledgerEntry("wf-gbp", uberWant) }),
    );

    const out = await importRows(t.ctx, "wf-gbp", [want, uberWant]);
    expect(out).toEqual({ imported: 0, updated: 1, duplicates: 1 });
    expect(oldRow.comment).toBe("Tesco");
    expect(edited.comment).toBe("Taxi home");
    expect(ledgerOf(t)[tesco.id]).toBe(ledgerEntry("wf-gbp", want));
    // Rewritten once; the next import has nothing to do.
    expect(await importRows(t.ctx, "wf-gbp", [want, uberWant])).toEqual({ imported: 0, updated: 0, duplicates: 2 });
  });

  it("skips currencies without an account", async () => {
    const t = makeCtx({ wfAccounts: accounts() });
    const out = await importStatement(t.ctx, statement(...JAN), { GBP: "wf-gbp" });
    expect(out.imported).toBe(4);
    expect(rowsIn(t, "wf-eur")).toHaveLength(0);
  });
});

describe("importStatement linking", () => {
  const T212: FakeAccount = { id: "wf-t212", name: "Invest", provider: "trading212-addon", providerAccountId: "4098937" };
  const SAVINGS: FakeAccount = { id: "wf-sav", name: "Revolut Savings", currency: "GBP" };
  const STATEMENT = [
    row("Exchange", "2024-03-10 12:00:00", "Exchanged to EUR", -85.46, "GBP", 1000),
    row("Exchange", "2024-03-10 12:00:00", "Exchanged to EUR", 99.2, "EUR", 99.2),
    row("Transfer", "2024-03-11 09:00:00", "To TRADING 212 UK LIMITED", -500, "GBP", 500),
    row("Transfer", "2024-03-12 09:00:00", "Depositing savings", -200, "GBP", 300),
    row("Transfer", "2024-03-20 09:00:00", "Withdrawing savings", 50, "GBP", 350),
  ];

  function setup(...more: FakeAccount[]) {
    const t = makeCtx({ wfAccounts: accounts(...more) });
    const deposit = (accountId: string, amount: number, date: string, comment: string) =>
      t.addRow({ accountId, activityType: "DEPOSIT", amount, currency: "GBP", date, comment });
    return { ...t, deposit };
  }

  it("links exchanges, Trading 212 moves and savings moves, one line each", async () => {
    const t = setup(T212, SAVINGS);
    const t212In = t.deposit("wf-t212", 500, "2024-03-12T00:00:00.000Z", "Deposit");
    const savedIn = t.deposit("wf-sav", 200, "2024-03-12T00:00:00.000Z", "Deposit");
    const out = await importStatement(t.ctx, statement(...STATEMENT), MAPPING, { savingsAccountId: "wf-sav" });
    expect(out.notes).toEqual([
      "Exchanges: 1 linked.",
      "Moves to and from Trading 212: 1 linked.",
      "Moves to and from Revolut Savings: 1 linked.",
    ]);
    expect(t.links).toHaveLength(3);
    expect(t212In.activityType).toBe("TRANSFER_IN");
    expect(savedIn.activityType).toBe("TRANSFER_IN");
    // "Withdrawing savings" has no counterpart in the savings account, so it stays as it is.
    const back = rowsIn(t, "wf-gbp").find((r) => r.comment === "Withdrawing savings")!;
    expect(await t.ctx.api.activities.getTransferPair(back.id)).toBeNull();

    // Importing again adds and links nothing more.
    const again = await importStatement(t.ctx, statement(...STATEMENT), MAPPING, { savingsAccountId: "wf-sav" });
    expect(again.imported).toBe(0);
    expect(t.links).toHaveLength(3);
  });

  it("converts a savings move imported as a withdrawal, and keeps recognising it afterwards", async () => {
    const t = setup(SAVINGS);
    t.deposit("wf-sav", 200, "2024-03-12T00:00:00.000Z", "Deposit");
    const rows = statement(row("Savings", "2024-03-12 09:00:00", "Depositing savings", -200, "GBP", 300));
    const out = await importStatement(t.ctx, rows, MAPPING, { savingsAccountId: "wf-sav" });
    expect(out.notes).toContain("Moves to and from Revolut Savings: 1 linked.");
    const move = rowsIn(t, "wf-gbp").find((r) => r.comment === "Depositing savings")!;
    expect(move.activityType).toBe("TRANSFER_OUT");
    expect(await importStatement(t.ctx, rows, MAPPING, { savingsAccountId: "wf-sav" })).toMatchObject({ imported: 0 });
  });

  it("only reports the kinds that apply", async () => {
    const t = setup();
    const out = await importStatement(t.ctx, statement(...STATEMENT), MAPPING);
    expect(out.notes).toEqual(["Exchanges: 1 linked."]);
    // No savings account chosen: the savings moves stay as Revolut wrote them.
    expect(t.saves).toEqual([]);
  });

  it("says so when there is nothing to link with Trading 212 or the savings account", async () => {
    const t = setup(T212, SAVINGS);
    const out = await importStatement(t.ctx, statement(...STATEMENT.slice(0, 2)), MAPPING, { savingsAccountId: "wf-sav" });
    expect(out.notes).toEqual([
      "Exchanges: 1 linked.",
      "Moves to and from Trading 212: none to link.",
      "Moves to and from Revolut Savings: none to link.",
    ]);
  });
});

describe("revolutAccountIds", () => {
  it("covers every account the add-on imported into or maps, that still exists", async () => {
    const t = makeCtx();
    t.storage.set(KEY_IMPORTED_IDS, JSON.stringify({ a: "wf-usd:1", b: "wf-gone:2", c: "wf-gbp:3" }));
    const ids = await revolutAccountIds(t.ctx, { EUR: "wf-eur" }, [{ id: "wf-gbp" }, { id: "wf-eur" }, { id: "wf-usd" }, { id: "x" }]);
    expect(ids).toEqual(["wf-gbp", "wf-eur", "wf-usd"]);
  });
});
