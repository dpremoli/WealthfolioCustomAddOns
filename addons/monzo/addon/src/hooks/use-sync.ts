import { useState } from "react";
import type { AddonContext } from "@wealthfolio/addon-sdk";
import type { AccountMapping, SyncResult } from "../types";
import { MonzoProxyClient } from "../lib/proxy-client";
import { isPending, isPotTransfer, mapTransactionToActivity } from "../lib/mapper";
import { getTokens, isTokenExpired, setTokens } from "./use-tokens";

const PROXY_URL_KEY = "monzo_proxy_url";
const MAPPING_KEY = "monzo_account_mapping";
const LAST_SYNC_KEY = "monzo_last_sync";
const CATEGORY_LABELS_KEY = "monzo_category_labels";

interface SyncState {
  isSyncing: boolean;
  lastSyncAt: string | null;
  lastResult: SyncResult | null;
  error: string | null;
}

export function useSync(ctx: AddonContext) {
  const [state, setState] = useState<SyncState>({
    isSyncing: false,
    lastSyncAt: null,
    lastResult: null,
    error: null,
  });

  async function sync() {
    setState((s) => ({ ...s, isSyncing: true, error: null }));
    try {
      const proxyUrl = await ctx.api.secrets.get(PROXY_URL_KEY);
      if (!proxyUrl) throw new Error("Proxy URL not configured. Open Settings to set it up.");

      const mappingRaw = await ctx.api.secrets.get(MAPPING_KEY);
      if (!mappingRaw) throw new Error("No account mapping configured. Open Settings first.");
      const mapping: AccountMapping = JSON.parse(mappingRaw);

      let tokens = await getTokens(ctx);
      if (!tokens) throw new Error("Not connected to Monzo. Open Settings to connect.");

      const client = new MonzoProxyClient(proxyUrl);

      if (isTokenExpired(tokens)) {
        const refreshed = await client.refreshToken(tokens.refresh_token);
        await setTokens(ctx, refreshed);
        tokens = refreshed;
      }

      const lastSyncRaw = await ctx.api.secrets.get(LAST_SYNC_KEY);
      const lastSync: string | undefined = lastSyncRaw
        ? (JSON.parse(lastSyncRaw) as string)
        : undefined;

      const categoryLabelsRaw = await ctx.api.secrets.get(CATEGORY_LABELS_KEY);
      const categoryLabels: Record<string, string> = categoryLabelsRaw
        ? (JSON.parse(categoryLabelsRaw) as Record<string, string>)
        : {};

      // Build account type lookup so we can skip the pending filter for Flex
      const monzoAccounts = await client.getAccounts(tokens.access_token);
      const flexAccountIds = new Set(
        monzoAccounts.filter((a) => a.account_type === "uk_monzo_flex").map((a) => a.id),
      );

      let totalImported = 0;
      let totalSkipped = 0;
      let totalDuplicates = 0;
      let hasStaleMapping = false;

      for (const [monzoAccountId, wealthfolioAccountId] of Object.entries(mapping)) {
        const { transactions } = await client.getTransactions(
          tokens.access_token,
          monzoAccountId,
          lastSync,
        );

        const isFlex = flexAccountIds.has(monzoAccountId);
        const eligible = transactions.filter(
          // Flex transactions are never settled (monthly billing) — don't filter them out
          (tx) => (isFlex || !isPending(tx)) && !isPotTransfer(tx),
        );
        if (eligible.length === 0) continue;

        const activities = eligible.map((tx) =>
          mapTransactionToActivity(tx, wealthfolioAccountId, categoryLabels),
        );

        const checked = await ctx.api.activities.checkImport(activities);
        
        // Separate valid and invalid activities
        const validActivities = checked.filter((a) => a.isValid !== false);
        const invalidActivities = checked.filter((a) => a.isValid === false);
        
        // If all activities are invalid due to "Record not found", mapping is stale
        if (invalidActivities.length > 0 && validActivities.length === 0) {
          hasStaleMapping = true;
          continue;
        }

        // Import only valid, non-duplicate activities
        const toImport = validActivities.filter((a) => !a.duplicateOfId);

        if (toImport.length > 0) {
          const result = await ctx.api.activities.import(toImport);
          totalImported += result.summary.imported;
          totalSkipped += result.summary.skipped;
          totalDuplicates += result.summary.duplicates;
        } else {
          totalDuplicates += validActivities.length;
        }
        
        // Count invalid activities as well
        totalDuplicates += invalidActivities.length;
      }

      if (hasStaleMapping) {
        throw new Error(
          "Account mapping is out of date (mapped accounts were deleted). " +
          "Open Settings to reconnect and re-create accounts."
        );
      }

      const now = new Date().toISOString();
      await ctx.api.secrets.set(LAST_SYNC_KEY, JSON.stringify(now));

      setState({
        isSyncing: false,
        lastSyncAt: now,
        lastResult: { imported: totalImported, skipped: totalSkipped, duplicates: totalDuplicates },
        error: null,
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        isSyncing: false,
        error: (err as Error).message,
      }));
    }
  }

  return { ...state, sync };
}
