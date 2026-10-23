import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";

export interface FakeAccount {
  id: string;
  name: string;
  currency?: string;
  provider?: string;
  providerAccountId?: string;
}

export type FakeRow = Record<string, unknown> & { id: string; accountId: string; activityType: string };

/** An in-memory stand-in for the parts of `AddonContext` the Revolut add-on touches. */
export function makeCtx(opts: { wfAccounts?: FakeAccount[] } = {}) {
  const storage = new Map<string, string>();
  const importCalls: ActivityImport[][] = [];
  /** Existing activities per Wealthfolio account; `import` appends to it. */
  const activities = new Map<string, FakeRow[]>();
  const wfAccounts: FakeAccount[] = opts.wfAccounts ?? [];
  /** Activity id pairs passed to `linkTransfer` (out, in). */
  const links: [string, string][] = [];
  /** Every `saveMany` update, in order. */
  const saves: { id: string; activityType?: string; comment?: string | null }[] = [];
  const warnings: string[] = [];
  let activitySeq = 0;

  const ctx = {
    api: {
      storage: {
        get: async (k: string) => storage.get(k) ?? null,
        set: async (k: string, v: string) => void storage.set(k, v),
        delete: async (k: string) => void storage.delete(k),
      },
      logger: { info() {}, warn: (m: string) => void warnings.push(m), error() {}, debug() {}, trace() {} },
      accounts: {
        getAll: async () => wfAccounts,
      },
      activities: {
        getAll: async (accountId?: string) => [...(activities.get(accountId ?? "") ?? [])],
        saveMany: async (req: {
          updates?: { id: string; comment?: string | null; amount?: unknown; activityType?: string }[];
        }) => {
          for (const u of req.updates ?? []) {
            saves.push(u);
            for (const list of activities.values()) {
              const row = list.find((r) => r.id === u.id);
              if (!row) continue;
              row.comment = u.comment ?? null;
              if (u.activityType) row.activityType = u.activityType;
              if (u.amount !== undefined) row.amount = u.amount == null ? null : String(u.amount);
            }
          }
          return { created: [], updated: req.updates ?? [], deleted: [], createdMappings: [], errors: [] };
        },
        getTransferPair: async (id: string) => {
          const hit = links.find((l) => l.includes(id));
          return hit ? { transferOut: { id: hit[0] }, transferIn: { id: hit[1] } } : null;
        },
        linkTransfer: async (a: string, b: string) => {
          if (links.some((l) => l.includes(a) || l.includes(b))) throw new Error("already linked");
          links.push([a, b]);
          return [{ id: a }, { id: b }];
        },
        import: async (batch: ActivityImport[]) => {
          importCalls.push(batch);
          for (const a of batch) addRow(a);
          return {
            activities: batch,
            importRunId: "run",
            summary: { total: batch.length, imported: batch.length, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
          };
        },
      },
    },
  } as unknown as AddonContext;

  /** Puts a row into an account the way the host stores an imported activity. */
  function addRow(a: Omit<Partial<ActivityImport>, "activityType"> & { accountId: string; activityType: string }): FakeRow {
    const row: FakeRow = {
      id: `act-${++activitySeq}`,
      accountId: a.accountId,
      activityType: a.activityType,
      date: new Date(a.date as string),
      amount: a.amount == null ? null : String(a.amount),
      quantity: null,
      unitPrice: null,
      currency: a.currency,
      comment: a.comment ?? null,
      assetSymbol: a.symbol,
    };
    activities.set(a.accountId, [...(activities.get(a.accountId) ?? []), row]);
    return row;
  }

  return { ctx, storage, importCalls, activities, wfAccounts, links, saves, warnings, addRow };
}
