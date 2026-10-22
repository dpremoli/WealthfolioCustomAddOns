import { describe, expect, it } from "vitest";
import { makeCtx, tx } from "../test-utils";
import { flexRepaymentCredit, mapTransactionToActivity } from "./mapper";
import { importNew } from "./sync";
import { linkNote, linkTransfers, pairTransferLegs } from "./transfers";

const repayment = (over = {}) =>
  tx({ category: "transfers", description: "Flex", amount: -5000, ...over });
const refundLegs = (amount = 1999, created = "2026-05-02T09:00:00.000Z") => {
  const base = { description: "Refunded (Flex)", category: "shopping", created };
  return {
    out: tx({ ...base, amount: -amount }), // on Flex
    inn: tx({ ...base, amount }), // on the current account
  };
};

describe("pairTransferLegs", () => {
  it("pairs a repayment with the Flex credit made from it", () => {
    const r = repayment();
    const out = mapTransactionToActivity(r, "wf-cur");
    const inn = flexRepaymentCredit(r, "wf-flex");
    const [pair, ...rest] = pairTransferLegs([inn, out]);
    expect(rest).toEqual([]);
    expect(pair.out).toBe(out);
    expect(pair.in).toBe(inn);
  });

  it("pairs refund legs on different accounts by amount and date", () => {
    const a = refundLegs(1999);
    const b = refundLegs(500, "2026-06-10T09:00:00.000Z");
    const acts = [
      mapTransactionToActivity(a.inn, "wf-cur"),
      mapTransactionToActivity(b.out, "wf-flex"),
      mapTransactionToActivity(a.out, "wf-flex"),
      mapTransactionToActivity(b.inn, "wf-cur"),
    ];
    const pairs = pairTransferLegs(acts).map((p) => [p.out.id, p.in.id]);
    expect(pairs).toEqual(
      expect.arrayContaining([
        [a.out.id, a.inn.id],
        [b.out.id, b.inn.id],
      ]),
    );
    expect(pairs).toHaveLength(2);
  });

  it("leaves a refund leg alone when its other half is not in the batch, or differs", () => {
    const a = refundLegs(1999);
    expect(pairTransferLegs([mapTransactionToActivity(a.inn, "wf-cur")])).toEqual([]);
    const other = refundLegs(2000);
    expect(
      pairTransferLegs([
        mapTransactionToActivity(a.inn, "wf-cur"),
        mapTransactionToActivity(other.out, "wf-flex"),
      ]),
    ).toEqual([]);
    // Same amount a month apart: not the same refund.
    const late = refundLegs(1999, "2026-07-02T09:00:00.000Z");
    expect(
      pairTransferLegs([
        mapTransactionToActivity(a.inn, "wf-cur"),
        mapTransactionToActivity(late.out, "wf-flex"),
      ]),
    ).toEqual([]);
  });

  it("does not pair a repayment with a credit written to the same account", () => {
    const r = repayment();
    const out = mapTransactionToActivity(r, "wf-flex");
    const inn = flexRepaymentCredit(r, "wf-flex");
    expect(pairTransferLegs([out, inn])).toEqual([]);
  });

  it("never pairs two legs on the same account, and ignores non-transfers", () => {
    const a = refundLegs(1999);
    expect(
      pairTransferLegs([
        mapTransactionToActivity(a.inn, "wf-cur"),
        mapTransactionToActivity(a.out, "wf-cur"),
        mapTransactionToActivity(tx(), "wf-cur"),
      ]),
    ).toEqual([]);
  });
});

describe("linkTransfers", () => {
  const setup = () =>
    makeCtx({
      wfAccounts: [
        { id: "wf-cur", name: "Current" },
        { id: "wf-flex", name: "Flex" },
      ],
    });

  async function importPair(t: ReturnType<typeof setup>) {
    const r = repayment();
    const out = mapTransactionToActivity(r, "wf-cur");
    const inn = flexRepaymentCredit(r, "wf-flex");
    await importNew(t.ctx, "wf-cur", [out]);
    await importNew(t.ctx, "wf-flex", [inn]);
    return { out, inn };
  }

  it("links the imported rows of each pair through the host's transfer API", async () => {
    const t = setup();
    const { out, inn } = await importPair(t);
    const result = await linkTransfers(t.ctx, [out, inn]);
    expect(result).toEqual({ linked: 1, unlinked: 0, failed: [] });
    const outRow = t.activities.get("wf-cur")![0].id;
    const inRow = t.activities.get("wf-flex")![0].id;
    expect(t.links).toEqual([[outRow, inRow]]);
  });

  it("does not link a pair twice", async () => {
    const t = setup();
    const { out, inn } = await importPair(t);
    await linkTransfers(t.ctx, [out, inn]);
    const again = await linkTransfers(t.ctx, [out, inn]);
    expect(again.linked).toBe(0);
    expect(t.links).toHaveLength(1);
  });

  it("counts legs it could not pair, and reports a failed link without throwing", async () => {
    const t = setup();
    const { out, inn } = await importPair(t);
    const lone = mapTransactionToActivity(refundLegs().inn, "wf-cur");
    (t.ctx.api.activities as unknown as { linkTransfer: unknown }).linkTransfer = async () => {
      throw new Error("host says no");
    };
    const result = await linkTransfers(t.ctx, [out, inn, lone]);
    expect(result.linked).toBe(0);
    expect(result.unlinked).toBe(1);
    expect(result.failed).toEqual([expect.stringContaining("host says no")]);
  });

  it("leaves a pair alone, without calling it a failure, when a row was edited since the import", async () => {
    const t = setup();
    const { out, inn } = await importPair(t);
    t.activities.get("wf-cur")![0].comment = "Edited by the user";
    const result = await linkTransfers(t.ctx, [out, inn]);
    expect(result).toEqual({ linked: 0, unlinked: 2, failed: [] });
    expect(t.links).toEqual([]);
  });

  it("reports rows that were edited but are already linked as already linked, not as unlinked", async () => {
    const t = setup();
    const { out, inn } = await importPair(t);
    t.activities.get("wf-cur")![0].comment = "Edited by the user";
    t.activities.get("wf-flex")![0].comment = "Edited by the user";
    t.links.push([t.activities.get("wf-cur")![0].id as string, t.activities.get("wf-flex")![0].id as string]);
    const result = await linkTransfers(t.ctx, [out, inn]);
    expect(result).toEqual({ linked: 0, unlinked: 0, alreadyLinked: 2, failed: [] });
    expect(linkNote(result)).toBe("Flex transfers: 0 linked, 2 already linked.");
  });

  it("reports a lone leg whose row is already linked as already linked", async () => {
    const t = setup();
    const lone = mapTransactionToActivity(refundLegs().inn, "wf-cur");
    await importNew(t.ctx, "wf-cur", [lone]);
    t.links.push([t.activities.get("wf-cur")![0].id as string, "other"]);
    expect(await linkTransfers(t.ctx, [lone])).toEqual({ linked: 0, unlinked: 0, alreadyLinked: 1, failed: [] });
  });

  it("is a no-op when there is nothing to pair", async () => {
    const t = setup();
    expect(await linkTransfers(t.ctx, [mapTransactionToActivity(tx(), "wf-cur")])).toEqual({
      linked: 0,
      unlinked: 0,
      failed: [],
    });
  });
});
