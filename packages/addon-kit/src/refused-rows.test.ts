import type { ActivityImport } from "@wealthfolio/addon-sdk";
import { describe, expect, it } from "vitest";
import {
  MAX_REFUSED_BYTES,
  MAX_REFUSED_ENTRIES,
  addRefused,
  describeRefused,
  emptyRefused,
  loadRefused,
  refusedError,
  refusedUnits,
  saveRefused,
  settleRefused,
} from "./refused-rows";

const memory = () => {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k: string) => data.get(k) ?? null,
    set: async (k: string, v: string) => void data.set(k, v),
    delete: async (k: string) => void data.delete(k),
  };
};
const row = (id: string, extra: Partial<ActivityImport> = {}): ActivityImport =>
  ({ id, accountId: "a", activityType: "BUY", symbol: "DEAD", date: "2026-02-16T10:00:00Z", quantity: 2, currency: "GBP", isValid: true, isDraft: false, ...extra }) as ActivityImport;
const at = new Date("2026-10-01T00:00:00Z");

describe("refused rows", () => {
  it("counts another attempt for a unit already listed, with the newest reason", () => {
    let rows = addRefused(emptyRefused(), [{ unit: [row("r1")], reason: "Symbol cannot be resolved" }], at);
    expect(rows.entries[0]).toMatchObject({ id: "r1", attempts: 1, since: at.toISOString() });
    rows = addRefused(rows, [{ unit: [row("r1")], reason: "Could not find DEAD in market data" }], new Date("2026-10-05T00:00:00Z"));
    expect(rows.entries).toHaveLength(1);
    expect(rows.entries[0]).toMatchObject({ attempts: 2, reason: "Could not find DEAD in market data", since: at.toISOString(), lastAt: "2026-10-05T00:00:00.000Z" });
  });

  it("settles a unit only when every one of its rows is accounted for, and sends the rest again", () => {
    const pair = [row("c1", { activityType: "WITHDRAWAL" }), row("c1-out", { activityType: "TRANSFER_OUT" }), row("c1-in", { activityType: "TRANSFER_IN" })];
    let rows = addRefused(emptyRefused(), [{ unit: [row("r1")], reason: "x" }, { unit: pair, reason: "y" }], at);
    expect(refusedUnits(rows)).toEqual([[row("r1")], pair]);
    rows = settleRefused(rows, ["r1", "c1"]); // the pair's funding legs are not accounted yet
    expect(rows.entries.map((e) => e.id)).toEqual(["c1"]);
    rows = settleRefused(rows, ["c1", "c1-out", "c1-in"]);
    expect(rows.entries).toEqual([]);
  });

  it("round-trips through storage, and an empty list deletes the key", async () => {
    const api = memory();
    expect(await loadRefused(api, "k")).toEqual(emptyRefused());
    await saveRefused(api, "k", addRefused(emptyRefused(), [{ unit: [row("r1")], reason: "x" }], at));
    expect((await loadRefused(api, "k")).entries[0].unit[0]).toMatchObject({ id: "r1", symbol: "DEAD" });
    await saveRefused(api, "k", emptyRefused());
    expect(api.data.has("k")).toBe(false);
    api.data.set("k", "{not json");
    expect(await loadRefused(api, "k")).toEqual(emptyRefused());
    api.data.set("k", JSON.stringify({ entries: [{ nope: true }, null] }));
    expect((await loadRefused(api, "k")).entries).toEqual([]);
  });

  it("keeps the stored value under the size guard and counts what did not fit", async () => {
    const api = memory();
    const many = Array.from({ length: 2000 }, (_, i) => ({ unit: [row(`r${i}`, { comment: "x".repeat(400) })], reason: "refused" }));
    const kept = await saveRefused(api, "k", addRefused(emptyRefused(), many, at));
    expect(new TextEncoder().encode(api.data.get("k")!).length).toBeLessThanOrEqual(MAX_REFUSED_BYTES);
    expect(kept.entries.length).toBeLessThanOrEqual(MAX_REFUSED_ENTRIES);
    expect(kept.entries.length + kept.dropped).toBe(2000);
    expect(kept.entries[0].id).toBe("r0"); // the oldest are kept
    expect(refusedError(kept)).toMatch(/2000 rows are refused/);
    expect(describeRefused(kept).join("\n")).toMatch(/not kept \(the list is full\)/);
  });

  it("describes the rows for the log and the error, and says nothing when there are none", () => {
    expect(describeRefused(emptyRefused())).toEqual([]);
    expect(refusedError(emptyRefused())).toBeUndefined();
    const rows = addRefused(addRefused(emptyRefused(), [{ unit: [row("r1")], reason: "Symbol cannot be resolved" }], at), [{ unit: [row("r1")], reason: "Symbol cannot be resolved" }], new Date("2026-10-03T00:00:00Z"));
    const lines = describeRefused(rows);
    expect(lines[0]).toMatch(/refuses 1 row; they are tried again at the start of every sync/);
    expect(lines[1]).toContain("BUY 2026-02-16 DEAD qty 2");
    expect(lines[1]).toContain("(r1): Symbol cannot be resolved — refused 2 times since 2026-10-01");
    expect(refusedError(rows)).toMatch(/^1 row is refused by Wealthfolio and retried on every sync \(see the log\)\. First: BUY 2026-02-16 DEAD/);
  });
});
