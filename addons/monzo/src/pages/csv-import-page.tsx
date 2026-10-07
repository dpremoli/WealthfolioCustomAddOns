import { useRef, useState } from "react";
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
import { addonRoute, jsonStore, type AddonPageProps } from "@wf-addons/kit";
import { ADDON_ID, KEY_CATEGORY_LABELS } from "../constants";
import { parseMonzoCsv } from "../lib/csv-parser";
import { isFlexRepayment, isPotTransfer, legacyActivity, mapTransactionToActivity } from "../lib/mapper";
import { ensureMigrated } from "../lib/migrate";
import { importNew } from "../lib/sync";
import type { MonzoTransaction } from "../types";

export default function CsvImportPage({ ctx }: AddonPageProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [transactions, setTransactions] = useState<MonzoTransaction[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [accountId, setAccountId] = useState("");
  const [skipTransfers, setSkipTransfers] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; duplicates: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: wfAccounts = [] } = useQuery({
    queryKey: ["wf_accounts"],
    queryFn: () => ctx.api.accounts.getAll(),
  });

  const { data: categoryLabels = {} } = useQuery({
    queryKey: ["monzo_category_labels"],
    queryFn: async () => {
      await ensureMigrated(ctx);
      return jsonStore(ctx.api.storage).get<Record<string, string>>(KEY_CATEGORY_LABELS, {});
    },
  });

  const filtered = transactions.filter(
    (tx) =>
      !isFlexRepayment(tx) &&
      !isPotTransfer(tx) &&
      (!skipTransfers || (tx.category !== "transfers" && tx.category !== "savings")),
  );

  async function doImport() {
    if (!accountId || filtered.length === 0) return;
    setIsImporting(true);
    setError(null);
    try {
      const activities = filtered.map((tx) =>
        mapTransactionToActivity(tx, accountId, categoryLabels),
      );
      // Reconcile against what the account already holds (by count, so genuine repeats
      // survive) and force-import the rest. Rows carry their Monzo transaction id, so this is
      // safe to re-run or overlap with API syncs.
      const legacy = new Map(filtered.map((tx) => [tx.id, legacyActivity(tx, accountId, categoryLabels)]));
      const outcome = await importNew(ctx, accountId, activities, legacy);
      setResult({ imported: outcome.imported, duplicates: outcome.duplicates });
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
            Import historical transactions from a Monzo CSV export. This is the only way to go
            back further than the 90 days the Monzo API shares.
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
            Export from Monzo app: Account → Export transactions → CSV
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              Choose CSV file
            </Button>
            <span className="text-sm text-muted-foreground">
              {fileName ?? "No file selected"}
            </span>
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
                  setTransactions(parseMonzoCsv(text));
                };
                reader.readAsText(file);
              }}
            />
          </div>
          {transactions.length > 0 && (
            <p className="text-sm text-green-700">
              Parsed {transactions.length} transactions
            </p>
          )}
        </CardContent>
      </Card>

      {transactions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Import Options</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium block mb-1">Target account</label>
              <select
                className="w-full border rounded px-3 py-2 text-sm bg-background"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                <option value="">Select a Wealthfolio account…</option>
                {wfAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={skipTransfers}
                onChange={(e) => setSkipTransfers(e.target.checked)}
              />
              Skip transfers &amp; savings (Flex repayments, bank transfers, Trading 212, etc.)
            </label>

            <p className="text-xs text-muted-foreground">
              {filtered.length} transactions to import
              {transactions.length - filtered.length > 0 &&
                ` · ${transactions.length - filtered.length} filtered out`}
            </p>

            <Button onClick={doImport} disabled={!accountId || isImporting || filtered.length === 0}>
              {isImporting ? "Importing…" : `Import ${filtered.length} transactions`}
            </Button>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {result && !isImporting && (
              <div className="flex gap-2">
                <Badge variant="outline">{result.imported} imported</Badge>
                <Badge variant="outline">{result.duplicates} already imported</Badge>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
