import { useQuery } from "@tanstack/react-query";
import type { AddonContext } from "@wealthfolio/addon-sdk";
import { getKeepPdfs, listPdfDates } from "../lib/pdf-store";
import { QUERY_ROOT } from "./use-payslip-data";

/** Pay dates that have a stored PDF. */
export function usePdfDates(ctx: AddonContext) {
  return useQuery<string[]>({ queryKey: [QUERY_ROOT, "pdf-dates"], queryFn: () => listPdfDates(ctx) });
}

/** Whether imports keep a copy of the PDF (on unless turned off in Settings). */
export function useKeepPdfs(ctx: AddonContext) {
  return useQuery<boolean>({ queryKey: [QUERY_ROOT, "keep-pdfs"], queryFn: () => getKeepPdfs(ctx) });
}
