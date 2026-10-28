import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertFeedback,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
import { QUERY_ROOT, usePayslipData } from "../hooks/use-payslip-data";
import { gbp } from "../lib/format";
import type { UssStatement } from "../lib/model";
import { addStatement, deleteStatement, loadStatements } from "../lib/store";
import { taxYearLabel } from "../lib/tax-year";
import { dbCapitalEstimate, latestStatement, ussContributions } from "../lib/uss";

const EMPTY = { date: "", dbPension: "", dbLumpSum: "", dcPot: "", employerContribution: "" };

/** A non-negative amount; `undefined` for an empty optional field, `null` when it is not a number. */
function amount(text: string): number | undefined | null {
  if (text.trim() === "") return undefined;
  const n = Number(text.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function toStatement(form: typeof EMPTY): UssStatement | string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return "Enter the statement date.";
  const dbPension = amount(form.dbPension);
  const dbLumpSum = amount(form.dbLumpSum);
  const dcPot = amount(form.dcPot);
  const employer = amount(form.employerContribution);
  if (dbPension == null) return "Enter the DB annual pension as a number.";
  if (dbLumpSum == null) return "Enter the DB lump sum as a number.";
  if (dcPot === null) return "The DC pot must be a number, or left empty.";
  if (employer === null) return "The employer contribution must be a number, or left empty.";
  return {
    date: form.date,
    dbPension,
    dbLumpSum,
    ...(dcPot !== undefined ? { dcPot } : {}),
    ...(employer !== undefined ? { employerContribution: employer } : {}),
  };
}

export default function PensionPage({ ctx }: AddonPageProps) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: [QUERY_ROOT] });
  const { data } = usePayslipData(ctx);
  const { data: statements = [] } = useQuery({ queryKey: [QUERY_ROOT, "statements"], queryFn: () => loadStatements(ctx) });
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: (s: UssStatement) => addStatement(ctx, s),
    onSuccess: () => {
      setForm(EMPTY);
      return refresh();
    },
  });
  const remove = useMutation({ mutationFn: (date: string) => deleteStatement(ctx, date), onSuccess: refresh });

  const uss = ussContributions(data?.payslips ?? []);
  const latest = latestStatement(statements);
  const set = (key: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  const submit = () => {
    const parsed = toStatement(form);
    if (typeof parsed === "string") return setFormError(parsed);
    setFormError(null);
    add.mutate(parsed);
  };

  return (
    <PageShell
      iconName="PiggyBank"
      heading="Pension"
      description="USS contributions from your payslips and the figures from your annual statements."
      actions={<PayslipsNav ctx={ctx} current="pension" />}
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">USS contributions</CardTitle>
          <CardDescription>Salary sacrificed into USS, from your stored payslips.</CardDescription>
        </CardHeader>
        <CardContent>
          {uss.byYear.length === 0 ? (
            <p className="text-muted-foreground text-sm">No USS contributions found yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tax year</TableHead>
                  <TableHead className="text-right">Contributions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {uss.byYear.map((y) => (
                  <TableRow key={y.taxYear}>
                    <TableCell>{taxYearLabel(y.taxYear)}</TableCell>
                    <TableCell className="text-right tabular-nums">{gbp(y.amount)}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell className="font-medium">Total</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{gbp(uss.total)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Latest statement</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {!latest ? (
            <p className="text-muted-foreground">Add a statement below to see your latest values.</p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-y-1">
                <dt className="text-muted-foreground">Statement date</dt>
                <dd className="text-right">{latest.date}</dd>
                <dt className="text-muted-foreground">DB annual pension</dt>
                <dd className="text-right tabular-nums">{gbp(latest.dbPension)}</dd>
                <dt className="text-muted-foreground">DB lump sum</dt>
                <dd className="text-right tabular-nums">{gbp(latest.dbLumpSum)}</dd>
                {latest.dcPot !== undefined && (
                  <>
                    <dt className="text-muted-foreground">DC pot</dt>
                    <dd className="text-right tabular-nums">{gbp(latest.dcPot)}</dd>
                  </>
                )}
                {latest.employerContribution !== undefined && (
                  <>
                    <dt className="text-muted-foreground">Employer contribution</dt>
                    <dd className="text-right tabular-nums">{gbp(latest.employerContribution)}</dd>
                  </>
                )}
              </dl>
              <p className="font-medium">
                Illustrative DB capital value: {gbp(dbCapitalEstimate(latest))} — estimate (pension × 20 + lump sum), not
                included in your net worth
              </p>
            </>
          )}
          <p className="text-muted-foreground text-xs">
            For projections use Wealthfolio's own retirement planner (Add retirement income / Add pension fund); this
            add-on does not rebuild it.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Statements</CardTitle>
          <CardDescription>Typed in from your USS annual benefit statement. Kept in this add-on only.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {statements.length > 0 && (
            <Table className="text-sm">
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">DB pension</TableHead>
                  <TableHead className="text-right">DB lump sum</TableHead>
                  <TableHead className="text-right">DC pot</TableHead>
                  <TableHead className="text-right">Employer</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...statements].reverse().map((s) => (
                  <TableRow key={s.date}>
                    <TableCell>{s.date}</TableCell>
                    <TableCell className="text-right tabular-nums">{gbp(s.dbPension)}</TableCell>
                    <TableCell className="text-right tabular-nums">{gbp(s.dbLumpSum)}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.dcPot !== undefined ? gbp(s.dcPot) : "–"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.employerContribution !== undefined ? gbp(s.employerContribution) : "–"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Delete statement ${s.date}`}
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(s.date)}
                      >
                        <Icons.Trash size={14} />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Field id="st-date" label="Statement date" type="date" value={form.date} onChange={set("date")} />
            <Field id="st-db" label="DB annual pension (£)" value={form.dbPension} onChange={set("dbPension")} />
            <Field id="st-lump" label="DB lump sum (£)" value={form.dbLumpSum} onChange={set("dbLumpSum")} />
            <Field id="st-dc" label="DC pot (£, optional)" value={form.dcPot} onChange={set("dcPot")} />
            <Field
              id="st-er"
              label="Employer contribution (£, optional)"
              value={form.employerContribution}
              onChange={set("employerContribution")}
            />
            <div className="flex items-end">
              <Button type="submit" disabled={add.isPending}>
                <Icons.Plus size={16} className="mr-1" />
                Add statement
              </Button>
            </div>
          </form>
          {(formError || add.error) && (
            <AlertFeedback variant="error">{formError ?? (add.error as Error).message}</AlertFeedback>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  type?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} inputMode={type === "text" ? "decimal" : undefined} value={value} onChange={onChange} />
    </div>
  );
}
