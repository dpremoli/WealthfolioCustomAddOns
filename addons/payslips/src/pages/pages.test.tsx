import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AddonContext, AddonRouteLocation } from "@wealthfolio/addon-sdk";
import { FakeWealthfolio, type StoredActivity } from "@wf-addons/kit/testing";
import type { ComponentType } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { lineContent, rawPdf, samplePayslipLines, withXObject, withoutPageTree, writePdf } from "../test-utils";
import { parsePayslipLines } from "../lib/payslip-parser";
import type { Payslip } from "../lib/model";
import { recordPayroll } from "../lib/payroll";
import { loadCandidateRows, matchSalaries } from "../lib/salary-match";
import { getKeepPdfs, listPdfDates, loadPdf, savePdf, setKeepPdfs } from "../lib/pdf-store";
import { loadLinks, loadPayslips, loadStatements, savePayslips } from "../lib/store";
import { PayslipViewer } from "../components/payslip-viewer";
import PayslipsPage from "./payslips-page";
import PensionPage from "./pension-page";
import SettingsPage from "./settings-page";
import TaxPage from "./tax-page";

type Page = ComponentType<{ ctx: AddonContext; location: AddonRouteLocation }>;

beforeAll(() => {
  // Base UI's checkbox builds a PointerEvent on click; jsdom has none.
  window.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent;
  // recharts' ResponsiveContainer observes its parent's size; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => vi.useRealTimers());

/** All figures are synthetic: salary 3000, USS 183, tax 380, NI 150, net 2287. */
const payslip = (): Payslip => ({
  ...parsePayslipLines(samplePayslipLines()),
  warnings: [],
  importedAt: "2026-11-02T09:00:00.000Z",
});

const deposit = (over: Partial<StoredActivity> = {}): StoredActivity => ({
  id: "act-1",
  accountId: "acc-1",
  activityType: "DEPOSIT",
  date: new Date("2026-10-31T12:00:00.000Z"),
  assetSymbol: null,
  exchangeMic: null,
  quantity: null,
  unitPrice: null,
  amount: 2287,
  fee: null,
  currency: "GBP",
  comment: "Salary",
  ...over,
});

async function setup(opts: { payslips?: Payslip[]; deposits?: StoredActivity[] } = {}) {
  const host = new FakeWealthfolio([
    { id: "acc-1", name: "Current Account", currency: "GBP", accountType: "CASH", trackingMode: "TRANSACTIONS" },
  ]);
  host.stored.set("acc-1", opts.deposits ?? [deposit()]);
  const navigate = vi.fn();
  // The fake host has no navigation (nor router).
  (host.ctx.api as unknown as Record<string, unknown>).navigation = { navigate };
  (host.ctx.api as unknown as Record<string, unknown>).query = { getClient: () => new QueryClient() };
  // ... nor a files API.
  const openSaveDialog = vi.fn().mockResolvedValue(null);
  (host.ctx.api as unknown as Record<string, unknown>).files = { openSaveDialog };
  await savePayslips(host.ctx, opts.payslips ?? [payslip()]);
  return { host, ctx: host.ctx, navigate, openSaveDialog };
}

/** Fresh ArrayBuffer-backed bytes (what `File` accepts) of the synthetic payslip PDF. */
const pdfBytes = () => new Uint8Array(writePdf([samplePayslipLines()]));

function renderPage(Page: Page, ctx: AddonContext) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <Page ctx={ctx} location={{} as AddonRouteLocation} />
    </QueryClientProvider>,
  );
  return Object.assign(view, { client });
}

describe("payslips page", () => {
  it("lists the stored payslip with its figures and the matched deposit", async () => {
    const { ctx } = await setup();
    renderPage(PayslipsPage, ctx);

    await waitFor(() => expect(screen.getByText("Matched")).toBeTruthy());
    expect(screen.getByText("2026-10-31", { selector: "td" })).toBeTruthy();
    expect(screen.getByText("Oct (07/2026)")).toBeTruthy();
    expect(screen.getByText("£3,000.00")).toBeTruthy(); // gross before USS
    expect(screen.getByText("£183.00")).toBeTruthy(); // USS
    expect(screen.getByText("£2,287.00")).toBeTruthy(); // net
    expect(screen.getByText("OK")).toBeTruthy();
    expect(screen.getByText("Current Account · 2026-10-31")).toBeTruthy();
    expect(screen.queryByText(/never uploaded/i)).toBeNull();
    expect(
      screen.getByText(
        "Payslips are read by this add-on on this device, and nothing is sent to any outside service. What the add-on keeps is stored in Wealthfolio's add-on storage, which Wealthfolio syncs to your paired devices.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "A copy of each PDF is kept in Wealthfolio so you can view and download it. It includes your name and NI number; turn this off in Settings.",
      ),
    ).toBeTruthy();
  });

  it("says only the figures are kept once the PDF copy is turned off", async () => {
    const { ctx } = await setup();
    await setKeepPdfs(ctx, false);
    renderPage(PayslipsPage, ctx);
    expect(await screen.findByText(/Only figures, pay date, tax period and tax code are kept\./)).toBeTruthy();
    expect(screen.queryByText(/A copy of each PDF is kept/)).toBeNull();
  });

  it("says how many stored PDF copies remain when new imports no longer keep one", async () => {
    const { ctx } = await setup();
    await savePdf(ctx, "2026-10-31", pdfBytes());
    await setKeepPdfs(ctx, false);
    renderPage(PayslipsPage, ctx);
    expect(
      await screen.findByText("New imports keep figures only; 1 stored PDF copy remains (remove it in Settings)."),
    ).toBeTruthy();
    expect(screen.queryByText(/Only figures, pay date, tax period and tax code are kept\./)).toBeNull();
  });

  it("navigates with the nav buttons", async () => {
    const { ctx, navigate } = await setup();
    renderPage(PayslipsPage, ctx);
    fireEvent.click(await screen.findByRole("button", { name: /Tax/ }));
    expect(navigate).toHaveBeenCalledWith("/addons/payslips-addon/tax");
  });

  it("shows warnings, a missing deposit and no tag button without a match", async () => {
    const bad = { ...payslip(), warnings: ["Payments do not add up to Total Payments"] };
    const { ctx } = await setup({ payslips: [bad], deposits: [] });
    renderPage(PayslipsPage, ctx);
    await waitFor(() => expect(screen.getByText("Missing")).toBeTruthy());
    expect(screen.getByText("1 warning")).toBeTruthy();
    expect(screen.getByText("Payments do not add up to Total Payments")).toBeTruthy();
    expect(screen.queryByText("Tag deposit")).toBeNull();
  });

  it("lets the user pick between two equally close deposits, and stores the pick", async () => {
    const { ctx } = await setup({
      deposits: [deposit({ id: "a" }), deposit({ id: "b", date: new Date("2026-10-31T13:00:00.000Z"), comment: "Other" })],
    });
    renderPage(PayslipsPage, ctx);
    const select = (await screen.findByLabelText("Choose the salary deposit")) as HTMLSelectElement;
    expect(screen.getByText("Ambiguous")).toBeTruthy();
    fireEvent.change(select, { target: { value: "b" } });
    await waitFor(() => expect(screen.getByText("Matched")).toBeTruthy());
    expect(await loadLinks(ctx)).toEqual({ "2026-10-31": { activityId: "b", accountId: "acc-1", chosen: "manual" } });
  });

  it("tags the matched deposit on request and remembers it", async () => {
    const { host, ctx } = await setup();
    renderPage(PayslipsPage, ctx);
    const button = await screen.findByText("Tag deposit");
    expect(button.closest("button")?.getAttribute("title")).toContain("[ref:payslip:2026-10-31]");
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText("Tagged")).toBeTruthy());
    expect(host.rows("acc-1")[0]?.comment).toContain("[ref:payslip:2026-10-31]");
    expect((await loadLinks(ctx))["2026-10-31"]).toMatchObject({ activityId: "act-1", tagged: true });
    expect(screen.queryByText("Tag deposit")).toBeNull();
  });

  it("deletes a payslip only after a second click", async () => {
    const { ctx } = await setup();
    renderPage(PayslipsPage, ctx);
    fireEvent.click(await screen.findByLabelText("Delete payslip 2026-10-31"));
    expect(await loadPayslips(ctx)).toHaveLength(1);
    fireEvent.click(screen.getByText("Confirm delete"));
    await waitFor(() => expect(screen.getByText("No payslips yet. Import a PDF above.")).toBeTruthy());
    expect(await loadPayslips(ctx)).toHaveLength(0);
  });

  it("parses a chosen PDF, stores it, and reports files it cannot read", async () => {
    const { ctx } = await setup({ payslips: [] });
    renderPage(PayslipsPage, ctx);
    const input = (await screen.findByTestId("payslip-files")) as HTMLInputElement;
    expect(input.multiple).toBe(true);
    expect(input.accept).toContain("application/pdf");

    const pdf = new File([pdfBytes()], "october.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [pdf] } });
    await waitFor(() => expect(screen.getByText("1 imported, 0 replaced")).toBeTruthy());
    expect((await loadPayslips(ctx)).map((p) => p.payDate)).toEqual(["2026-10-31"]);
    await waitFor(() => expect(screen.getByText("Matched")).toBeTruthy());

    // The same file again replaces; a file that is not a PDF is reported by name.
    const again = new File([pdfBytes()], "october-again.pdf", { type: "application/pdf" });
    const junk = new File(["hello"], "notes.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [again, junk] } });
    await waitFor(() => expect(screen.getByText("0 imported, 1 replaced")).toBeTruthy());
    expect(screen.getByText("notes.pdf")).toBeTruthy();
  });

  it("imports PDFs dropped on the card", async () => {
    const { ctx } = await setup({ payslips: [] });
    renderPage(PayslipsPage, ctx);
    const zone = await screen.findByTestId("payslip-drop-zone");
    const pdf = new File([pdfBytes()], "dropped.pdf", { type: "application/pdf" });
    fireEvent.drop(zone, { dataTransfer: { files: [pdf] } });
    await waitFor(() => expect(screen.getByText("1 imported, 0 replaced")).toBeTruthy());
  });
});

describe("payslips page: stored PDFs", () => {
  const NET_PAY = /Net Pay/;

  /** A payslip row whose PDF is stored (the bytes are the synthetic payslip PDF). */
  async function withStoredPdf() {
    const s = await setup();
    const bytes = pdfBytes();
    await savePdf(s.ctx, "2026-10-31", bytes);
    return { ...s, bytes };
  }

  it("keeps the PDF of an imported file, replaces it on re-import, and offers View and Download", async () => {
    const { ctx } = await setup({ payslips: [] });
    renderPage(PayslipsPage, ctx);
    const input = (await screen.findByTestId("payslip-files")) as HTMLInputElement;

    fireEvent.change(input, { target: { files: [new File([pdfBytes()], "october.pdf", { type: "application/pdf" })] } });
    await waitFor(() => expect(screen.getByText("1 imported, 0 replaced")).toBeTruthy());
    expect(await loadPdf(ctx, "2026-10-31")).toEqual(pdfBytes());
    expect(await listPdfDates(ctx)).toEqual(["2026-10-31"]);
    const view = (await screen.findByLabelText("View payslip 2026-10-31")) as HTMLButtonElement;
    expect(view.disabled).toBe(false);
    expect(view.textContent).toContain("View");
    const download = screen.getByLabelText("Download payslip 2026-10-31") as HTMLButtonElement;
    expect(download.disabled).toBe(false);
    expect(download.textContent).toContain("Download");

    // The same pay date again (other figures, so other bytes) replaces the stored copy.
    const other = new Uint8Array(writePdf([samplePayslipLines({ payments: ["Salary 3100.00", "USS(CRB) 16 SS 183.00-"] })]));
    fireEvent.change(input, { target: { files: [new File([other], "october-v2.pdf", { type: "application/pdf" })] } });
    await waitFor(() => expect(screen.getByText("0 imported, 1 replaced")).toBeTruthy());
    expect(await loadPdf(ctx, "2026-10-31")).toEqual(other);
    expect(await listPdfDates(ctx)).toEqual(["2026-10-31"]);
  });

  it("keeps nothing when keeping PDFs is off", async () => {
    const { host, ctx } = await setup({ payslips: [] });
    await setKeepPdfs(ctx, false);
    renderPage(PayslipsPage, ctx);
    const input = (await screen.findByTestId("payslip-files")) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([pdfBytes()], "october.pdf", { type: "application/pdf" })] } });
    await waitFor(() => expect(screen.getByText("1 imported, 0 replaced")).toBeTruthy());
    expect(await listPdfDates(ctx)).toEqual([]);
    expect([...host.storage.keys()].filter((k) => k.startsWith("pdf:") && k !== "pdf:keep")).toEqual([]);
    expect((screen.getByLabelText("View payslip 2026-10-31") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Download payslip 2026-10-31") as HTMLButtonElement).disabled).toBe(true);
  });

  it("imports a PDF that is too large to keep, and says why the copy is missing next to the file", async () => {
    const { ctx } = await setup({ payslips: [] });
    renderPage(PayslipsPage, ctx);
    const input = (await screen.findByTestId("payslip-files")) as HTMLInputElement;
    // The payslip text plus ~170 KB of PDF comment in its content stream.
    const big = new Uint8Array(rawPdf([`${lineContent(samplePayslipLines())}\n% ${"x".repeat(170_000)}\n`]));
    fireEvent.change(input, { target: { files: [new File([big], "huge.pdf", { type: "application/pdf" })] } });
    await waitFor(() => expect(screen.getByText("1 imported, 0 replaced")).toBeTruthy());
    expect((await loadPayslips(ctx)).map((p) => p.payDate)).toEqual(["2026-10-31"]);
    expect(await listPdfDates(ctx)).toEqual([]);
    expect(screen.getByText("huge.pdf")).toBeTruthy();
    expect(screen.getByText(/too large to keep \(over ~150 KB\)/)).toBeTruthy();
    expect((screen.getByLabelText("View payslip 2026-10-31") as HTMLButtonElement).disabled).toBe(true);
  });

  it("drops the old PDF copy when the re-imported payslip's copy is not kept", async () => {
    const { ctx } = await setup();
    await savePdf(ctx, "2026-10-31", new Uint8Array([1, 2, 3]));
    await setKeepPdfs(ctx, false);
    renderPage(PayslipsPage, ctx);
    const input = (await screen.findByTestId("payslip-files")) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([pdfBytes()], "october.pdf", { type: "application/pdf" })] } });
    await waitFor(() => expect(screen.getByText("0 imported, 1 replaced")).toBeTruthy());
    expect(await loadPdf(ctx, "2026-10-31")).toBeNull();
    expect(await listPdfDates(ctx)).toEqual([]);
    await waitFor(() => expect((screen.getByLabelText("View payslip 2026-10-31") as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByLabelText("Download payslip 2026-10-31") as HTMLButtonElement).disabled).toBe(true);
  });

  it("drops the old PDF copy when the re-imported file is too large to keep", async () => {
    const { ctx } = await setup();
    await savePdf(ctx, "2026-10-31", new Uint8Array([1, 2, 3]));
    renderPage(PayslipsPage, ctx);
    const input = (await screen.findByTestId("payslip-files")) as HTMLInputElement;
    const big = new Uint8Array(rawPdf([`${lineContent(samplePayslipLines())}\n% ${"x".repeat(170_000)}\n`]));
    fireEvent.change(input, { target: { files: [new File([big], "huge.pdf", { type: "application/pdf" })] } });
    await waitFor(() => expect(screen.getByText("0 imported, 1 replaced")).toBeTruthy());
    expect(screen.getByText(/too large to keep \(over ~150 KB\)/)).toBeTruthy();
    expect(await loadPdf(ctx, "2026-10-31")).toBeNull();
    expect(await listPdfDates(ctx)).toEqual([]);
  });

  it("shows that there is no stored PDF at once, without retrying the lookup", async () => {
    const { ctx } = await setup();
    // A default client retries a failing query three times, seconds apart.
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <PayslipViewer ctx={ctx} payDate="2026-10-31" onClose={() => {}} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/There is no stored PDF for the 2026-10-31 payslip/, {}, { timeout: 500 })).toBeTruthy();
  });

  it("disables View and Download for a payslip with no stored PDF", async () => {
    const { ctx } = await setup();
    renderPage(PayslipsPage, ctx);
    const view = (await screen.findByLabelText("View payslip 2026-10-31")) as HTMLButtonElement;
    expect(view.disabled).toBe(true);
    expect((screen.getByLabelText("Download payslip 2026-10-31") as HTMLButtonElement).disabled).toBe(true);
  });

  it("draws the payslip page as an SVG, with no Original PDF tab or object", async () => {
    const { ctx } = await withStoredPdf();
    renderPage(PayslipsPage, ctx);
    const view = await screen.findByLabelText("View payslip 2026-10-31");
    await waitFor(() => expect((view as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(view);

    const dialog = await screen.findByRole("dialog");
    const net = await within(dialog).findByText(NET_PAY, { selector: "svg text" });
    const svg = net.closest("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 595 842");
    expect(net.getAttribute("font-family")).toMatch(/Courier/);
    expect(svg.textContent).toContain("Total Payments");
    expect(svg.textContent).toContain("ZZNAME TESTPERSON");
    expect(dialog.querySelector("pre")).toBeNull();
    expect(within(dialog).queryByRole("tab")).toBeNull();
    expect(within(dialog).queryByText("Original PDF")).toBeNull();
    expect(dialog.querySelector("object")).toBeNull();
  });

  it("fits the dialog to the window with inline styles: a fixed header and a scrolling page area", async () => {
    const { dialog } = await openViewer(writePdf([["Page one text"], ["Page two text"]]));
    const svg = (await within(dialog).findByText("Page one text", { selector: "svg text" })).closest("svg")!;
    expect(dialog.style.maxHeight).toBe("calc(100vh - 2rem)");
    expect(dialog.style.maxWidth).toBe("calc(100vw - 2rem)");
    expect(dialog.style.overflow).toBe("hidden");
    expect(dialog.style.display).toBe("flex");
    const area = dialog.querySelector<HTMLElement>("[data-testid='payslip-pages']")!;
    expect(area.style.overflowY).toBe("auto");
    expect(parseFloat(area.style.minHeight)).toBe(0);
    expect(area.contains(svg)).toBe(true);
    expect(area.style.flex).toMatch(/^1 1 auto/);
    // The title and the buttons are outside the scrolling area.
    expect(area.contains(within(dialog).getByRole("button", { name: "Download" }))).toBe(false);
    expect(svg.style.width).toBe("100%");
    expect(svg.style.height).toBe("auto");
    expect(svg.style.display).toBe("block");
  });

  it("switches between fitting the page width and the whole page", async () => {
    const { dialog } = await openViewer(writePdf([["Page one text"]]));
    const svg = (await within(dialog).findByText("Page one text", { selector: "svg text" })).closest("svg")!;
    const toggle = within(dialog).getByRole("button", { name: "Fit page" });
    expect(svg.style.width).toBe("100%");
    fireEvent.click(toggle);
    expect(svg.style.width).toBe("auto");
    expect(svg.style.height).toMatch(/^calc\(100vh/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Fit width" }));
    expect(svg.style.width).toBe("100%");
    expect(svg.style.height).toBe("auto");
  });

  it("falls back to the text view when the page cannot be drawn", async () => {
    const { ctx } = await setup();
    // Readable text, but no page tree for the renderer to walk.
    await savePdf(ctx, "2026-10-31", withoutPageTree(pdfBytes()));
    renderPage(PayslipsPage, ctx);
    const view = await screen.findByLabelText("View payslip 2026-10-31");
    await waitFor(() => expect((view as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(view);

    const dialog = await screen.findByRole("dialog");
    const text = await within(dialog).findByText(NET_PAY);
    expect(text.tagName).toBe("PRE");
    expect(text.className).toMatch(/font-mono/);
    expect(text.style.overflow).toBe("auto");
    expect(text.style.maxHeight).not.toBe("");
    expect(text.textContent).toContain("Total Payments");
    expect(dialog.querySelector("svg text")).toBeNull();
  });

  async function openViewer(bytes: Uint8Array) {
    const { ctx } = await setup();
    await savePdf(ctx, "2026-10-31", bytes);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PayslipViewer ctx={ctx} payDate="2026-10-31" onClose={() => {}} />
      </QueryClientProvider>,
    );
    return { client, dialog: await screen.findByRole("dialog") };
  }

  it("draws every page of the PDF, stacked, not only the first", async () => {
    const { dialog } = await openViewer(writePdf([["Page one text"], ["Page two text"]]));
    await within(dialog).findByText("Page two text", { selector: "svg text" });
    const svgs = dialog.querySelectorAll("svg[role='img']");
    expect(svgs).toHaveLength(2);
    expect(svgs[0]!.textContent).toBe("Page one text");
    expect(svgs[1]!.textContent).toBe("Page two text");
    expect(dialog.querySelector("pre")).toBeNull();
  });

  it("falls back to the text when the drawing has no text at all but the PDF does (text in a Form XObject)", async () => {
    const page = rawPdf(["/Fm1 Do"]);
    const form = withXObject(page, "Fm1", "/Type /XObject /Subtype /Form /BBox [0 0 595 842]", lineContent(["Text inside a form"]));
    const { dialog } = await openViewer(form);
    const text = await within(dialog).findByText(/Text inside a form/);
    expect(text.tagName).toBe("PRE");
    expect(dialog.querySelector("svg text")).toBeNull();
  });

  it("keeps the stored page's drawing for good: no refetch, no retry", async () => {
    const { client, dialog } = await openViewer(writePdf([["Only page"]]));
    await within(dialog).findByText("Only page", { selector: "svg text" });
    const drawing = client.getQueryCache().getAll().find((q) => q.queryKey.includes("pdf-render"));
    expect(drawing!.isStale()).toBe(false);
    expect(drawing!.options.retry).toBe(false);
  });

  it("downloads from the row with the stored bytes and the file name", async () => {
    const { ctx, openSaveDialog, bytes } = await withStoredPdf();
    renderPage(PayslipsPage, ctx);
    const download = await screen.findByLabelText("Download payslip 2026-10-31");
    await waitFor(() => expect((download as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(download);
    await waitFor(() => expect(openSaveDialog).toHaveBeenCalledTimes(1));
    expect(openSaveDialog).toHaveBeenCalledWith(bytes, "payslip-2026-10-31.pdf");
  });

  it("downloads from the viewer too", async () => {
    const { ctx, openSaveDialog, bytes } = await withStoredPdf();
    renderPage(PayslipsPage, ctx);
    const view = await screen.findByLabelText("View payslip 2026-10-31");
    await waitFor(() => expect((view as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(view);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Download" }));
    await waitFor(() => expect(openSaveDialog).toHaveBeenCalledWith(bytes, "payslip-2026-10-31.pdf"));
  });

  it("shows a failed download inline", async () => {
    const { ctx, openSaveDialog } = await withStoredPdf();
    openSaveDialog.mockRejectedValue(new Error("Disk is full"));
    renderPage(PayslipsPage, ctx);
    const download = await screen.findByLabelText("Download payslip 2026-10-31");
    await waitFor(() => expect((download as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(download);
    expect(await screen.findByText("Disk is full")).toBeTruthy();
  });

  it("deleting a payslip removes its stored PDF", async () => {
    const { ctx } = await withStoredPdf();
    renderPage(PayslipsPage, ctx);
    fireEvent.click(await screen.findByLabelText("Delete payslip 2026-10-31"));
    fireEvent.click(screen.getByText("Confirm delete"));
    await waitFor(() => expect(screen.getByText("No payslips yet. Import a PDF above.")).toBeTruthy());
    expect(await loadPdf(ctx, "2026-10-31")).toBeNull();
    expect(await listPdfDates(ctx)).toEqual([]);
  });
});

describe("tax page", () => {
  it("shows the tax year's figures, rates, year to date and the months with no payslip", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T09:00:00Z") });
    const { ctx } = await setup();
    renderPage(TaxPage, ctx);

    await waitFor(() => expect(screen.getByText("Gross before USS")).toBeTruthy());
    expect(screen.getByText("£3,000.00")).toBeTruthy();
    expect(screen.getByText("£183.00")).toBeTruthy();
    expect(screen.getByText("£380.00")).toBeTruthy();
    expect(screen.getByText("£150.00")).toBeTruthy();
    expect(screen.getByText("£2,287.00")).toBeTruthy();
    expect(screen.getByText("£0.00")).toBeTruthy(); // student loan
    expect(screen.getByText(/income tax 12\.7%, NI 5\.0%, all deductions 17\.7%/)).toBeTruthy();
    expect(screen.getByText(/paid 2026-10-31/)).toBeTruthy();
    expect(screen.getAllByText("£19,719.00")).toHaveLength(2); // year to date gross and taxable pay
    expect(screen.getByText("£2,660.00")).toBeTruthy(); // year to date tax

    // 10 November is tax month 8: only month 7 has a payslip.
    expect(screen.getByText("Months with no payslip")).toBeTruthy();
    for (const m of [1, 2, 3, 4, 5, 6, 8]) expect(screen.getByText(`(month ${m})`)).toBeTruthy();
    expect(screen.queryByText("(month 7)")).toBeNull();
    expect(screen.queryByText("(month 9)")).toBeNull();
  });

  it("shows expense refunds as their own tile, apart from gross before USS, only when there are some", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T09:00:00Z") });
    const withExpenses: Payslip = {
      ...parsePayslipLines(
        samplePayslipLines({ payments: ["Salary 3000.00", "USS(CRB) 16 SS 183.00-", "Gen Trav & Sub 45.50", "Telephone Costs 20.00"] }),
      ),
      warnings: [],
      importedAt: "2026-11-02T09:00:00.000Z",
    };
    const { ctx } = await setup({ payslips: [withExpenses] });
    renderPage(TaxPage, ctx);
    await waitFor(() => expect(screen.getByText("Expense refunds")).toBeTruthy());
    expect(screen.getByText("£65.50")).toBeTruthy();
    expect(screen.getByText("£3,000.00")).toBeTruthy(); // gross before USS, without the refunds
    expect(screen.getByText("£2,352.50")).toBeTruthy(); // net pay, with them
  });

  it("has no expense refunds tile without any", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T09:00:00Z") });
    const { ctx } = await setup();
    renderPage(TaxPage, ctx);
    await waitFor(() => expect(screen.getByText("Gross before USS")).toBeTruthy());
    expect(screen.queryByText("Expense refunds")).toBeNull();
  });

  it("explains an empty add-on", async () => {
    const { ctx } = await setup({ payslips: [] });
    renderPage(TaxPage, ctx);
    await waitFor(() => expect(screen.getByText(/No payslips yet/)).toBeTruthy());
  });
});

describe("pension page", () => {
  it("adds a statement, shows the USS total and the labelled DB estimate, and deletes it", async () => {
    const { ctx } = await setup();
    renderPage(PensionPage, ctx);

    await waitFor(() => expect(screen.getByText("2026/27")).toBeTruthy());
    expect(screen.getAllByText("£183.00").length).toBe(2); // the year and the total
    expect(screen.getByText(/Add retirement income \/ Add pension fund/)).toBeTruthy();

    fireEvent.click(screen.getByText("Add statement"));
    await waitFor(() => expect(screen.getByText("Enter the statement date.")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Statement date"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("DB annual pension (£)"), { target: { value: "2000" } });
    fireEvent.change(screen.getByLabelText("DB lump sum (£)"), { target: { value: "6000" } });
    fireEvent.change(screen.getByLabelText("DC pot (£, optional)"), { target: { value: "1500.50" } });
    fireEvent.click(screen.getByText("Add statement"));

    await waitFor(() =>
      expect(
        screen.getByText(
          "Illustrative DB capital value: £46,000.00 — estimate (pension × 20 + lump sum), not included in your net worth",
        ),
      ).toBeTruthy(),
    );
    expect(await loadStatements(ctx)).toEqual([{ date: "2026-09-01", dbPension: 2000, dbLumpSum: 6000, dcPot: 1500.5 }]);
    expect(screen.getByText("£1,500.50", { selector: "dd" })).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Delete statement 2026-09-01"));
    await waitFor(() => expect(screen.getByText(/Add a statement below/)).toBeTruthy());
    expect(await loadStatements(ctx)).toEqual([]);
  });
});

describe("settings page", () => {
  it("offers the GBP cash accounts, the match window and the spending caveat", async () => {
    const { ctx } = await setup();
    renderPage(SettingsPage, ctx);

    await waitFor(() => expect(screen.getByText("Current Account")).toBeTruthy());
    expect(screen.getByLabelText(/Match window/)).toHaveProperty("value", "4");
    expect(
      screen.getByText(
        "Keep the Payroll account switched off for Spending in Wealthfolio's settings. Linking turns the bank's salary deposit into a transfer, so Wealthfolio's spending report may no longer count it as income.",
      ),
    ).toBeTruthy();
    // Off by default: no preview or record buttons.
    expect(screen.queryByText("Preview")).toBeNull();
    expect(screen.queryByText("Record in Wealthfolio")).toBeNull();
  });

  it("rejects a match window outside 1 to 10 days", async () => {
    const { ctx } = await setup();
    renderPage(SettingsPage, ctx);
    const input = await screen.findByLabelText(/Match window/);
    fireEvent.change(input, { target: { value: "11" } });
    expect(screen.getByText(/whole number of days from 1 to 10/)).toBeTruthy();
    expect(screen.getByText("Save").closest("button")?.disabled).toBe(true);
  });

  it("previews the payroll rows first, writes only on Record, and shows the outcome", async () => {
    const { host, ctx } = await setup();
    renderPage(SettingsPage, ctx);
    await screen.findByText("Current Account");
    // One checkbox per GBP cash account, then the payroll switch.
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[1]!);

    const preview = await screen.findByText("Preview");
    const record = screen.getByText("Record in Wealthfolio").closest("button")!;
    expect(record.disabled).toBe(true);

    fireEvent.click(preview);
    await waitFor(() => expect(screen.getByText("Payroll (new)")).toBeTruthy());
    expect(screen.getAllByText("TRANSFER_OUT").length).toBe(1);
    expect(screen.getByText(/DEPOSIT becomes TRANSFER_IN/)).toBeTruthy();
    expect(host.accounts).toHaveLength(1); // nothing written yet
    expect(host.rows("acc-1")[0]?.activityType).toBe("DEPOSIT");
    expect(record.disabled).toBe(false);

    fireEvent.click(record);
    await waitFor(() => expect(screen.getByText("Payroll recorded")).toBeTruthy());
    expect(screen.getByText("4 rows stored")).toBeTruthy();
    expect(screen.getByText("1 bank deposits linked")).toBeTruthy();
    expect(host.accounts.map((a) => a.name)).toEqual(["Current Account", "Payroll"]);
    expect(host.rows("acc-1")[0]?.activityType).toBe("TRANSFER_IN");
    expect(host.links).toHaveLength(1);
    expect(screen.getByText("Record in Wealthfolio").closest("button")?.disabled).toBe(true);
  });

  /** Switches the payroll tools on (the second checkbox) and returns the Preview / Record buttons. */
  async function openPayrollTools() {
    await screen.findByText("Current Account");
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    const preview = await screen.findByText("Preview");
    return { preview, record: () => screen.getByText("Record in Wealthfolio").closest("button")! };
  }

  // Same net pay as the sample payslip (2287), but another tax figure and a student loan line.
  const corrected = (): Payslip => ({
    ...parsePayslipLines(samplePayslipLines({ deductions: ["Tax paid 330.00", "Employee NIC 150.00", "Student Loan 50.00"] })),
    warnings: [],
    importedAt: "2026-11-03T09:00:00.000Z",
  });

  it("says each payslip is new, and after recording it unchanged", async () => {
    const { ctx } = await setup();
    renderPage(SettingsPage, ctx);
    const { preview, record } = await openPayrollTools();
    fireEvent.click(preview);
    await screen.findByText("2026-10-31: new");
    fireEvent.click(record());
    await screen.findByText("Payroll recorded");

    fireEvent.click(screen.getByText("Preview"));
    await screen.findByText("2026-10-31: unchanged (already recorded)");
  });

  it("tells the user a corrected payslip will replace the rows already recorded", async () => {
    const { host, ctx } = await setup();
    const original = payslip();
    const matches = matchSalaries([original], await loadCandidateRows(ctx, ["acc-1"]), 4, {});
    await recordPayroll(ctx, [original], matches, 4);
    await savePayslips(ctx, [corrected()]);

    renderPage(SettingsPage, ctx);
    const { preview, record } = await openPayrollTools();
    fireEvent.click(preview);
    await screen.findByText("2026-10-31: changed — 4 rows will be replaced");
    expect(host.rows(host.accounts.find((a) => a.name === "Payroll")!.id)).toHaveLength(4); // nothing written by previewing

    fireEvent.click(record());
    await screen.findByText("Payroll recorded");
    expect(screen.getByText("1 payslip replaced")).toBeTruthy();
    const rows = host.rows(host.accounts.find((a) => a.name === "Payroll")!.id);
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.activityType === "TRANSFER_OUT")).toHaveLength(1);
  });

  it("warns that a deposit a penny off the net pay will not be linked", async () => {
    const { ctx } = await setup({ deposits: [deposit({ amount: 2287.01 })] });
    renderPage(SettingsPage, ctx);
    const { preview } = await openPayrollTools();
    fireEvent.click(preview);
    await screen.findByText(/won't be linked \(amount differs by a penny\)/);
    expect(screen.queryByText(/DEPOSIT becomes TRANSFER_IN/)).toBeNull();
  });

  it("reports why a matched deposit could not be linked after recording", async () => {
    const { ctx } = await setup({ deposits: [deposit({ amount: 2287.01 })] });
    renderPage(SettingsPage, ctx);
    const { preview, record } = await openPayrollTools();
    fireEvent.click(preview);
    await screen.findByText(/won't be linked/);
    fireEvent.click(record());
    await screen.findByText(/deposit of £2,287\.01 differs from net pay £2,287\.00 by a penny; not linked/);
    expect(screen.getByText("0 bank deposits linked")).toBeTruthy();
  });

  it("drops the preview, and disables Record, when the data changes after it", async () => {
    const { host, ctx } = await setup();
    const view = renderPage(SettingsPage, ctx);
    const { preview, record } = await openPayrollTools();
    fireEvent.click(preview);
    await screen.findByText("2026-10-31: new");
    expect(record().disabled).toBe(false);

    // A payslip is corrected elsewhere and the page's data is refetched.
    await savePayslips(ctx, [corrected()]);
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ["payslips"] });
    });
    await waitFor(() => expect(record().disabled).toBe(true));
    expect(screen.queryByText("2026-10-31: new")).toBeNull();
    expect(screen.getByText(/changed since the preview/i)).toBeTruthy();
    expect(host.accounts).toHaveLength(1); // nothing was written

    // A new preview shows what will be recorded now, and Record writes that.
    fireEvent.click(screen.getByText("Preview"));
    await screen.findByText("2026-10-31: new");
    fireEvent.click(record());
    await screen.findByText("Payroll recorded");
    const rows = host.rows(host.accounts.find((a) => a.name === "Payroll")!.id);
    expect(rows.map((r) => r.comment ?? "").some((c) => c.includes(":ded:student-loan]"))).toBe(true);
  });
});

describe("settings page: stored PDFs", () => {
  it("shows how many PDFs are kept and lets the user stop keeping them", async () => {
    const { ctx } = await setup();
    await savePdf(ctx, "2026-10-31", new Uint8Array([1]));
    await savePdf(ctx, "2026-09-30", new Uint8Array([2]));
    renderPage(SettingsPage, ctx);

    expect(await screen.findByText("Stored PDFs")).toBeTruthy();
    expect(await screen.findByText("2 PDFs stored")).toBeTruthy();
    const keep = screen.getByRole("switch", { name: "Keep a copy of each payslip PDF" });
    expect(keep.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(keep);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Keep a copy of each payslip PDF" }).getAttribute("aria-checked")).toBe("false"));
    expect(await getKeepPdfs(ctx)).toBe(false);
    expect(await listPdfDates(ctx)).toHaveLength(2); // turning it off removes nothing
  });

  it("removes all stored PDFs only after a second click", async () => {
    const { ctx } = await setup();
    await savePdf(ctx, "2026-10-31", new Uint8Array([1]));
    renderPage(SettingsPage, ctx);
    expect(await screen.findByText("1 PDF stored")).toBeTruthy();

    fireEvent.click(screen.getByText("Remove all stored PDFs"));
    expect(await listPdfDates(ctx)).toEqual(["2026-10-31"]);
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Confirm remove all")).toBeNull();
    expect(await listPdfDates(ctx)).toEqual(["2026-10-31"]);

    fireEvent.click(screen.getByText("Remove all stored PDFs"));
    fireEvent.click(screen.getByText("Confirm remove all"));
    await waitFor(() => expect(screen.getByText("No PDFs stored")).toBeTruthy());
    expect(await listPdfDates(ctx)).toEqual([]);
    expect(await loadPdf(ctx, "2026-10-31")).toBeNull();
    expect(await loadPayslips(ctx)).toHaveLength(1); // the payslips stay
    expect((screen.getByText("Remove all stored PDFs").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });
});

/** Three payslips with different figures, in two tax years and two calendar years. */
const sampleSlip = (payDate: string, period: string, salary: number, uss: number, tax: number, ni: number): Payslip => ({
  ...parsePayslipLines(
    samplePayslipLines({
      payDate,
      period,
      payments: [`Salary ${salary.toFixed(2)}`, `USS(CRB) 16 SS ${uss.toFixed(2)}-`],
      deductions: [`Tax paid ${tax.toFixed(2)}`, `Employee NIC ${ni.toFixed(2)}`],
    }),
  ),
  warnings: [],
  importedAt: "2026-11-02T09:00:00.000Z",
});
// net: 1500 - 100 - 300 - 90 = 1010 | 4000 - 200 - 700 - 250 = 2850 | 3000 - 183 - 380 - 150 = 2287
const nov25 = () => sampleSlip("30.11.2025", "08/2025", 1500, 100, 300, 90); // tax 2025/26, calendar 2025
const jan26 = () => sampleSlip("30.01.2026", "10/2025", 4000, 200, 700, 250); // tax 2025/26, calendar 2026
const oct26 = () => sampleSlip("30.10.2026", "07/2026", 3000, 183, 380, 150); // tax 2026/27, calendar 2026
const threeSlips = () => [oct26(), nov25(), jan26()];

const tableOf = () => screen.getByRole("table") as HTMLTableElement;
const bodyRows = () => [...tableOf().querySelectorAll("tbody tr")] as HTMLTableRowElement[];
const payDates = () => bodyRows().map((r) => r.querySelector("td")!.textContent);

describe("payslips page: table columns", () => {
  it("gives every row one cell per header, and a header and its cells the same alignment", async () => {
    const { ctx } = await setup({ payslips: threeSlips() });
    renderPage(PayslipsPage, ctx);
    await waitFor(() => expect(bodyRows()).toHaveLength(1)); // the default period is the latest tax year
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "range" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2025-01-01" } });
    await waitFor(() => expect(bodyRows()).toHaveLength(3));

    const headers = [...tableOf().querySelectorAll("thead th")] as HTMLElement[];
    const expected = ["left", "left", "right", "right", "right", "right", "right", "left", "left", "right"];
    expect(headers).toHaveLength(expected.length);
    for (const row of bodyRows()) expect(row.querySelectorAll("td")).toHaveLength(headers.length);

    headers.forEach((th, i) => {
      expect(th.style.textAlign, `header ${i} (${th.textContent})`).toBe(expected[i]);
      for (const row of bodyRows()) {
        const td = row.querySelectorAll("td")[i]!;
        expect(td.style.textAlign, `cell ${i} of ${row.querySelector("td")!.textContent}`).toBe(expected[i]);
        if (i >= 2 && i <= 6) {
          expect(td.style.fontVariantNumeric).toBe("tabular-nums");
          expect(td.style.whiteSpace).toBe("nowrap");
        }
      }
    });
  });
});

describe("payslips page: sorting", () => {
  const netsShown = () => bodyRows().map((r) => r.querySelectorAll("td")[6]!.textContent);
  const rangeAll = async () => {
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "range" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2025-01-01" } });
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
  };

  it("starts with the newest pay date first, marked on its header", async () => {
    const { ctx } = await setup({ payslips: threeSlips() });
    renderPage(PayslipsPage, ctx);
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    await rangeAll();
    expect(payDates()).toEqual(["2026-10-30", "2026-01-30", "2025-11-30"]);
    const head = screen.getByRole("columnheader", { name: /Pay date/ });
    expect(head.getAttribute("aria-sort")).toBe("descending");
    expect(head.textContent).toContain("▼");
    expect(screen.getByRole("columnheader", { name: /Net/ }).getAttribute("aria-sort")).toBe("none");
  });

  it("sorts by Net ascending on the first click and descending on the second", async () => {
    const { ctx } = await setup({ payslips: threeSlips() });
    renderPage(PayslipsPage, ctx);
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    await rangeAll();

    fireEvent.click(screen.getByRole("button", { name: "Net" }));
    expect(netsShown()).toEqual(["£1,010.00", "£2,287.00", "£2,850.00"]);
    expect(screen.getByRole("columnheader", { name: /Net/ }).getAttribute("aria-sort")).toBe("ascending");
    expect(screen.getByRole("columnheader", { name: /Net/ }).textContent).toContain("▲");
    expect(screen.getByRole("columnheader", { name: /Pay date/ }).getAttribute("aria-sort")).toBe("none");
    expect(screen.getByRole("columnheader", { name: /Pay date/ }).textContent).not.toMatch(/[▲▼]/);

    fireEvent.click(screen.getByRole("button", { name: "Net" }));
    expect(netsShown()).toEqual(["£2,850.00", "£2,287.00", "£1,010.00"]);
    expect(screen.getByRole("columnheader", { name: /Net/ }).getAttribute("aria-sort")).toBe("descending");
    expect(screen.getByRole("columnheader", { name: /Net/ }).textContent).toContain("▼");
  });

  it("sorts by the other columns too", async () => {
    const { ctx } = await setup({ payslips: threeSlips() });
    renderPage(PayslipsPage, ctx);
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    await rangeAll();

    fireEvent.click(screen.getByRole("button", { name: "Gross before USS" }));
    expect(payDates()).toEqual(["2025-11-30", "2026-10-30", "2026-01-30"]);
    fireEvent.click(screen.getByRole("button", { name: "Pay date" })); // from another column: ascending
    expect(payDates()).toEqual(["2025-11-30", "2026-01-30", "2026-10-30"]);
    fireEvent.click(screen.getByRole("button", { name: "Pay date" }));
    expect(payDates()).toEqual(["2026-10-30", "2026-01-30", "2025-11-30"]);
  });
});

describe("period picker", () => {
  const pick = (mode: string) => fireEvent.change(screen.getByLabelText("Period"), { target: { value: mode } });

  it("shows the latest tax year first, and picks another tax year", async () => {
    const { ctx } = await setup({ payslips: threeSlips() });
    renderPage(PayslipsPage, ctx);
    await waitFor(() => expect(payDates()).toEqual(["2026-10-30"]));
    expect((screen.getByLabelText("Tax year") as HTMLSelectElement).value).toBe("2026");
    fireEvent.change(screen.getByLabelText("Tax year"), { target: { value: "2025" } });
    expect(payDates()).toEqual(["2026-01-30", "2025-11-30"]);
  });

  it("switches to a calendar year, listing the years that have payslips", async () => {
    const { ctx } = await setup({ payslips: threeSlips() });
    renderPage(PayslipsPage, ctx);
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    pick("calendar");
    const year = screen.getByLabelText("Calendar year") as HTMLSelectElement;
    expect([...year.options].map((o) => o.value)).toEqual(["2026", "2025"]);
    expect(year.value).toBe("2026");
    expect(payDates()).toEqual(["2026-10-30", "2026-01-30"]); // two tax years in one calendar year
    fireEvent.change(year, { target: { value: "2025" } });
    expect(payDates()).toEqual(["2025-11-30"]);
  });

  it("filters by a custom range, both dates included, starting from the dates of the period it replaces", async () => {
    const { ctx } = await setup({ payslips: threeSlips() });
    renderPage(PayslipsPage, ctx);
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    pick("range");
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-04-06");
    expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe("2027-04-05");
    expect((screen.getByLabelText("From") as HTMLInputElement).type).toBe("date");

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2025-11-30" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-01-30" } });
    expect(payDates()).toEqual(["2026-01-30", "2025-11-30"]);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2025-12-01" } });
    expect(payDates()).toEqual(["2026-01-30"]);
  });

  it("says so when the range holds no payslip", async () => {
    const { ctx } = await setup({ payslips: threeSlips() });
    renderPage(PayslipsPage, ctx);
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    pick("range");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2030-01-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2030-12-31" } });
    expect(screen.getByText(/No payslips in 2030-01-01 to 2030-12-31/)).toBeTruthy();
    expect(screen.getByLabelText("From")).toBeTruthy(); // the picker stays, so the dates can be changed
  });
});

describe("tax page: period", () => {
  const pick = (mode: string) => fireEvent.change(screen.getByLabelText("Period"), { target: { value: mode } });
  const today = () => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T09:00:00Z") });

  it("keeps the year to date for a tax year only", async () => {
    today();
    const { ctx } = await setup({ payslips: threeSlips() });
    renderPage(TaxPage, ctx);
    await waitFor(() => expect(screen.getByText("1 payslip in 2026/27")).toBeTruthy());
    expect(screen.getByText("Year to date")).toBeTruthy();

    pick("calendar");
    expect(screen.getByText("2 payslips in 2026")).toBeTruthy();
    expect(screen.queryByText("Year to date")).toBeNull();
    pick("range");
    expect(screen.queryByText("Year to date")).toBeNull();
  });

  it("totals a calendar year over two tax years and lists its missing months", async () => {
    today();
    const { ctx } = await setup({ payslips: threeSlips() });
    renderPage(TaxPage, ctx);
    await waitFor(() => expect(screen.getByText("1 payslip in 2026/27")).toBeTruthy());
    pick("calendar");

    expect(screen.getByText("£7,000.00")).toBeTruthy(); // gross before USS: 4000 + 3000
    expect(screen.getByText("£383.00")).toBeTruthy(); // USS: 200 + 183
    expect(screen.getByText("£1,080.00")).toBeTruthy(); // tax: 700 + 380
    expect(screen.getByText("£5,137.00")).toBeTruthy(); // net: 2850 + 2287
    // To 10 November 2026: Feb-Sep and Nov have no payslip; January and October do.
    for (const m of ["Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Nov"]) expect(screen.getByText(`${m} 2026`)).toBeTruthy();
    expect(screen.queryByText("Jan 2026")).toBeNull();
    expect(screen.queryByText("Oct 2026")).toBeNull();
    expect(screen.queryByText("Dec 2026")).toBeNull();
  });

  it("totals a custom range", async () => {
    today();
    const { ctx } = await setup({ payslips: threeSlips() });
    renderPage(TaxPage, ctx);
    await waitFor(() => expect(screen.getByText("1 payslip in 2026/27")).toBeTruthy());
    pick("range");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2025-11-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-01-31" } });

    expect(screen.getByText("2 payslips in 2025-11-01 to 2026-01-31")).toBeTruthy();
    expect(screen.getByText("£5,500.00")).toBeTruthy(); // gross before USS: 1500 + 4000
    expect(screen.getByText("£3,860.00")).toBeTruthy(); // net: 1010 + 2850
    // Nov, Dec and Jan are whole months in the range; only December has no payslip.
    expect(screen.getByText("Dec 2025")).toBeTruthy();
    expect(screen.queryByText("Nov 2025")).toBeNull();
    expect(screen.queryByText("Jan 2026")).toBeNull();
  });
});
