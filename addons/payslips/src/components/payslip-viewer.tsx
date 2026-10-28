import { useMutation, useQuery } from "@tanstack/react-query";
import type { AddonContext } from "@wealthfolio/addon-sdk";
import {
  AlertFeedback,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Icons,
} from "@wealthfolio/ui";
import { useState, type CSSProperties } from "react";
import { QUERY_ROOT } from "../hooks/use-payslip-data";
import { downloadPdf, loadPdf } from "../lib/pdf-store";
import { renderPdfPages } from "../lib/pdf-render";
import { extractPdfLines } from "../lib/pdf-text";
import { PayslipPageView } from "./payslip-page-view";

interface Loaded {
  bytes: Uint8Array;
  /** The PDF's text with its layout, or why it could not be read (the PDF itself is still there). */
  lines: string[] | null;
  textError?: string;
}

async function loadViewed(ctx: AddonContext, payDate: string): Promise<Loaded> {
  const bytes = await loadPdf(ctx, payDate);
  if (!bytes) throw new Error(`There is no stored PDF for the ${payDate} payslip.`);
  try {
    return { bytes, lines: await extractPdfLines(bytes) };
  } catch (err) {
    return { bytes, lines: null, textError: err instanceof Error ? err.message : String(err) };
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Space the dialog's header, buttons and padding take; "Fit page" leaves it free so a whole page is visible. */
const HEADER_HEIGHT = "12rem";

const DIALOG_STYLE: CSSProperties = {
  width: "min(900px, calc(100vw - 2rem))",
  maxWidth: "calc(100vw - 2rem)",
  maxHeight: "calc(100vh - 2rem)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

/** The only part of the dialog that scrolls. */
const PAGES_STYLE: CSSProperties = { flex: "1 1 auto", minHeight: 0, overflowY: "auto" };

/** A dialog with the stored PDF of one payslip: the pages drawn from its content, or its text when they cannot be drawn. */
export function PayslipViewer({ ctx, payDate, onClose }: { ctx: AddonContext; payDate: string; onClose: () => void }) {
  const { data, error, isLoading } = useQuery({
    queryKey: [QUERY_ROOT, "pdf-view", payDate],
    queryFn: () => loadViewed(ctx, payDate),
    gcTime: 0,
    // A missing PDF will still be missing a second later: say so at once.
    retry: false,
  });
  // The drawn pages; when they cannot be drawn the Payslip tab shows the PDF's text instead.
  const drawing = useQuery({
    queryKey: [QUERY_ROOT, "pdf-render", payDate],
    queryFn: () => renderPdfPages(data!.bytes),
    enabled: !!data,
    // The stored bytes of a pay date do not change while the dialog is open: draw them once.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  // Pages that drew no text at all (it sits where the renderer does not look, say in a form)
  // would show a blank sheet while the PDF does have text: show that instead.
  const drawn = drawing.data && !(data?.lines?.length && drawing.data.every((page) => page.texts.length === 0)) ? drawing.data : null;
  const [fit, setFit] = useState<"width" | "page">("width");
  const download = useMutation({ mutationFn: () => downloadPdf(ctx, payDate) });
  const failure = error ?? download.error;

  return (
    <Dialog open onOpenChange={(open: boolean) => !open && onClose()}>
      {/* Layout is inline on purpose: the add-on ships no stylesheet, so only classes the host's own CSS happens to contain would apply. */}
      <DialogContent style={DIALOG_STYLE}>
        <DialogHeader style={{ flexShrink: 0 }}>
          <DialogTitle>Payslip {payDate}</DialogTitle>
          <DialogDescription>The copy of the PDF kept in Wealthfolio.</DialogDescription>
        </DialogHeader>

        {failure && (
          <div style={{ flexShrink: 0 }}>
            <AlertFeedback variant="error" title="Something went wrong">
              {messageOf(failure)}
            </AlertFeedback>
          </div>
        )}

        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : data ? (
          <>
            <div style={{ flexShrink: 0, display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              {drawn && (
                <Button size="sm" variant="outline" onClick={() => setFit(fit === "width" ? "page" : "width")}>
                  {fit === "width" ? "Fit page" : "Fit width"}
                </Button>
              )}
              <Button size="sm" variant="outline" disabled={download.isPending} onClick={() => download.mutate()}>
                <Icons.Download size={14} className="mr-1" />
                Download
              </Button>
            </div>
            <div data-testid="payslip-pages" style={PAGES_STYLE}>
              {drawn ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "0.75rem", borderRadius: "0.25rem", background: "rgba(128,128,128,0.2)" }}>
                  {drawn.map((page, i) => (
                    <PayslipPageView key={i} drawing={page} fit={fit} headerHeight={HEADER_HEIGHT} />
                  ))}
                </div>
              ) : drawing.isLoading ? (
                <p className="text-muted-foreground text-sm">Drawing the payslip…</p>
              ) : data.lines ? (
                <pre
                  className="bg-muted/40 rounded border p-3 font-mono text-xs leading-tight"
                  style={{ overflow: "auto", maxHeight: `calc(100vh - ${HEADER_HEIGHT})`, whiteSpace: "pre", margin: 0 }}
                >
                  {data.lines.join("\n")}
                </pre>
              ) : (
                <p className="text-destructive text-sm">
                  The text of this PDF could not be read ({data.textError}). Use Download to open the PDF.
                </p>
              )}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
