import type { AddonContext } from "@wealthfolio/addon-sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertFeedback, Badge, Button, Icons, Label } from "@wealthfolio/ui";
import { useRef, useState } from "react";
import {
  CASH_ISA_PROVIDER_ID,
  ensureCashIsaAccount,
  importCashIsa,
  mergeCashIsaParses,
  parseCashIsaCsv,
  type CashIsaImportResult,
  type CashIsaParse,
} from "../lib/cash-isa";

/** Picker value for the add-on's own Cash ISA account (created on first import). */
const NEW_ACCOUNT = "__new__";

interface PickedFile {
  key: string;
  name: string;
  parse?: CashIsaParse;
  error?: string;
}

interface CashIsaImportProps {
  ctx: AddonContext;
  /** Import into this account (re-importing an already listed Cash ISA); no account picker. */
  accountId?: string;
  /** Name of the Cash account created on the first import. */
  newAccountName: string;
  onImported?: (result: CashIsaImportResult) => void;
}

/**
 * Picks one or more Trading 212 Cash ISA CSV exports and imports them into a Wealthfolio Cash
 * account. The Cash ISA has no API access, so this is the only way to bring it in; rows that
 * appear in several files, or were imported before, are added only once.
 */
export function CashIsaImport({ ctx, accountId, newAccountName, onImported }: CashIsaImportProps) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [target, setTarget] = useState(NEW_ACCOUNT);
  const [isImporting, setIsImporting] = useState(false);
  const [result, setResult] = useState<CashIsaImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: cashAccounts = [] } = useQuery({
    queryKey: ["wf_accounts"],
    queryFn: () => ctx.api.accounts.getAll(),
    select: (accounts) => accounts.filter((a) => a.accountType === "CASH"),
    enabled: !accountId,
  });

  async function addFiles(list: File[]) {
    setResult(null);
    setError(null);
    const picked = await Promise.all(
      list.map(async (file): Promise<PickedFile> => {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        try {
          return { key, name: file.name, parse: await parseCashIsaCsv(await file.text(), "") };
        } catch (err) {
          return { key, name: file.name, error: (err as Error).message };
        }
      }),
    );
    setFiles((prev) => [...prev.filter((f) => !picked.some((p) => p.key === f.key)), ...picked]);
  }

  const parsed = files.some((f) => f.parse)
    ? mergeCashIsaParses(files.flatMap((f) => (f.parse ? [f.parse] : [])))
    : null;

  async function doImport() {
    if (!parsed) return;
    setIsImporting(true);
    setError(null);
    try {
      const dest =
        accountId ??
        (target === NEW_ACCOUNT
          ? await ensureCashIsaAccount(ctx, parsed.currency, newAccountName.trim() || undefined)
          : target);
      const res = await importCashIsa(ctx, dest, parsed.activities);
      setResult(res);
      setFiles([]);
      await queryClient.invalidateQueries({ queryKey: ["wf_accounts"] });
      await queryClient.invalidateQueries({ queryKey: ["t212_cash_isa"] });
      onImported?.(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsImporting(false);
    }
  }

  const counts = (parsed?.activities ?? []).reduce<Record<string, number>>((acc, a) => {
    const k = String(a.activityType);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const skipped = parsed ? Object.entries(parsed.skipped) : [];
  const ownAccount = cashAccounts.find(
    (a) => (a as { providerAccountId?: string }).providerAccountId === CASH_ISA_PROVIDER_ID,
  );
  const otherAccounts = cashAccounts.filter((a) => a !== ownAccount);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>CSV exports</Label>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={isImporting}>
            <Icons.Import size={14} className="mr-1" weight="bold" />
            {files.length > 0 ? "Add more files" : "Choose CSV files"}
          </Button>
          {files.length === 0 && (
            <span className="text-muted-foreground text-sm">No files selected</span>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            multiple
            className="hidden"
            data-testid="t212-cash-isa-files"
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              if (list.length > 0) void addFiles(list);
              e.target.value = "";
            }}
          />
        </div>
        <p className="text-muted-foreground text-xs">
          In the Trading 212 app, open the Cash ISA, then History → Export (CSV). Pick as many
          exports as you like; overlapping ranges and earlier imports add nothing twice.
        </p>
      </div>

      {files.length > 0 && (
        <ul className="divide-y rounded-md border text-sm">
          {files.map((f) => (
            <li key={f.key} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="flex min-w-0 items-center gap-2">
                <Icons.FileText size={14} weight="duotone" className="text-muted-foreground shrink-0" />
                <span className="truncate">{f.name}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {f.error ? (
                  <span className="text-destructive text-xs">Could not read: {f.error}</span>
                ) : (
                  <span className="text-muted-foreground text-xs">{f.parse?.activities.length ?? 0} rows</span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${f.name}`}
                  disabled={isImporting}
                  onClick={() => setFiles((prev) => prev.filter((p) => p.key !== f.key))}
                >
                  <Icons.Close size={12} />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {parsed && (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{counts.DEPOSIT ?? 0} deposits</Badge>
            <Badge variant="outline">{counts.WITHDRAWAL ?? 0} withdrawals</Badge>
            <Badge variant="outline">{counts.INTEREST ?? 0} interest payments</Badge>
            {counts.FEE ? <Badge variant="outline">{counts.FEE} fees</Badge> : null}
          </div>
          {skipped.length > 0 && (
            <p className="text-muted-foreground text-xs">
              Left out: {skipped.map(([action, n]) => `${n} ${action}`).join(", ")} (no date,
              amount or id, or not a cash row).
            </p>
          )}
        </div>
      )}

      {parsed && parsed.activities.length > 0 && !accountId && (
        <div className="space-y-1.5">
          <Label htmlFor="t212-cash-isa-target">Wealthfolio account</Label>
          <select
            id="t212-cash-isa-target"
            className="bg-background w-full rounded border px-3 py-2 text-sm"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value={NEW_ACCOUNT}>
              {ownAccount
                ? ownAccount.name
                : `Create "${newAccountName.trim() || "Trading 212 Cash ISA"}" (${parsed.currency})`}
            </option>
            {otherAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <p className="text-muted-foreground text-xs">
            The Cash ISA goes into a Wealthfolio Cash account, so its interest counts as income
            and the balance shows in your net worth.
          </p>
        </div>
      )}

      {parsed && parsed.activities.length > 0 && (
        <Button onClick={doImport} disabled={isImporting}>
          {isImporting ? (
            <>
              <Icons.Spinner size={14} className="mr-1 animate-spin" />
              Importing…
            </>
          ) : (
            <>
              <Icons.Import size={14} className="mr-1" weight="bold" />
              Import {parsed.activities.length} rows
            </>
          )}
        </Button>
      )}

      {error && (
        <AlertFeedback variant="error" title="Import failed">
          {error}
        </AlertFeedback>
      )}
      {result && !isImporting && (
        <AlertFeedback variant="success" title="Imported">
          {result.imported} imported, {result.duplicates} already there.
        </AlertFeedback>
      )}
    </div>
  );
}
