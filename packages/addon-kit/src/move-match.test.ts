import type { AddonContext } from "@wealthfolio/addon-sdk";
import {
  convertAndLinkMoves,
  isMoveMatch,
  matchMoves,
  moveLinkNote,
  type MoveRow,
} from "./move-match";

const DAY = 24 * 60 * 60 * 1000;
const t0 = Date.parse("2026-03-10T12:00:00.000Z");
const row = (
  id: string,
  type: string,
  amount: number,
  days = 0,
  extra: Partial<MoveRow> = {},
): MoveRow => ({
  id,
  accountId: type === "WITHDRAWAL" || type === "TRANSFER_OUT" ? "A" : "B",
  activityType: type,
  amount: String(amount),
  currency: "GBP",
  date: new Date(t0 + days * DAY),
  comment: id,
  ...extra,
});

describe("isMoveMatch", () => {
  const out = row("o", "WITHDRAWAL", 300);
  it("needs money out against money in, same amount and currency, different accounts, within 3 days", () => {
    expect(isMoveMatch(out, row("i", "DEPOSIT", 300, 3))).toBe(true);
    expect(isMoveMatch(out, row("i", "TRANSFER_IN", 300, -3))).toBe(true);
    expect(isMoveMatch(row("o", "TRANSFER_OUT", 300), row("i", "DEPOSIT", 300))).toBe(true);
    expect(isMoveMatch(out, row("i", "DEPOSIT", 300, 3.5))).toBe(false);
    expect(isMoveMatch(out, row("i", "DEPOSIT", 301))).toBe(false);
    expect(isMoveMatch(out, row("i", "DEPOSIT", 300, 0, { currency: "USD" }))).toBe(false);
    expect(isMoveMatch(out, row("o2", "WITHDRAWAL", 300))).toBe(false);
    expect(isMoveMatch(out, row("i", "DEPOSIT", 300, 0, { accountId: "A" }))).toBe(false);
    expect(isMoveMatch(out, row("x", "INTEREST", 300))).toBe(false);
  });
});

describe("matchMoves", () => {
  it("pairs an out with its in, taking the closest date among several", () => {
    const { pairs } = matchMoves(
      [row("o", "WITHDRAWAL", 300)],
      [row("far", "DEPOSIT", 300, 2), row("near", "DEPOSIT", 300, 1)],
    );
    expect(pairs.map((p) => [p.out.id, p.in.id])).toEqual([["o", "near"]]);
  });

  it("skips an exact tie on date, and reports the leg", () => {
    const { pairs, ambiguous } = matchMoves(
      [row("o", "WITHDRAWAL", 300)],
      [row("a", "DEPOSIT", 300, -1), row("b", "DEPOSIT", 300, 1)],
    );
    expect(pairs).toEqual([]);
    expect(ambiguous.map((l) => l.id)).toEqual(["o"]);
  });

  it("finds nothing without a counterpart", () => {
    expect(matchMoves([row("o", "WITHDRAWAL", 300)], [row("i", "DEPOSIT", 250)])).toEqual({
      pairs: [],
      ambiguous: [],
    });
  });

  it("gives a shared counterpart to the nearer leg, and skips both when equally near", () => {
    const ins = [row("i", "DEPOSIT", 300, 0)];
    const near = matchMoves([row("o1", "WITHDRAWAL", 300, 0), row("o2", "WITHDRAWAL", 300, 2)], ins);
    expect(near.pairs.map((p) => [p.out.id, p.in.id])).toEqual([["o1", "i"]]);
    const equal = matchMoves([row("o1", "WITHDRAWAL", 300, -1), row("o2", "WITHDRAWAL", 300, 1)], ins);
    expect(equal.pairs).toEqual([]);
    expect(equal.ambiguous.map((l) => l.id).sort()).toEqual(["o1", "o2"]);
  });
});

describe("convertAndLinkMoves", () => {
  type Stored = MoveRow & { accountId: string };
  function setup(rows: Stored[], opts: { linked?: string[]; saveErrors?: string[]; linkFails?: boolean } = {}) {
    const store = new Map(rows.map((r) => [r.id, { ...r }]));
    const linked = new Set(opts.linked ?? []);
    const links: [string, string][] = [];
    const saves: { id: string; activityType: string }[][] = [];
    const warn = vi.fn();
    const ctx = {
      api: {
        logger: { warn, info: vi.fn(), error: vi.fn() },
        activities: {
          getTransferPair: async (id: string) => (linked.has(id) ? { transferOut: {}, transferIn: {} } : null),
          saveMany: async (req: { updates: { id: string; activityType: string }[] }) => {
            saves.push(req.updates);
            const errors = req.updates
              .filter((u) => opts.saveErrors?.includes(u.id))
              .map((u) => ({ id: u.id, action: "update", message: "no" }));
            for (const u of req.updates) if (!errors.some((e) => e.id === u.id)) store.get(u.id)!.activityType = u.activityType;
            return { created: [], updated: [], deleted: [], createdMappings: [], errors };
          },
          linkTransfer: async (a: string, b: string) => {
            if (opts.linkFails) throw new Error("host says no");
            links.push([a, b]);
            linked.add(a).add(b);
            return [{}, {}];
          },
        },
      },
    } as unknown as AddonContext;
    return { ctx, store, links, saves, warn };
  }
  const withdrawal = (id = "w", days = 0) => row(id, "WITHDRAWAL", 300, days) as Stored;
  const deposit = (id = "d", days = 1) => row(id, "DEPOSIT", 300, days) as Stored;

  it("converts both legs to transfers and links them", async () => {
    const t = setup([withdrawal(), deposit()]);
    const out = await convertAndLinkMoves(t.ctx, [withdrawal()], [deposit()]);
    expect(out).toEqual({ linked: 1, ambiguous: [], failed: [] });
    expect(t.store.get("w")!.activityType).toBe("TRANSFER_OUT");
    expect(t.store.get("d")!.activityType).toBe("TRANSFER_IN");
    expect(t.links).toEqual([["w", "d"]]);
  });

  it("only links a leg that is already a transfer, converting just the other", async () => {
    const t = setup([withdrawal(), row("d", "TRANSFER_IN", 300, 1) as Stored]);
    const out = await convertAndLinkMoves(t.ctx, [withdrawal()], [row("d", "TRANSFER_IN", 300, 1)]);
    expect(out.linked).toBe(1);
    expect(t.saves.flat().map((u) => u.id)).toEqual(["w"]);
  });

  it("leaves rows untouched when there is no counterpart", async () => {
    const t = setup([withdrawal(), row("d", "DEPOSIT", 250, 1) as Stored]);
    const out = await convertAndLinkMoves(t.ctx, [withdrawal()], [row("d", "DEPOSIT", 250, 1)]);
    expect(out).toEqual({ linked: 0, ambiguous: [], failed: [] });
    expect(t.saves).toEqual([]);
    expect(t.store.get("w")!.activityType).toBe("WITHDRAWAL");
  });

  it("never touches a row that is already linked, on either side", async () => {
    for (const linked of [["w"], ["d"]]) {
      const t = setup([withdrawal(), deposit()], { linked });
      const out = await convertAndLinkMoves(t.ctx, [withdrawal()], [deposit()]);
      expect(out.linked).toBe(0);
      expect(t.saves).toEqual([]);
      expect(t.links).toEqual([]);
    }
  });

  it("takes the closest date, and skips and logs an exact tie", async () => {
    const closest = setup([withdrawal(), deposit("far", 2), deposit("near", 1)]);
    await convertAndLinkMoves(closest.ctx, [withdrawal()], [deposit("far", 2), deposit("near", 1)]);
    expect(closest.links).toEqual([["w", "near"]]);

    const tie = setup([withdrawal(), deposit("a", -1), deposit("b", 1)]);
    const out = await convertAndLinkMoves(tie.ctx, [withdrawal()], [deposit("a", -1), deposit("b", 1)]);
    expect(out.ambiguous).toEqual(["w"]);
    expect(tie.saves).toEqual([]);
    expect(tie.warn).toHaveBeenCalledWith(expect.stringContaining("w"));
  });

  it("is idempotent: running it again changes nothing", async () => {
    const t = setup([withdrawal(), deposit()]);
    await convertAndLinkMoves(t.ctx, [withdrawal()], [deposit()]);
    const again = await convertAndLinkMoves(t.ctx, [t.store.get("w")!], [t.store.get("d")!]);
    expect(again.linked).toBe(0);
    expect(t.links).toHaveLength(1);
    expect(t.saves).toHaveLength(1);
  });

  it("puts the rows back as they were when the link is refused", async () => {
    const t = setup([withdrawal(), deposit()], { linkFails: true });
    const out = await convertAndLinkMoves(t.ctx, [withdrawal()], [deposit()]);
    expect(out.linked).toBe(0);
    expect(out.failed).toEqual([expect.stringContaining("host says no")]);
    expect(t.store.get("w")!.activityType).toBe("WITHDRAWAL");
    expect(t.store.get("d")!.activityType).toBe("DEPOSIT");
  });

  it("puts the rows back when converting one leg failed", async () => {
    const t = setup([withdrawal(), deposit()], { saveErrors: ["d"] });
    const out = await convertAndLinkMoves(t.ctx, [withdrawal()], [deposit()]);
    expect(out.linked).toBe(0);
    expect(out.failed).toHaveLength(1);
    expect(t.store.get("w")!.activityType).toBe("WITHDRAWAL");
    expect(t.links).toEqual([]);
  });
});

describe("moveLinkNote", () => {
  it("says nothing when nothing happened, else summarises", () => {
    expect(moveLinkNote("Trading 212", { linked: 0, ambiguous: [], failed: [] })).toBeNull();
    expect(moveLinkNote("Trading 212", { linked: 2, ambiguous: ["a"], failed: [] })).toMatch(
      /Trading 212.*2 linked.*1 .*ambiguous/,
    );
  });
});
