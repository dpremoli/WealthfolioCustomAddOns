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
 * - `storeNothing` makes `import` answer 200 and `success: true` while saving nothing and saying
 *   nothing about any row (the worst case: no reason anywhere).
 * - `storage.set` refuses a value above ~244 KB: "too large to sync across devices".
 * - **Duplicates** (`activities_service.rs`, `idempotency.rs`), keyed like the host's idempotency
 *   key (account, type, day, asset@MIC, quantity, price, amount, currency, comment): `checkImport`
 *   marks a row matching a stored activity `duplicateOfId` and a row matching an earlier row of the
 *   same call `duplicateOfLineNumber` (with a `_duplicate` warning). `import` skips such a row
 *   unless it is sent with `forceImport`, and returns it marked; a forced row is stored even if it
 *   still carries a marker, and the marker it was sent with comes back on the returned row.
 * - A row in a minor-unit currency (GBX) is stored in its major unit: its price, amount and fee
 *   divided by 100, a SPLIT's ratio included (`activities_service.rs`, `fx/currency.rs`).
 * - Holdings apply `SPLIT` rows (ratio in `amount`) to the lots held before the split day, and
 *   `saveMany({ deleteIds })` deletes activities.
 */
import type { AddonContext, ActivityImport } from "@wealthfolio/addon-sdk";

export const STORAGE_CAP_BYTES = 244 * 1024;

export interface StoredActivity {
  id: string;
  accountId: string;
  activityType: string;
  date: Date;
  assetSymbol: string | null;
  exchangeMic: string | null;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
  fee: number | null;
  currency: string;
  comment: string | null;
}

export interface ImportCall {
  sent: number;
  /** The ids (as the add-on sent them) of the rows of the call. */
  sentIds: (string | undefined)[];
  stored: number;
  success: boolean;
  importRunId: string;
}

export interface FakeAccount {
  id: string;
  name: string;
  provider?: string;
  currency?: string;
  trackingMode?: string;
  providerAccountId?: string;
  accountType?: string;
}

const CASH_TYPES = new Set(["DEPOSIT", "WITHDRAWAL", "INTEREST", "FEE", "TAX", "CREDIT"]);
const ASSET_TYPES = new Set(["BUY", "SELL", "DIVIDEND", "SPLIT"]);

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;
// Minor-unit currencies the host stores in their major unit: [major, units per major].
const MINOR_UNITS: Record<string, [string, number]> = { GBX: ["GBP", 100], ZAC: ["ZAR", 100], ILA: ["ILS", 100], KWF: ["KWD", 1000], USX: ["USD", 100] };
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
const bytes = (s: string) => new TextEncoder().encode(s).length;

export class FakeWealthfolio {
  readonly storage = new Map<string, string>();
  readonly secrets = new Map<string, string>();
  readonly accounts: FakeAccount[];
  readonly stored = new Map<string, StoredActivity[]>();
  readonly importCalls: ImportCall[] = [];
  /** The ids (as the add-on sent them) of the rows of each `checkImport` call. */
  readonly checkedIds: (string | undefined)[][] = [];
  /** Largest value written to storage so far. */
  maxStoredValueBytes = 0;
  /** Returns a reason to make the host's writer policy refuse a row (the rest of the call is stored). */
  policy: (a: ActivityImport) => string | null = () => null;
  /** Returns a reason to make `checkImport` flag a row invalid (and `import` refuse the call). */
  validation: (a: ActivityImport) => string | null = () => null;
  /** Returns a reason to make only `import`'s own validation fail a row (the whole call stores nothing). */
  importValidation: (a: ActivityImport) => string | null = () => null;
  /** Makes `import` answer 200 and store nothing, with no reason on any row. */
  storeNothing = false;
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
          create: async (a: Omit<FakeAccount, "id"> & Record<string, unknown>) => {
            // Everything the add-on sent is kept (provider ids included): it is how it finds the account again.
            const created = { ...a, id: `acc-${this.accounts.length + 1}` } as FakeAccount;
            this.accounts.push(created);
            return created;
          },
        },
        activities: {
          checkImport: async (rows: ActivityImport[]) => this.checkImport(rows),
          import: async (rows: ActivityImport[]) => this.importRows(rows),
          getAll: async (accountId?: string) => [...(this.stored.get(accountId ?? "") ?? [])],
          saveMany: async (req: { deleteIds?: string[] }) => {
            const gone = new Set(req.deleteIds ?? []);
            for (const [id, list] of this.stored) this.stored.set(id, list.filter((r) => !gone.has(r.id)));
            return { deleted: [...gone] };
          },
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
    // A split scales the lots held before its day; rows of the split day come after it.
    const order = (r: StoredActivity) => (r.activityType === "SPLIT" ? 0 : 1);
    const rows = this.rows(accountId).sort((a, b) => {
      const d = a.date.toISOString().slice(0, 10).localeCompare(b.date.toISOString().slice(0, 10));
      return d !== 0 ? d : order(a) - order(b);
    });
    for (const r of rows) {
      const q = r.quantity ?? 0;
      if (r.assetSymbol && (r.activityType === "BUY" || r.activityType === "TRANSFER_IN")) qty.set(r.assetSymbol, (qty.get(r.assetSymbol) ?? 0) + q);
      else if (r.assetSymbol && (r.activityType === "SELL" || r.activityType === "TRANSFER_OUT")) qty.set(r.assetSymbol, (qty.get(r.assetSymbol) ?? 0) - q);
      else if (r.assetSymbol && r.activityType === "SPLIT") qty.set(r.assetSymbol, (qty.get(r.assetSymbol) ?? 0) * (r.amount ?? 1));
      cash += this.cashEffect(r);
    }
    const securities = [...qty].filter(([, q]) => Math.abs(q) > 1e-9).map(([symbol, quantity]) => ({ holdingType: "security", instrument: { symbol }, quantity, localCurrency: "GBP" }));
    return [...securities, { holdingType: "cash", instrument: undefined as { symbol: string } | undefined, quantity: cash, localCurrency: "GBP" }];
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

  /** The host's idempotency key for a row as sent (the fields its key hashes). */
  private keyOf(a: ActivityImport): string {
    // In major units, as the host's key is (a GBX row matches the GBP row it was stored as).
    const minor = MINOR_UNITS[a.currency === "GBp" ? "GBX" : (a.currency ?? "").toUpperCase()];
    const n = (v: unknown) => (v === null || v === undefined || v === "" ? "" : String(Math.abs(Number(v)) / (minor?.[1] ?? 1)));
    const q = (v: unknown) => (v === null || v === undefined || v === "" ? "" : String(Math.abs(Number(v))));
    const asset = this.isAssetRow(a) ? `${a.symbol ?? ""}@${a.exchangeMic ?? ""}` : "";
    const comment = (a.comment ?? "").split(/\s+/).filter(Boolean).join(" ");
    const currency = minor ? minor[0] : (a.currency ?? "");
    return [a.accountId, a.activityType, String(a.date ?? "").slice(0, 10), asset, q(a.quantity), n(a.unitPrice), n(a.amount), currency, comment, n(a.fee)].join("|");
  }

  private keyOfStored(r: StoredActivity): string {
    return this.keyOf({
      accountId: r.accountId,
      activityType: r.activityType as ActivityImport["activityType"],
      date: r.date.toISOString(),
      symbol: r.assetSymbol ?? "",
      exchangeMic: r.exchangeMic ?? undefined,
      quantity: r.quantity,
      unitPrice: r.unitPrice,
      amount: r.amount,
      fee: r.fee,
      currency: r.currency,
      comment: r.comment ?? undefined,
      isValid: true,
      isDraft: false,
    });
  }

  /** Stored activity ids by key, for duplicate detection. */
  private storedKeys(): Map<string, string> {
    const out = new Map<string, string>();
    for (const r of this.rows()) if (!out.has(this.keyOfStored(r))) out.set(this.keyOfStored(r), r.id);
    return out;
  }

  private isAssetRow(a: ActivityImport): boolean {
    return ASSET_TYPES.has(String(a.activityType)) || (!!a.symbol && !String(a.symbol).startsWith("$CASH") && !CASH_TYPES.has(String(a.activityType)));
  }

  private checkImport(rows: ActivityImport[]): ActivityImport[] {
    this.checkedIds.push(rows.map((a) => a.id));
    const stored = this.storedKeys();
    const firstInBatch = new Map<string, number>();
    return rows.map((a, i) => {
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
        return out;
      }
      // Duplicates, as the host's check marks them (on the filled-in row).
      const key = this.keyOf(out);
      const existing = stored.get(key);
      if (existing) {
        out.duplicateOfId = existing;
        out.warnings = { _duplicate: ["Duplicate activity already exists"] };
      } else if (firstInBatch.has(key)) {
        out.duplicateOfLineNumber = firstInBatch.get(key)! + 1;
        out.warnings = { _duplicate: [`Duplicate of line ${firstInBatch.get(key)! + 1} in this import batch`] };
      } else firstInBatch.set(key, i);
      return out;
    });
  }

  private importRows(rows: ActivityImport[]) {
    const total = rows.length;
    let duplicates = 0;
    const result = (activities: ActivityImport[], stored: number, success: boolean, runId: string, error?: string) => {
      this.importCalls.push({ sent: total, sentIds: rows.map((a) => a.id), stored, success, importRunId: runId });
      return {
        activities,
        importRunId: runId,
        summary: { total, imported: stored, skipped: total - stored, duplicates, assetsCreated: 0, success, errorMessage: error },
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

    if (this.storeNothing) return result(checked, 0, true, "");

    // Writer policy: refuses some rows, stores the rest; then duplicates are left out unless forced
    // (a forced row is stored and keeps whatever marker it was sent with).
    const toStore: ActivityImport[] = [];
    const stored = this.storedKeys();
    const firstInBatch = new Map<string, number>();
    checked.forEach((a, i) => {
      const why = this.policy(a);
      if (why) {
        a.isValid = false;
        a.errors = { general: [why] };
        return;
      }
      const key = this.keyOf(a);
      const forced = (a as ActivityImport & { forceImport?: boolean }).forceImport === true;
      if (!forced && stored.has(key)) {
        a.duplicateOfId = stored.get(key);
        a.warnings = { _duplicate: ["Duplicate activity already exists"] };
        duplicates++;
        return;
      }
      if (!forced && firstInBatch.has(key)) {
        a.duplicateOfLineNumber = firstInBatch.get(key)! + 1;
        a.warnings = { _duplicate: [`Duplicate of line ${firstInBatch.get(key)! + 1} in this import batch`] };
        duplicates++;
        return;
      }
      if (!firstInBatch.has(key)) firstInBatch.set(key, i);
      toStore.push(a);
    });
    const runId = toStore.length > 0 ? uuid() : "";
    for (const a of toStore) {
      const list = this.stored.get(a.accountId) ?? [];
      // Like Wealthfolio, a minor-unit row (GBX) is stored in its major unit: price, amount and fee
      // divided by 100, whatever the row is (a SPLIT's ratio included).
      const minor = MINOR_UNITS[a.currency === "GBp" ? "GBX" : (a.currency ?? "").toUpperCase()];
      const unit = (v: unknown) => (minor && num(v) !== null ? num(v)! / minor[1] : num(v));
      list.push({
        id: uuid(), // the host keeps no id of ours
        accountId: a.accountId,
        activityType: String(a.activityType),
        date: new Date(String(a.date)),
        assetSymbol: this.isAssetRow(a) ? (a.symbol ?? null) : null,
        exchangeMic: this.isAssetRow(a) ? (a.exchangeMic ?? null) : null,
        quantity: num(a.quantity),
        unitPrice: unit(a.unitPrice),
        amount: unit(a.amount),
        fee: unit(a.fee),
        currency: minor ? minor[0] : (a.currency ?? "GBP"),
        comment: a.comment ?? null,
      });
      this.stored.set(a.accountId, list);
    }
    return result(checked, toStore.length, true, runId);
  }
}
