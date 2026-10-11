import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AddonRouteLocation } from "@wealthfolio/addon-sdk";
import { runExclusive } from "../lib/busy";
import CsvImportPage from "./csv-import-page";
import { makeCtx } from "../test-utils";

const HEADER =
  "Transaction ID,Date,Time,Type,Name,Emoji,Category,Amount,Currency,Local amount,Local currency,Notes and #tags,Address,Receipt,Description,Category split,Money Out,Money In";
const row = (id: string, amount: string, category = "Eating out") =>
  `${id},05/03/2026,14:30:00,Card payment,Cafe,,${category},${amount},GBP,${amount},GBP,,,,CAFE,,${amount},`;
const rowWithNotes = (id: string, amount: string, notes: string) =>
  `${id},05/03/2026,14:30:00,Card payment,Cafe,,Eating out,${amount},GBP,${amount},GBP,${notes},,,CAFE,,${amount},`;
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");

function renderPage() {
  const t = makeCtx({
    wfAccounts: [
      { id: "wf-1", name: "Current" },
      { id: "wf-2", name: "Flex" },
    ],
  });
  (t.ctx.api as unknown as { navigation: unknown }).navigation = { navigate: vi.fn() };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <CsvImportPage ctx={t.ctx} location={{} as AddonRouteLocation} />
    </QueryClientProvider>,
  );
  const input = utils.container.querySelector('input[type="file"]') as HTMLInputElement;
  return { ...t, input };
}

describe("CsvImportPage", () => {
  it("lists several files, each with its own account, and imports them into the right accounts", async () => {
    const { input, importCalls } = renderPage();
    expect(input.multiple).toBe(true);

    const files = [
      new File([csv(row("tx_a1", "-1.00"), row("tx_a2", "-2.00", "Transfers"))], "current.csv"),
      new File([csv(row("tx_b1", "-3.00"))], "flex.csv"),
      new File(["not a monzo export"], "junk.csv"),
    ];
    fireEvent.change(input, { target: { files } });

    await screen.findByText("current.csv");
    expect(screen.getByText("flex.csv")).toBeTruthy();
    expect(screen.getByText(/Parsed 2 transactions · 1 to import/)).toBeTruthy();
    expect(screen.getByText(/Parsed 1 transaction · 1 to import/)).toBeTruthy();
    expect(screen.getByText(/No Monzo transactions found/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Import/ }) as HTMLButtonElement).disabled).toBe(true);

    await waitFor(() => expect(screen.getAllByRole("option", { name: "Flex" })).toHaveLength(2));
    fireEvent.change(screen.getByLabelText("Target account for current.csv"), { target: { value: "wf-1" } });
    fireEvent.change(screen.getByLabelText("Target account for flex.csv"), { target: { value: "wf-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Import 2 transactions from 2 files" }));

    await screen.findAllByText("1 imported");
    expect(importCalls.map((c) => [c[0].accountId, c.length])).toEqual([
      ["wf-1", 1],
      ["wf-2", 1],
    ]);
  });
  const choose = (input: HTMLInputElement, ...files: File[]) => fireEvent.change(input, { target: { files } });
  const accountSelects = () => screen.getAllByRole("combobox") as HTMLSelectElement[];

  it("gives a different file with the same name its own row and no account, but lets the same file replace its row", async () => {
    const { input } = renderPage();
    const current = () => new File([csv(row("tx_c1", "-1.00"))], "export.csv", { lastModified: 1000 });
    choose(input, current());
    await screen.findByText("export.csv");
    await waitFor(() => expect(screen.getAllByRole("option", { name: "Flex" })).toHaveLength(1));
    fireEvent.change(accountSelects()[0], { target: { value: "wf-1" } });

    // A different file (another folder) with the same name.
    choose(input, new File([csv(row("tx_j1", "-2.00"), row("tx_j2", "-3.00"))], "export.csv", { lastModified: 2000 }));
    await waitFor(() => expect(accountSelects()).toHaveLength(2));
    expect(accountSelects().map((x) => x.value)).toEqual(["wf-1", ""]);
    expect(screen.getAllByText(/^export\.csv \(/)).toHaveLength(2);

    // Choosing the very same file again replaces its row (and keeps its account).
    choose(input, current());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(accountSelects().map((x) => x.value)).toEqual(["wf-1", ""]);
  });

  it("says which listed files were not imported, and shows how many rows were updated", async () => {
    const { input, importCalls } = renderPage();
    choose(
      input,
      new File([csv(row("tx_a1", "-1.00"))], "with-account.csv"),
      new File([csv(row("tx_b1", "-2.00"))], "no-account.csv"),
    );
    await screen.findByText("with-account.csv");
    await waitFor(() => expect(screen.getAllByRole("option", { name: "Flex" })).toHaveLength(2));
    fireEvent.change(screen.getByLabelText("Target account for with-account.csv"), { target: { value: "wf-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Import 1 transaction from 1 file" }));
    await screen.findByText("1 imported");
    // Listed once in the options and once in the results.
    expect(screen.getAllByText("no-account.csv")).toHaveLength(2);
    expect(screen.getByText("Not imported: no target account chosen.")).toBeTruthy();
    expect(importCalls).toHaveLength(1);

    // The same transaction with a new note: the earlier row is rewritten, not imported again.
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    choose(input, new File([csv(rowWithNotes("tx_a1", "-1.00", "split with Sam"))], "again.csv"));
    await screen.findByText("again.csv");
    fireEvent.change(screen.getByLabelText("Target account for again.csv"), { target: { value: "wf-1" } });
    fireEvent.click(screen.getByRole("button", { name: /^Import/ }));
    await screen.findByText("1 updated");
    expect(screen.getByText("0 imported")).toBeTruthy();
    expect(importCalls).toHaveLength(1);
  });

  it("locks the controls while a sync or another import is running", async () => {
    const { input } = renderPage();
    choose(input, new File([csv(row("tx_a1", "-1.00"))], "a.csv"));
    await screen.findByText("a.csv");
    await waitFor(() => expect(screen.getAllByRole("option", { name: "Flex" })).toHaveLength(1));
    fireEvent.change(accountSelects()[0], { target: { value: "wf-1" } });
    const controls = () => [
      screen.getByRole("button", { name: /^Import/ }),
      screen.getByRole("button", { name: "Choose CSV files" }),
      screen.getByRole("button", { name: "Remove" }),
      screen.getByRole("checkbox"),
      accountSelects()[0],
    ] as HTMLButtonElement[];
    expect(controls().map((c) => c.disabled)).toEqual([false, false, false, false, false]);

    let release!: () => void;
    let running!: Promise<void>;
    act(() => {
      running = runExclusive(() => new Promise<void>((r) => (release = r)));
    });
    await waitFor(() => expect(controls().map((c) => c.disabled)).toEqual([true, true, true, true, true]));
    await act(async () => {
      release();
      await running;
    });
    await waitFor(() => expect(controls().map((c) => c.disabled)).toEqual([false, false, false, false, false]));
  });
});
