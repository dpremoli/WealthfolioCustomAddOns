import { describe, expect, it } from "vitest";
import type { MoveRow } from "@wf-addons/kit";
import { makeCtx } from "../test-utils";
import { exchangeLinkNote, exchangeOf, isExchangeMatch, linkExchanges, matchExchanges } from "./exchanges";

const t0 = Date.parse("2024-03-10T12:00:00.000Z");
const MIN = 60 * 1000;

/** An exchange leg: out of GBP (account G) or into EUR (account E) unless overridden. */
const leg = (id: string, type: "TRANSFER_OUT" | "TRANSFER_IN", minutes = 0, extra: Partial<MoveRow> = {}): MoveRow => ({
  id,
  accountId: type === "TRANSFER_OUT" ? "G" : "E",
  activityType: type,
  amount: type === "TRANSFER_OUT" ? "85.46" : "99.20",
  currency: type === "TRANSFER_OUT" ? "GBP" : "EUR",
  date: new Date(t0 + minutes * MIN),
  comment: "Exchanged to EUR",
  ...extra,
});

describe("exchangeOf", () => {
  it("reads the currency an exchange description names, either way round", () => {
    expect(exchangeOf("Exchanged to EUR")).toEqual({ to: "EUR" });
    expect(exchangeOf("exchanged from gbp")).toEqual({ from: "GBP" });
    expect(exchangeOf("Exchanged to USD GBP -> USD")).toEqual({ to: "USD" });
    expect(exchangeOf("To EUR savings")).toBeNull();
    expect(exchangeOf(null)).toBeNull();
  });
});

describe("isExchangeMatch", () => {
  const out = leg("o", "TRANSFER_OUT");
  it("pairs the sold leg with the bought one: other account and currency, within 2 minutes", () => {
    expect(isExchangeMatch(out, leg("i", "TRANSFER_IN"))).toBe(true);
    expect(isExchangeMatch(out, leg("i", "TRANSFER_IN", 2))).toBe(true);
    expect(isExchangeMatch(out, leg("i", "TRANSFER_IN", -2))).toBe(true);
    expect(isExchangeMatch(out, leg("i", "TRANSFER_IN", 2.5))).toBe(false);
  });

  it("does not compare amounts (they differ by the rate)", () => {
    expect(isExchangeMatch(out, leg("i", "TRANSFER_IN", 0, { amount: "1" }))).toBe(true);
  });

  it("needs the bought currency to be the money-in leg's", () => {
    expect(isExchangeMatch(out, leg("i", "TRANSFER_IN", 0, { currency: "USD", accountId: "U" }))).toBe(false);
    expect(
      isExchangeMatch(
        leg("o", "TRANSFER_OUT", 0, { comment: "Exchanged to USD" }),
        leg("i", "TRANSFER_IN", 0, { comment: "Exchanged to USD", currency: "USD", accountId: "U" }),
      ),
    ).toBe(true);
  });

  it("accepts 'Exchanged from' naming the sold currency", () => {
    expect(isExchangeMatch(out, leg("i", "TRANSFER_IN", 0, { comment: "Exchanged from GBP" }))).toBe(true);
    expect(isExchangeMatch(out, leg("i", "TRANSFER_IN", 0, { comment: "Exchanged from USD" }))).toBe(false);
  });

  it("needs two exchange rows of opposite direction in different accounts and currencies", () => {
    expect(isExchangeMatch(out, leg("i", "TRANSFER_IN", 0, { comment: "Payment from Sam" }))).toBe(false);
    expect(isExchangeMatch(out, leg("i", "DEPOSIT" as "TRANSFER_IN"))).toBe(false);
    expect(isExchangeMatch(out, leg("i", "TRANSFER_IN", 0, { accountId: "G" }))).toBe(false);
    expect(isExchangeMatch(out, leg("i", "TRANSFER_IN", 0, { currency: "GBP", accountId: "X" }))).toBe(false);
  });
});

describe("matchExchanges", () => {
  it("pairs each exchange's two legs, nearest in time first", () => {
    const rows = [
      leg("o1", "TRANSFER_OUT", 0),
      leg("o2", "TRANSFER_OUT", 1),
      leg("i1", "TRANSFER_IN", 0),
      leg("i2", "TRANSFER_IN", 1),
    ];
    const { pairs, ambiguous } = matchExchanges(rows);
    expect(pairs.map((p) => [p.out.id, p.in.id])).toEqual([
      ["o1", "i1"],
      ["o2", "i2"],
    ]);
    expect(ambiguous).toEqual([]);
  });

  it("skips a tie instead of guessing", () => {
    const { pairs, ambiguous } = matchExchanges([
      leg("o", "TRANSFER_OUT", 0),
      leg("a", "TRANSFER_IN", -1),
      leg("b", "TRANSFER_IN", 1),
    ]);
    expect(pairs).toEqual([]);
    expect(ambiguous.map((r) => r.id)).toEqual(["o"]);

    const shared = matchExchanges([leg("o1", "TRANSFER_OUT", -1), leg("o2", "TRANSFER_OUT", 1), leg("i", "TRANSFER_IN")]);
    expect(shared.pairs).toEqual([]);
    expect(shared.ambiguous.map((r) => r.id).sort()).toEqual(["o1", "o2"]);
  });

  it("leaves a leg whose other half is missing alone", () => {
    expect(matchExchanges([leg("o", "TRANSFER_OUT")])).toEqual({ pairs: [], ambiguous: [] });
  });
});

describe("linkExchanges", () => {
  function setup() {
    const t = makeCtx();
    const add = (accountId: string, activityType: string, currency: string, amount: number, minutes: number, comment: string) =>
      t.addRow({ accountId, activityType, currency, amount, comment, date: new Date(t0 + minutes * MIN).toISOString() });
    return { ...t, add };
  }

  it("links each exchange's legs across the currency accounts, once", async () => {
    const t = setup();
    const out = t.add("G", "TRANSFER_OUT", "GBP", 85.46, 0, "Exchanged to EUR");
    const inn = t.add("E", "TRANSFER_IN", "EUR", 99.2, 0, "Exchanged to EUR");
    t.add("G", "TRANSFER_OUT", "GBP", 100, 0, "To Sam"); // not an exchange
    expect(await linkExchanges(t.ctx, ["G", "E"])).toEqual({ linked: 1, ambiguous: [], failed: [] });
    expect(t.links).toEqual([[out.id, inn.id]]);

    // Already linked: nothing to do the second time.
    expect(await linkExchanges(t.ctx, ["G", "E"])).toEqual({ linked: 0, ambiguous: [], failed: [] });
    expect(t.links).toHaveLength(1);
  });

  it("does not let an already-linked leg make a new match ambiguous", async () => {
    const t = setup();
    const a = t.add("G", "TRANSFER_OUT", "GBP", 10, 0, "Exchanged to EUR");
    const b = t.add("E", "TRANSFER_IN", "EUR", 11, 1, "Exchanged to EUR");
    const c = t.add("E", "TRANSFER_IN", "EUR", 12, -1, "Exchanged to EUR");
    const other = t.add("X", "TRANSFER_OUT", "EUR", 12, -1, "Exchanged from EUR");
    t.links.push([other.id, c.id]); // linked by hand to something else
    expect((await linkExchanges(t.ctx, ["G", "E"])).linked).toBe(1);
    expect(t.links).toContainEqual([a.id, b.id]);
  });

  it("reports a tie and a refused link instead of throwing", async () => {
    const t = setup();
    t.add("G", "TRANSFER_OUT", "GBP", 10, 0, "Exchanged to EUR");
    t.add("E", "TRANSFER_IN", "EUR", 11, 1, "Exchanged to EUR");
    t.add("E", "TRANSFER_IN", "EUR", 12, -1, "Exchanged to EUR");
    const tie = await linkExchanges(t.ctx, ["G", "E"]);
    expect(tie.linked).toBe(0);
    expect(tie.ambiguous).toHaveLength(1);
    expect(t.warnings.join(" ")).toMatch(/several matching legs/);

    const u = setup();
    u.add("G", "TRANSFER_OUT", "GBP", 10, 0, "Exchanged to EUR");
    u.add("E", "TRANSFER_IN", "EUR", 11, 0, "Exchanged to EUR");
    u.ctx.api.activities.linkTransfer = async () => {
      throw new Error("host says no");
    };
    const refused = await linkExchanges(u.ctx, ["G", "E"]);
    expect(refused.linked).toBe(0);
    expect(refused.failed.join(" ")).toMatch(/host says no/);
  });
});

describe("exchangeLinkNote", () => {
  it("summarises the outcome in one line", () => {
    expect(exchangeLinkNote({ linked: 3, ambiguous: [], failed: [] })).toBe("Exchanges: 3 linked.");
    expect(exchangeLinkNote({ linked: 0, ambiguous: ["a"], failed: ["x: no"] })).toMatch(
      /^Exchanges: 0 linked, 1 left unlinked .*could not link: x: no\.$/,
    );
  });
});
