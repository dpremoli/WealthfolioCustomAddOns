import { TableHead } from "@wealthfolio/ui";
import type { CSSProperties } from "react";
import type { SortDir } from "../lib/table-sort";

/*
 * The add-on ships no stylesheet, so a Tailwind class only works if Wealthfolio's own CSS happens to
 * contain it, and the host's TableHead/TableCell classes set their own alignment. Alignment, widths
 * and wrapping of the table are therefore inline, the same on a column's header and its cells.
 */

/** Style of a header cell. */
export const headStyle = (align: "left" | "right"): CSSProperties => ({ textAlign: align, whiteSpace: "nowrap" });

/** Style of a body cell: numbers right and in tabular figures, never wrapped; text left. */
export const cellStyle = (align: "left" | "right", opts: { nowrap?: boolean } = {}): CSSProperties =>
  align === "right"
    ? { textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }
    : { textAlign: "left", ...(opts.nowrap ? { whiteSpace: "nowrap" } : {}) };

const BUTTON: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: 0,
  margin: 0,
  border: 0,
  background: "none",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
  whiteSpace: "nowrap",
};
// Fixed width, so the header does not change size when the arrow appears.
const ARROW: CSSProperties = { display: "inline-block", width: "1em", textAlign: "center", fontSize: "0.8em" };

/**
 * A column header that sorts by its column when clicked. The arrow sits on the side away from the
 * edge the text is aligned to, so the label stays flush with the values below it.
 */
export function SortableHead({
  label,
  align,
  dir,
  onSort,
}: {
  label: string;
  align: "left" | "right";
  /** The direction when this is the sorted column; undefined otherwise. */
  dir: SortDir | undefined;
  onSort: () => void;
}) {
  const arrow = (
    <span aria-hidden="true" style={ARROW}>
      {dir === "asc" ? "▲" : dir === "desc" ? "▼" : ""}
    </span>
  );
  return (
    <TableHead
      style={headStyle(align)}
      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
    >
      <button type="button" style={BUTTON} onClick={onSort} title={`Sort by ${label.toLowerCase()}`}>
        {align === "right" && arrow}
        {label}
        {align === "left" && arrow}
      </button>
    </TableHead>
  );
}
