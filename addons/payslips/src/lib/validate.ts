import { round2 } from "@wf-addons/kit";
import { employeeNi, incomeTax, type Line, type Payslip } from "./model";

const TOLERANCE = 0.005;
const gbp = (n: number) => n.toFixed(2);
const sum = (lines: Line[]) => round2(lines.reduce((s, l) => s + l.amount, 0));

/** Human-readable warnings for a payslip whose figures do not add up (empty when consistent). */
export function validatePayslip(p: Payslip): string[] {
  const warnings: string[] = [];
  const check = (computed: string, computedValue: number, printed: string, printedValue: number) => {
    if (Math.abs(computedValue - printedValue) > TOLERANCE) {
      warnings.push(`${computed} ${gbp(computedValue)}, but ${printed} ${gbp(printedValue)}.`);
    }
  };
  check("Payment lines add up to", sum(p.payments), "Total Payments says", p.totalPayments);
  check("Deduction lines add up to", sum(p.deductions), "Total Deductions says", p.totalDeductions);
  check(
    "Total Payments minus Total Deductions is",
    round2(p.totalPayments - p.totalDeductions),
    "Net Pay says",
    p.netPay,
  );
  check("Tax lines add up to", incomeTax(p), "This Period tax says", p.thisPeriod.tax);
  check("NI lines add up to", employeeNi(p), "This Period EE's NIC says", p.thisPeriod.eeNic);
  return warnings;
}
