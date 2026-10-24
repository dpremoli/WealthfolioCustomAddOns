import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import {
  MOVE_MATCH_WINDOW_MS,
  T212_CASH_ISA_PROVIDER_ID,
  adoptUntrackedRows,
  isTrading212Payee,
  emptyRefused,
  importStoredRows,
  jsonStore,
  ledgerAccountId,
  linkMovesBetween,
  loadRefused,
  moveLinkNote,
  pendingRows,
  reconcileWithLedger,
  recordRefused,
  refusedError,
  saveRefused,
  trading212Refs,
  withoutUnsaved,
  type ImportLedger,
  type RefusedRows,
  type UnsavedRow,
} from "@wf-addons/kit";
import { PROVIDER } from "../constants";
import { mapCsvRow, parseCsv } from "./csv";
import type { SymbolResolver } from "./symbol-resolver";

/**
 * Trading 212's Cash ISA has no API access (the Public API only serves Invest and Stocks
 * ISA), so it is imported from the CSV the app exports: `Action, Time (UTC), Notes, ID,
 * Total, Currency (Total)`, with Deposit / Withdrawal / Interest on cash rows.
 */

/** Wealthfolio account id of the Cash ISA account this add-on created, by providerAccountId. */
export const CASH_ISA_PROVIDER_ID = T212_CASH_ISA_PROVIDER_ID;
/** Import ledger (kit `ImportLedger`) of Cash ISA rows already imported. */
const LEDGER_KEY = "t212_cash_isa_ledger";
/** Rows Wealthfolio refuses, retried on every import (kit `refused-rows`). */
const REFUSED_KEY = "t212_cash_isa_refused";
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
  /** Rows Wealthfolio stored. */
  imported: number;
  /** Already in the account (same Trading 212 id, or the same row imported earlier). */
  duplicates: number;
  /** Deposits/withdrawals converted to transfers and linked with a Monzo row (usually 0). */
  linked: number;
  /** One line about the matching with other accounts, when there was anything to say. */
  moveNote?: string;
  /** Rows Wealthfolio did not store in this call, with its reason: not in the ledger, kept in `refused`. */
  unsaved: UnsavedRow[];
  /** Every row Wealthfolio is refusing now (this call's and earlier ones); each import sends them again. */
  refused: RefusedRows;
  /** Set while Wealthfolio refuses some rows: tell the user; they are retried on every import. */
  error?: string;
}

/**
 * Imports parsed Cash ISA rows. Safe to repeat and to overlap exports: rows are recognised by
 * their Trading 212 id through an import ledger, and genuine identical rows (two equal
 * deposits on one day) are kept, since every row is force-imported after reconciling. A row the
 * user already turned into a transfer by hand is taken for the same row, not imported again.
 *
 * Deposits and withdrawals stay as they are, which is right for everyone (they count towards the
 * ISA allowance) and is all that happens unless another Wealthfolio account holds the other half
 * of the move: see {@link matchWithOtherAccounts}.
 *
 * Wealthfolio answers 200 even when it stored nothing, so a row is recorded in the ledger only
 * when the answer says it was stored (kit `importStoredRows`); the rest come back as `unsaved` and
 * wait in a list of their own (`REFUSED_KEY`): they are reconciled and sent again with every
 * import, and leave the list once stored.
 */
export async function importCashIsa(
  ctx: AddonContext,
  accountId: string,
  activities: ActivityImport[],
): Promise<CashIsaImportResult> {
  const store = jsonStore(ctx.api.storage);
  const refused = await loadRefused(ctx.api.storage, REFUSED_KEY);
  // The rows refused earlier are reconciled and sent again with the new ones, once each.
  const rows = pendingRows(
    refused,
    accountId,
    activities.map((a) => ({ ...a, accountId })),
  );
  if (rows.length === 0) return { imported: 0, duplicates: 0, linked: 0, unsaved: [], refused: emptyRefused() };
  const existing = await ctx.api.activities.getAll(accountId);
  const reconciled = reconcileWithLedger(
    rows,
    existing,
    await store.get<ImportLedger>(LEDGER_KEY, {}),
    accountId,
  );
  const { present } = reconciled;
  const { toImport, adopted } = adoptUntrackedRows(reconciled.toImport, existing, reconciled.ledger, accountId, {
    equivalents: { DEPOSIT: ["TRANSFER_IN"], WITHDRAWAL: ["TRANSFER_OUT"] },
    // The two legs of a move can be dated days apart; a transfer made by hand carries one date.
    windowMs: MOVE_MATCH_WINDOW_MS,
  });
  let imported = 0;
  let unsaved: UnsavedRow[] = [];
  let accounted = [...present, ...adopted];
  if (toImport.length > 0) {
    const res = await importStoredRows((batch) => ctx.api.activities.import(batch), toImport);
    imported = res.stored.length;
    unsaved = res.unsaved;
    accounted = [...accounted, ...res.stored, ...res.duplicates];
  }
  // The ledger keeps entries only for rows Wealthfolio stored: an unsaved row is not recorded.
  await store.set(LEDGER_KEY, withoutUnsaved(reconciled.ledger, unsaved));
  // Rows stored (or already there) leave the refused list; the ones refused now join it.
  const refusedNow =
    refused.entries.length > 0 || refused.dropped > 0 || unsaved.length > 0
      ? await saveRefused(ctx.api.storage, REFUSED_KEY, recordRefused(refused, accounted, unsaved))
      : refused;
  await store.set<CashIsaState>(STATE_KEY, { accountId, lastImport: new Date().toISOString() });
  const moves = await matchWithOtherAccounts(ctx, accountId);
  return {
    imported,
    duplicates: present.length + adopted.length,
    linked: moves.linked,
    moveNote: moveLinkNote("your bank account", moves) ?? undefined,
    unsaved,
    refused: refusedNow,
    error: refusedError(refusedNow),
  };
}

/**
 * Finds the other half of the Cash ISA's deposits and withdrawals in the user's other cash
 * accounts (a Monzo account that the Monzo add-on synced, say) and, for each confident pair,
 * converts both rows to a linked transfer (see kit `linkMovesBetween`). Only rows whose payee
 * points at Trading 212 (its name or one of the user's Trading 212 account numbers) are
 * considered on the other side, so unrelated moves of the same amount are not mistaken for each
 * other. Deposits from accounts that are not in Wealthfolio have no counterpart, so they stay
 * deposits (an unlinked transfer would drop them from the ISA allowance). Never throws.
 */
export async function matchWithOtherAccounts(ctx: AddonContext, isaAccountId: string) {
  try {
    const accounts = await ctx.api.accounts.getAll();
    const refs = trading212Refs(accounts);
    return await linkMovesBetween(ctx, {
      accounts,
      mine: [isaAccountId],
      theirs: (a) => a.accountType === "CASH" && a.provider !== PROVIDER,
      theirRow: (r) => isTrading212Payee(r.comment, refs),
    });
  } catch (err) {
    return { linked: 0, ambiguous: [] as string[], failed: [(err as Error).message] };
  }
}
