import type { ActivityImport, AddonContext } from "@wealthfolio/addon-sdk";
import type { MonzoTransaction } from "./types";

export interface FakeRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  auth?: { type: string; secretKey: string };
  timeoutSecs?: number;
}
export interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}
export type NetworkHandler = (req: FakeRequest) => FakeResponse | Promise<FakeResponse>;

export interface FakeAccount {
  id: string;
  name: string;
  currency?: string;
}

/** An in-memory stand-in for the parts of `AddonContext` the Monzo add-on touches. */
export function makeCtx(
  opts: { handler?: NetworkHandler; wfAccounts?: FakeAccount[] } = {},
) {
  const storage = new Map<string, string>();
  const secrets = new Map<string, string>();
  const requests: FakeRequest[] = [];
  const importCalls: ActivityImport[][] = [];
  /** Existing activities per Wealthfolio account; `import` appends to it. */
  const activities = new Map<string, Record<string, unknown>[]>();
  const wfAccounts: FakeAccount[] = opts.wfAccounts ?? [];
  const created: Record<string, unknown>[] = [];
  const state = { handler: opts.handler };

  const kv = (m: Map<string, string>) => ({
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  });

  const ctx = {
    api: {
      storage: kv(storage),
      secrets: kv(secrets),
      logger: { info() {}, warn() {}, error() {}, debug() {}, trace() {} },
      network: {
        request: async (req: FakeRequest) => {
          requests.push(req);
          if (!state.handler) throw new Error("no network handler");
          const r = await state.handler(req);
          return { status: r.status, headers: r.headers ?? {}, body: r.body ?? "" };
        },
      },
      accounts: {
        getAll: async () => wfAccounts,
        create: async (input: Record<string, unknown>) => {
          const account = { id: `wf-${wfAccounts.length + 1}`, name: String(input.name), currency: String(input.currency) };
          wfAccounts.push(account);
          created.push(input);
          return account;
        },
      },
      activities: {
        getAll: async (accountId?: string) => [...(activities.get(accountId ?? "") ?? [])],
        saveMany: async (req: { updates?: { id: string; comment?: string | null; amount?: unknown }[] }) => {
          for (const u of req.updates ?? []) {
            for (const list of activities.values()) {
              const row = list.find((r) => r.id === u.id);
              if (!row) continue;
              row.comment = u.comment ?? null;
              if (u.amount !== undefined) row.amount = u.amount == null ? null : String(u.amount);
            }
          }
          return { created: [], updated: req.updates ?? [], deleted: [], createdMappings: [], errors: [] };
        },
        import: async (batch: ActivityImport[]) => {
          importCalls.push(batch);
          for (const a of batch) {
            const list = activities.get(a.accountId) ?? [];
            list.push({
              id: `act-${list.length + 1}`,
              activityType: a.activityType,
              date: new Date(a.date as string),
              amount: a.amount == null ? null : String(a.amount),
              quantity: null,
              unitPrice: null,
              currency: a.currency,
              comment: a.comment ?? null,
              assetSymbol: a.symbol,
            });
            activities.set(a.accountId, list);
          }
          return {
            activities: batch,
            importRunId: "run",
            summary: { total: batch.length, imported: batch.length, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
          };
        },
      },
    },
  } as unknown as AddonContext;

  return { ctx, storage, secrets, requests, importCalls, activities, wfAccounts, created, state };
}

export function json(status: number, body: unknown): FakeResponse {
  return { status, body: JSON.stringify(body) };
}

let seq = 0;
export function tx(over: Partial<MonzoTransaction> = {}): MonzoTransaction {
  seq++;
  return {
    id: `tx_${String(seq).padStart(5, "0")}`,
    created: "2026-05-01T12:00:00.000Z",
    settled: "2026-05-01T12:00:01.000Z",
    amount: -350,
    currency: "GBP",
    description: "Coffee",
    notes: "",
    category: "eating_out",
    is_load: false,
    metadata: {},
    ...over,
  };
}
