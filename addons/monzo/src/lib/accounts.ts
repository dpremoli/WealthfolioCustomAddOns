import type { AddonContext } from "@wealthfolio/addon-sdk";
import type { AccountMapping, MonzoAccount } from "../types";

/** Name of the Wealthfolio cash account created for a Monzo account. */
export function accountTypeLabel(acc: MonzoAccount): string {
  switch (acc.account_type) {
    case "uk_retail":
      return acc.account_number ? `Monzo Current (${acc.account_number})` : "Monzo Current Account";
    case "uk_retail_joint":
      return "Monzo Joint Account";
    case "uk_monzo_flex":
      return "Monzo Flex";
    default:
      return acc.description || acc.account_type;
  }
}

/** Monzo accounts with no mapping, or whose mapped Wealthfolio account no longer exists. */
export function findUnmapped(
  monzoAccounts: MonzoAccount[],
  wfAccounts: { id: string }[],
  saved: AccountMapping,
  handled: ReadonlySet<string> = new Set(),
): MonzoAccount[] {
  const wfIds = new Set(wfAccounts.map((a) => a.id));
  return monzoAccounts.filter((acc) => {
    if (handled.has(acc.id)) return false;
    const mapped = saved[acc.id];
    return !mapped || !wfIds.has(mapped);
  });
}

export interface MappingResult {
  mapping: AccountMapping;
  /** Names of Wealthfolio accounts created in this pass. */
  created: string[];
}

/**
 * Maps every unmapped Monzo account to a Wealthfolio cash account: reuses an account with
 * the expected name, otherwise creates one. Never creates two accounts with the same name.
 */
export async function ensureAccountMapping(
  ctx: AddonContext,
  monzoAccounts: MonzoAccount[],
  wfAccounts: { id: string; name: string }[],
  saved: AccountMapping,
  handled: Set<string> = new Set(),
): Promise<MappingResult> {
  const mapping: AccountMapping = { ...saved };
  const created: string[] = [];
  const names = new Set(wfAccounts.map((a) => a.name));

  for (const acc of findUnmapped(monzoAccounts, wfAccounts, saved, handled)) {
    handled.add(acc.id);
    const name = accountTypeLabel(acc);
    const existing = wfAccounts.find((a) => a.name === name);
    if (existing) {
      mapping[acc.id] = existing.id;
      continue;
    }
    if (names.has(name)) continue;
    try {
      const account = await ctx.api.accounts.create({
        name,
        accountType: "CASH",
        currency: acc.currency || "GBP",
        isDefault: false,
        isActive: true,
        trackingMode: "TRANSACTIONS",
      });
      mapping[acc.id] = account.id;
      names.add(name);
      created.push(name);
    } catch (err) {
      ctx.api.logger.error(`Failed to create account ${name}: ${(err as Error).message}`);
    }
  }
  return { mapping, created };
}
