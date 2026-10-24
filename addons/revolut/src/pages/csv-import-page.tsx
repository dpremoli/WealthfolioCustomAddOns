import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui";
import { addonRoute, describeUnsaved, jsonStore, type AddonPageProps } from "@wf-addons/kit";
import { ACCOUNTS_KEY, ADDON_ID, KEY_SAVINGS_ACCOUNT } from "../constants";
import { parseRevolutCsv } from "../lib/csv-parser";
import { importStatement, type StatementImportOutcome } from "../lib/import";
import type { RevolutTransaction } from "../types";

export default function CsvImportPage({ ctx }: AddonPageProps) {
  const store = jsonStore(ctx.api.storage);
  const fileRef = useRef<HTMLInputElement>(null);
  const [transactions, setTransactions] = useState<RevolutTransaction[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  // currency → Wealthfolio account id
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [isImporting, setIsImporting] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  // Wealthfolio account the user keeps their Revolut savings in ("" = none).
  const [savingsAccountId, setSavingsAccountId] = useState("");
  const [result, setResult] = useState<StatementImportOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: wfAccounts = [], refetch: refetchAccounts } = useQuery({
    queryKey: ["wf_accounts"],
    queryFn: () => ctx.api.accounts.getAll(),
  });

  // Currencies present in the loaded statement, with COMPLETED-row counts, sorted by volume.
  const currencies = (() => {
    const counts = new Map<string, number>();
    for (const tx of transactions) counts.set(tx.currency, (counts.get(tx.currency) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  })();

  // Restore the remembered currency→account map, keeping only accounts that still exist.
  useEffect(() => {
    if (wfAccounts.length === 0 || Object.keys(mapping).length > 0) return;
    (async () => {
      const saved = await store.get<Record<string, string>>(ACCOUNTS_KEY, {});
      const valid = Object.fromEntries(
        Object.entries(saved).filter(([, id]) => wfAccounts.some((a) => a.id === id)),
      );
      if (Object.keys(valid).length > 0) setMapping(valid);
    })();
  }, [wfAccounts, mapping]);

  // Restore the remembered savings account, if it still exists.
  useEffect(() => {
    if (wfAccounts.length === 0) return;
    (async () => {
      const saved = await store.get<string>(KEY_SAVINGS_ACCOUNT, "");
      if (saved && wfAccounts.some((a) => a.id === saved)) setSavingsAccountId(saved);
    })();
  }, [wfAccounts]);

  async function persistSavingsAccount(id: string) {
    setSavingsAccountId(id);
    await store.set(KEY_SAVINGS_ACCOUNT, id);
  }

  async function persistMapping(next: Record<string, string>) {
    setMapping(next);
    await store.set(ACCOUNTS_KEY, next);
  }

  async function createAccountForCurrency(currency: string) {
    setCreating(currency);
    setError(null);
    try {
      const account = await ctx.api.accounts.create({
        name: `Revolut ${currency}`,
        accountType: "CASH",
        currency,
        isDefault: false,
        isActive: true,
        trackingMode: "TRANSACTIONS",
      });
      await refetchAccounts();
      await persistMapping({ ...mapping, [currency]: account.id });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(null);
    }
  }

  async function createAllMissing() {
    for (const [currency] of currencies) {
      if (!mapping[currency]) await createAccountForCurrency(currency);
    }
  }

  const mappedCount = currencies.filter(([c]) => mapping[c]).length;

  async function doImport() {
    if (mappedCount === 0 || transactions.length === 0) return;
    setIsImporting(true);
    setError(null);
    try {
      await store.set(ACCOUNTS_KEY, mapping);
      // Each currency's rows go to its own account so every account reconciles to Revolut's
      // per-currency balance; re-imports add nothing (the import ledger knows every row id).
      // Exchanges, Trading 212 and savings moves are then linked as transfers.
      setResult(await importStatement(ctx, transactions, mapping, { savingsAccountId }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsImporting(false);
    }
  }

  return (
    <div className="space-y-6 p-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Import from CSV</h1>
          <p className="text-muted-foreground mt-1">
            Import transactions from a Revolut account statement.
          </p>
        </div>
        <Button variant="outline" onClick={() => ctx.api.navigation.navigate(addonRoute(ADDON_ID))}>
          ← Back
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Select File</CardTitle>
          <CardDescription>
            Export from Revolut: Account → ⋯ → Statement → Excel/CSV format
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              Choose CSV file
            </Button>
            <span className="text-sm text-muted-foreground">{fileName ?? "No file selected"}</span>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setFileName(file.name);
                setResult(null);
                setError(null);
                const reader = new FileReader();
                reader.onload = (ev) => {
                  const text = ev.target?.result as string;
                  setTransactions(parseRevolutCsv(text));
                };
                reader.readAsText(file);
              }}
            />
          </div>
          {transactions.length > 0 && (
            <p className="text-sm text-green-700">Parsed {transactions.length} transactions</p>
          )}
        </CardContent>
      </Card>

      {transactions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Map currencies to accounts</CardTitle>
            <CardDescription>
              Each Revolut currency imports into its own cash account so every balance matches
              Revolut. Transfers and exchanges are kept in the balance but excluded from spending.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              {currencies.map(([currency, count]) => (
                <div key={currency} className="flex items-center gap-2">
                  <div className="w-28 shrink-0 text-sm">
                    <span className="font-medium">{currency}</span>
                    <span className="text-muted-foreground"> · {count}</span>
                  </div>
                  <select
                    className="w-full border rounded px-3 py-2 text-sm bg-background"
                    value={mapping[currency] ?? ""}
                    onChange={(e) => persistMapping({ ...mapping, [currency]: e.target.value })}
                  >
                    <option value="">Select an account…</option>
                    {wfAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="outline"
                    onClick={() => createAccountForCurrency(currency)}
                    disabled={creating !== null}
                    className="shrink-0"
                  >
                    {creating === currency ? "Creating…" : `+ Revolut ${currency}`}
                  </Button>
                </div>
              ))}
            </div>

            {currencies.some(([c]) => !mapping[c]) && (
              <Button variant="outline" onClick={createAllMissing} disabled={creating !== null}>
                Create all missing accounts
              </Button>
            )}

            <p className="text-xs text-muted-foreground">
              {mappedCount} of {currencies.length} currencies mapped
            </p>

            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="revolut-savings-account">
                Savings account
              </label>
              <select
                id="revolut-savings-account"
                className="w-full border rounded px-3 py-2 text-sm bg-background"
                value={savingsAccountId}
                onChange={(e) => persistSavingsAccount(e.target.value)}
              >
                <option value="">None</option>
                {wfAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Optional. The account you keep your Revolut savings in: "Depositing savings" and
                "Withdrawing savings" rows are linked to its matching moves as transfers.
              </p>
            </div>

            <Button onClick={doImport} disabled={mappedCount === 0 || isImporting}>
              {isImporting ? "Importing…" : `Import ${transactions.length} transactions`}
            </Button>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {result && !isImporting && (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Badge variant="outline">{result.imported} imported</Badge>
                  <Badge variant="outline">{result.duplicates} duplicates skipped</Badge>
                  {result.updated > 0 && <Badge variant="outline">{result.updated} updated</Badge>}
                </div>
                {result.error && (
                  <div className="space-y-1 text-sm text-destructive" role="alert">
                    <p>{result.error}</p>
                    <ul className="list-disc pl-5 text-xs">
                      {result.unsaved.slice(0, 20).map((u) => (
                        <li key={u.activity.id ?? describeUnsaved(u)}>{describeUnsaved(u)}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {result.notes.map((note) => (
                  <p key={note} className="text-sm text-muted-foreground">
                    {note}
                  </p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
