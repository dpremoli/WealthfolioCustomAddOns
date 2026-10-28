import { useMutation, useQueryClient } from "@tanstack/react-query";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui";
import { sourceRefOf, type AddonPageProps } from "@wf-addons/kit";
import { PageShell } from "@wf-addons/kit/ui";
import { useRef, useState, type DragEvent } from "react";
import { PayslipsNav } from "../components/nav";
import { PayslipViewer } from "../components/payslip-viewer";
import { TaxYearSelect } from "../components/tax-year-select";
import { QUERY_ROOT, useSalaryMatches } from "../hooks/use-payslip-data";
import { useKeepPdfs, usePdfDates } from "../hooks/use-pdf-dates";
import { gbp, isoDay } from "../lib/format";
import { employeeNi, grossBeforeSacrifice, incomeTax, ussSacrifice, type Payslip } from "../lib/model";
import { parsePayslipPdf } from "../lib/payslip-parser";
import { deletePdf, downloadPdf, getKeepPdfs, savePdf } from "../lib/pdf-store";
import { readBytes } from "../lib/read-file";
import { refreshPayslips, type RefreshResult } from "../lib/refresh";
import { tagDeposit, type SalaryMatch } from "../lib/salary-match";
import { deletePayslip, saveLink, savePayslips } from "../lib/store";
import { periodLabel } from "../lib/tax-year";

interface FileError {
  name: string;
  message: string;
}
interface ImportResult {
  added: number;
  replaced: number;
  errors: FileError[];
  /** Imported payslips whose PDF copy could not be kept (the payslip itself is stored). */
  pdfErrors: FileError[];
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function importFiles(ctx: AddonPageProps["ctx"], files: File[]): Promise<ImportResult> {
  const parsed: { file: File; payslip: Payslip; bytes: Uint8Array }[] = [];
  const errors: FileError[] = [];
  const pdfErrors: FileError[] = [];
  for (const file of files) {
    try {
      const bytes = await readBytes(file);
      parsed.push({ file, payslip: await parsePayslipPdf(bytes), bytes });
    } catch (err) {
      errors.push({ name: file.name, message: messageOf(err) });
    }
  }
  const { added, replaced } =
    parsed.length > 0 ? await savePayslips(ctx, parsed.map((p) => p.payslip)) : { added: 0, replaced: 0 };
  // A copy that cannot be kept never fails the import: the payslip is already stored. But a copy
  // from an earlier import of this pay date must not outlive the figures it no longer matches.
  if (parsed.length > 0) {
    const keep = await getKeepPdfs(ctx);
    for (const { file, payslip, bytes } of parsed) {
      try {
        if (!keep) {
          await deletePdf(ctx, payslip.payDate);
          continue;
        }
        try {
          await savePdf(ctx, payslip.payDate, bytes);
        } catch (err) {
          pdfErrors.push({ name: file.name, message: messageOf(err) });
          await deletePdf(ctx, payslip.payDate);
        }
      } catch (err) {
        pdfErrors.push({ name: file.name, message: `The earlier PDF copy could not be removed. ${messageOf(err)}` });
      }
    }
  }
  return { added, replaced, errors, pdfErrors };
}

export default function PayslipsPage({ ctx }: AddonPageProps) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: [QUERY_ROOT] });
  const { data, isLoading, error: loadError } = useSalaryMatches(ctx);
  const [year, setYear] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const keepPdfs = useKeepPdfs(ctx).data ?? true;
  const pdfDates = new Set(usePdfDates(ctx).data ?? []);
  const storedPdfs = pdfDates.size;
  const fileInput = useRef<HTMLInputElement>(null);

  const upload = useMutation({ mutationFn: (files: File[]) => importFiles(ctx, files), onSuccess: refresh });
  const choose = useMutation({
    mutationFn: ({ payDate, row }: { payDate: string; row: { id: string; accountId?: string } }) =>
      saveLink(ctx, payDate, { activityId: row.id, accountId: row.accountId ?? "", chosen: "manual" }),
    onSuccess: refresh,
  });
  const tag = useMutation({
    mutationFn: async ({ match }: { match: SalaryMatch }) => {
      const row = match.activity!;
      await tagDeposit(ctx, row, match.payDate);
      await saveLink(ctx, match.payDate, {
        activityId: row.id,
        accountId: row.accountId ?? "",
        chosen: match.chosen ?? "auto",
        tagged: true,
      });
    },
    onSuccess: refresh,
  });
  // Re-reads the stored PDFs, then recomputes everything against the bank deposits as they are now.
  const reread = useMutation({
    mutationFn: () => refreshPayslips(ctx),
    onSettled: refresh,
  });
  const download = useMutation({ mutationFn: (payDate: string) => downloadPdf(ctx, payDate) });
  const remove = useMutation({
    mutationFn: (payDate: string) => deletePayslip(ctx, payDate),
    onSuccess: () => {
      setConfirming(null);
      return refresh();
    },
  });

  const payslips = data?.payslips ?? [];
  const years = [...new Set(payslips.map((p) => p.taxYear))].sort((a, b) => a - b);
  const selected = year !== null && years.includes(year) ? year : years[years.length - 1];
  const shown = payslips.filter((p) => p.taxYear === selected);
  const matchOf = new Map((data?.matches ?? []).map((m) => [m.payDate, m]));
  const accountName = (id?: string) => data?.accounts.find((a) => a.id === id)?.name ?? "account";

  const pick = (list: FileList | File[] | null | undefined) => {
    const files = Array.from(list ?? []);
    if (files.length > 0) upload.mutate(files);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer?.files);
  };

  const result = upload.data;
  const failure = upload.error ?? tag.error ?? choose.error ?? download.error ?? remove.error ?? reread.error ?? loadError;

  return (
    <PageShell
      iconName="Receipt"
      heading="Payslips"
      description="Import payslip PDFs, match net pay to your salary deposits and keep the figures per tax year."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={reread.isPending}
            title="Re-read the stored PDFs and look for new bank deposits again"
            onClick={() => reread.mutate()}
          >
            {reread.isPending ? (
              <Icons.Spinner size={14} className="mr-1 animate-spin" />
            ) : (
              <Icons.Refresh size={14} className="mr-1" />
            )}
            {reread.isPending ? "Refreshing…" : "Refresh"}
          </Button>
          <PayslipsNav ctx={ctx} current="payslips" />
        </div>
      }
      className="max-w-6xl"
    >
      {reread.data && <RefreshSummary result={reread.data} />}
      <Card
        onDragOver={(e: DragEvent) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={dragging ? "border-primary bg-primary/5" : undefined}
        data-testid="payslip-drop-zone"
      >
        <CardHeader>
          <CardTitle className="text-base">Import payslips</CardTitle>
          <CardDescription>Drop PDF files here, or choose them. Several at once is fine.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            hidden
            data-testid="payslip-files"
            onChange={(e) => {
              pick(e.target.files);
              e.target.value = "";
            }}
          />
          <Button onClick={() => fileInput.current?.click()} disabled={upload.isPending}>
            <Icons.Upload size={16} className="mr-1" weight="bold" />
            {upload.isPending ? "Reading…" : "Choose PDF files"}
          </Button>

          {result && (
            <div className="space-y-2 text-sm">
              <p>
                {result.added + result.replaced > 0 || result.errors.length === 0
                  ? `${result.added} imported, ${result.replaced} replaced`
                  : "Nothing imported"}
              </p>
              {result.errors.length > 0 && (
                <ul className="space-y-1 text-destructive">
                  {result.errors.map((e, i) => (
                    <li key={`${e.name}-${i}`}>
                      <span className="font-medium">{e.name}</span>: {e.message}
                    </li>
                  ))}
                </ul>
              )}
              {result.pdfErrors.length > 0 && (
                <ul className="space-y-1 text-destructive">
                  {result.pdfErrors.map((e, i) => (
                    <li key={`${e.name}-${i}`}>
                      <span className="font-medium">{e.name}</span>: imported, but its PDF copy was not kept. {e.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <div className="text-muted-foreground -mt-3 space-y-1 text-xs">
        <p>
          Payslips are read by this add-on on this device, and nothing is sent to any outside service. What the add-on keeps is
          stored in Wealthfolio's add-on storage, which Wealthfolio syncs to your paired devices.
        </p>
        {!keepPdfs && (
          <p>
            {storedPdfs > 0
              ? `New imports keep figures only; ${storedPdfs} stored PDF ${storedPdfs === 1 ? "copy remains (remove it" : "copies remain (remove them"} in Settings).`
              : "Only figures, pay date, tax period and tax code are kept."}
          </p>
        )}
        {keepPdfs && (
          <p>
            A copy of each PDF is kept in Wealthfolio so you can view and download it. It includes your name and NI number; turn
            this off in Settings.
          </p>
        )}
      </div>

      {failure && (
        <AlertFeedback variant="error" title="Something went wrong">
          {failure instanceof Error ? failure.message : String(failure)}
        </AlertFeedback>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
          <CardTitle className="text-base">Stored payslips</CardTitle>
          {selected !== undefined && <TaxYearSelect years={years} value={selected} onChange={setYear} />}
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="text-muted-foreground text-sm">No payslips yet. Import a PDF above.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead>Pay date</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Gross before USS</TableHead>
                    <TableHead className="text-right">USS</TableHead>
                    <TableHead className="text-right">Tax</TableHead>
                    <TableHead className="text-right">NI</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                    <TableHead>Checks</TableHead>
                    <TableHead>Salary deposit</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((p) => {
                    const match = matchOf.get(p.payDate);
                    const tagged =
                      data?.links[p.payDate]?.tagged === true ||
                      sourceRefOf(match?.activity?.comment) === `payslip:${p.payDate}`;
                    return (
                      <TableRow key={p.payDate}>
                        <TableCell className="whitespace-nowrap">{p.payDate}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {periodLabel(p.period)} ({String(p.period).padStart(2, "0")}/{p.taxYear})
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{gbp(grossBeforeSacrifice(p))}</TableCell>
                        <TableCell className="text-right tabular-nums">{gbp(ussSacrifice(p))}</TableCell>
                        <TableCell className="text-right tabular-nums">{gbp(incomeTax(p))}</TableCell>
                        <TableCell className="text-right tabular-nums">{gbp(employeeNi(p))}</TableCell>
                        <TableCell className="text-right tabular-nums">{gbp(p.netPay)}</TableCell>
                        <TableCell>
                          {p.warnings.length === 0 ? (
                            <Badge variant="success-subtle">OK</Badge>
                          ) : (
                            <div className="space-y-1" title={p.warnings.join("\n")}>
                              <Badge variant="warning-subtle">
                                {p.warnings.length} {p.warnings.length === 1 ? "warning" : "warnings"}
                              </Badge>
                              <ul className="text-muted-foreground max-w-56 space-y-0.5">
                                {p.warnings.map((w, i) => (
                                  <li key={i}>{w}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <MatchCell
                            match={match}
                            accountName={accountName}
                            busy={choose.isPending}
                            onPick={(row) => choose.mutate({ payDate: p.payDate, row })}
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`View payslip ${p.payDate}`}
                            disabled={!pdfDates.has(p.payDate)}
                            title={pdfDates.has(p.payDate) ? "View this payslip in Wealthfolio" : "No PDF is stored for this payslip"}
                            onClick={() => setViewing(p.payDate)}
                          >
                            <Icons.Eye size={14} className="mr-1" />
                            View
                          </Button>{" "}
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`Download payslip ${p.payDate}`}
                            disabled={!pdfDates.has(p.payDate) || download.isPending}
                            title={pdfDates.has(p.payDate) ? "Save the PDF to your computer" : "No PDF is stored for this payslip"}
                            onClick={() => download.mutate(p.payDate)}
                          >
                            <Icons.Download size={14} className="mr-1" />
                            Download
                          </Button>{" "}
                          {match?.status === "matched" && match.activity && !tagged && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={tag.isPending}
                              title={`Adds [ref:payslip:${p.payDate}] to the bank row's comment, so you can find it later. Nothing else about the row changes.`}
                              onClick={() => tag.mutate({ match })}
                            >
                              <Icons.Tag size={14} className="mr-1" />
                              Tag deposit
                            </Button>
                          )}
                          {match?.status === "matched" && tagged && (
                            <Badge variant="outline" title={`The bank row's comment carries [ref:payslip:${p.payDate}]`}>
                              Tagged
                            </Badge>
                          )}{" "}
                          {confirming === p.payDate ? (
                            <>
                              <Button size="sm" variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate(p.payDate)}>
                                Confirm delete
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                                Cancel
                              </Button>
                            </>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Delete payslip ${p.payDate}`}
                              title="Delete this payslip from the add-on (nothing in your accounts changes)"
                              onClick={() => setConfirming(p.payDate)}
                            >
                              <Icons.Trash size={14} />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      {viewing && <PayslipViewer ctx={ctx} payDate={viewing} onClose={() => setViewing(null)} />}
    </PageShell>
  );
}

function RefreshSummary({ result }: { result: RefreshResult }) {
  const { reparsed, unchanged, failed, withoutPdf } = result;
  const n = withoutPdf.length;
  const noPdf = n > 0 ? ` ${n} ${n === 1 ? "has" : "have"} no stored PDF — import ${n === 1 ? "it" : "them"} again to update.` : "";
  return (
    <div className="space-y-1 text-sm" role="status">
      <p>{`Re-read ${reparsed + unchanged} ${reparsed + unchanged === 1 ? "payslip" : "payslips"} (${unchanged} unchanged).${noPdf}`}</p>
      {failed.length > 0 && (
        <ul className="space-y-1 text-destructive">
          {failed.map((f) => (
            <li key={f.payDate}>
              <span className="font-medium">{f.payDate}</span>: {f.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MatchCell({
  match,
  accountName,
  busy,
  onPick,
}: {
  match: SalaryMatch | undefined;
  accountName: (id?: string) => string;
  busy: boolean;
  onPick: (row: { id: string; accountId?: string }) => void;
}) {
  if (!match) return <Badge variant="outline">Checking…</Badge>;
  if (match.status === "matched" && match.activity) {
    return (
      <div className="space-y-1">
        <Badge variant="success-subtle">Matched</Badge>
        <div className="text-muted-foreground">
          {accountName(match.activity.accountId)} · {isoDay(match.activity.date)}
        </div>
      </div>
    );
  }
  if (match.status === "ambiguous") {
    return (
      <div className="space-y-1">
        <Badge variant="warning-subtle">Ambiguous</Badge>
        <select
          className="block w-full max-w-56 rounded border bg-background px-2 py-1 text-xs"
          aria-label="Choose the salary deposit"
          defaultValue=""
          disabled={busy}
          onChange={(e) => {
            const row = match.candidates.find((c) => c.id === e.target.value);
            if (row) onPick(row);
          }}
        >
          <option value="">Choose the deposit…</option>
          {match.candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {accountName(c.accountId)} · {isoDay(c.date)}
            </option>
          ))}
        </select>
      </div>
    );
  }
  return <Badge variant="outline">Missing</Badge>;
}
