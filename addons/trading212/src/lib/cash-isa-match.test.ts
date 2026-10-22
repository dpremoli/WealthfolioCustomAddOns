import { describe, expect, it, vi } from "vitest";
import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import { importCashIsa, parseCashIsaCsv } from "./cash-isa";

const ISA = "wf-isa";
const MONZO = "wf-monzo";

const EXPORT = [
  "Action,Time (UTC),Notes,ID,Total,Currency (Total)",
  "Deposit,2026-04-02 09:00:00+00:00,Bank Transfer,9f1c2d3e-0000-4000-8000-000000000001,300.00,GBP",
  "Deposit,2026-04-20 09:00:00+00:00,Bank Transfer,9f1c2d3e-0000-4000-8000-000000000002,500.00,GBP",
  "Withdrawal,2026-05-15 12:30:00+00:00,Sent to Bank,9f1c2d3e-0000-4000-8000-000000000003,-250.00,GBP",
  "Interest on cash,2026-05-31 06:45:21+00:00,Interest on cash,0cc283e7-35f2-494c-86f8-bac61c79ed12,1.43,GBP",
].join("\n");

interface Row {
  id: string;
  accountId: string;
  activityType: string;
  date: Date;
  amount: string;
  currency: string;
  comment: string | null;
  assetSymbol: string;
  subtype?: string | null;
}

function fakeCtx(extraAccounts: Record<string, unknown>[] = []) {
  const storage = new Map<string, string>();
  const rows: Row[] = [];
  const links: [string, string][] = [];
  const linked = new Set<string>();
  let seq = 0;
  const accounts = [
    { id: ISA, name: "Trading 212 Cash ISA", accountType: "CASH", provider: "trading212-addon", providerAccountId: "t212-cash-isa" },
    { id: MONZO, name: "Monzo Current", accountType: "CASH" },
    ...extraAccounts,
  ];
  const ctx = {
    api: {
      logger: { info() {}, warn() {}, error() {} },
      storage: {
        get: async (k: string) => storage.get(k) ?? null,
        set: async (k: string, v: string) => void storage.set(k, v),
        delete: async (k: string) => void storage.delete(k),
      },
      accounts: { getAll: async () => accounts },
      activities: {
        getAll: async (accountId?: string) => rows.filter((r) => r.accountId === accountId),
        import: vi.fn(async (batch: ActivityImport[]) => {
          for (const a of batch) {
            rows.push({
              id: `act-${++seq}`,
              accountId: a.accountId,
              activityType: String(a.activityType),
              date: new Date(String(a.date)),
              amount: String(a.amount),
              currency: a.currency ?? "GBP",
              comment: a.comment ?? null,
              assetSymbol: a.symbol ?? "",
            });
          }
          return { summary: { imported: batch.length, skipped: 0 } };
        }),
        saveMany: vi.fn(async (req: { updates?: { id: string; activityType: string; comment?: string | null }[] }) => {
          for (const u of req.updates ?? []) {
            const r = rows.find((x) => x.id === u.id)!;
            r.activityType = u.activityType;
          }
          return { created: [], updated: [], deleted: [], createdMappings: [], errors: [] };
        }),
        getTransferPair: async (id: string) => (linked.has(id) ? { transferOut: {}, transferIn: {} } : null),
        linkTransfer: vi.fn(async (a: string, b: string) => {
          links.push([a, b]);
          linked.add(a).add(b);
          return [{}, {}];
        }),
      },
    },
  } as unknown as AddonContext;
  const addMonzo = (type: string, amount: number, date: string, comment = "Trading 212 | Savings") => {
    const row: Row = {
      id: `m-${++seq}`,
      accountId: MONZO,
      activityType: type,
      date: new Date(date),
      amount: String(amount),
      currency: "GBP",
      comment,
      assetSymbol: "$CASH-GBP",
    };
    rows.push(row);
    return row;
  };
  return { ctx, rows, links, linked, addMonzo };
}

const types = (rows: Row[], acc: string) => rows.filter((r) => r.accountId === acc).map((r) => r.activityType);

describe("Cash ISA import: match with Monzo", () => {
  it("keeps deposits and withdrawals as they are when nothing matches (counts towards the ISA allowance)", async () => {
    const t = fakeCtx();
    t.addMonzo("WITHDRAWAL", 999, "2026-04-02T09:00:00.000Z"); // not a Cash ISA move
    const { activities } = await parseCashIsaCsv(EXPORT, "");
    const out = await importCashIsa(t.ctx, ISA, activities);
    expect(out).toMatchObject({ imported: 4, linked: 0 });
    expect(types(t.rows, ISA)).toEqual(["DEPOSIT", "DEPOSIT", "WITHDRAWAL", "INTEREST"]);
    expect(t.links).toEqual([]);
  });

  it("converts and links a deposit and a withdrawal with their Monzo rows, and nothing else", async () => {
    const t = fakeCtx();
    const out1 = t.addMonzo("WITHDRAWAL", 300, "2026-04-01T09:00:00.000Z");
    const in1 = t.addMonzo("DEPOSIT", 250, "2026-05-16T09:00:00.000Z");
    const { activities } = await parseCashIsaCsv(EXPORT, "");
    const out = await importCashIsa(t.ctx, ISA, activities);
    expect(out.linked).toBe(2);
    // 300 deposit and the 250 withdrawal are linked; the 500 deposit (from Chase) and interest are not.
    expect(types(t.rows, ISA)).toEqual(["TRANSFER_IN", "DEPOSIT", "TRANSFER_OUT", "INTEREST"]);
    expect(out1.activityType).toBe("TRANSFER_OUT");
    expect(in1.activityType).toBe("TRANSFER_IN");
    expect(t.links).toHaveLength(2);
  });

  it("does not match a Monzo row whose payee is not Trading 212", async () => {
    const t = fakeCtx();
    const m = t.addMonzo("WITHDRAWAL", 300, "2026-04-01T09:00:00.000Z", "Landlord | Rent");
    const { activities } = await parseCashIsaCsv(EXPORT, "");
    expect((await importCashIsa(t.ctx, ISA, activities)).linked).toBe(0);
    expect(m.activityType).toBe("WITHDRAWAL");
  });

  it("takes the closest date, and skips an exact tie", async () => {
    const t = fakeCtx();
    const near = t.addMonzo("WITHDRAWAL", 300, "2026-04-02T01:00:00.000Z");
    const far = t.addMonzo("WITHDRAWAL", 300, "2026-03-30T12:00:00.000Z");
    const { activities } = await parseCashIsaCsv(EXPORT, "");
    await importCashIsa(t.ctx, ISA, activities);
    expect([near.activityType, far.activityType]).toEqual(["TRANSFER_OUT", "WITHDRAWAL"]);

    const tie = fakeCtx();
    tie.addMonzo("WITHDRAWAL", 300, "2026-04-01T09:00:00.000Z");
    tie.addMonzo("WITHDRAWAL", 300, "2026-04-03T09:00:00.000Z");
    const r = await importCashIsa(tie.ctx, ISA, activities);
    expect(r.linked).toBe(0);
    expect(types(tie.rows, MONZO)).toEqual(["WITHDRAWAL", "WITHDRAWAL"]);
    expect(types(tie.rows, ISA)[0]).toBe("DEPOSIT");
  });

  it("leaves a Monzo row that is already linked alone", async () => {
    const t = fakeCtx();
    const m = t.addMonzo("TRANSFER_OUT", 300, "2026-04-01T09:00:00.000Z");
    t.linked.add(m.id);
    const { activities } = await parseCashIsaCsv(EXPORT, "");
    expect((await importCashIsa(t.ctx, ISA, activities)).linked).toBe(0);
    expect(types(t.rows, ISA)[0]).toBe("DEPOSIT");
  });

  it("changes nothing on a re-import, and never turns a converted row back", async () => {
    const t = fakeCtx();
    t.addMonzo("WITHDRAWAL", 300, "2026-04-01T09:00:00.000Z");
    const { activities } = await parseCashIsaCsv(EXPORT, "");
    await importCashIsa(t.ctx, ISA, activities);
    const again = await importCashIsa(t.ctx, ISA, activities);
    expect(again).toMatchObject({ imported: 0, linked: 0 });
    expect(types(t.rows, ISA)).toEqual(["TRANSFER_IN", "DEPOSIT", "WITHDRAWAL", "INTEREST"]);
    expect(t.links).toHaveLength(1);
    expect(t.rows).toHaveLength(5);
  });

  it("does not import a row again that was already turned into a linked transfer by hand", async () => {
    const t = fakeCtx();
    t.rows.push({
      id: "hand-1",
      accountId: ISA,
      activityType: "TRANSFER_OUT",
      date: new Date("2026-05-15T00:00:00.000Z"),
      amount: "250",
      currency: "GBP",
      comment: "moved to Monzo",
      assetSymbol: "$CASH-GBP",
    });
    t.linked.add("hand-1");
    const { activities } = await parseCashIsaCsv(EXPORT, "");
    const out = await importCashIsa(t.ctx, ISA, activities);
    expect(out.imported).toBe(3); // the withdrawal is the hand-made row
    expect(types(t.rows, ISA).filter((x) => x === "WITHDRAWAL")).toEqual([]);
    expect(t.rows.find((r) => r.id === "hand-1")!.activityType).toBe("TRANSFER_OUT");
  });

  it("ignores other accounts that are not cash accounts or belong to this add-on", async () => {
    const t = fakeCtx([{ id: "card", name: "T212 card", accountType: "CASH", provider: "trading212-addon" }]);
    t.rows.push({
      id: "c-1",
      accountId: "card",
      activityType: "WITHDRAWAL",
      date: new Date("2026-04-01T09:00:00.000Z"),
      amount: "300",
      currency: "GBP",
      comment: "Trading 212",
      assetSymbol: "$CASH-GBP",
    });
    const { activities } = await parseCashIsaCsv(EXPORT, "");
    expect((await importCashIsa(t.ctx, ISA, activities)).linked).toBe(0);
  });
});
