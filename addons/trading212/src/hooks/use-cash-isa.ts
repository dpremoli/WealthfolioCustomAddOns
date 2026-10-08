import type { Account, AddonContext } from "@wealthfolio/addon-sdk";
import { useQuery } from "@tanstack/react-query";
import { findCashIsa } from "../lib/cash-isa";

/** Query key of {@link useCashIsa}; invalidate it after an import or a remove. */
export const CASH_ISA_QUERY_KEY = ["t212_cash_isa"] as const;

export interface CashIsaInfo {
  /** The Wealthfolio account holding the Cash ISA (also after it was removed from the list). */
  account: Account | null;
  /** Whether the dashboard and Connected accounts list it. */
  listed: boolean;
  lastImport: string | null;
}

/** The Cash ISA's Wealthfolio account and import state (see `findCashIsa`). */
export function useCashIsa(ctx: AddonContext, enabled = true) {
  return useQuery({
    queryKey: CASH_ISA_QUERY_KEY,
    queryFn: async (): Promise<CashIsaInfo> => {
      const { account, state } = await findCashIsa(ctx, await ctx.api.accounts.getAll());
      return {
        account: account ?? null,
        listed: !!account && !state.removed,
        lastImport: state.lastImport ?? null,
      };
    },
    enabled,
  });
}
