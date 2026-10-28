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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@wealthfolio/ui";
import { useEffect, useState } from "react";
import { QUERY_ROOT } from "../hooks/use-payslip-data";
import { downloadPdf, loadPdf } from "../lib/pdf-store";
import { renderPdfPage } from "../lib/pdf-render";
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

/** A dialog with the stored PDF of one payslip: the page drawn from its content (text as a fallback) and the original PDF (may not render in a sandboxed frame). */
export function PayslipViewer({ ctx, payDate, onClose }: { ctx: AddonContext; payDate: string; onClose: () => void }) {
  const { data, error, isLoading } = useQuery({
    queryKey: [QUERY_ROOT, "pdf-view", payDate],
    queryFn: () => loadViewed(ctx, payDate),
    gcTime: 0,
    // A missing PDF will still be missing a second later: say so at once.
    retry: false,
  });
  // The drawn page; when it cannot be drawn the Payslip tab shows the PDF's text instead.
  const drawing = useQuery({
    queryKey: [QUERY_ROOT, "pdf-render", payDate],
    queryFn: () => renderPdfPage(data!.bytes),
    enabled: !!data,
    gcTime: 0,
    retry: false,
  });
  const download = useMutation({ mutationFn: () => downloadPdf(ctx, payDate) });
  const failure = error ?? download.error;

  return (
    <Dialog open onOpenChange={(open: boolean) => !open && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Payslip {payDate}</DialogTitle>
          <DialogDescription>The copy of the PDF kept in Wealthfolio.</DialogDescription>
        </DialogHeader>

        {failure && (
          <AlertFeedback variant="error" title="Something went wrong">
            {messageOf(failure)}
          </AlertFeedback>
        )}

        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : data ? (
          <Tabs defaultValue="payslip">
            <div className="flex items-center justify-between gap-3">
              <TabsList>
                <TabsTrigger value="payslip">Payslip</TabsTrigger>
                <TabsTrigger value="pdf">Original PDF</TabsTrigger>
              </TabsList>
              <Button size="sm" variant="outline" disabled={download.isPending} onClick={() => download.mutate()}>
                <Icons.Download size={14} className="mr-1" />
                Download
              </Button>
            </div>
            <TabsContent value="payslip" className="mt-3">
              {drawing.data ? (
                <div className="max-h-[70vh] overflow-y-auto rounded bg-neutral-200/60 p-3 dark:bg-neutral-800/60">
                  <PayslipPageView drawing={drawing.data} />
                </div>
              ) : drawing.isLoading ? (
                <p className="text-muted-foreground text-sm">Drawing the payslip…</p>
              ) : data.lines ? (
                <pre className="bg-muted/40 max-h-[60vh] overflow-auto rounded border p-3 font-mono text-xs leading-tight whitespace-pre">
                  {data.lines.join("\n")}
                </pre>
              ) : (
                <p className="text-destructive text-sm">
                  The text of this PDF could not be read ({data.textError}). Use Download to open the PDF.
                </p>
              )}
            </TabsContent>
            <TabsContent value="pdf" className="mt-3">
              <OriginalPdf bytes={data.bytes} />
            </TabsContent>
          </Tabs>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** The PDF in an `<object>` fed from a blob URL that lives only as long as the tab does. */
function OriginalPdf({ bytes }: { bytes: Uint8Array }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const made = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [bytes]);
  if (!url) return null;
  return (
    <object data={url} type="application/pdf" aria-label="Original payslip PDF" className="h-[60vh] w-full rounded border">
      <p className="text-muted-foreground p-3 text-sm">Wealthfolio can't show the PDF inline here — use Download.</p>
    </object>
  );
}
