import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AddonContext } from "@wealthfolio/addon-sdk";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui";
import { parseMonzoCsv } from "../lib/csv-parser";
import { isFlexRepayment, isPotTransfer, mapTransactionToActivity } from "../lib/mapper";
import type { MonzoTransaction } from "../types";

const CATEGORY_LABELS_KEY = "monzo_category_labels";

export default function CsvImportPage({ ctx }: { ctx: AddonContext }) {
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
      const raw = await ctx.api.secrets.get(CATEGORY_LABELS_KEY);
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
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
      const checked = await ctx.api.activities.checkImport(activities);
      const toImport = checked.filter((a) => a.isValid !== false && !a.duplicateOfId);
      const dupes = checked.length - toImport.length;
      let imported = 0;
      if (toImport.length > 0) {
        const r = await ctx.api.activities.import(toImport);
        imported = r.summary.imported;
      }
      setResult({ imported, duplicates: dupes });
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
            Import historical transactions from a Monzo CSV export.
          </p>
        </div>
        <Button variant="outline" onClick={() => ctx.api.navigation.navigate("/addons/monzo")}>
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
                <Badge variant="outline">{result.duplicates} duplicates skipped</Badge>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
