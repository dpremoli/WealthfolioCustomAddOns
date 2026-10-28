import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AddonContext, AddonRouteLocation } from "@wealthfolio/addon-sdk";
import { FakeWealthfolio, type StoredActivity } from "@wf-addons/kit/testing";
import type { ComponentType } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { samplePayslipLines, writePdf } from "../test-utils";
import { parsePayslipLines } from "../lib/payslip-parser";
import type { Payslip } from "../lib/model";
import { recordPayroll } from "../lib/payroll";
import { loadCandidateRows, matchSalaries } from "../lib/salary-match";
import { loadLinks, loadPayslips, loadStatements, savePayslips } from "../lib/store";
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
  await savePayslips(host.ctx, opts.payslips ?? [payslip()]);
  return { host, ctx: host.ctx, navigate };
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
    expect(screen.getByText(/read on this device only and never uploaded/i)).toBeTruthy();
    expect(screen.getByText(/Only figures, pay date, tax period and tax code are kept\./)).toBeTruthy();
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
