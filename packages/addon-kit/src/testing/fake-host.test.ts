import { FakeWealthfolio } from "./fake-host";

describe("FakeWealthfolio transfer links", () => {
  async function setup() {
    const host = new FakeWealthfolio([
      { id: "a", name: "A", currency: "GBP" },
      { id: "b", name: "B", currency: "GBP" },
    ]);
    await host.ctx.api.activities.import([
      { accountId: "a", activityType: "WITHDRAWAL", date: "2026-10-30", amount: 100, currency: "GBP", comment: "out", isValid: true, isDraft: false },
      { accountId: "b", activityType: "DEPOSIT", date: "2026-10-30", amount: 100, currency: "GBP", comment: "in", isValid: true, isDraft: false },
    ]);
    return { host, out: host.rows("a")[0], inn: host.rows("b")[0] };
  }

  it("patches an activity's type and comment through saveMany", async () => {
    const { host, inn } = await setup();
    const res = await host.ctx.api.activities.saveMany({
      updates: [{ id: inn.id, accountId: "b", activityType: "TRANSFER_IN", comment: "in [ref:x]" } as never],
    });
    expect(res.errors).toEqual([]);
    expect(host.rows("b")[0]).toMatchObject({ activityType: "TRANSFER_IN", comment: "in [ref:x]" });
  });

  it("links two activities and answers the pair for either of them", async () => {
    const { host, out, inn } = await setup();
    expect(await host.ctx.api.activities.getTransferPair(out.id)).toBeNull();
    await host.ctx.api.activities.linkTransfer(out.id, inn.id);
    const pair = await host.ctx.api.activities.getTransferPair(inn.id);
    expect(pair?.transferOut.id).toBe(out.id);
    expect(pair?.transferIn.id).toBe(inn.id);
    expect(host.links).toEqual([[out.id, inn.id]]);
  });

  it("drops the link of a deleted activity, so the other leg can be linked again", async () => {
    const { host, out, inn } = await setup();
    await host.ctx.api.activities.linkTransfer(out.id, inn.id);
    await host.ctx.api.activities.saveMany({ deleteIds: [out.id] });
    expect(host.links).toEqual([]);
    expect(await host.ctx.api.activities.getTransferPair(inn.id)).toBeNull();
  });
});

describe("FakeWealthfolio storage keys", () => {
  it("refuses a key with characters the host does not allow, like the host", async () => {
    const host = new FakeWealthfolio([]);
    await expect(host.ctx.api.storage.set("payslips/2026", "[]")).rejects.toThrow(/Invalid storage key/);
    await expect(host.ctx.api.storage.get("a b")).rejects.toThrow(/Invalid storage key/);
    await host.ctx.api.storage.set("payslips:2026_x.y-z", "[]");
    expect(await host.ctx.api.storage.get("payslips:2026_x.y-z")).toBe("[]");
  });
});
