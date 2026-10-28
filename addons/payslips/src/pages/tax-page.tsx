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
import { TaxYearSelect } from "../components/tax-year-select";
import { usePayslipData } from "../hooks/use-payslip-data";
import { gbp, pct, todayIso } from "../lib/format";
import { summariseYear } from "../lib/summary";
import { periodLabel } from "../lib/tax-year";

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
  const [year, setYear] = useState<number | null>(null);

  const years = data?.years ?? [];
  const selected = year !== null && years.includes(year) ? year : years[years.length - 1];
  const summary = data && selected !== undefined ? summariseYear(data.payslips, selected, todayIso()) : undefined;

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
      description="Income tax, National Insurance and pension per UK tax year (6 April to 5 April)."
      actions={<PayslipsNav ctx={ctx} current="tax" />}
      className="max-w-5xl"
    >
      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : !summary || selected === undefined ? (
        <Card>
          <CardContent className="text-muted-foreground pt-6 text-sm">
            No payslips yet. Import some on the Payslips page to see your tax figures.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex items-center justify-between gap-4">
            <TaxYearSelect years={years} value={selected} onChange={setYear} />
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
              <CardDescription>Where each month's gross pay went, April to March{hasRefunds ? ", with the expense refunds paid on top" : ""}.</CardDescription>
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

          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Year to date</CardTitle>
                <CardDescription>
                  {summary.ytd ? `From the latest payslip, paid ${summary.ytd.payDate}` : "No payslip in this tax year"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {summary.ytd && (
                  <dl className="grid grid-cols-2 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">Gross pay</dt>
                    <dd className="text-right tabular-nums">{gbp(summary.ytd.grossPay)}</dd>
                    <dt className="text-muted-foreground">Taxable pay</dt>
                    <dd className="text-right tabular-nums">{gbp(summary.ytd.taxablePay)}</dd>
                    <dt className="text-muted-foreground">Tax paid</dt>
                    <dd className="text-right tabular-nums">{gbp(summary.ytd.tax)}</dd>
                    <dt className="text-muted-foreground">Employee NI</dt>
                    <dd className="text-right tabular-nums">{gbp(summary.ytd.eeNic)}</dd>
                  </dl>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Months with no payslip</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {summary.missingMonths.length === 0 ? (
                  <p className="text-muted-foreground">None: every month so far has a payslip.</p>
                ) : (
                  <ul className="flex flex-wrap gap-x-4 gap-y-1">
                    {summary.missingMonths.map((m) => (
                      <li key={m}>
                        {periodLabel(m)} <span className="text-muted-foreground">(month {m})</span>
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
