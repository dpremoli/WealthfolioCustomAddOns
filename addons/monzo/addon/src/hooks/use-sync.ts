import { useState } from "react";
import type { AddonContext } from "@wealthfolio/addon-sdk";
import type { AccountMapping, SyncProgress, SyncResult, SyncStep } from "../types";
import { MonzoProxyClient } from "../lib/proxy-client";
import {
  isPending,
  isPotTransfer,
  isFlexRepayment,
  mapTransactionToActivity,
  tallyByCategory,
} from "../lib/mapper";
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
  progress: SyncProgress | null;
  steps: SyncStep[];
}

export function useSync(ctx: AddonContext) {
  const [state, setState] = useState<SyncState>({
    isSyncing: false,
    lastSyncAt: null,
    lastResult: null,
    error: null,
    progress: null,
    steps: [],
  });

  async function sync() {
    setState((s) => ({ ...s, isSyncing: true, error: null, progress: null, steps: [] }));
    const onProgress = (p: SyncProgress) =>
      setState((s) => ({ ...s, progress: p, steps: appendStep(s.steps, p) }));

    const log: string[] = [];
    try {
      onProgress({ phase: "fetch", message: "Checking connection…" });
      const proxyUrl = await ctx.api.secrets.get(PROXY_URL_KEY);
      if (!proxyUrl) throw new Error("Proxy URL not configured. Open Settings to set it up.");

      const mappingRaw = await ctx.api.secrets.get(MAPPING_KEY);
      if (!mappingRaw) throw new Error("No account mapping configured. Open Settings first.");
      const mapping: AccountMapping = JSON.parse(mappingRaw);

      let tokens = await getTokens(ctx);
      if (!tokens) throw new Error("Not connected to Monzo. Open Settings to connect.");

      const client = new MonzoProxyClient(proxyUrl);

      if (isTokenExpired(tokens)) {
        onProgress({ phase: "fetch", message: "Refreshing access token…" });
        const refreshed = await client.refreshToken(tokens.refresh_token);
        await setTokens(ctx, refreshed);
        tokens = refreshed;
      }

      const lastSyncRaw = await ctx.api.secrets.get(LAST_SYNC_KEY);
      const lastSync: string | undefined = lastSyncRaw
        ? (JSON.parse(lastSyncRaw) as string)
        : undefined;
      log.push(lastSync ? `Incremental sync since ${lastSync}.` : "Full sync (last 90 days).");

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
      const breakdown: Record<string, number> = {};

      const accountIds = Object.entries(mapping);
      let idx = 0;
      for (const [monzoAccountId, wealthfolioAccountId] of accountIds) {
        idx++;
        onProgress({
          phase: "fetch",
          message: "Fetching transactions…",
          current: idx,
          total: accountIds.length,
        });
        const { transactions } = await client.getTransactions(
          tokens.access_token,
          monzoAccountId,
          lastSync,
        );

        const isFlex = flexAccountIds.has(monzoAccountId);
        const eligible = transactions.filter(
          // Flex transactions are never settled (monthly billing) — don't filter them out
          (tx) => (isFlex || !isPending(tx)) && !isPotTransfer(tx) && !isFlexRepayment(tx),
        );
        log.push(`Account ${monzoAccountId.slice(0, 10)}…: ${transactions.length} fetched, ${eligible.length} eligible.`);
        // Tally spending by category across all accounts for the UI breakdown.
        const catCounts = tallyByCategory(eligible, categoryLabels);
        for (const [k, v] of Object.entries(catCounts)) breakdown[k] = (breakdown[k] ?? 0) + v;

        if (eligible.length === 0) continue;

        const activities = eligible.map((tx) =>
          mapTransactionToActivity(tx, wealthfolioAccountId, categoryLabels),
        );

        const checked = await ctx.api.activities.checkImport(activities);
        const validActivities = checked.filter((a) => a.isValid !== false);
        const invalidActivities = checked.filter((a) => a.isValid === false);

        if (invalidActivities.length > 0 && validActivities.length === 0) {
          hasStaleMapping = true;
          continue;
        }

        const toImport = validActivities.filter((a) => !a.duplicateOfId);
        if (toImport.length > 0) {
          onProgress({ phase: "import", message: `Importing ${toImport.length} transactions…` });
          const result = await ctx.api.activities.import(toImport);
          totalImported += result.summary.imported;
          totalSkipped += result.summary.skipped;
          totalDuplicates += result.summary.duplicates;
        } else {
          totalDuplicates += validActivities.length;
        }
        totalDuplicates += invalidActivities.length;
      }

      if (hasStaleMapping) {
        throw new Error(
          "Account mapping is out of date (mapped accounts were deleted). " +
            "Open Settings to reconnect and re-create accounts.",
        );
      }

      const now = new Date().toISOString();
      await ctx.api.secrets.set(LAST_SYNC_KEY, JSON.stringify(now));
      log.push(`Import: ${totalImported} imported, ${totalDuplicates} duplicates, ${totalSkipped} skipped.`);

      onProgress({ phase: "done", message: `Synced ${totalImported} transaction${totalImported === 1 ? "" : "s"}.` });

      setState((s) => ({
        isSyncing: false,
        lastSyncAt: now,
        lastResult: {
          imported: totalImported,
          skipped: totalSkipped,
          duplicates: totalDuplicates,
          breakdown,
          log,
          finishedAt: now,
        },
        error: null,
        progress: null,
        steps: markLastDone(s.steps),
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        isSyncing: false,
        progress: null,
        error: (err as Error).message,
      }));
    }
  }

  return { ...state, sync };
}

/** Appends a progress event, coalescing consecutive duplicates and marking the prior done. */
function appendStep(prev: SyncStep[], p: SyncProgress): SyncStep[] {
  const last = prev[prev.length - 1];
  const same = last && last.phase === p.phase && last.message === p.message;
  const incoming: SyncStep = { ...p, ts: new Date().toISOString(), status: "active" };
  if (same) return [...prev.slice(0, -1), { ...last, ...incoming }];
  if (last) return [...prev.slice(0, -1), { ...last, status: "done" }, incoming];
  return [incoming];
}

function markLastDone(steps: SyncStep[]): SyncStep[] {
  if (steps.length === 0) return steps;
  return [...steps.slice(0, -1), { ...steps[steps.length - 1], status: "done" }];
}
