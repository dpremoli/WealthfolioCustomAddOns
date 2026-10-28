import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AddonContext } from "@wealthfolio/addon-sdk";
import { AlertFeedback, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Switch } from "@wealthfolio/ui";
import { useState } from "react";
import { QUERY_ROOT } from "../hooks/use-payslip-data";
import { useKeepPdfs, usePdfDates } from "../hooks/use-pdf-dates";
import { deleteAllPdfs, setKeepPdfs } from "../lib/pdf-store";

const countLabel = (n: number) => (n === 0 ? "No PDFs stored" : `${n} ${n === 1 ? "PDF" : "PDFs"} stored`);

/** Settings: whether imports keep the PDF, how many are kept, and removing them all (two clicks, no `window.confirm` in the sandbox). */
export function StoredPdfsCard({ ctx }: { ctx: AddonContext }) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: [QUERY_ROOT] });
  const keep = useKeepPdfs(ctx);
  const dates = usePdfDates(ctx);
  const [confirming, setConfirming] = useState(false);

  const toggle = useMutation({ mutationFn: (on: boolean) => setKeepPdfs(ctx, on), onSuccess: refresh });
  const removeAll = useMutation({
    mutationFn: () => deleteAllPdfs(ctx),
    onSuccess: () => {
      setConfirming(false);
      return refresh();
    },
  });
  const failure = toggle.error ?? removeAll.error ?? keep.error ?? dates.error;
  const count = dates.data?.length ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Stored PDFs</CardTitle>
        <CardDescription>
          A copy of each imported payslip PDF can be kept in Wealthfolio so you can view and download it. The PDF includes your
          name and NI number.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {failure && (
          <AlertFeedback variant="error" title="Something went wrong">
            {failure instanceof Error ? failure.message : String(failure)}
          </AlertFeedback>
        )}
        <div className="flex items-center gap-2">
          <Switch
            id="keep-pdfs"
            aria-label="Keep a copy of each payslip PDF"
            checked={keep.data ?? true}
            disabled={keep.data === undefined || toggle.isPending}
            onCheckedChange={(on: boolean) => toggle.mutate(on)}
          />
          <Label htmlFor="keep-pdfs" className="text-sm font-normal">
            Keep a copy of each payslip PDF
          </Label>
        </div>
        <p>{dates.data ? countLabel(count) : "Loading…"}</p>
        <div className="flex items-center gap-2">
          {confirming ? (
            <>
              <Button variant="destructive" disabled={removeAll.isPending} onClick={() => removeAll.mutate()}>
                Confirm remove all
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="outline" disabled={count === 0} onClick={() => setConfirming(true)}>
              Remove all stored PDFs
            </Button>
          )}
        </div>
        <p className="text-muted-foreground text-xs">Your payslip figures stay; only the PDF copies are removed.</p>
      </CardContent>
    </Card>
  );
}
