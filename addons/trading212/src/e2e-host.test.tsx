/**
 * End to end against a fake Wealthfolio 3.11 (see test-host.ts): a real Trading 212 export goes
 * through the whole sync, and the test counts what the host actually STORES, not what was sent.
 * 2.6.0 and 2.6.1 passed their unit tests while storing no trades at all on a real host, because
 * their fakes accepted whatever the add-on sent.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { runSyncAll, useSync, ledgerAhead } from "./hooks/use-sync";
import { addImportedRefs, fitResult, getImportedRefs } from "./hooks/use-config";
import { FakeWealthfolio, STORAGE_CAP_BYTES } from "./test-host";
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
function installTrading212(host: FakeWealthfolio, data: Record<string, Dataset>, cashOf: (secret: string) => number) {
  const served = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (host.ctx.api as any).network.request = async (req: { url: string; auth?: { secretKey: string } }) => {
    const u = req.url;
    if (u.includes("amazonaws.com")) {
      const secret = /\/([^/]+)\.csv/.exec(u)?.[1] ?? "";
      const first = !served.has(secret);
      served.add(secret);
      return { status: 200, headers: {}, body: first ? data[secret].csv.join("\n") : HDR };
    }
    const secret = req.auth?.secretKey ?? "";
    if (u.includes("/exports")) return json([REPORT(secret)]);
    if (u.includes("account/summary")) return json({ id: secret === "t212_auth_inv" ? 11 : 22, currency: "GBP", cash: { availableToTrade: cashOf(secret) } });
    if (u.includes("/positions")) {
      return json(
        (data[secret]?.positions ?? []).map((p) => ({ instrument: { ticker: `${p.sym}_GB_EQ`, isin: `GB00${p.sym}000001`, name: p.sym, currency: "GBP" }, quantity: p.qty })),
      );
    }
    return json({ items: [], nextPagePath: null });
  };
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
  installTrading212(host, { t212_auth_inv: d.inv, t212_auth_isa: d.isa }, (secret) => host.cash(secret === "t212_auth_inv" ? "acc-inv" : "acc-isa"));
  return { host, d };
}

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
  it("a call refused by the host's own validation is not recorded: the bad row is reported, the rest stored, and it fails loudly", async () => {
    const { host } = setup();
    // Passes checkImport, then fails import's validation — the whole call stores nothing.
    host.importValidation = (a) => (a.comment === "BBB" && a.activityType === "BUY" && Number(a.unitPrice) === 52 ? "Symbol cannot be resolved" : null);
    const results = await runSyncAll(host.ctx, {});
    const inv = results.perAccount.find((r) => r.connectionId === "inv")!;

    expect(inv.error).toMatch(/1 trade or corporate-action row was not imported/);
    expect(inv.error).toMatch(/Symbol cannot be resolved/);
    expect(host.countsByType("acc-inv").BUY).toBe(17); // 18 less the refused one
    expect(host.countsByType("acc-inv").DEPOSIT).toBe(3); // sent in the same call, still stored
    // The refused row has no recorded id, so a later sync reads it again.
    expect([...(await refsOf(host, "inv"))].filter((r) => r.startsWith("t212-order-"))).toHaveLength(17 + 1 /* the sell */);
    expect([...(await refsOf(host, "inv"))]).not.toContain("t212-order-BUY-BBB-2");
    // …and the history is not marked as read, so that sync starts from the beginning.
    expect(JSON.parse(host.storage.get("t212_sync_inv")!).lastSync).toBeNull();
    expect(inv.log.join("\n")).toContain("not marked as read");

    // The host is fixed; the next sync imports just the missing row.
    host.importValidation = () => null;
    installTrading212(host, { t212_auth_inv: realisticDataset().inv, t212_auth_isa: realisticDataset().isa }, (s) => host.cash(s === "t212_auth_inv" ? "acc-inv" : "acc-isa"));
    const next = await runSyncAll(host.ctx, {});
    expect(next.perAccount.find((r) => r.connectionId === "inv")!.error).toBeUndefined();
    expect(host.countsByType("acc-inv").BUY).toBe(18);
    expect(JSON.parse(host.storage.get("t212_sync_inv")!).lastSync).not.toBeNull();
  });

  it("a row the writer policy refuses is left out and reported while the others are stored", async () => {
    const { host } = setup();
    host.policy = (a) => (a.activityType === "DIVIDEND" && Number(a.amount) === 4.25 ? "Preparation failed: no price for BBB" : null);
    const results = await runSyncAll(host.ctx, {});
    const inv = results.perAccount.find((r) => r.connectionId === "inv")!;
    expect(inv.error).toMatch(/1 row was not saved/);
    expect(host.countsByType("acc-inv").DIVIDEND).toBe(2);
    expect([...(await refsOf(host, "inv"))].some((r) => r.startsWith("t212-div-") && r.includes("BBB"))).toBe(false);
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
    for (const r of results.perAccount) expect(r.error).toMatch(/not imported[\s\S]*import saved nothing/);
    (host.ctx.api.activities as { import: unknown }).import = real;
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
