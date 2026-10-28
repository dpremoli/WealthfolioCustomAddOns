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
  Checkbox,
  Icons,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui";
import type { AddonPageProps } from "@wf-addons/kit";
import { PageShell } from "@wf-addons/kit/ui";
import { useState } from "react";
import { PayslipsNav } from "../components/nav";
import { StoredPdfsCard } from "../components/stored-pdfs-card";
import { QUERY_ROOT, useSalaryMatches } from "../hooks/use-payslip-data";
import { gbp, isoDay } from "../lib/format";
import { findPayrollAccount, recordPayroll, PAYROLL_ACCOUNT_NAME, type PayrollOutcome } from "../lib/payroll";
import { payslipStatusLabel, previewPayroll, type PayrollPreview } from "../lib/payroll-preview";
import { defaultAccountIds } from "../lib/salary-match";
import type { Payslip } from "../lib/model";
import type { SalaryMatch } from "../lib/salary-match";
import { loadSettings, saveSettings } from "../lib/store";

/** Exactly what Preview showed: record writes this, never newer data. */
interface PreviewSnapshot {
  /** `dataUpdatedAt` of the loaded data the preview was made from; a later load makes it stale. */
  updatedAt: number;
  payslips: Payslip[];
  matches: SalaryMatch[];
  windowDays: number;
  preview: PayrollPreview;
}

export const SPENDING_CAVEAT =
  "Keep the Payroll account switched off for Spending in Wealthfolio's settings. Linking turns the bank's salary deposit into a transfer, so Wealthfolio's spending report may no longer count it as income.";

const MIN_DAYS = 1;
const MAX_DAYS = 10;

export default function SettingsPage({ ctx }: AddonPageProps) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: [QUERY_ROOT] });
  const { data, isLoading, dataUpdatedAt } = useSalaryMatches(ctx);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [days, setDays] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [snapshot, setSnapshot] = useState<PreviewSnapshot | null>(null);
  const [outcome, setOutcome] = useState<PayrollOutcome | null>(null);

  // A preview is only good for the data it was made from; once that is reloaded it is dropped.
  const preview = snapshot && snapshot.updatedAt === dataUpdatedAt ? snapshot.preview : null;
  const previewStale = snapshot !== null && preview === null;

  const accounts = data?.accounts ?? [];
  const defaults = defaultAccountIds(accounts);
  const candidates = accounts.filter((a) => defaults.includes(a.id));
  const settings = data?.settings;
  const selected = picked ?? settings?.accountIds ?? defaults;
  const daysText = days ?? String(settings?.windowDays ?? 4);
  const daysNumber = Number(daysText);
  const daysValid = Number.isInteger(daysNumber) && daysNumber >= MIN_DAYS && daysNumber <= MAX_DAYS;

  const save = useMutation({
    mutationFn: async () => {
      if (!settings || !daysValid) return;
      await saveSettings(ctx, { ...settings, accountIds: selected.filter((id) => defaults.includes(id)), windowDays: daysNumber });
    },
    onSuccess: async () => {
      setSaved(true);
      setPicked(null);
      setDays(null);
      setSnapshot(null);
      await refresh();
    },
  });

  const togglePayroll = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (settings) await saveSettings(ctx, { ...settings, payroll: { ...settings.payroll, enabled } });
    },
    onSuccess: async () => {
      setSnapshot(null);
      setOutcome(null);
      await refresh();
    },
  });

  const showPreview = useMutation({
    mutationFn: async (): Promise<PreviewSnapshot> => {
      if (!data) throw new Error("Still loading");
      const { payslips, matches } = data;
      const windowDays = data.settings.windowDays;
      const payroll = findPayrollAccount(data.accounts);
      const existing = payroll ? await ctx.api.activities.getAll(payroll.id) : [];
      const preview = previewPayroll(payslips, matches, payroll?.id ?? "payroll-new", existing);
      return { updatedAt: dataUpdatedAt, payslips, matches, windowDays, preview };
    },
    onSuccess: (snap) => {
      setSnapshot(snap);
      setOutcome(null);
    },
  });

  const record = useMutation({
    mutationFn: async (snap: PreviewSnapshot): Promise<PayrollOutcome> => {
      const result = await recordPayroll(ctx, snap.payslips, snap.matches, snap.windowDays);
      const account = findPayrollAccount(await ctx.api.accounts.getAll());
      const settings = await loadSettings(ctx);
      if (account && account.id !== settings.payroll.accountId) {
        await saveSettings(ctx, { ...settings, payroll: { ...settings.payroll, accountId: account.id } });
      }
      return result;
    },
    onSuccess: async (result) => {
      setOutcome(result);
      setSnapshot(null);
      await refresh();
    },
  });

  const accountName = (id?: string) => accounts.find((a) => a.id === id)?.name ?? "account";
  const payrollExists = !!findPayrollAccount(accounts);
  const payrollOn = settings?.payroll.enabled === true;
  const failure = save.error ?? togglePayroll.error ?? showPreview.error ?? record.error;

  return (
    <PageShell
      iconName="Settings"
      heading="Settings"
      description="Which accounts hold your salary, and the optional Payroll account."
      actions={<PayslipsNav ctx={ctx} current="settings" />}
      className="max-w-5xl"
    >
      {failure && (
        <AlertFeedback variant="error" title="Something went wrong">
          {failure instanceof Error ? failure.message : String(failure)}
        </AlertFeedback>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Salary matching</CardTitle>
          <CardDescription>
            Each payslip's net pay is looked for as a deposit in these accounts. Only GBP cash accounts are offered.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : candidates.length === 0 ? (
            <p className="text-muted-foreground text-sm">No active GBP cash accounts found.</p>
          ) : (
            <div className="space-y-2" role="group" aria-label="Accounts to search">
              {candidates.map((a) => (
                <div key={a.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`acc-${a.id}`}
                    checked={selected.includes(a.id)}
                    onCheckedChange={(on: boolean) => {
                      setSaved(false);
                      setPicked(on ? [...new Set([...selected, a.id])] : selected.filter((id) => id !== a.id));
                    }}
                  />
                  <Label htmlFor={`acc-${a.id}`} className="text-sm font-normal">
                    {a.name}
                  </Label>
                </div>
              ))}
            </div>
          )}

          <div className="max-w-xs space-y-1">
            <Label htmlFor="match-window">Match window (days either side of the pay date)</Label>
            <Input
              id="match-window"
              type="number"
              min={MIN_DAYS}
              max={MAX_DAYS}
              value={daysText}
              onChange={(e) => {
                setSaved(false);
                setDays(e.target.value);
              }}
            />
            {!daysValid && (
              <p className="text-destructive text-xs">
                Enter a whole number of days from {MIN_DAYS} to {MAX_DAYS}.
              </p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={() => save.mutate()} disabled={!settings || !daysValid || save.isPending}>
              Save
            </Button>
            {saved && <span className="text-muted-foreground text-sm">Saved</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payroll account (optional)</CardTitle>
          <CardDescription>Off by default. Nothing is written to Wealthfolio unless you press the record button.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p>
            Turned on, the add-on can keep a separate "{PAYROLL_ACCOUNT_NAME}" cash account in Wealthfolio. Each payslip
            is recorded there as gross pay in, income tax, National Insurance, other deductions, and the net pay out as a
            transfer. The transfer is linked to the salary deposit already in your bank account, which is turned from a
            deposit into the other side of that transfer. Only payslips without warnings are recorded; recording an unchanged
            payslip again adds nothing, and a corrected one replaces the rows already recorded for its pay date.
          </p>
          <AlertFeedback variant="warning">{SPENDING_CAVEAT}</AlertFeedback>

          <div className="flex items-center gap-2">
            <Checkbox
              id="payroll-on"
              checked={payrollOn}
              disabled={!settings || togglePayroll.isPending}
              onCheckedChange={(on: boolean) => togglePayroll.mutate(on)}
            />
            <Label htmlFor="payroll-on" className="text-sm font-normal">
              Enable the Payroll account tools
            </Label>
          </div>

          {payrollOn && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" onClick={() => showPreview.mutate()} disabled={!data || showPreview.isPending}>
                  <Icons.Eye size={16} className="mr-1" />
                  Preview
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => snapshot && preview && record.mutate(snapshot)}
                  disabled={!preview || preview.rows.length === 0 || record.isPending}
                  title="Writes the previewed rows to Wealthfolio and converts the matched bank deposits to linked transfers"
                >
                  {record.isPending ? "Recording…" : "Record in Wealthfolio"}
                </Button>
                {previewStale ? (
                  <span className="text-muted-foreground text-xs">
                    Your payslips or deposits changed since the preview. Preview again to see what will be recorded.
                  </span>
                ) : (
                  !preview && <span className="text-muted-foreground text-xs">Preview first: nothing is written until you record.</span>
                )}
              </div>

              {preview && (
                <div className="space-y-4">
                  <p>
                    Account:{" "}
                    <span className="font-medium">{payrollExists ? PAYROLL_ACCOUNT_NAME : `${PAYROLL_ACCOUNT_NAME} (new)`}</span>
                    {payrollExists ? "" : " — would be created (GBP cash)"}
                  </p>

                  {preview.payslips.length > 0 && (
                    <ul className="list-disc pl-5">
                      {preview.payslips.map((p) => (
                        <li key={p.payDate}>{`${p.payDate}: ${payslipStatusLabel(p)}`}</li>
                      ))}
                    </ul>
                  )}

                  {preview.rows.length === 0 ? (
                    <p className="text-muted-foreground">No payslip can be recorded yet.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table className="text-xs">
                        <TableHeader>
                          <TableRow>
                            <TableHead>Pay date</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead className="text-right">Amount</TableHead>
                            <TableHead>Description</TableHead>
                            <TableHead />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {preview.rows.map((r) => (
                            <TableRow key={r.id}>
                              <TableCell className="whitespace-nowrap">{r.payDate}</TableCell>
                              <TableCell>{r.activityType}</TableCell>
                              <TableCell className="text-right tabular-nums">{gbp(r.amount)}</TableCell>
                              <TableCell>{r.comment.replace(/\s*\[ref:[^\]]*\]/, "")}</TableCell>
                              <TableCell>{r.alreadyRecorded && <Badge variant="outline">Already recorded</Badge>}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}

                  <div>
                    <p className="font-medium">Bank deposits that would become linked transfers</p>
                    {preview.conversions.length === 0 ? (
                      <p className="text-muted-foreground">None: no recordable payslip has a matched deposit.</p>
                    ) : (
                      <ul className="text-muted-foreground list-disc pl-5">
                        {preview.conversions.map((c) => (
                          <li key={c.payDate}>
                            {gbp(Number(c.activity.amount))} on {isoDay(c.activity.date)} in {accountName(c.activity.accountId)} (
                            {c.payDate} payslip)
                            {c.pennyOff
                              ? ": won't be linked (amount differs by a penny)"
                              : c.alreadyTransfer
                                ? ": already a transfer"
                                : ": DEPOSIT becomes TRANSFER_IN"}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {preview.skipped.length > 0 && (
                    <div>
                      <p className="font-medium">Left out (payslip has warnings)</p>
                      <ul className="text-muted-foreground list-disc pl-5">
                        {preview.skipped.map((s) => (
                          <li key={s}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {outcome && <OutcomeView outcome={outcome} />}
            </div>
          )}
        </CardContent>
      </Card>

      <StoredPdfsCard ctx={ctx} />
    </PageShell>
  );
}

function OutcomeView({ outcome }: { outcome: PayrollOutcome }) {
  const clean = outcome.unsaved.length === 0 && outcome.linkFailed.length === 0 && !outcome.refusedError;
  return (
    <AlertFeedback variant={clean ? "success" : "warning"} title="Payroll recorded">
      <ul className="list-disc pl-5">
        <li>{outcome.stored} rows stored</li>
        {outcome.replaced > 0 && <li>{`${outcome.replaced} payslip${outcome.replaced === 1 ? "" : "s"} replaced`}</li>}
        <li>{outcome.linked} bank deposits linked</li>
        {outcome.unsaved.length > 0 && (
          <li>
            {outcome.unsaved.length} rows not stored (they will be retried):
            <ul className="list-disc pl-5">
              {outcome.unsaved.map((u, i) => (
                <li key={u.activity.id ?? i}>
                  {u.activity.comment?.replace(/\s*\[ref:[^\]]*\]/, "") ?? u.activity.id}: {u.reason}
                </li>
              ))}
            </ul>
          </li>
        )}
        {outcome.linkFailed.length > 0 && (
          <li>
            Could not link:
            <ul className="list-disc pl-5">
              {outcome.linkFailed.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </li>
        )}
        {outcome.skipped.length > 0 && (
          <li>
            Skipped (warnings):
            <ul className="list-disc pl-5">
              {outcome.skipped.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </li>
        )}
        {outcome.refusedError && <li>{outcome.refusedError}</li>}
      </ul>
    </AlertFeedback>
  );
}
