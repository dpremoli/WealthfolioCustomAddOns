import { Label } from "@wealthfolio/ui";
import { useId, type CSSProperties } from "react";
import { periodOfKind, periodYears, type Period, type PeriodKind } from "../lib/period";
import { taxYearLabel } from "../lib/tax-year";

// No stylesheet ships with the add-on: what decides the layout is inline.
const ROW: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 };
const FIELD: CSSProperties = { display: "flex", alignItems: "center", gap: 6 };
const CONTROL = "rounded border bg-background px-3 py-1.5 text-sm";

const MODES: { kind: PeriodKind; label: string }[] = [
  { kind: "tax", label: "Tax year" },
  { kind: "calendar", label: "Calendar year" },
  { kind: "range", label: "Custom range" },
];

/**
 * Chooses what the page shows: a tax year (6 April to 5 April), a calendar year (of the years that
 * have payslips) or a custom range of pay dates, both ends included.
 */
export function PeriodSelect({
  payslips,
  value,
  onChange,
}: {
  payslips: { payDate: string; taxYear: number }[];
  value: Period;
  onChange: (period: Period) => void;
}) {
  const id = useId();
  const kindLabel = MODES.find((m) => m.kind === value.kind)!.label;

  return (
    <div style={ROW}>
      <div style={FIELD}>
        <Label htmlFor={`${id}-mode`} className="text-sm">
          Period
        </Label>
        <select
          id={`${id}-mode`}
          className={CONTROL}
          value={value.kind}
          onChange={(e) => onChange(periodOfKind(e.target.value as PeriodKind, value, payslips))}
        >
          {MODES.map((m) => (
            <option key={m.kind} value={m.kind}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {value.kind !== "range" && (
        <div style={FIELD}>
          <Label htmlFor={`${id}-year`} className="text-sm">
            {kindLabel}
          </Label>
          <select
            id={`${id}-year`}
            className={CONTROL}
            value={value.year}
            onChange={(e) => onChange({ kind: value.kind, year: Number(e.target.value) })}
          >
            {periodYears(payslips, value.kind)
              .reverse()
              .map((y) => (
                <option key={y} value={y}>
                  {value.kind === "tax" ? taxYearLabel(y) : y}
                </option>
              ))}
          </select>
        </div>
      )}

      {value.kind === "range" && (
        <>
          <div style={FIELD}>
            <Label htmlFor={`${id}-from`} className="text-sm">
              From
            </Label>
            <input
              id={`${id}-from`}
              type="date"
              className={CONTROL}
              value={value.from}
              onChange={(e) => onChange({ ...value, from: e.target.value })}
            />
          </div>
          <div style={FIELD}>
            <Label htmlFor={`${id}-to`} className="text-sm">
              To
            </Label>
            <input
              id={`${id}-to`}
              type="date"
              className={CONTROL}
              value={value.to}
              onChange={(e) => onChange({ ...value, to: e.target.value })}
            />
          </div>
        </>
      )}
    </div>
  );
}
