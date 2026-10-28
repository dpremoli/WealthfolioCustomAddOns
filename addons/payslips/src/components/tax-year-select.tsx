import { Label } from "@wealthfolio/ui";
import { taxYearLabel } from "../lib/tax-year";

/** Native select of the tax years that have payslips, newest first. */
export function TaxYearSelect({ years, value, onChange }: { years: number[]; value: number; onChange: (year: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="payslips-tax-year" className="text-sm">
        Tax year
      </Label>
      <select
        id="payslips-tax-year"
        className="rounded border bg-background px-3 py-1.5 text-sm"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {[...years].sort((a, b) => b - a).map((y) => (
          <option key={y} value={y}>
            {taxYearLabel(y)}
          </option>
        ))}
      </select>
    </div>
  );
}
