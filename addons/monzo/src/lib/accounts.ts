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

/**
 * Wealthfolio account type for a Monzo account: Flex is a credit line (a liability you
 * repay), so it is a credit card account; current and joint accounts hold cash.
 */
export function monzoAccountType(acc: MonzoAccount): "CASH" | "CREDIT_CARD" {
  return acc.account_type === "uk_monzo_flex" ? "CREDIT_CARD" : "CASH";
}

const TYPE_NAMES: Record<string, string> = {
  CASH: "Cash",
  CREDIT_CARD: "Credit card",
  SECURITIES: "Securities",
  CRYPTOCURRENCY: "Cryptocurrency",
};

export interface AccountTypeIssue {
  /** The Wealthfolio account. */
  name: string;
  /** Its current type, for display ("Securities"). */
  current: string;
  /** The type it should have, for display ("Cash" / "Credit card"). */
  expected: string;
}

/**
 * Mapped Wealthfolio accounts whose type keeps them out of Wealthfolio's Spending reports
 * (which only count Cash and Credit card accounts). Early v1 versions sent the type under the
 * wrong field name, so their accounts were created as Securities. The add-on API cannot
 * change an account's type, so these are reported for the user to fix.
 */
export function accountTypeIssues(
  monzoAccounts: MonzoAccount[],
  wfAccounts: { id: string; name: string; accountType?: string }[],
  mapping: AccountMapping,
): AccountTypeIssue[] {
  const issues: AccountTypeIssue[] = [];
  for (const acc of monzoAccounts) {
    const wf = wfAccounts.find((a) => a.id === mapping[acc.id]);
    if (!wf?.accountType || wf.accountType === "CASH" || wf.accountType === "CREDIT_CARD") continue;
    issues.push({
      name: wf.name,
      current: TYPE_NAMES[wf.accountType] ?? wf.accountType,
      expected: TYPE_NAMES[monzoAccountType(acc)],
    });
  }
  return issues;
}

/** One sentence describing an {@link AccountTypeIssue} and its fix. */
export function accountTypeIssueText(i: AccountTypeIssue): string {
  return (
    `"${i.name}" is a ${i.current} account, so Wealthfolio's Spending reports and categories ` +
    `leave it out. Change it to ${i.expected} (Accounts → ${i.name} → Update Account).`
  );
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
        accountType: monzoAccountType(acc),
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
