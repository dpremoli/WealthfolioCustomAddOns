import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@wealthfolio/ui";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  XAxis,
  YAxis,
  type ChartConfig,
} from "@wealthfolio/ui/chart";
import type { AddonPageProps } from "@wf-addons/kit";
import { PageShell, StatTiles, type Stat } from "@wf-addons/kit/ui";
import { useState } from "react";
import { PayslipsNav } from "../components/nav";
import { PeriodSelect } from "../components/period-select";
import { usePayslipData } from "../hooks/use-payslip-data";
import { gbp, pct, todayIso } from "../lib/format";
import { resolvePeriod, type Period } from "../lib/period";
import { summarise } from "../lib/summary";

const CHART_CONFIG: ChartConfig = {
  netFromPay: { label: "Net pay", color: "#2f9e6e" },
  expenseRefunds: { label: "Expense refunds", color: "#2aa5a0" },
  tax: { label: "Income tax", color: "#d6545a" },
  ni: { label: "Employee NI", color: "#e0a030" },
  studentLoan: { label: "Student loan", color: "#8a6bbe" },
  other: { label: "Other deductions", color: "#8b95a1" },
  uss: { label: "USS pension", color: "#3b82c4" },
};

export default function TaxPage({ ctx }: AddonPageProps) {
  const { data, isLoading } = usePayslipData(ctx);
  const [chosen, setChosen] = useState<Period | null>(null);

  const period = data ? resolvePeriod(chosen, data.payslips) : undefined;
  const summary = data && period ? summarise(data.payslips, period, todayIso()) : undefined;
  const isTaxYear = period?.kind === "tax";

  // The refunds are a series of their own, and the net pay series is what is left without them.
  const hasRefunds = (summary?.expenseRefunds ?? 0) > 0;
  const chartConfig: ChartConfig = {
    ...CHART_CONFIG,
    netFromPay: { ...CHART_CONFIG.netFromPay, label: hasRefunds ? "Net pay (without refunds)" : "Net pay" },
  };
  const seriesKeys = Object.keys(CHART_CONFIG).filter((key) => key !== "expenseRefunds" || hasRefunds);

  return (
    <PageShell
      iconName="BarChart"
      heading="Tax"
      description="Income tax, National Insurance and pension for a UK tax year (6 April to 5 April), a calendar year or any range of pay dates."
      actions={<PayslipsNav ctx={ctx} current="tax" />}
      className="max-w-5xl"
    >
      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : !summary || !period || !data ? (
        <Card>
          <CardContent className="text-muted-foreground pt-6 text-sm">
            No payslips yet. Import some on the Payslips page to see your tax figures.
          </CardContent>
        </Card>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
            <PeriodSelect payslips={data.payslips} value={period} onChange={setChosen} />
            <span className="text-muted-foreground text-sm">
              {summary.count} {summary.count === 1 ? "payslip" : "payslips"} in {summary.label}
            </span>
          </div>

          <StatTiles
            stats={[
              { label: "Gross before USS", value: gbp(summary.grossBeforeUss), icon: "Banknote" },
              { label: "USS sacrifice", value: gbp(summary.ussSacrifice), icon: "PiggyBank" },
              { label: "Taxable pay", value: gbp(summary.taxablePay), icon: "FileText" },
              ...(summary.expenseRefunds > 0
                ? [{ label: "Expense refunds", value: gbp(summary.expenseRefunds), icon: "Receipt" } satisfies Stat]
                : []),
              { label: "Income tax", value: gbp(summary.incomeTax), icon: "Receipt" },
              { label: "Employee NI", value: gbp(summary.employeeNi), icon: "Receipt" },
              { label: "Student loan", value: gbp(summary.studentLoan), icon: "Receipt" },
              { label: "Net pay", value: gbp(summary.net), icon: "Wallet", tone: "success" },
            ]}
          />

          <p className="text-muted-foreground text-sm">
            Effective rates, as a share of gross before USS: income tax {pct(summary.rates.incomeTax)}, NI{" "}
            {pct(summary.rates.employeeNi)}, all deductions {pct(summary.rates.deductions)}.
          </p>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Month by month</CardTitle>
              <CardDescription>
                Where each month's gross pay went, {isTaxYear ? "April to March" : "by calendar month"}
                {hasRefunds ? ", with the expense refunds paid on top" : ""}.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ChartContainer config={chartConfig} className="h-72 w-full">
                <BarChart data={summary.months} margin={{ left: 4, right: 4 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => `£${v}`} />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value, name) => (
                          <div className="flex w-full justify-between gap-4">
                            <span className="text-muted-foreground">{chartConfig[String(name)]?.label ?? name}</span>
                            <span className="tabular-nums">{gbp(Number(value))}</span>
                          </div>
                        )}
                      />
                    }
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  {seriesKeys.map((key) => (
                    <Bar key={key} dataKey={key} stackId="pay" fill={`var(--color-${key})`} />
                  ))}
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(18rem, 1fr))", gap: 16 }}>
            {isTaxYear && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Year to date</CardTitle>
                  <CardDescription>
                    {summary.ytd ? `From the latest payslip, paid ${summary.ytd.payDate}` : "No payslip in this tax year"}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {summary.ytd && (
                    <dl style={{ display: "grid", gridTemplateColumns: "1fr auto", rowGap: 4, columnGap: 16 }} className="text-sm">
                      <dt className="text-muted-foreground">Gross pay</dt>
                      <dd style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{gbp(summary.ytd.grossPay)}</dd>
                      <dt className="text-muted-foreground">Taxable pay</dt>
                      <dd style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{gbp(summary.ytd.taxablePay)}</dd>
                      <dt className="text-muted-foreground">Tax paid</dt>
                      <dd style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{gbp(summary.ytd.tax)}</dd>
                      <dt className="text-muted-foreground">Employee NI</dt>
                      <dd style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{gbp(summary.ytd.eeNic)}</dd>
                    </dl>
                  )}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Months with no payslip</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {summary.missing.length === 0 ? (
                  <p className="text-muted-foreground">None: every month so far has a payslip.</p>
                ) : (
                  <ul style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", listStyle: "none", margin: 0, padding: 0 }}>
                    {summary.missing.map((m) => (
                      <li key={m.key}>
                        {m.label} {isTaxYear && <span className="text-muted-foreground">(month {m.month})</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </PageShell>
  );
}
