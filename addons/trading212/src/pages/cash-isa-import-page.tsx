import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertFeedback,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Icons,
} from "@wealthfolio/ui";
import { addonRoute, type AddonPageProps } from "@wf-addons/kit";
import { PageShell } from "@wf-addons/kit/ui";
import { useRef, useState } from "react";
import { ADDON_ID } from "../constants";
import {
  CASH_ISA_PROVIDER_ID,
  DEFAULT_CASH_ISA_NAME,
  ensureCashIsaAccount,
  importCashIsa,
  parseCashIsaCsv,
  type CashIsaImportResult,
  type CashIsaParse,
} from "../lib/cash-isa";

/** Picker value for the add-on's own Cash ISA account (created on first import). */
const NEW_ACCOUNT = "__new__";

/**
 * Imports Trading 212 Cash ISA history from the CSV the app exports. The Cash ISA has no API
 * access, so this is the only way to bring it in; re-importing or overlapping exports is safe.
 */
export default function CashIsaImportPage({ ctx }: AddonPageProps) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<CashIsaParse | null>(null);
  const [target, setTarget] = useState(NEW_ACCOUNT);
  const [isImporting, setIsImporting] = useState(false);
  const [result, setResult] = useState<CashIsaImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: cashAccounts = [] } = useQuery({
    queryKey: ["wf_accounts"],
    queryFn: () => ctx.api.accounts.getAll(),
    select: (accounts) => accounts.filter((a) => a.accountType === "CASH"),
  });

  async function readFile(file: File) {
    setFileName(file.name);
    setResult(null);
    setError(null);
    try {
      setParsed(await parseCashIsaCsv(await file.text(), ""));
    } catch (err) {
      setParsed(null);
      setError(`Could not read the file: ${(err as Error).message}`);
    }
  }

  async function doImport() {
    if (!parsed) return;
    setIsImporting(true);
    setError(null);
    try {
      const accountId =
        target === NEW_ACCOUNT ? await ensureCashIsaAccount(ctx, parsed.currency) : target;
      setResult(await importCashIsa(ctx, accountId, parsed.activities));
      queryClient.invalidateQueries({ queryKey: ["wf_accounts"] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsImporting(false);
    }
  }

  const counts = parsed
    ? parsed.activities.reduce<Record<string, number>>((acc, a) => {
        const k = String(a.activityType);
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {})
    : {};
  const skipped = parsed ? Object.entries(parsed.skipped) : [];
  const ownAccount = cashAccounts.find(
    (a) => (a as { providerAccountId?: string }).providerAccountId === CASH_ISA_PROVIDER_ID,
  );
  const otherAccounts = cashAccounts.filter((a) => a !== ownAccount);

  return (
    <PageShell
      iconName="Wallet"
      heading="Import Cash ISA"
      description="Trading 212's API does not cover the Cash ISA, so its history comes from the CSV the app exports."
      actions={
        <Button variant="outline" size="lg" onClick={() => ctx.api.navigation.navigate(addonRoute(ADDON_ID))}>
          <Icons.ArrowLeft size={16} className="mr-1" weight="bold" />
          Dashboard
        </Button>
      }
    >
      <Card>
        <CardHeader>
          <CardTitle>1. Choose the export</CardTitle>
          <CardDescription>
            In the Trading 212 app, open the Cash ISA, then History → Export (CSV). Any date range
            works; importing overlapping exports adds nothing twice.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              Choose CSV file
            </Button>
            <span className="text-muted-foreground text-sm">{fileName ?? "No file selected"}</span>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void readFile(file);
                e.target.value = "";
              }}
            />
          </div>
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
        </CardContent>
      </Card>

      {parsed && parsed.activities.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>2. Import</CardTitle>
            <CardDescription>
              The Cash ISA goes into a Wealthfolio Cash account, so its interest counts as income
              and the balance shows in your net worth.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="t212-cash-isa-target">
                Wealthfolio account
              </label>
              <select
                id="t212-cash-isa-target"
                className="bg-background w-full rounded border px-3 py-2 text-sm"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value={NEW_ACCOUNT}>
                  {ownAccount
                    ? ownAccount.name
                    : `Create "${DEFAULT_CASH_ISA_NAME}" (${parsed.currency})`}
                </option>
                {otherAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>

            <Button onClick={doImport} disabled={isImporting}>
              {isImporting ? "Importing…" : `Import ${parsed.activities.length} rows`}
            </Button>

            {error && <AlertFeedback variant="error" title="Import failed">{error}</AlertFeedback>}
            {result && !isImporting && (
              <div className="flex gap-2">
                <Badge variant="outline">{result.imported} imported</Badge>
                <Badge variant="outline">{result.duplicates} already there</Badge>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}
