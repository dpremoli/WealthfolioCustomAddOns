/**
 * Copies `text`, preferring the async Clipboard API. A sandboxed add-on iframe may be
 * denied it; then the text in `fallbackInput` is selected (and a legacy `execCommand`
 * copy attempted) so the user can finish with Ctrl/Cmd+C.
 *
 * Returns "copied" when the clipboard was written, "selected" when the user must copy.
 */
export async function copyText(
  text: string,
  fallbackInput?: HTMLInputElement | HTMLTextAreaElement | null,
): Promise<"copied" | "selected"> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return "copied";
    }
  } catch {
    /* denied by the sandbox: fall through */
  }
  if (fallbackInput) {
    fallbackInput.focus();
    fallbackInput.select();
    try {
      if (document.execCommand?.("copy")) return "copied";
    } catch {
      /* ignore */
    }
  }
  return "selected";
}
