/**
 * A fake Wealthfolio 3.11 host for end-to-end tests of the add-on: it behaves where the real host
 * does, and only counts what it actually stores. What it reproduces (each learned the hard way, see
 * the host's `activities_service.rs` and storage API):
 *
 * - `checkImport` returns the rows in order with a **new random id on every row**, fills in the
 *   resolved asset (exchange MIC, quote currency, instrument type) and flags invalid rows.
 * - `import` is **all or nothing on validation**: if any row fails its checks (an equity row with
 *   no quote currency or instrument type, no account…) it answers 200 with `success: false`,
 *   `imported: 0`, no import run and the reasons on the rows, and stores not one row — not even
 *   the valid ones sent with it. A row its writer policy refuses is left out and marked invalid
 *   on the returned row while the rest are stored.
 * - A stored activity gets a new id of the host's own (the id sent is not kept).
 * - `storage.set` refuses a value above ~244 KB: "too large to sync across devices".
 */
import type { AddonContext, ActivityImport } from "@wealthfolio/addon-sdk";

export const STORAGE_CAP_BYTES = 244 * 1024;

export interface StoredActivity {
  id: string;
  accountId: string;
  activityType: string;
  date: Date;
  assetSymbol: string | null;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
  fee: number | null;
  currency: string;
  comment: string | null;
}

export interface ImportCall {
  sent: number;
  stored: number;
  success: boolean;
  importRunId: string;
}

export interface FakeAccount {
  id: string;
  name: string;
  currency?: string;
  trackingMode?: string;
  providerAccountId?: string;
  accountType?: string;
}

const CASH_TYPES = new Set(["DEPOSIT", "WITHDRAWAL", "INTEREST", "FEE", "TAX", "CREDIT"]);
const ASSET_TYPES = new Set(["BUY", "SELL", "DIVIDEND", "SPLIT"]);

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
const bytes = (s: string) => new TextEncoder().encode(s).length;

export class FakeWealthfolio {
  readonly storage = new Map<string, string>();
  readonly secrets = new Map<string, string>();
  readonly accounts: FakeAccount[];
  readonly stored = new Map<string, StoredActivity[]>();
  readonly importCalls: ImportCall[] = [];
  /** Largest value written to storage so far. */
  maxStoredValueBytes = 0;
  /** Returns a reason to make the host's writer policy refuse a row (the rest of the call is stored). */
  policy: (a: ActivityImport) => string | null = () => null;
  /** Returns a reason to make `checkImport` flag a row invalid (and `import` refuse the call). */
  validation: (a: ActivityImport) => string | null = () => null;
  /** Returns a reason to make only `import`'s own validation fail a row (the whole call stores nothing). */
  importValidation: (a: ActivityImport) => string | null = () => null;
  readonly ctx: AddonContext;

  constructor(accounts: FakeAccount[], opts: { search?: (q: string) => unknown[] } = {}) {
    this.accounts = [...accounts];
    const search = opts.search ?? ((q: string) => [{ symbol: q.split("_")[0], exchangeMic: "XLON", currency: "GBP", score: 1, quoteType: "EQUITY" }]);
    const kv = (m: Map<string, string>, capped: boolean) => ({
      get: async (k: string) => m.get(k) ?? null,
      set: async (k: string, v: string) => {
        const n = bytes(v);
        if (capped) {
          if (n > STORAGE_CAP_BYTES) {
            throw new Error(`Invalid storage value: too large to sync across devices (max ~244 KB) [${k}: ${n} bytes]`);
          }
          this.maxStoredValueBytes = Math.max(this.maxStoredValueBytes, n);
        }
        m.set(k, v);
      },
      delete: async (k: string) => void m.delete(k),
    });
    this.ctx = {
      api: {
        storage: kv(this.storage, true),
        secrets: kv(this.secrets, false),
        // Each test installs its own Trading 212 API behaviour on `network`.
        network: { request: async () => ({ status: 404, headers: {}, body: "" }) },
        market: { searchTicker: async (q: string) => search(q) },
        accounts: {
          getAll: async () => this.accounts.map((a) => ({ providerAccountId: "", ...a })),
          create: async (a: { name: string; accountType?: string; currency?: string; trackingMode?: string }) => {
            const created = { id: `acc-${this.accounts.length + 1}`, name: a.name, accountType: a.accountType, currency: a.currency, trackingMode: a.trackingMode };
            this.accounts.push(created);
            return created;
          },
        },
        activities: {
          checkImport: async (rows: ActivityImport[]) => this.checkImport(rows),
          import: async (rows: ActivityImport[]) => this.importRows(rows),
          getAll: async (accountId?: string) => [...(this.stored.get(accountId ?? "") ?? [])],
          saveMany: async () => ({}),
        },
        snapshots: { getAll: async () => [], save: async () => {}, delete: async () => {} },
        portfolio: { getHoldings: async (accountId: string) => this.holdings(accountId) },
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      },
    } as unknown as AddonContext;
  }

  /** Every row stored in `accountId`, or in all accounts. */
  rows(accountId?: string): StoredActivity[] {
    return accountId ? [...(this.stored.get(accountId) ?? [])] : [...this.stored.values()].flat();
  }

  /** How many stored rows of each activity type an account holds. */
  countsByType(accountId: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.rows(accountId)) out[r.activityType] = (out[r.activityType] ?? 0) + 1;
    return out;
  }

  /** The securities Wealthfolio derives from the stored rows, and the cash (account currency). */
  holdings(accountId: string) {
    const qty = new Map<string, number>();
    let cash = 0;
    for (const r of this.rows(accountId)) {
      const q = r.quantity ?? 0;
      if (r.assetSymbol && (r.activityType === "BUY" || r.activityType === "TRANSFER_IN")) qty.set(r.assetSymbol, (qty.get(r.assetSymbol) ?? 0) + q);
      else if (r.assetSymbol && (r.activityType === "SELL" || r.activityType === "TRANSFER_OUT")) qty.set(r.assetSymbol, (qty.get(r.assetSymbol) ?? 0) - q);
      cash += this.cashEffect(r);
    }
    const securities = [...qty].filter(([, q]) => Math.abs(q) > 1e-9).map(([symbol, quantity]) => ({ holdingType: "security", instrument: { symbol }, quantity, localCurrency: "GBP" }));
    return [...securities, { holdingType: "cash", quantity: cash, localCurrency: "GBP" }];
  }

  cash(accountId: string): number {
    return this.rows(accountId).reduce((n, r) => n + this.cashEffect(r), 0);
  }

  private cashEffect(r: StoredActivity): number {
    const amount = r.amount ?? 0;
    const gross = (r.quantity ?? 0) * (r.unitPrice ?? 0);
    switch (r.activityType) {
      case "DEPOSIT":
      case "INTEREST":
      case "DIVIDEND":
      case "CREDIT":
        return amount;
      case "WITHDRAWAL":
      case "FEE":
      case "TAX":
        return -amount;
      case "BUY":
        return -(gross + (r.fee ?? 0));
      case "SELL":
        return gross - (r.fee ?? 0);
      case "TRANSFER_IN":
        return r.assetSymbol ? 0 : amount;
      case "TRANSFER_OUT":
        return r.assetSymbol ? 0 : -amount;
      default:
        return 0;
    }
  }

  private isAssetRow(a: ActivityImport): boolean {
    return ASSET_TYPES.has(String(a.activityType)) || (!!a.symbol && !String(a.symbol).startsWith("$CASH") && !CASH_TYPES.has(String(a.activityType)));
  }

  private checkImport(rows: ActivityImport[]): ActivityImport[] {
    return rows.map((a) => {
      const out: ActivityImport = { ...a, id: uuid(), isValid: true, errors: undefined, warnings: undefined };
      if (Number.isNaN(Date.parse(String(a.date)))) {
        out.isValid = false;
        out.errors = { activityDate: ["Invalid date"] };
        return out;
      }
      if (this.isAssetRow(a)) {
        out.exchangeMic = a.exchangeMic ?? "XLON";
        out.quoteCcy = a.quoteCcy ?? a.currency;
        out.instrumentType = a.instrumentType ?? "EQUITY";
      } else {
        out.symbol = "";
        out.exchangeMic = undefined;
        out.quoteCcy = undefined;
        out.instrumentType = undefined;
      }
      const why = this.validation(a);
      if (why) {
        out.isValid = false;
        out.errors = { general: [why] };
      }
      return out;
    });
  }

  private importRows(rows: ActivityImport[]) {
    const total = rows.length;
    const result = (activities: ActivityImport[], stored: number, success: boolean, runId: string, error?: string) => {
      this.importCalls.push({ sent: total, stored, success, importRunId: runId });
      return {
        activities,
        importRunId: runId,
        summary: { total, imported: stored, skipped: total - stored, duplicates: 0, assetsCreated: 0, success, errorMessage: error },
      };
    };

    // Step 3.5: validation, all or nothing.
    const checked = rows.map((a) => ({ ...a }));
    let failed = false;
    for (const a of checked) {
      const account = this.accounts.find((x) => x.id === a.accountId);
      const fail = (field: string, message: string) => {
        a.isValid = false;
        a.errors = { ...(a.errors ?? {}), [field]: [...(a.errors?.[field] ?? []), message] };
        failed = true;
      };
      if (!account) fail("accountId", "Account is required before importing activities.");
      if (Number.isNaN(Date.parse(String(a.date)))) fail("activityDate", "Invalid date");
      if (this.isAssetRow(a) && !a.assetId) {
        if (!a.quoteCcy?.trim()) fail("quoteCcy", "Price currency (quoteCcy) is required to import this activity.");
        if (!a.instrumentType?.trim()) fail("instrumentType", "Instrument type is required to import this activity.");
      }
      const why = this.validation(a) ?? this.importValidation(a);
      if (why) fail("general", why);
    }
    if (failed) return result(checked, 0, false, "", "Validation errors found in activities.");

    // Writer policy: refuses some rows, stores the rest.
    const toStore: ActivityImport[] = [];
    for (const a of checked) {
      const why = this.policy(a);
      if (why) {
        a.isValid = false;
        a.errors = { general: [why] };
      } else toStore.push(a);
    }
    const runId = toStore.length > 0 ? uuid() : "";
    for (const a of toStore) {
      const list = this.stored.get(a.accountId) ?? [];
      list.push({
        id: uuid(), // the host keeps no id of ours
        accountId: a.accountId,
        activityType: String(a.activityType),
        date: new Date(String(a.date)),
        assetSymbol: this.isAssetRow(a) ? (a.symbol ?? null) : null,
        quantity: num(a.quantity),
        unitPrice: num(a.unitPrice),
        amount: num(a.amount),
        fee: num(a.fee),
        currency: a.currency ?? "GBP",
        comment: a.comment ?? null,
      });
      this.stored.set(a.accountId, list);
    }
    return result(checked, toStore.length, true, runId);
  }
}
