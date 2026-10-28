import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AddonContext, AddonRouteLocation } from "@wealthfolio/addon-sdk";
import { FakeWealthfolio, type StoredActivity } from "@wf-addons/kit/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Payslip } from "../lib/model";
import { parsePayslipLines } from "../lib/payslip-parser";
import { savePdf } from "../lib/pdf-store";
import { loadPayslips, savePayslips } from "../lib/store";
import { samplePayslipLines, writePdf } from "../test-utils";
import PayslipsPage from "./payslips-page";

beforeAll(() => {
  // Base UI's checkbox builds a PointerEvent on click; jsdom has none.
  window.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const WARNING = "Payments do not add up to Total Payments";

/** What an older parser stored for the synthetic payslip: empty lines and a false warning. */
const misread = (payDate = "31.10.2026", period = "07/2026"): Payslip => ({
  ...parsePayslipLines(samplePayslipLines({ payDate, period })),
  payments: [],
  deductions: [],
  warnings: [WARNING],
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

async function setup(opts: { payslips: Payslip[]; deposits?: StoredActivity[] }) {
  const host = new FakeWealthfolio([
    { id: "acc-1", name: "Current Account", currency: "GBP", accountType: "CASH", trackingMode: "TRANSACTIONS" },
  ]);
  host.stored.set("acc-1", opts.deposits ?? []);
  // The fake host has no navigation (nor router, nor files API).
  (host.ctx.api as unknown as Record<string, unknown>).navigation = { navigate: vi.fn() };
  (host.ctx.api as unknown as Record<string, unknown>).files = { openSaveDialog: vi.fn() };
  await savePayslips(host.ctx, opts.payslips);
  return host;
}

function renderPage(ctx: AddonContext) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PayslipsPage ctx={ctx} location={{} as AddonRouteLocation} />
    </QueryClientProvider>,
  );
}

describe("payslips page: Refresh", () => {
  it("re-reads a stored payslip from its PDF, and its warning disappears", async () => {
    const host = await setup({ payslips: [misread()] });
    await savePdf(host.ctx, "2026-10-31", new Uint8Array(writePdf([samplePayslipLines()])));
    renderPage(host.ctx);
    expect(await screen.findByText(WARNING, { selector: "li" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));

    expect(await screen.findByText("Re-read 1 payslip (0 unchanged).")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(WARNING, { selector: "li" })).toBeNull());
    expect(screen.getByText("OK")).toBeTruthy();
    expect((await loadPayslips(host.ctx))[0]!.payments.length).toBe(2);
  });

  it("matches a bank deposit added since the page loaded, without reloading", async () => {
    const host = await setup({ payslips: [misread()] });
    await savePdf(host.ctx, "2026-10-31", new Uint8Array(writePdf([samplePayslipLines()])));
    renderPage(host.ctx);
    expect(await screen.findByText("Missing")).toBeTruthy();

    host.stored.set("acc-1", [deposit()]);
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));

    expect(await screen.findByText("Matched")).toBeTruthy();
    expect(screen.queryByText("Missing")).toBeNull();
  });

  it("is disabled while it runs, then says what has no stored PDF and what failed", async () => {
    const host = await setup({
      payslips: [misread(), misread("30.11.2026", "08/2026"), misread("31.12.2026", "09/2026")],
    });
    await savePdf(host.ctx, "2026-10-31", new Uint8Array(writePdf([samplePayslipLines()])));
    // The PDF stored for 2026-11-30 is really the November one for 31.12.
    await savePdf(host.ctx, "2026-11-30", new Uint8Array(writePdf([samplePayslipLines({ payDate: "31.12.2026", period: "09/2026" })])));
    // Hold the first PDF read back, so the run is observable while it is in progress.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const storage = host.ctx.api.storage;
    const get = storage.get.bind(storage);
    storage.get = async (key: string) => {
      if (key.startsWith("pdf:2026")) await gate;
      return get(key);
    };
    renderPage(host.ctx);
    await screen.findByText("2026-10-31", { selector: "td" });

    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    expect(((await screen.findByRole("button", { name: /Refreshing/ })) as HTMLButtonElement).disabled).toBe(true);
    release();

    expect(await screen.findByText("Re-read 1 payslip (0 unchanged). 1 has no stored PDF — import it again to update.")).toBeTruthy();
    expect(
      screen.getByText((_, el) => el?.tagName === "LI" && el.textContent === "2026-11-30: the stored PDF is for 2026-12-31"),
    ).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Refresh/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
