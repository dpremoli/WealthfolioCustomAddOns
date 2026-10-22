import { describe, expect, it } from "vitest";
import { makeCtx, tx } from "../test-utils";
import { mapTransactionToActivity } from "./mapper";
import { importNew } from "./sync";
import { matchWithCashIsa } from "./transfers";

const MONZO = "wf-monzo";
const ISA = "wf-isa";

function setup(isaProvider = "t212-cash-isa") {
  const t = makeCtx({
    wfAccounts: [
      { id: MONZO, name: "Monzo Current", accountType: "CASH" },
      { id: ISA, name: "Trading 212 Cash ISA", accountType: "CASH", providerAccountId: isaProvider },
    ],
  });
  return t;
}

const monzoMove = (amount: number, created: string, description = "Trading 212") =>
  tx({ category: "savings", description, amount, created });

/** A Cash ISA row as the Trading 212 add-on imports it. */
const isaRow = (type: "DEPOSIT" | "WITHDRAWAL", amount: number, created: string) => ({
  ...mapTransactionToActivity(tx({ amount: 1, created }), ISA),
  id: `t212-txn-${type}-${amount}-${created}`,
  activityType: type as never,
  amount,
  comment: undefined,
});

describe("matchWithCashIsa", () => {
  it("converts and links a Monzo move with its Cash ISA row", async () => {
    const t = setup();
    await importNew(t.ctx, MONZO, [mapTransactionToActivity(monzoMove(-30000, "2026-04-01T09:00:00.000Z"), MONZO)]);
    await importNew(t.ctx, ISA, [isaRow("DEPOSIT", 300, "2026-04-02T09:00:00.000Z")]);
    const out = await matchWithCashIsa(t.ctx, [MONZO]);
    expect(out).toEqual({ linked: 1, ambiguous: [], failed: [] });
    expect(t.activities.get(MONZO)![0].activityType).toBe("TRANSFER_OUT");
    expect(t.activities.get(ISA)![0].activityType).toBe("TRANSFER_IN");
    expect(t.links).toHaveLength(1);
  });

  it("works the other way: money back from the ISA", async () => {
    const t = setup();
    await importNew(t.ctx, MONZO, [mapTransactionToActivity(monzoMove(25000, "2026-04-05T09:00:00.000Z"), MONZO)]);
    await importNew(t.ctx, ISA, [isaRow("WITHDRAWAL", 250, "2026-04-04T09:00:00.000Z")]);
    expect((await matchWithCashIsa(t.ctx, [MONZO])).linked).toBe(1);
    expect(t.activities.get(MONZO)![0].activityType).toBe("TRANSFER_IN");
    expect(t.activities.get(ISA)![0].activityType).toBe("TRANSFER_OUT");
  });

  it("leaves both rows as deposit/withdrawal when there is no counterpart", async () => {
    const t = setup();
    await importNew(t.ctx, MONZO, [mapTransactionToActivity(monzoMove(-30000, "2026-04-01T09:00:00.000Z"), MONZO)]);
    await importNew(t.ctx, ISA, [isaRow("DEPOSIT", 500, "2026-04-02T09:00:00.000Z")]); // from Chase, say
    expect(await matchWithCashIsa(t.ctx, [MONZO])).toEqual({ linked: 0, ambiguous: [], failed: [] });
    expect(t.activities.get(MONZO)![0].activityType).toBe("WITHDRAWAL");
    expect(t.activities.get(ISA)![0].activityType).toBe("DEPOSIT");
    expect(t.links).toEqual([]);
  });

  it("does not match a Monzo row whose payee is not Trading 212, even for the same amount", async () => {
    const t = setup();
    await importNew(t.ctx, MONZO, [
      mapTransactionToActivity(tx({ category: "general", description: "Landlord", amount: -30000, created: "2026-04-01T09:00:00.000Z" }), MONZO),
    ]);
    await importNew(t.ctx, ISA, [isaRow("DEPOSIT", 300, "2026-04-02T09:00:00.000Z")]);
    expect((await matchWithCashIsa(t.ctx, [MONZO])).linked).toBe(0);
    expect(t.activities.get(MONZO)![0].activityType).toBe("WITHDRAWAL");
  });

  it("takes the closest date, skips an exact tie, and leaves linked rows alone", async () => {
    const t = setup();
    await importNew(t.ctx, MONZO, [mapTransactionToActivity(monzoMove(-30000, "2026-04-10T12:00:00.000Z"), MONZO)]);
    await importNew(t.ctx, ISA, [
      isaRow("DEPOSIT", 300, "2026-04-12T12:00:00.000Z"),
      isaRow("DEPOSIT", 300, "2026-04-11T12:00:00.000Z"),
    ]);
    await matchWithCashIsa(t.ctx, [MONZO]);
    const isaRows = t.activities.get(ISA)!;
    expect(isaRows.map((r) => r.activityType)).toEqual(["DEPOSIT", "TRANSFER_IN"]);

    const tie = setup();
    await importNew(tie.ctx, MONZO, [mapTransactionToActivity(monzoMove(-30000, "2026-04-10T12:00:00.000Z"), MONZO)]);
    await importNew(tie.ctx, ISA, [
      isaRow("DEPOSIT", 300, "2026-04-09T12:00:00.000Z"),
      isaRow("DEPOSIT", 300, "2026-04-11T12:00:00.000Z"),
    ]);
    const out = await matchWithCashIsa(tie.ctx, [MONZO]);
    expect(out.ambiguous).toHaveLength(1);
    expect(tie.links).toEqual([]);
    expect(tie.activities.get(MONZO)![0].activityType).toBe("WITHDRAWAL");
  });

  it("changes nothing when run again", async () => {
    const t = setup();
    await importNew(t.ctx, MONZO, [mapTransactionToActivity(monzoMove(-30000, "2026-04-01T09:00:00.000Z"), MONZO)]);
    await importNew(t.ctx, ISA, [isaRow("DEPOSIT", 300, "2026-04-02T09:00:00.000Z")]);
    await matchWithCashIsa(t.ctx, [MONZO]);
    const again = await matchWithCashIsa(t.ctx, [MONZO]);
    expect(again.linked).toBe(0);
    expect(t.links).toHaveLength(1);
  });

  it("does nothing when there is no Cash ISA account", async () => {
    const t = setup("something-else");
    await importNew(t.ctx, MONZO, [mapTransactionToActivity(monzoMove(-30000, "2026-04-01T09:00:00.000Z"), MONZO)]);
    expect(await matchWithCashIsa(t.ctx, [MONZO])).toEqual({ linked: 0, ambiguous: [], failed: [] });
  });

  it("also finds an ISA account by its name", async () => {
    const t = makeCtx({
      wfAccounts: [
        { id: MONZO, name: "Monzo Current", accountType: "CASH" },
        { id: ISA, name: "My Cash ISA", accountType: "CASH" },
      ],
    });
    await importNew(t.ctx, MONZO, [mapTransactionToActivity(monzoMove(-30000, "2026-04-01T09:00:00.000Z"), MONZO)]);
    await importNew(t.ctx, ISA, [isaRow("DEPOSIT", 300, "2026-04-02T09:00:00.000Z")]);
    expect((await matchWithCashIsa(t.ctx, [MONZO])).linked).toBe(1);
  });
});
