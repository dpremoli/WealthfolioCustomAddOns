import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import { jsonStore, reconcileWithLedger, type ImportLedger } from "@wf-addons/kit";
import { PROVIDER } from "../constants";
import { mapCsvRow, parseCsv } from "./csv";
import type { SymbolResolver } from "./symbol-resolver";

/**
 * Trading 212's Cash ISA has no API access (the Public API only serves Invest and Stocks
 * ISA), so it is imported from the CSV the app exports: `Action, Time (UTC), Notes, ID,
 * Total, Currency (Total)`, with Deposit / Withdrawal / Interest on cash rows.
 */

/** Wealthfolio account id of the Cash ISA account this add-on created, by providerAccountId. */
export const CASH_ISA_PROVIDER_ID = "t212-cash-isa";
/** Import ledger (kit `ImportLedger`) of Cash ISA rows already imported. */
const LEDGER_KEY = "t212_cash_isa_ledger";
export const DEFAULT_CASH_ISA_NAME = "Trading 212 Cash ISA";

const CASH_TYPES = new Set(["DEPOSIT", "WITHDRAWAL", "INTEREST", "FEE"]);

// Cash rows never need a symbol lookup; anything that would is not a Cash ISA row.
const NO_SYMBOLS = {
  resolve: async () => null,
  resolveDetailed: async () => null,
} as unknown as SymbolResolver;

export interface CashIsaParse {
  activities: ActivityImport[];
  /** Rows left out, by Action. */
  skipped: Record<string, number>;
  /** Currency of the rows (the account's currency), GBP if none say. */
  currency: string;
}

/** Maps a Cash ISA CSV export to cash activities for `accountId` (ids dedupe within the file). */
export async function parseCashIsaCsv(text: string, accountId: string): Promise<CashIsaParse> {
  const activities: ActivityImport[] = [];
  const skipped: Record<string, number> = {};
  const seen = new Set<string>();
  let currency = "";
  for (const row of parseCsv(text)) {
    const action = (row["Action"] ?? "").trim() || "(no action)";
    const a = await mapCsvRow(row, accountId, NO_SYMBOLS);
    if (!a || !CASH_TYPES.has(String(a.activityType))) {
      skipped[action] = (skipped[action] ?? 0) + 1;
      continue;
    }
    if (a.id && seen.has(a.id)) continue;
    if (a.id) seen.add(a.id);
    currency ||= a.currency ?? "";
    activities.push(a);
  }
  return { activities, skipped, currency: currency || "GBP" };
}

/** The Wealthfolio Cash account for the Cash ISA, created on first use. */
export async function ensureCashIsaAccount(
  ctx: AddonContext,
  currency: string,
  name = DEFAULT_CASH_ISA_NAME,
): Promise<string> {
  const accounts = await ctx.api.accounts.getAll();
  const match = accounts.find(
    (a) => (a as { providerAccountId?: string }).providerAccountId === CASH_ISA_PROVIDER_ID,
  );
  if (match) return match.id;
  const created = await ctx.api.accounts.create({
    name,
    accountType: "CASH",
    currency,
    isDefault: false,
    isActive: true,
    trackingMode: "TRANSACTIONS",
    provider: PROVIDER,
    providerAccountId: CASH_ISA_PROVIDER_ID,
  });
  return created.id;
}

export interface CashIsaImportResult {
  imported: number;
  /** Already in the account (same Trading 212 id, or the same row imported earlier). */
  duplicates: number;
}

/**
 * Imports parsed Cash ISA rows. Safe to repeat and to overlap exports: rows are recognised by
 * their Trading 212 id through an import ledger, and genuine identical rows (two equal
 * deposits on one day) are kept, since every row is force-imported after reconciling.
 */
export async function importCashIsa(
  ctx: AddonContext,
  accountId: string,
  activities: ActivityImport[],
): Promise<CashIsaImportResult> {
  if (activities.length === 0) return { imported: 0, duplicates: 0 };
  const store = jsonStore(ctx.api.storage);
  const rows = activities.map((a) => ({ ...a, accountId }));
  const { toImport, present, ledger } = reconcileWithLedger(
    rows,
    await ctx.api.activities.getAll(accountId),
    await store.get<ImportLedger>(LEDGER_KEY, {}),
    accountId,
  );
  let imported = 0;
  if (toImport.length > 0) {
    const res = await ctx.api.activities.import(toImport);
    imported = res.summary.imported;
  }
  await store.set(LEDGER_KEY, ledger);
  return { imported, duplicates: present.length };
}
