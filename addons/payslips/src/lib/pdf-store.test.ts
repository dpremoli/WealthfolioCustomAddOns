import { FakeWealthfolio, STORAGE_CAP_BYTES, STORAGE_KEY_RE } from "@wf-addons/kit/testing";
import { describe, expect, it, vi } from "vitest";
import { samplePayslipLines, writePdf } from "../test-utils";
import {
  MAX_PDF_BASE64_BYTES,
  base64Decode,
  base64Encode,
  deleteAllPdfs,
  deletePdf,
  downloadPdf,
  getKeepPdfs,
  hasPdf,
  listPdfDates,
  loadPdf,
  savePdf,
  setKeepPdfs,
} from "./pdf-store";

const host = () => new FakeWealthfolio([]);
const bytesOf = (...values: number[]) => new Uint8Array(values);
const pdf = () => new Uint8Array(writePdf([samplePayslipLines()]));

describe("base64", () => {
  it("round-trips every length around the 3-byte boundary", () => {
    for (let n = 0; n < 10; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 250) % 256);
      expect(base64Decode(base64Encode(bytes))).toEqual(bytes);
    }
  });

  it("matches the standard encoding", () => {
    expect(base64Encode(new TextEncoder().encode("Man"))).toBe("TWFu");
    expect(base64Encode(new TextEncoder().encode("Ma"))).toBe("TWE=");
    expect(base64Encode(new TextEncoder().encode("M"))).toBe("TQ==");
  });

  it("handles a buffer far larger than one chunk without overflowing the stack", () => {
    const big = Uint8Array.from({ length: 700_001 }, (_, i) => i % 251);
    const encoded = base64Encode(big);
    expect(encoded).toBe(Buffer.from(big).toString("base64"));
    expect(Buffer.from(base64Decode(encoded)).equals(Buffer.from(big))).toBe(true);
  });
});

describe("pdf store", () => {
  it("returns the bytes it was given", async () => {
    const h = host();
    const bytes = pdf();
    await savePdf(h.ctx, "2026-10-31", bytes);
    expect(await loadPdf(h.ctx, "2026-10-31")).toEqual(bytes);
  });

  it("keeps one base64 value per pay date, and only host-valid keys", async () => {
    const h = host();
    await savePdf(h.ctx, "2026-10-31", bytesOf(1, 2, 3));
    expect(h.storage.get("pdf:2026-10-31")).toBe("AQID");
    for (const key of h.storage.keys()) expect(key).toMatch(STORAGE_KEY_RE);
  });

  it("keeps a sorted index of the pay dates", async () => {
    const h = host();
    await savePdf(h.ctx, "2026-10-31", bytesOf(1));
    await savePdf(h.ctx, "2026-04-30", bytesOf(2));
    await savePdf(h.ctx, "2026-10-31", bytesOf(3));
    expect(JSON.parse(h.storage.get("pdf:index")!)).toEqual(["2026-04-30", "2026-10-31"]);
    expect(await listPdfDates(h.ctx)).toEqual(["2026-04-30", "2026-10-31"]);
    expect(await hasPdf(h.ctx, "2026-04-30")).toBe(true);
    expect(await hasPdf(h.ctx, "2026-05-31")).toBe(false);
  });

  it("replaces the PDF of the same pay date", async () => {
    const h = host();
    await savePdf(h.ctx, "2026-10-31", bytesOf(1, 1, 1));
    await savePdf(h.ctx, "2026-10-31", bytesOf(9, 9));
    expect(await loadPdf(h.ctx, "2026-10-31")).toEqual(bytesOf(9, 9));
    expect(await listPdfDates(h.ctx)).toEqual(["2026-10-31"]);
  });

  it("answers null when there is no PDF", async () => {
    expect(await loadPdf(host().ctx, "2026-10-31")).toBeNull();
  });

  it("deletes one PDF and its index entry, and drops an empty index", async () => {
    const h = host();
    await savePdf(h.ctx, "2026-04-30", bytesOf(1));
    await savePdf(h.ctx, "2026-10-31", bytesOf(2));
    await deletePdf(h.ctx, "2026-04-30");
    expect(h.storage.has("pdf:2026-04-30")).toBe(false);
    expect(await listPdfDates(h.ctx)).toEqual(["2026-10-31"]);
    await deletePdf(h.ctx, "2026-10-31");
    expect(h.storage.has("pdf:index")).toBe(false);
    await deletePdf(h.ctx, "2026-10-31"); // deleting what is not there is fine
  });

  it("deletes every PDF and reports how many", async () => {
    const h = host();
    await savePdf(h.ctx, "2026-04-30", bytesOf(1));
    await savePdf(h.ctx, "2026-10-31", bytesOf(2));
    h.storage.set("settings", "{}");
    expect(await deleteAllPdfs(h.ctx)).toBe(2);
    expect([...h.storage.keys()]).toEqual(["settings"]);
  });

  it("refuses a PDF whose base64 is over 200 000 bytes, and stores nothing", async () => {
    const h = host();
    const limit = Math.floor((MAX_PDF_BASE64_BYTES / 4) * 3); // the largest that still fits
    await savePdf(h.ctx, "2026-04-30", new Uint8Array(limit));
    expect(h.storage.get("pdf:2026-04-30")!.length).toBeLessThanOrEqual(200_000);
    expect(h.storage.get("pdf:2026-04-30")!.length).toBeLessThan(STORAGE_CAP_BYTES);
    await expect(savePdf(h.ctx, "2026-10-31", new Uint8Array(limit + 1))).rejects.toThrow(
      "too large to keep (over ~150 KB)",
    );
    expect(h.storage.has("pdf:2026-10-31")).toBe(false);
    expect(await listPdfDates(h.ctx)).toEqual(["2026-04-30"]);
  });

  it("refuses a pay date that is not a day", async () => {
    await expect(savePdf(host().ctx, "../x", bytesOf(1))).rejects.toThrow(/pay date/i);
  });
});

describe("keep PDFs setting", () => {
  it("is on by default and remembers the choice in its own key", async () => {
    const h = host();
    expect(await getKeepPdfs(h.ctx)).toBe(true);
    await setKeepPdfs(h.ctx, false);
    expect(h.storage.get("pdf:keep")).toBe("false");
    expect(await getKeepPdfs(h.ctx)).toBe(false);
    await setKeepPdfs(h.ctx, true);
    expect(h.storage.get("pdf:keep")).toBe("true");
    expect(await getKeepPdfs(h.ctx)).toBe(true);
  });
});

describe("downloadPdf", () => {
  const withFiles = (openSaveDialog = vi.fn().mockResolvedValue(null)) => {
    const h = host();
    (h.ctx.api as unknown as Record<string, unknown>).files = { openSaveDialog };
    return { h, openSaveDialog };
  };

  it("hands the stored bytes and a file name to the save dialog", async () => {
    const { h, openSaveDialog } = withFiles();
    await savePdf(h.ctx, "2026-10-31", bytesOf(1, 2, 3));
    await downloadPdf(h.ctx, "2026-10-31");
    expect(openSaveDialog).toHaveBeenCalledTimes(1);
    expect(openSaveDialog).toHaveBeenCalledWith(bytesOf(1, 2, 3), "payslip-2026-10-31.pdf");
  });

  it("says so when there is no PDF, without opening the dialog", async () => {
    const { h, openSaveDialog } = withFiles();
    await expect(downloadPdf(h.ctx, "2026-10-31")).rejects.toThrow(/no stored PDF/i);
    expect(openSaveDialog).not.toHaveBeenCalled();
  });

  it("passes on the host's failure", async () => {
    const { h } = withFiles(vi.fn().mockRejectedValue(new Error("Save dialog closed unexpectedly")));
    await savePdf(h.ctx, "2026-10-31", bytesOf(1));
    await expect(downloadPdf(h.ctx, "2026-10-31")).rejects.toThrow("Save dialog closed unexpectedly");
  });
});
