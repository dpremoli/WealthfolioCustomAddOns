import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import { jsonStore, ledgerAccountId, reconcileWithLedger, type ImportLedger } from "@wf-addons/kit";
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
/** {@link CashIsaState}: which Wealthfolio account holds the Cash ISA. */
const STATE_KEY = "t212_cash_isa";
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
  for (const row of parseCsv(text)) {
    const action = (row["Action"] ?? "").trim() || "(no action)";
    const a = await mapCsvRow(row, accountId, NO_SYMBOLS);
    if (a && CASH_TYPES.has(String(a.activityType))) activities.push(a);
    else skipped[action] = (skipped[action] ?? 0) + 1;
  }
  return mergeCashIsaParses([{ activities, skipped, currency: "" }]);
}

/**
 * Combines the parses of several exports (e.g. one per tax year) into one: rows that appear
 * in more than one file (same Trading 212 id) are kept once.
 */
export function mergeCashIsaParses(parses: CashIsaParse[]): CashIsaParse {
  const activities: ActivityImport[] = [];
  const skipped: Record<string, number> = {};
  const seen = new Set<string>();
  let currency = "";
  for (const p of parses) {
    for (const [action, n] of Object.entries(p.skipped)) skipped[action] = (skipped[action] ?? 0) + n;
    for (const a of p.activities) {
      if (a.id && seen.has(a.id)) continue;
      if (a.id) seen.add(a.id);
      currency ||= a.currency ?? "";
      activities.push(a);
    }
  }
  return { activities, skipped, currency: currency || "GBP" };
}

export interface CashIsaState {
  /** Wealthfolio account the last import went into. */
  accountId?: string;
  /** When the last import finished (ISO). */
  lastImport?: string;
  /** The user removed the Cash ISA from the add-on; cleared by the next import. */
  removed?: boolean;
}

export async function getCashIsaState(ctx: AddonContext): Promise<CashIsaState> {
  return jsonStore(ctx.api.storage).get<CashIsaState>(STATE_KEY, {});
}

/**
 * Stops listing the Cash ISA. The account, its activities, the import ledger and which account
 * it is are all kept, so importing again later goes into the same account and adds nothing twice.
 */
export async function forgetCashIsa(ctx: AddonContext): Promise<void> {
  const state = await getCashIsaState(ctx);
  await jsonStore(ctx.api.storage).set<CashIsaState>(STATE_KEY, { ...state, removed: true });
}

/** Whether `account` is the Cash account this add-on created for the Cash ISA. */
export function isOwnCashIsaAccount(account: object): boolean {
  return (account as { providerAccountId?: string }).providerAccountId === CASH_ISA_PROVIDER_ID;
}

export interface CashIsa<A> {
  /** The Wealthfolio account holding the Cash ISA, if it has one (removed ones included). */
  account?: A;
  state: CashIsaState;
}

/**
 * The Wealthfolio account holding the Cash ISA: the account the last import went into, else the
 * one this add-on created, else (imports made before that was recorded) an account the import
 * ledger points at. Both listing and importing use this, so they always agree.
 */
export async function findCashIsa<A extends { id: string }>(
  ctx: AddonContext,
  accounts: A[],
): Promise<CashIsa<A>> {
  const state = await getCashIsaState(ctx);
  const byId = (id: string | undefined) => (id ? accounts.find((a) => a.id === id) : undefined);
  let account = byId(state.accountId) ?? accounts.find(isOwnCashIsaAccount);
  if (!account) {
    const ledger = await jsonStore(ctx.api.storage).get<ImportLedger>(LEDGER_KEY, {});
    for (const entry of Object.values(ledger)) {
      account = byId(ledgerAccountId(entry));
      if (account) break;
    }
  }
  return { account, state };
}

/** The Wealthfolio account for the Cash ISA ({@link findCashIsa}), created on first use. */
export async function ensureCashIsaAccount(
  ctx: AddonContext,
  currency: string,
  name = DEFAULT_CASH_ISA_NAME,
): Promise<string> {
  const { account } = await findCashIsa(ctx, await ctx.api.accounts.getAll());
  if (account) return account.id;
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
  await store.set<CashIsaState>(STATE_KEY, { accountId, lastImport: new Date().toISOString() });
  return { imported, duplicates: present.length };
}
