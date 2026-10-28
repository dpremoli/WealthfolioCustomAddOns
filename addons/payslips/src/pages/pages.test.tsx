import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AddonContext, AddonRouteLocation } from "@wealthfolio/addon-sdk";
import { FakeWealthfolio, type StoredActivity } from "@wf-addons/kit/testing";
import type { ComponentType } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { lineContent, rawPdf, samplePayslipLines, withoutPageTree, writePdf } from "../test-utils";
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
  // jsdom has no blob URLs; the PDF viewer makes one for the inline <object>.
  URL.createObjectURL = vi.fn(() => "blob:payslip-pdf");
  URL.revokeObjectURL = vi.fn();
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

  it("draws the payslip page as an SVG, then shows the original PDF tab", async () => {
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
    expect(within(dialog).getByRole("tab", { name: "Payslip" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(within(dialog).getByRole("tab", { name: "Original PDF" }));
    await waitFor(() => expect(dialog.querySelector("object")).toBeTruthy());
    const object = dialog.querySelector("object")!;
    expect(object.getAttribute("type")).toBe("application/pdf");
    expect(object.getAttribute("data")).toBe("blob:payslip-pdf");
    expect(object.textContent).toContain("Wealthfolio can't show the PDF inline here — use Download.");
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob;
    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBe(pdfBytes().length);
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
    expect(text.textContent).toContain("Total Payments");
    expect(dialog.querySelector("svg text")).toBeNull();
  });

  it("revokes the PDF's blob URL when the viewer closes", async () => {
    const { ctx } = await withStoredPdf();
    vi.mocked(URL.revokeObjectURL).mockClear();
    renderPage(PayslipsPage, ctx);
    const view = await screen.findByLabelText("View payslip 2026-10-31");
    await waitFor(() => expect((view as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(view);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("tab", { name: "Original PDF" }));
    await waitFor(() => expect(dialog.querySelector("object")).toBeTruthy());
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:payslip-pdf");
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
