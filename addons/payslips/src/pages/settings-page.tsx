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
import { sourceRefOf, type AddonPageProps } from "@wf-addons/kit";
import { PageShell } from "@wf-addons/kit/ui";
import { useState } from "react";
import { PayslipsNav } from "../components/nav";
import { QUERY_ROOT, useSalaryMatches } from "../hooks/use-payslip-data";
import { gbp, isoDay } from "../lib/format";
import { findPayrollAccount, recordPayroll, PAYROLL_ACCOUNT_NAME, type PayrollOutcome } from "../lib/payroll";
import { previewPayroll, type PayrollPreview } from "../lib/payroll-preview";
import { defaultAccountIds } from "../lib/salary-match";
import { saveSettings } from "../lib/store";

export const SPENDING_CAVEAT =
  "Keep the Payroll account switched off for Spending in Wealthfolio's settings. Linking turns the bank's salary deposit into a transfer, so Wealthfolio's spending report may no longer count it as income.";

const MIN_DAYS = 1;
const MAX_DAYS = 10;

export default function SettingsPage({ ctx }: AddonPageProps) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: [QUERY_ROOT] });
  const { data, isLoading } = useSalaryMatches(ctx);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [days, setDays] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState<PayrollPreview | null>(null);
  const [outcome, setOutcome] = useState<PayrollOutcome | null>(null);

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
      setPreview(null);
      await refresh();
    },
  });

  const togglePayroll = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (settings) await saveSettings(ctx, { ...settings, payroll: { ...settings.payroll, enabled } });
    },
    onSuccess: async () => {
      setPreview(null);
      setOutcome(null);
      await refresh();
    },
  });

  const showPreview = useMutation({
    mutationFn: async (): Promise<PayrollPreview> => {
      if (!data) throw new Error("Still loading");
      const payroll = findPayrollAccount(data.accounts);
      const existing = payroll ? await ctx.api.activities.getAll(payroll.id) : [];
      const refs = new Set(existing.map((a) => sourceRefOf(a.comment)).filter((r): r is string => !!r));
      return previewPayroll(data.payslips, data.matches, payroll?.id ?? "payroll-new", refs);
    },
    onSuccess: (p) => {
      setPreview(p);
      setOutcome(null);
    },
  });

  const record = useMutation({
    mutationFn: async (): Promise<PayrollOutcome> => {
      if (!data) throw new Error("Still loading");
      const result = await recordPayroll(ctx, data.payslips, data.matches);
      const account = findPayrollAccount(await ctx.api.accounts.getAll());
      if (account && account.id !== data.settings.payroll.accountId) {
        await saveSettings(ctx, { ...data.settings, payroll: { ...data.settings.payroll, accountId: account.id } });
      }
      return result;
    },
    onSuccess: async (result) => {
      setOutcome(result);
      setPreview(null);
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
            deposit into the other side of that transfer. Only payslips without warnings are recorded, and recording a
            payslip twice adds nothing.
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
                  onClick={() => record.mutate()}
                  disabled={!preview || preview.rows.length === 0 || record.isPending}
                  title="Writes the previewed rows to Wealthfolio and converts the matched bank deposits to linked transfers"
                >
                  {record.isPending ? "Recording…" : "Record in Wealthfolio"}
                </Button>
                {!preview && <span className="text-muted-foreground text-xs">Preview first: nothing is written until you record.</span>}
              </div>

              {preview && (
                <div className="space-y-4">
                  <p>
                    Account:{" "}
                    <span className="font-medium">{payrollExists ? PAYROLL_ACCOUNT_NAME : `${PAYROLL_ACCOUNT_NAME} (new)`}</span>
                    {payrollExists ? "" : " — would be created (GBP cash)"}
                  </p>

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
                            {c.alreadyTransfer ? ": already a transfer" : ": DEPOSIT becomes TRANSFER_IN"}
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
    </PageShell>
  );
}

function OutcomeView({ outcome }: { outcome: PayrollOutcome }) {
  const clean = outcome.unsaved.length === 0 && outcome.linkFailed.length === 0 && !outcome.refusedError;
  return (
    <AlertFeedback variant={clean ? "success" : "warning"} title="Payroll recorded">
      <ul className="list-disc pl-5">
        <li>{outcome.stored} rows stored</li>
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
