/**
 * End to end against a fake Wealthfolio 3.11 (the kit's `@wf-addons/kit/testing`): a real Trading 212 export goes
 * through the whole sync, and the test counts what the host actually STORES, not what was sent.
 * 2.6.0 and 2.6.1 passed their unit tests while storing no trades at all on a real host, because
 * their fakes accepted whatever the add-on sent.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { runSyncAll, useSync, ledgerAhead } from "./hooks/use-sync";
import { addImportedRefs, fitResult, getImportedRefs } from "./hooks/use-config";
import { FakeWealthfolio, STORAGE_CAP_BYTES } from "@wf-addons/kit/testing";
import type { SyncResult } from "./types";

const HDR =
  "Action,Time,ISIN,Ticker,Name,No. of shares,Price / share,Currency (Price / share),Exchange rate,Total," +
  "Currency (Total),Withholding tax,Currency (Withholding tax),Charge amount,Currency (Charge amount),Notes,ID," +
  "Currency conversion fee,Currency (Currency conversion fee),Merchant name,Merchant category";
const COLS = HDR.split(",");
const row = (cells: Record<string, string | number>) => COLS.map((c) => String(cells[c] ?? "")).join(",");
const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);

const deposit = (id: string, ago: number, amount: number) =>
  row({ Action: "Deposit", Time: `${day(ago)}T08:00:00Z`, Total: amount, "Currency (Total)": "GBP", ID: id });
const trade = (side: "buy" | "sell", id: string, ago: number, sym: string, shares: number, price: number) =>
  row({
    Action: `Market ${side}`, Time: `${day(ago)}T10:00:00Z`, ISIN: `GB00${sym}000001`, Ticker: `${sym}_GB_EQ`, Name: sym,
    "No. of shares": shares, "Price / share": price, "Currency (Price / share)": "GBP", Total: +(shares * price).toFixed(2), "Currency (Total)": "GBP", ID: id,
  });
const dividend = (ago: number, sym: string, shares: number, total: number) =>
  row({
    Action: "Dividend (Ordinary)", Time: `${day(ago)}T06:00:00Z`, ISIN: `GB00${sym}000001`, Ticker: `${sym}_GB_EQ`, Name: sym,
    "No. of shares": shares, "Currency (Price / share)": "GBP", Total: total, "Currency (Total)": "GBP",
  });
const interest = (id: string, ago: number, amount: number) =>
  row({ Action: "Interest on cash", Time: `${day(ago)}T06:00:00Z`, Total: amount, "Currency (Total)": "GBP", ID: id });
const cardDebit = (id: string, ago: number, amount: number) =>
  row({ Action: "Card debit", Time: `${day(ago)}T12:00:00Z`, Total: -amount, "Currency (Total)": "GBP", "Merchant name": "SAINSBURYS", "Merchant category": "RETAIL_STORES", ID: id });

const REPORT = (secret: string) => ({
  reportId: 1,
  status: "Finished",
  downloadLink: `https://test.amazonaws.com/${secret}.csv`,
  timeFrom: "2000-01-01T00:00:00Z",
  timeTo: "2100-01-01T00:00:00Z",
  dataIncluded: { includeDividends: true, includeInterest: true, includeOrders: true, includeTransactions: true },
});
const json = (body: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(body) });

interface Dataset {
  csv: string[]; // one export per connection secret
  positions: { sym: string; qty: number }[];
}

/** Installs a Trading 212 API that serves each connection (told apart by its key) its own export. */
function installTrading212(host: FakeWealthfolio, data: Record<string, Dataset>, cashOf: (secret: string) => number, currencyOf: (secret: string) => string = () => "GBP") {
  const served = new Set<string>();
  /** How many times history was asked for: an export listed or downloaded. */
  const calls = { exports: 0 };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (host.ctx.api as any).network.request = async (req: { url: string; auth?: { secretKey: string } }) => {
    const u = req.url;
    if (u.includes("amazonaws.com") || u.includes("/exports")) calls.exports++;
    if (u.includes("amazonaws.com")) {
      const secret = /\/([^/]+)\.csv/.exec(u)?.[1] ?? "";
      const first = !served.has(secret);
      served.add(secret);
      return { status: 200, headers: {}, body: first ? data[secret].csv.join("\n") : HDR };
    }
    const secret = req.auth?.secretKey ?? "";
    if (u.includes("/exports")) return json([REPORT(secret)]);
    if (u.includes("account/summary")) return json({ id: secret === "t212_auth_inv" ? 11 : 22, currency: currencyOf(secret), cash: { availableToTrade: cashOf(secret) } });
    if (u.includes("/positions")) {
      return json(
        (data[secret]?.positions ?? []).map((p) => ({ instrument: { ticker: `${p.sym}_GB_EQ`, isin: `GB00${p.sym}000001`, name: p.sym, currency: "GBP" }, quantity: p.qty })),
      );
    }
    return json({ items: [], nextPagePath: null });
  };
  return calls;
}

function connect(host: FakeWealthfolio, ids: { id: string; name: string; accountId: string; kind: "invest" | "isa" }[], settings: object = { env: "demo", extractCard: true }) {
  host.storage.set("t212_settings", JSON.stringify(settings));
  host.storage.set("t212_connections", JSON.stringify(ids));
  for (const c of ids) host.secrets.set(`t212_auth_${c.id}`, btoa(`kid-${c.id}:sec`));
}

const refsOf = async (host: FakeWealthfolio, id: string) => getImportedRefs(host.ctx, id);

/** Invest: deposits, trades, dividends, interest, card spending. ISA: deposits, a trade, a dividend. */
function realisticDataset() {
  const inv: string[] = [HDR];
  inv.push(deposit("DEP-A", 300, 5000), deposit("DEP-B", 200, 3000), deposit("DEP-C", 100, 1000));
  for (let i = 0; i < 12; i++) inv.push(trade("buy", `BUY-AAA-${i}`, 280 - i * 10, "AAA", 2, 100 + i));
  for (let i = 0; i < 6; i++) inv.push(trade("buy", `BUY-BBB-${i}`, 270 - i * 10, "BBB", 1.5, 50 + i));
  inv.push(trade("sell", "SELL-AAA-1", 90, "AAA", 4, 130));
  inv.push(dividend(80, "AAA", 20, 12.5), dividend(40, "AAA", 20, 13.5), dividend(60, "BBB", 9, 4.25));
  for (let i = 0; i < 5; i++) inv.push(interest(`INT-${i}`, 30 - i, 0.35 + i / 100));
  for (let i = 0; i < 25; i++) inv.push(cardDebit(`CARD-${i}`, 60 - i, 5 + i));
  const isa: string[] = [HDR, deposit("ISA-DEP-A", 250, 4000), trade("buy", "ISA-BUY-1", 240, "CCC", 3, 200), trade("buy", "ISA-BUY-2", 230, "CCC", 2, 210), dividend(70, "CCC", 5, 6.1)];
  return {
    inv: { csv: inv, positions: [{ sym: "AAA", qty: 24 - 4 }, { sym: "BBB", qty: 9 }] },
    isa: { csv: isa, positions: [{ sym: "CCC", qty: 5 }] },
  };
}

const CONNS = [
  { id: "inv", name: "Trading 212 (Invest)", accountId: "acc-inv", kind: "invest" as const },
  { id: "isa", name: "Trading 212 (ISA)", accountId: "acc-isa", kind: "isa" as const },
];
const ACCOUNTS = [
  { id: "acc-inv", name: "Trading 212 (Invest)", currency: "GBP", trackingMode: "TRANSACTIONS" },
  { id: "acc-isa", name: "Trading 212 (ISA)", currency: "GBP", trackingMode: "TRANSACTIONS" },
];

function setup(opts: { dataset?: ReturnType<typeof realisticDataset> } = {}) {
  const host = new FakeWealthfolio(ACCOUNTS);
  connect(host, CONNS);
  const d = opts.dataset ?? realisticDataset();
  // Trading 212's cash is whatever the stored rows add up to, so only the rows' presence is tested.
  const calls = installTrading212(host, { t212_auth_inv: d.inv, t212_auth_isa: d.isa }, (secret) => host.cash(secret === "t212_auth_inv" ? "acc-inv" : "acc-isa"));
  return { host, d, calls };
}

const refusedList = (host: FakeWealthfolio, id: string): { id: string; reason: string; attempts: number }[] =>
  JSON.parse(host.storage.get(`t212_refused_${id}`) ?? '{"entries":[]}').entries;
const lastSyncOf = (host: FakeWealthfolio, id: string) => JSON.parse(host.storage.get(`t212_sync_${id}`) ?? "{}").lastSync ?? null;

describe("a full backfill against a fake Wealthfolio 3.11", () => {
  it("stores every kind of row — trades, dividends, cash, card spending — and records ids only for stored rows", async () => {
    const { host } = setup();
    const results = await runSyncAll(host.ctx, {});

    for (const r of results.perAccount) expect(r.error, r.log.join("\n")).toBeUndefined();

    const inv = host.countsByType("acc-inv");
    expect(inv).toMatchObject({ DEPOSIT: 3, BUY: 18, SELL: 1, DIVIDEND: 3, INTEREST: 5 });
    expect(host.countsByType("acc-isa")).toEqual({ DEPOSIT: 1, BUY: 2, DIVIDEND: 1 });
    // The card account holds the 25 spends, each with the transfer pair that funds it.
    const cardAccount = host.accounts.find((a) => a.id !== "acc-inv" && a.id !== "acc-isa")!;
    expect(host.countsByType(cardAccount.id).WITHDRAWAL).toBe(25);
    expect(host.countsByType(cardAccount.id).TRANSFER_IN).toBe(25);
    expect(inv.TRANSFER_OUT).toBe(25);

    // Every call the add-on made stored everything it sent: nothing was refused and dropped.
    expect(host.importCalls.length).toBeGreaterThan(0);
    for (const c of host.importCalls) expect(c, JSON.stringify(c)).toMatchObject({ success: true });
    expect(host.importCalls.reduce((n, c) => n + c.stored, 0)).toBe(host.rows().length);

    // Each stored row has exactly one recorded id, and every recorded id is a stored row.
    const invRefs = await refsOf(host, "inv");
    expect(invRefs.size).toBe(host.rows("acc-inv").length + host.rows(cardAccount.id).length);
    expect((await refsOf(host, "isa")).size).toBe(host.rows("acc-isa").length);

    // The account matches Trading 212 (positions and cash), and no storage value is near the cap.
    for (const r of results.perAccount) expect(r.verification?.ok, r.log.join("\n")).toBe(true);
    expect(host.maxStoredValueBytes).toBeLessThan(STORAGE_CAP_BYTES / 2);
  });

  it("is idempotent: a second full sync stores nothing new", async () => {
    const { host } = setup();
    await runSyncAll(host.ctx, {});
    const before = host.rows().length;
    // Back to a first sync (as after Reset of the watermark only): the ledger and the rows dedupe it.
    for (const id of ["inv", "isa"]) {
      const st = JSON.parse(host.storage.get(`t212_sync_${id}`)!);
      host.storage.set(`t212_sync_${id}`, JSON.stringify({ ...st, lastSync: null }));
    }
    installTrading212(host, { t212_auth_inv: realisticDataset().inv, t212_auth_isa: realisticDataset().isa }, (s) => host.cash(s === "t212_auth_inv" ? "acc-inv" : "acc-isa"));
    const again = await runSyncAll(host.ctx, {});
    expect(host.rows().length).toBe(before);
    for (const r of again.perAccount) expect(r.error, r.log.join("\n")).toBeUndefined();
  });
});

describe("when the host does not store what was sent", () => {
  it("a call refused by the host's own validation is not recorded: the bad row is reported, the rest stored, and the sync fails loudly", async () => {
    const { host } = setup();
    // Passes checkImport, then fails import's validation — the whole call stores nothing.
    host.importValidation = (a) => (a.comment === "BBB" && a.activityType === "BUY" && Number(a.unitPrice) === 52 ? "Symbol cannot be resolved" : null);
    const results = await runSyncAll(host.ctx, {});
    const inv = results.perAccount.find((r) => r.connectionId === "inv")!;

    expect(inv.error).toMatch(/^1 row is refused by Wealthfolio and retried on every sync/);
    expect(inv.error).toMatch(/Symbol cannot be resolved/);
    expect(host.countsByType("acc-inv").BUY).toBe(17); // 18 less the refused one
    expect(host.countsByType("acc-inv").DEPOSIT).toBe(3); // sent in the same call, still stored
    // The refused row has no recorded id…
    expect([...(await refsOf(host, "inv"))]).not.toContain("t212-order-BUY-BBB-2");
    // …it waits in the refused list, and the watermark moved on regardless.
    expect(refusedList(host, "inv").map((e) => e.id)).toEqual(["t212-order-BUY-BBB-2"]);
    expect(lastSyncOf(host, "inv")).not.toBeNull();
    expect(inv.log.join("\n")).toMatch(/Wealthfolio refuses 1 row; they are tried again at the start of every sync/);
  });

  it("a row the writer policy refuses is left out and reported while the others are stored", async () => {
    const { host } = setup();
    host.policy = (a) => (a.activityType === "DIVIDEND" && Number(a.amount) === 4.25 ? "Preparation failed: no price for BBB" : null);
    const results = await runSyncAll(host.ctx, {});
    const inv = results.perAccount.find((r) => r.connectionId === "inv")!;
    expect(inv.error).toMatch(/^1 row is refused by Wealthfolio/);
    expect(host.countsByType("acc-inv").DIVIDEND).toBe(2);
    expect([...(await refsOf(host, "inv"))].some((r) => r.startsWith("t212-div-") && r.includes("BBB"))).toBe(false);
    expect(refusedList(host, "inv")).toHaveLength(1);
  });

  it("a host that answers 200 with nothing stored is never taken for success", async () => {
    const { host } = setup();
    const real = host.ctx.api.activities.import;
    // Whatever is sent, "imported" 0 and no reason on the rows: the add-on gives up on those rows.
    (host.ctx.api.activities as { import: unknown }).import = async (rows: unknown[]) => ({
      activities: rows,
      importRunId: "",
      summary: { total: rows.length, imported: 0, skipped: rows.length, duplicates: 0, assetsCreated: 0, success: false },
    });
    const results = await runSyncAll(host.ctx, {});
    expect(host.rows()).toHaveLength(0);
    expect(await refsOf(host, "inv")).toEqual(new Set());
    expect(await refsOf(host, "isa")).toEqual(new Set());
    for (const r of results.perAccount) expect(r.error).toMatch(/rows are refused by Wealthfolio[\s\S]*import saved nothing/);
    (host.ctx.api.activities as { import: unknown }).import = real;
  });
});

describe("a row Wealthfolio refuses on every call must not hold the watermark", () => {
  const BAD = "t212-order-BUY-BBB-2";
  const refuseTrade = (a: { id?: string; comment?: string; activityType?: unknown; unitPrice?: unknown }) =>
    a.comment === "BBB" && a.activityType === "BUY" && Number(a.unitPrice) === 52 ? "Could not find 'BBB' in market data (delisted)" : null;

  it("syncs 2 and 3 neither re-export history nor re-send anything but that row, and the error stays; once accepted it is stored once and the error clears", async () => {
    const { host, calls } = setup();
    host.validation = refuseTrade; // refused at checkImport, every time
    const inv = (r: Awaited<ReturnType<typeof runSyncAll>>) => r.perAccount.find((x) => x.connectionId === "inv")!;

    // Sync 1: the full backfill. The row is refused; everything else is saved; the watermark moves on.
    const first = inv(await runSyncAll(host.ctx, {}));
    expect(first.error).toMatch(/^1 row is refused by Wealthfolio and retried on every sync/);
    expect(lastSyncOf(host, "inv")).not.toBeNull();
    expect(JSON.parse(host.storage.get("t212_sync_inv")!).backfillCheckpoint ?? null).toBeNull();
    expect(host.countsByType("acc-inv").BUY).toBe(17);
    expect(refusedList(host, "inv")).toMatchObject([{ id: BAD, attempts: 1 }]);
    const storedAfterFirst = host.rows().length;
    const exportsAfterFirst = calls.exports;
    expect(exportsAfterFirst).toBeGreaterThan(0);

    // Syncs 2 and 3: history is not read again, only that row is sent to Wealthfolio, and it is still
    // reported (error, log, attempts).
    for (const attempt of [2, 3]) {
      const checksBefore = host.checkedIds.length;
      const r = inv(await runSyncAll(host.ctx, {}));
      expect(calls.exports, `sync ${attempt} re-read the export`).toBe(exportsAfterFirst);
      const checked = host.checkedIds.slice(checksBefore).flat();
      expect(checked, `sync ${attempt}`).toEqual([BAD]);
      expect(r.error).toMatch(/^1 row is refused by Wealthfolio and retried on every sync/);
      expect(r.log.join("\n")).toContain(`Retrying 1 row Wealthfolio refused in earlier syncs.`);
      expect(r.log.join("\n")).toContain(`(${BAD}): Could not find 'BBB' in market data (delisted) — refused ${attempt} times`);
      expect(refusedList(host, "inv")).toMatchObject([{ id: BAD, attempts: attempt }]);
      expect(host.rows()).toHaveLength(storedAfterFirst); // nothing new, nothing twice
      expect(lastSyncOf(host, "inv")).not.toBeNull();
    }

    // The host accepts it: the next sync saves it once, the list empties and the error clears.
    host.validation = () => null;
    const fixed = inv(await runSyncAll(host.ctx, {}));
    expect(fixed.error).toBeUndefined();
    expect(host.countsByType("acc-inv").BUY).toBe(18);
    expect(host.rows()).toHaveLength(storedAfterFirst + 1);
    expect(refusedList(host, "inv")).toEqual([]);
    expect(host.storage.has("t212_refused_inv")).toBe(false);
    expect(fixed.log.join("\n")).toContain("Refused rows: 1 saved now, 0 still refused.");
    expect(calls.exports).toBe(exportsAfterFirst);

    // And it is not sent again.
    const checksBefore = host.checkedIds.length;
    const after = inv(await runSyncAll(host.ctx, {}));
    expect(host.checkedIds.length).toBe(checksBefore);
    expect(after.error).toBeUndefined();
    expect(host.rows()).toHaveLength(storedAfterFirst + 1);
  });

  it("a row refused at import (not at check) is retried the same way, and is the only row sent", async () => {
    const { host, calls } = setup();
    host.importValidation = refuseTrade;
    await runSyncAll(host.ctx, {});
    const exportsAfterFirst = calls.exports;
    const callsBefore = host.importCalls.length;
    const second = (await runSyncAll(host.ctx, {})).perAccount.find((x) => x.connectionId === "inv")!;
    expect(calls.exports).toBe(exportsAfterFirst);
    // One import call, of that one row; the host refuses it again.
    expect(host.importCalls.slice(callsBefore)).toEqual([expect.objectContaining({ sent: 1, stored: 0, success: false })]);
    expect(second.error).toMatch(/refused/);
    expect(refusedList(host, "inv")[0].attempts).toBe(2);
  });

  it("several refused rows: each leaves the list on its own once the host accepts it", async () => {
    const { host } = setup();
    host.validation = (a) => (a.activityType === "BUY" && a.comment === "BBB" && [51, 52].includes(Number(a.unitPrice)) ? "refused" : null);
    await runSyncAll(host.ctx, {});
    expect(refusedList(host, "inv").map((e) => e.id).sort()).toEqual(["t212-order-BUY-BBB-1", "t212-order-BUY-BBB-2"]);
    host.validation = (a) => (a.activityType === "BUY" && a.comment === "BBB" && Number(a.unitPrice) === 52 ? "refused" : null);
    const r = (await runSyncAll(host.ctx, {})).perAccount.find((x) => x.connectionId === "inv")!;
    expect(refusedList(host, "inv").map((e) => e.id)).toEqual(["t212-order-BUY-BBB-2"]);
    expect(r.error).toMatch(/^1 row is refused/);
    expect(host.countsByType("acc-inv").BUY).toBe(17);
  });

  it("a card row the host refuses on every call waits in the list too, with its funding pair, and is saved once when accepted", async () => {
    const { host, calls } = setup();
    // The writer refuses the spend of £9 (CARD-4) but takes the funding transfers sent with it.
    host.policy = (a) => (a.activityType === "WITHDRAWAL" && Number(a.amount) === 9 ? "Preparation failed: category unknown" : null);
    const cardAccount = () => host.accounts.find((a) => a.id !== "acc-inv" && a.id !== "acc-isa")!.id;
    const first = (await runSyncAll(host.ctx, {})).perAccount.find((x) => x.connectionId === "inv")!;
    expect(first.error).toMatch(/^1 row is refused by Wealthfolio/);
    expect(refusedList(host, "inv").map((e) => e.id)).toEqual(["t212-txn-CARD-4"]);
    expect(host.countsByType(cardAccount()).WITHDRAWAL).toBe(24);
    const exportsAfterFirst = calls.exports;
    const total = host.rows().length;

    for (const attempt of [2, 3]) {
      const r = (await runSyncAll(host.ctx, {})).perAccount.find((x) => x.connectionId === "inv")!;
      expect(calls.exports).toBe(exportsAfterFirst); // the card history is not exported again either
      expect(r.error).toMatch(/refused/);
      expect(refusedList(host, "inv")[0].attempts).toBe(attempt);
      expect(host.rows()).toHaveLength(total);
    }

    host.policy = () => null;
    const fixed = (await runSyncAll(host.ctx, {})).perAccount.find((x) => x.connectionId === "inv")!;
    expect(fixed.error).toBeUndefined();
    expect(refusedList(host, "inv")).toEqual([]);
    // The 25 spends, and each of them funded exactly once (the retried unit's stored legs were not doubled).
    expect(host.countsByType(cardAccount())).toMatchObject({ WITHDRAWAL: 25, TRANSFER_IN: 25 });
    expect(host.countsByType("acc-inv").TRANSFER_OUT).toBe(25);
    expect(host.rows()).toHaveLength(total + 1);
  });
});

describe("a ledger that is ahead of the account (left by 2.6.0 / 2.6.1)", () => {
  it("is forgotten, and the history is read again", async () => {
    const { host } = setup();
    // As on the real ISA: lastSync set and hundreds of ids recorded, with no activity in the account.
    const ids = Array.from({ length: 791 }, (_, i) => `t212-order-OLD-${i}`);
    host.storage.set("t212_sync_isa", JSON.stringify({ lastSync: "2026-10-01T00:00:00.000Z", importedRefs: ids }));
    host.storage.set("t212_sync_inv", JSON.stringify({ lastSync: null, importedRefs: [] }));
    const results = await runSyncAll(host.ctx, {});
    const isa = results.perAccount.find((r) => r.connectionId === "isa")!;
    expect(isa.log.join("\n")).toContain("The import ledger is ahead of the account");
    expect(isa.error, isa.log.join("\n")).toBeUndefined();
    expect(host.countsByType("acc-isa")).toEqual({ DEPOSIT: 1, BUY: 2, DIVIDEND: 1 });
    expect(await refsOf(host, "isa")).not.toContain("t212-order-OLD-1");
  });

  it("is judged only on the clear cases", () => {
    const refs = new Set(["t212-order-1", "t212-order-2", "t212-txn-9"]);
    expect(ledgerAhead(new Set(), [])).toBeNull();
    expect(ledgerAhead(refs, [])).toMatch(/holds none/);
    expect(ledgerAhead(refs, [{ activityType: "DEPOSIT" }])).toMatch(/2 trades/);
    // A trade the user deleted by hand stays deleted.
    expect(ledgerAhead(refs, [{ activityType: "BUY" }])).toBeNull();
  });
});

describe("the storage cap (~244 KB per value)", () => {
  it("a history of thousands of rows never puts more than a small share in one value", async () => {
    // 5,400 deposits with UUID ids: the ids alone are ~260 KB, which one value cannot hold.
    const lines: string[] = [HDR];
    for (let i = 0; i < 5400; i++) {
      const id = `${(i + 1).toString(16).padStart(8, "0")}-aaaa-4bbb-8ccc-${i.toString(16).padStart(12, "0")}`;
      lines.push(deposit(id, 400 - Math.floor(i / 20), 10 + (i % 7)));
    }
    const host = new FakeWealthfolio(ACCOUNTS);
    connect(host, [CONNS[1]], { env: "demo" });
    installTrading212(host, { t212_auth_isa: { csv: lines, positions: [] } }, () => host.cash("acc-isa"));
    const results = await runSyncAll(host.ctx, {});
    const r = results.perAccount[0];
    expect(r.error, r.log.slice(-6).join("\n")).toBeUndefined();
    expect(host.rows("acc-isa")).toHaveLength(5400);
    const refs = await refsOf(host, "isa");
    expect(refs.size).toBe(5400);
    const total = [...refs].reduce((n, x) => n + x.length + 3, 0);
    expect(total).toBeGreaterThan(STORAGE_CAP_BYTES); // would not have fit in one value
    expect(host.maxStoredValueBytes).toBeLessThan(STORAGE_CAP_BYTES / 4);
  }, 60_000);

  it("refs spread over keys, each far below the cap, and read back whole", async () => {
    const host = new FakeWealthfolio(ACCOUNTS);
    const refs = Array.from({ length: 20_000 }, (_, i) => `t212-txn-${i.toString(16).padStart(8, "0")}-1111-4222-8333-${i.toString(16).padStart(12, "0")}`);
    await addImportedRefs(host.ctx, "c", refs);
    expect((await getImportedRefs(host.ctx, "c")).size).toBe(20_000);
    expect(host.maxStoredValueBytes).toBeLessThan(STORAGE_CAP_BYTES);
    expect([...host.storage.keys()].filter((k) => k.startsWith("t212_refs_c_")).length).toBeGreaterThan(8);
  });

  it("refs an older version kept in the sync state are moved into the shards on first read", async () => {
    const host = new FakeWealthfolio(ACCOUNTS);
    host.storage.set("t212_sync_c", JSON.stringify({ lastSync: "2026-01-01T00:00:00.000Z", importedRefs: ["t212-order-1", "t212-order-2"] }));
    expect([...(await getImportedRefs(host.ctx, "c"))].sort()).toEqual(["t212-order-1", "t212-order-2"]);
    const state = JSON.parse(host.storage.get("t212_sync_c")!);
    expect(state.importedRefs).toEqual([]);
    expect(state.lastSync).toBe("2026-01-01T00:00:00.000Z");
    expect([...(await getImportedRefs(host.ctx, "c"))].sort()).toEqual(["t212-order-1", "t212-order-2"]);
  });

  it("the saved result is cut to fit, whatever the log's length", () => {
    const result: SyncResult = {
      connectionId: "c", accountId: "a", accountName: "n", imported: 1, duplicates: 0, unresolved: 0,
      log: Array.from({ length: 50_000 }, (_, i) => `line ${i} ${"x".repeat(300)}`),
    };
    const fitted = fitResult(result);
    expect(new TextEncoder().encode(JSON.stringify(fitted)).length).toBeLessThan(STORAGE_CAP_BYTES / 1.5);
    expect(fitted.log[0]).toBe(result.log[0].length > 600 ? result.log[0].slice(0, 600) + "…" : result.log[0]);
    expect(fitted.log.some((l) => l.includes("log lines left out"))).toBe(true);
    expect(fitted.log.at(-1)).toContain("line 49999");
  });
});

describe("the log survives a refresh", () => {
  it("a new dashboard (a fresh hook) shows the last sync's results, log and activity feed", async () => {
    const { host } = setup();
    const first = renderHook(() => useSync(host.ctx, { restore: true }));
    await act(async () => {
      await first.result.current.syncAll();
    });
    const log = first.result.current.results!.perAccount[0].log;
    expect(log.length).toBeGreaterThan(5);
    first.unmount();

    // "Refresh": a hook that has never run a sync, over the same storage.
    const again = renderHook(() => useSync(host.ctx, { restore: true }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const restored = again.result.current.results!;
    expect(restored.perAccount.map((r) => r.connectionId).sort()).toEqual(["inv", "isa"]);
    expect(restored.perAccount.find((r) => r.connectionId === "inv")!.log).toEqual(log);
    expect(restored.perAccount.find((r) => r.connectionId === "inv")!.verification?.ok).toBe(true);
    expect(restored.totals.imported).toBeGreaterThan(0);
    expect(again.result.current.steps.length).toBeGreaterThan(0);
    expect(again.result.current.isSyncing).toBe(false);
  });

  it("Reset forgets the saved result, whose log would describe a watermark that no longer exists", async () => {
    const { host } = setup();
    await runSyncAll(host.ctx, {});
    expect(host.storage.has("t212_last_result_inv")).toBe(true);
    const { resetSyncState } = await import("./hooks/use-config");
    await resetSyncState(host.ctx, "inv");
    expect(host.storage.has("t212_last_result_inv")).toBe(false);
    expect([...host.storage.keys()].some((k) => k.startsWith("t212_refs_inv_"))).toBe(false);
  });
});

describe("a full switch on an account that already holds an older card import", () => {
  // As on a real switch: an older add-on version imported the card spends with other merchant text,
  // and a Holdings-mode connection since removed funded each from an Invest account that is gone,
  // leaving the card side of every funding pair behind.
  const coffee = (id: string, ago: number) =>
    row({ Action: "Card debit", Time: `${day(ago)}T09:00:00Z`, Total: -2.8, "Currency (Total)": "GBP", "Merchant name": "PRET A MANGER", "Merchant category": "RESTAURANTS", ID: id });

  function withOlderCardImport() {
    const host = new FakeWealthfolio([
      ...ACCOUNTS,
      { id: "acc-card", name: "Trading 212 (Invest) Card", currency: "GBP", trackingMode: "TRANSACTIONS", provider: "trading212-addon", providerAccountId: "11-card", accountType: "CASH" },
    ]);
    connect(host, CONNS);
    const d = realisticDataset();
    // Two identical deposits on one day: the host flags the second as a duplicate within the call.
    d.inv.csv.push(deposit("DEP-D", 50, 20), deposit("DEP-E", 50, 20));
    // Two identical coffees on one day, of which the older import holds one.
    d.inv.csv.push(coffee("COF-1", 45), coffee("COF-2", 45));
    // A refund, which versions before 2.6.4 stored as CREDIT and 2.6.4 as DEPOSIT.
    d.inv.csv.push(
      row({ Action: "Card credit", Time: `${day(40)}T15:00:00Z`, Total: 8.54, "Currency (Total)": "GBP", "Merchant name": "AMAZON", "Merchant category": "RETAIL_STORES", ID: "REF-1" }),
    );
    let n = 0;
    const older: Parameters<typeof host.stored.set>[1] = [];
    const add = (r: { activityType: string; date: Date; amount: number; comment: string }) =>
      older.push({ id: `old-${++n}`, accountId: "acc-card", assetSymbol: null, exchangeMic: null, quantity: null, unitPrice: null, fee: null, currency: "GBP", ...r });
    for (let i = 0; i < 25; i++) {
      const date = new Date(`${day(60 - i)}T12:00:00Z`);
      add({ activityType: "WITHDRAWAL", date, amount: 5 + i, comment: "Sainsbury's · Groceries" });
      add({ activityType: "TRANSFER_IN", date, amount: 5 + i, comment: "Card funding" });
    }
    add({ activityType: "WITHDRAWAL", date: new Date(`${day(45)}T09:00:00Z`), amount: 2.8, comment: "Pret · Eating out" });
    add({ activityType: "CREDIT", date: new Date(`${day(40)}T15:00:00Z`), amount: 8.54, comment: "Amazon refund" });
    host.stored.set("acc-card", older);
    installTrading212(host, { t212_auth_inv: d.inv, t212_auth_isa: d.isa }, (s) => host.cash(s === "t212_auth_inv" ? "acc-inv" : "acc-isa"));
    return host;
  }

  /** Each card-funding leg in the card account has its partner in the Invest account, and the reverse. */
  function fundingLegs(host: FakeWealthfolio) {
    const key = (r: { date: Date; amount: number | null }) => `${r.date.toISOString().slice(0, 10)}|${r.amount}`;
    const legs = (acc: string, type: string) =>
      host.rows(acc).filter((r) => r.activityType === type && r.comment === "Card funding").map(key).sort();
    return { cardIn: legs("acc-card", "TRANSFER_IN"), invOut: legs("acc-inv", "TRANSFER_OUT") };
  }

  function expectClean(host: FakeWealthfolio, results: Awaited<ReturnType<typeof runSyncAll>>) {
    for (const r of results.perAccount) expect(r.error, r.log.join("\n")).toBeUndefined();
    // No duplicates: the 25 spends and the 2 coffees, once each, whatever the merchant text.
    expect(host.rows("acc-card").filter((r) => r.activityType === "WITHDRAWAL")).toHaveLength(27);
    // No orphan transfers: one funding pair per spend, both legs present.
    const { cardIn, invOut } = fundingLegs(host);
    expect(cardIn).toHaveLength(27);
    expect(invOut).toEqual(cardIn);
    // Nothing listed as refused, and every call stored what it said it stored.
    expect(refusedList(host, "inv")).toEqual([]);
    expect(refusedList(host, "isa")).toEqual([]);
    for (const r of results.perAccount) expect(r.log.join("\n")).not.toMatch(/refuses|not imported: /i);
    // Both identical deposits are there.
    expect(host.countsByType("acc-inv").DEPOSIT).toBe(5);
    // The refund is there once (the older CREDIT, not a new DEPOSIT beside it), funded back to Invest once.
    const card = host.rows("acc-card");
    expect(card.filter((r) => r.activityType === "CREDIT" || r.activityType === "DEPOSIT")).toHaveLength(1);
    expect(card.filter((r) => r.activityType === "TRANSFER_OUT" && r.comment === "Card funding")).toHaveLength(1);
    expect(host.rows("acc-inv").filter((r) => r.activityType === "TRANSFER_IN" && r.comment === "Card funding")).toHaveLength(1);
    for (const r of results.perAccount) expect(r.verification?.ok ?? true, r.log.join("\n")).toBe(true);
  }

  it("imports no spend twice, re-funds the orphaned spends, and lists nothing as refused; a second sync changes nothing", async () => {
    const host = withOlderCardImport();
    const first = await runSyncAll(host.ctx, {});
    expectClean(host, first);
    // The forced in-batch duplicate came back marked by the host, and was still counted as stored.
    expect(host.importCalls.every((c) => c.success)).toBe(true);
    // The older rows are the ones kept (matched by day, amount and type, not merchant text), and
    // each orphaned card leg found its Invest partner in the new funding pair.
    expect(host.rows("acc-card").filter((r) => r.comment === "Sainsbury's · Groceries")).toHaveLength(25);
    expect(host.rows("acc-card").filter((r) => r.comment === "Card funding" && r.id.startsWith("old-"))).toHaveLength(25);

    const before = host.rows().length;
    const second = await runSyncAll(host.ctx, {});
    expectClean(host, second);
    expect(host.rows().length).toBe(before);
  });

  it("removes the refund 2.6.4 imported a second time (a DEPOSIT beside an older CREDIT), with its extra funding", async () => {
    const host = withOlderCardImport();
    // What 2.6.4 left: the CREDIT from an older version, and beside it a DEPOSIT for the same refund
    // with the funding pair that sends it back to Invest.
    const date = new Date(`${day(40)}T15:00:00Z`);
    const base = { assetSymbol: null, exchangeMic: null, quantity: null, unitPrice: null, fee: null, currency: "GBP", date, amount: 8.54 };
    host.stored.get("acc-card")!.push(
      { ...base, id: "dup-dep", accountId: "acc-card", activityType: "DEPOSIT", comment: "AMAZON · Shopping" },
      { ...base, id: "dup-out", accountId: "acc-card", activityType: "TRANSFER_OUT", comment: "Card funding" },
    );
    host.stored.set("acc-inv", [{ ...base, id: "dup-in", accountId: "acc-inv", activityType: "TRANSFER_IN", comment: "Card funding" }]);

    const results = await runSyncAll(host.ctx, {});
    expectClean(host, results);
    expect(host.rows().map((r) => r.id)).not.toContain("dup-dep");
    const inv = results.perAccount.find((r) => r.connectionId === "inv")!;
    expect(inv.log.join("\n")).toMatch(/Card refunds: deleted 1 row 2\.6\.4 had imported a second time/);
  });

  it("a later sync deletes the card legs whose Invest partner is gone and funds those spends again", async () => {
    const host = withOlderCardImport();
    await runSyncAll(host.ctx, {});
    // The Invest legs go (as when the account that held them is deleted): 27 card legs are orphans.
    const invLegs = host.rows("acc-inv").filter((r) => r.activityType === "TRANSFER_OUT" && r.comment === "Card funding");
    await host.ctx.api.activities.saveMany({ deleteIds: invLegs.map((r) => r.id) } as never);
    expect(fundingLegs(host).invOut).toEqual([]);

    const again = await runSyncAll(host.ctx, {});
    expectClean(host, again);
    const inv = again.perAccount.find((r) => r.connectionId === "inv")!;
    expect(inv.log.join("\n")).toMatch(/deleted 27 funding transfers whose other half was gone/);
  });
});

describe("splits Trading 212 does not export, against the fake host", () => {
  it("adds a known split even while another row is refused, and the account then matches", async () => {
    const host = new FakeWealthfolio(ACCOUNTS, {
      search: (q) => (q.startsWith("AMZN") || q === "US0231351067" ? [{ symbol: "AMZN", exchangeMic: "XNAS", currency: "USD", score: 1, quoteType: "EQUITY" }] : [{ symbol: q.split("_")[0], exchangeMic: "XLON", currency: "GBP", score: 1, quoteType: "EQUITY" }]),
    });
    connect(host, CONNS);
    const d = realisticDataset();
    // One Amazon buy before its 20:1 split of 2022-06-06; Trading 212 holds 20 times as many now.
    d.inv.csv.push(
      row({
        Action: "Market buy", Time: "2021-09-01T10:00:00Z", ISIN: "US0231351067", Ticker: "AMZN", Name: "Amazon",
        "No. of shares": 0.108245, "Price / share": 3400, "Currency (Price / share)": "USD", "Exchange rate": 1.37, Total: 268.5, "Currency (Total)": "GBP", ID: "AMZN-1",
      }),
    );
    installTrading212(host, { t212_auth_inv: d.inv, t212_auth_isa: d.isa }, (s) => host.cash(s === "t212_auth_inv" ? "acc-inv" : "acc-isa"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = host.ctx.api as any;
    const t212 = api.network.request;
    api.network.request = async (req: { url: string; auth?: { secretKey: string } }) => {
      if (req.url.includes("/positions") && req.auth?.secretKey === "t212_auth_inv") {
        const base = JSON.parse((await t212(req)).body);
        return json([...base, { instrument: { ticker: "AMZN_US_EQ", isin: "US0231351067", name: "Amazon", currency: "USD" }, quantity: 2.1649 }]);
      }
      return t212(req);
    };
    // A row Wealthfolio refuses on every call: it waits in the refused list.
    host.importValidation = (a) => (a.comment === "BBB" && a.activityType === "BUY" && Number(a.unitPrice) === 52 ? "Symbol cannot be resolved" : null);

    const results = await runSyncAll(host.ctx, {});
    const inv = results.perAccount.find((r) => r.connectionId === "inv")!;
    expect(refusedList(host, "inv").map((e) => e.id)).toEqual(["t212-order-BUY-BBB-2"]);
    const split = host.rows("acc-inv").find((r) => r.activityType === "SPLIT");
    expect(split, inv.log.join("\n")).toMatchObject({ assetSymbol: "AMZN", amount: 20 });
    expect(Number(host.holdings("acc-inv").find((h) => h.instrument?.symbol === "AMZN")?.quantity)).toBeCloseTo(2.1649, 6);
    expect(inv.log.join("\n")).toMatch(/adding the 20:1 split of 2022-06-06/);
  });
});

describe("an EUR account trading shares priced in pence", () => {
  it("pays in euros what Trading 212 took for the share, and the check compares the EUR wallet alone", async () => {
    const host = new FakeWealthfolio([
      { id: "acc-inv", name: "Trading 212 (Invest)", currency: "EUR", trackingMode: "TRANSACTIONS" },
      { id: "acc-isa", name: "Trading 212 (ISA)", currency: "GBP", trackingMode: "TRANSACTIONS" },
    ]);
    host.rates = [{ fromCurrency: "GBP", toCurrency: "EUR", rate: 1.17 }];
    connect(host, CONNS, { env: "demo", extractCard: false });
    const inv = [
      HDR,
      row({ Action: "Deposit", Time: `${day(30)}T08:00:00Z`, Total: 1000, "Currency (Total)": "EUR", ID: "DEP-EUR" }),
      // A GBP top-up stays in a GBP wallet: Trading 212's cash figure leaves it out.
      row({ Action: "Deposit", Time: `${day(29)}T08:00:00Z`, Total: 200, "Currency (Total)": "GBP", ID: "DEP-GBP" }),
      // 19.0384 RR at 540.2p; Trading 212 took €123.37 from the EUR wallet (rate given per penny).
      row({
        Action: "Market buy", Time: `${day(20)}T10:00:00Z`, ISIN: "GB00RR000001", Ticker: "RR_GB_EQ", Name: "RR",
        "No. of shares": 19.0384, "Price / share": 540.2, "Currency (Price / share)": "GBX", "Exchange rate": 83.4987,
        Total: 123.37, "Currency (Total)": "EUR", "Currency conversion fee": 0.19, "Currency (Currency conversion fee)": "EUR", ID: "RR-1",
      }),
    ];
    installTrading212(
      host,
      { t212_auth_inv: { csv: inv, positions: [{ sym: "RR", qty: 19.0384 }] }, t212_auth_isa: { csv: [HDR], positions: [] } },
      // Trading 212's own figure: the EUR wallet, 1000 − 123.37.
      (s) => (s === "t212_auth_inv" ? 876.63 : 0),
      (s) => (s === "t212_auth_inv" ? "EUR" : "GBP"),
    );

    const results = await runSyncAll(host.ctx, {});
    const r = results.perAccount.find((x) => x.connectionId === "inv")!;
    expect(host.rows("acc-inv").find((a) => a.activityType === "BUY")).toMatchObject({ currency: "GBP", unitPrice: 5.402 });
    expect(host.cash("acc-inv", "EUR")).toBeCloseTo(876.63, 1);
    expect(host.cash("acc-inv", "GBP")).toBeCloseTo(200, 2);
    expect(r.verification?.ok, r.log.join("\n")).toBe(true);
    expect(r.log.join("\n")).toMatch(/Cash in GBP \(200\) was not compared: Trading 212's cash figure is the EUR wallet only/);
  });
});
