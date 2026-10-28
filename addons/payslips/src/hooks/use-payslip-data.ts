import { useQuery } from "@tanstack/react-query";
import type { Account, AddonContext } from "@wealthfolio/addon-sdk";
import type { Link, Payslip, Settings } from "../lib/model";
import { defaultAccountIds, loadCandidateRows, matchSalaries, type SalaryMatch } from "../lib/salary-match";
import { loadLinks, loadPayslips, loadSettings, taxYears } from "../lib/store";

/** Every query of the add-on starts with this key, so one invalidation refreshes all pages. */
export const QUERY_ROOT = "payslips";

export interface PayslipData {
  years: number[];
  payslips: Payslip[];
}

export function usePayslipData(ctx: AddonContext) {
  return useQuery<PayslipData>({
    queryKey: [QUERY_ROOT, "data"],
    queryFn: async () => ({ years: await taxYears(ctx), payslips: await loadPayslips(ctx) }),
  });
}

export interface MatchData {
  accounts: Account[];
  settings: Settings;
  payslips: Payslip[];
  links: Record<string, Link>;
  matches: SalaryMatch[];
}

/**
 * Stored payslips matched to salary deposits of the accounts chosen in settings. Auto matches are
 * recomputed on every load; only manual picks and tags are stored (as links).
 */
export function useSalaryMatches(ctx: AddonContext) {
  return useQuery<MatchData>({
    queryKey: [QUERY_ROOT, "matches"],
    queryFn: async () => {
      const [accounts, settings, payslips, links] = await Promise.all([
        ctx.api.accounts.getAll(),
        loadSettings(ctx),
        loadPayslips(ctx),
        loadLinks(ctx),
      ]);
      const accountIds = settings.accountIds ?? defaultAccountIds(accounts);
      const rows = payslips.length > 0 ? await loadCandidateRows(ctx, accountIds) : [];
      return { accounts, settings, payslips, links, matches: matchSalaries(payslips, rows, settings.windowDays, links) };
    },
  });
}
