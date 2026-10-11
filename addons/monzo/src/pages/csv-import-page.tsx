import { useRef, useState, useSyncExternalStore } from "react";
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
import { isBusy, subscribeBusy } from "../lib/busy";
import { filterCsvTransactions, importCsvFiles, type CsvImportOutcome } from "../lib/csv-import";
import { parseMonzoCsv } from "../lib/csv-parser";
import { ensureMigrated } from "../lib/migrate";
import type { MonzoTransaction } from "../types";

interface CsvFile {
  /** Name + size + last-modified: the same name can be a different file (another folder). */
  id: string;
  name: string;
  size: number;
  modified: number;
  transactions: MonzoTransaction[];
  /** Set when the file could not be read. */
  error?: string;
  accountId: string;
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
    reader.readAsText(file);
  });
}

async function readCsv(file: File): Promise<Omit<CsvFile, "accountId">> {
  const meta = {
    id: `${file.name}|${file.size}|${file.lastModified}`,
    name: file.name,
    size: file.size,
    modified: file.lastModified,
  };
  try {
    return { ...meta, transactions: parseMonzoCsv(await readText(file)) };
  } catch (err) {
    return { ...meta, transactions: [], error: (err as Error).message };
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What one listed file came to: an import outcome, or why it was not imported. */
interface FileResult {
  id: string;
  label: string;
  outcome?: CsvImportOutcome;
  notImported?: string;
}

export default function CsvImportPage({ ctx }: AddonPageProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<CsvFile[]>([]);
  const [skipTransfers, setSkipTransfers] = useState(true);
  const [importing, setImporting] = useState<string | null>(null);
  const [results, setResults] = useState<FileResult[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  // A sync (or an import from elsewhere) in flight also blocks importing.
  const busy = useSyncExternalStore(subscribeBusy, isBusy);
  const locked = busy || importing !== null;

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

  const rows = files.map((f) => ({
    ...f,
    filtered: filterCsvTransactions(f.transactions, skipTransfers),
    // Two different files can share a name: tell them apart by size and date.
    label: files.some((o) => o.id !== f.id && o.name === f.name)
      ? `${f.name} (${f.size} bytes, ${new Date(f.modified).toLocaleDateString()})`
      : f.name,
  }));
  const ready = rows.filter((f) => f.accountId && f.filtered.length > 0);
  const readyCount = ready.reduce((n, f) => n + f.filtered.length, 0);

  async function addFiles(chosen: File[]) {
    setResults(null);
    const read = await Promise.all(chosen.map(readCsv));
    // The very same file replaces its row (keeping its account choice); a different file
    // with the same name gets a row of its own.
    setFiles((prev) => {
      const next = [...prev];
      for (const f of read) {
        const i = next.findIndex((p) => p.id === f.id);
        if (i >= 0) next[i] = { ...f, accountId: next[i].accountId };
        else next.push({ ...f, accountId: "" });
      }
      return next;
    });
  }

  function update(id: string, patch: Partial<CsvFile>) {
    setResults(null);
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  async function doImport() {
    if (ready.length === 0) return;
    setImporting("");
    setResults(null);
    setImportError(null);
    try {
      const outcomes = await importCsvFiles(
        ctx,
        ready.map((f) => ({ name: f.label, accountId: f.accountId, transactions: f.filtered })),
        categoryLabels,
        (name, i, total) => setImporting(`${name} (${i + 1} of ${total})`),
      );
      // One outcome per ready file, in order; the others say why they were left out.
      let next = 0;
      setResults(
        rows.flatMap((f): FileResult[] => {
          if (f.error || f.transactions.length === 0) return [];
          if (ready.includes(f)) return [{ id: f.id, label: f.label, outcome: outcomes[next++] }];
          return [
            {
              id: f.id,
              label: f.label,
              notImported: f.accountId ? "Nothing to import." : "Not imported: no target account chosen.",
            },
          ];
        }),
      );
    } catch (err) {
      setImportError((err as Error).message);
    } finally {
      setImporting(null);
    }
  }

  return (
    <div className="space-y-6 p-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Import from CSV</h1>
          <p className="text-muted-foreground mt-1">
            Import historical transactions from Monzo CSV exports, several files at once. This is
            how to get history older than the 90 days the Monzo API shares (unless you sync right
            after connecting, when it shares everything).
          </p>
        </div>
        <Button variant="outline" onClick={() => ctx.api.navigation.navigate(addonRoute(ADDON_ID))}>
          ← Back
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Select Files</CardTitle>
          <CardDescription>
            Export from Monzo app: Account → Export transactions → CSV. Choose one file per Monzo
            account (current account, Flex, …); you can add files in several goes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Button variant="outline" disabled={locked} onClick={() => fileRef.current?.click()}>
              Choose CSV files
            </Button>
            <span className="text-sm text-muted-foreground">
              {files.length > 0 ? plural(files.length, "file") : "No files selected"}
            </span>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              multiple
              disabled={locked}
              className="hidden"
              onChange={(e) => {
                const chosen = Array.from(e.target.files ?? []);
                // Reset so the same file can be chosen again.
                e.target.value = "";
                if (chosen.length > 0) void addFiles(chosen);
              }}
            />
          </div>
        </CardContent>
      </Card>

      {files.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Import Options</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {rows.map((f) => (
              <div key={f.id} className="space-y-1 border rounded p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium break-all">{f.label}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={locked}
                    onClick={() => {
                      setResults(null);
                      setFiles((prev) => prev.filter((p) => p.id !== f.id));
                    }}
                  >
                    Remove
                  </Button>
                </div>
                {f.error ? (
                  <p className="text-sm text-destructive">Could not read this file: {f.error}</p>
                ) : f.transactions.length === 0 ? (
                  <p className="text-sm text-destructive">No Monzo transactions found in this file.</p>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Parsed {plural(f.transactions.length, "transaction")} · {f.filtered.length} to
                      import
                    </p>
                    <label className="text-sm font-medium block">Target account</label>
                    <select
                      className="w-full border rounded px-3 py-2 text-sm bg-background"
                      aria-label={`Target account for ${f.label}`}
                      value={f.accountId}
                      disabled={locked}
                      onChange={(e) => update(f.id, { accountId: e.target.value })}
                    >
                      <option value="">Select a Wealthfolio account…</option>
                      {wfAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
            ))}

            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={skipTransfers}
                disabled={locked}
                onChange={(e) => setSkipTransfers(e.target.checked)}
              />
              Skip transfers &amp; savings (Flex repayments, bank transfers, Trading 212, etc.)
            </label>

            <Button onClick={doImport} disabled={locked || ready.length === 0}>
              {locked
                ? "Importing…"
                : `Import ${plural(readyCount, "transaction")} from ${plural(ready.length, "file")}`}
            </Button>

            {importing && <p className="text-sm text-muted-foreground">Importing {importing}</p>}
            {importError && <p className="text-sm text-destructive">{importError}</p>}

            {results && importing === null && (
              <div className="space-y-1">
                {results.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="break-all">{r.label}</span>
                    {r.notImported ? (
                      <span className="text-muted-foreground">{r.notImported}</span>
                    ) : r.outcome?.error ? (
                      <span className="text-destructive">{r.outcome.error}</span>
                    ) : (
                      r.outcome && (
                        <>
                          <Badge variant="outline">{r.outcome.imported} imported</Badge>
                          {r.outcome.updated > 0 && (
                            <Badge variant="outline">{r.outcome.updated} updated</Badge>
                          )}
                          <Badge variant="outline">{r.outcome.duplicates} already imported</Badge>
                        </>
                      )
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
