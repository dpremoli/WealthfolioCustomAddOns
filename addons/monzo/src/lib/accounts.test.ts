import { describe, expect, it } from "vitest";
import { makeCtx } from "../test-utils";
import type { MonzoAccount } from "../types";
import { accountTypeLabel, ensureAccountMapping, findUnmapped } from "./accounts";

const current: MonzoAccount = {
  id: "monzo-1",
  description: "Current",
  created: "",
  account_number: "12345678",
  account_type: "uk_retail",
  currency: "GBP",
};
const flex: MonzoAccount = { id: "monzo-2", description: "Flex", created: "", account_type: "uk_monzo_flex" };

describe("accountTypeLabel", () => {
  it("names accounts by type", () => {
    expect(accountTypeLabel(current)).toBe("Monzo Current (12345678)");
    expect(accountTypeLabel({ ...current, account_number: undefined })).toBe("Monzo Current Account");
    expect(accountTypeLabel(flex)).toBe("Monzo Flex");
    expect(accountTypeLabel({ ...flex, account_type: "uk_prepaid", description: "Prepaid" })).toBe("Prepaid");
  });
});

describe("findUnmapped", () => {
  it("flags accounts with no mapping or a mapping to a deleted Wealthfolio account", () => {
    const wf = [{ id: "wf-1" }];
    expect(findUnmapped([current, flex], wf, { "monzo-1": "wf-1" }).map((a) => a.id)).toEqual(["monzo-2"]);
    expect(findUnmapped([current], wf, { "monzo-1": "wf-deleted" }).map((a) => a.id)).toEqual(["monzo-1"]);
  });

  it("skips accounts already handled this session", () => {
    expect(findUnmapped([current], [], {}, new Set(["monzo-1"]))).toEqual([]);
  });
});

describe("ensureAccountMapping", () => {
  it("reuses an existing Wealthfolio account with the expected name", async () => {
    const t = makeCtx({ wfAccounts: [{ id: "wf-1", name: "Monzo Current (12345678)" }] });
    const { mapping, created } = await ensureAccountMapping(t.ctx, [current], t.wfAccounts, {});
    expect(mapping).toEqual({ "monzo-1": "wf-1" });
    expect(created).toEqual([]);
    expect(t.created).toHaveLength(0);
  });

  it("creates cash accounts for the rest, once each, in the account currency", async () => {
    const t = makeCtx();
    const handled = new Set<string>();
    const first = await ensureAccountMapping(t.ctx, [current, flex], t.wfAccounts, {}, handled);
    expect(first.created).toEqual(["Monzo Current (12345678)", "Monzo Flex"]);
    expect(t.created[0]).toMatchObject({ accountType: "CASH", currency: "GBP", trackingMode: "TRANSACTIONS" });

    // A second pass (e.g. a re-render) must not create duplicates.
    const second = await ensureAccountMapping(t.ctx, [current, flex], t.wfAccounts, first.mapping, handled);
    expect(second.created).toEqual([]);
    expect(t.created).toHaveLength(2);
  });
});
