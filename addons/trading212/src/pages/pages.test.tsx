import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AddonContext, AddonRouteLocation } from "@wealthfolio/addon-sdk";
import DashboardPage from "./dashboard-page";
import SettingsPage from "./settings-page";

function makeCtx(
  opts: { secrets?: [string, string][]; storage?: [string, string][]; accounts?: Record<string, unknown>[] } = {},
) {
  const secrets = new Map<string, string>(opts.secrets ?? []);
  const storage = new Map<string, string>(opts.storage ?? []);
  const kv = (m: Map<string, string>) => ({
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  });
  const request = vi.fn(async () => ({ status: 200, headers: {}, body: JSON.stringify({ id: 1, currency: "GBP" }) }));
  const ctx = {
    api: {
      secrets: kv(secrets),
      storage: kv(storage),
      network: { request },
      accounts: {
        getAll: async () =>
          opts.accounts ?? [{ id: "acc-1", providerAccountId: "1", trackingMode: "TRANSACTIONS" }],
        create: vi.fn(async (input: Record<string, unknown>) => ({ id: "wf-new", ...input })),
      },
      activities: {
        getAll: async () => [],
        import: vi.fn(async (rows: unknown[]) => ({ summary: { imported: rows.length, skipped: 0 } })),
      },
      navigation: { navigate: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
  } as unknown as AddonContext;
  return { ctx, secrets, storage, request };
}

function renderPage(Page: typeof DashboardPage, ctx: AddonContext) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Page ctx={ctx} location={{} as AddonRouteLocation} />
    </QueryClientProvider>,
  );
}

// A v1 install: keys + proxy URL in the keyring; one connection with key+secret, one legacy single key.
const V1 = (): [string, string][] => [
  ["t212_settings", JSON.stringify({ proxyUrl: "http://p", env: "demo" })],
  [
    "t212_connections",
    JSON.stringify([
      { id: "c1", name: "Invest", apiKey: "AKID1234", apiSecret: "shh", accountId: "acc-1" },
      { id: "c2", name: "Old ISA", apiKey: "LEGACY9876", accountId: "acc-2", kind: "isa" },
    ]),
  ],
];

describe("pages (smoke)", () => {
  it("settings: no proxy field, key ID + secret fields, flagged legacy connection surfaced", async () => {
    const { ctx, secrets } = makeCtx({ secrets: V1() });
    renderPage(SettingsPage, ctx);

    // Migrated connections render with masked last-4 and the legacy one is flagged.
    await waitFor(() => expect(screen.getByText("Old ISA")).toBeTruthy());
    expect(screen.getByText("••••1234")).toBeTruthy();
    expect(screen.getByText("••••9876")).toBeTruthy();
    expect(screen.getAllByText(/Needs credentials/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/single API key, which can no longer be used/i)).toBeTruthy();

    expect(screen.queryByText(/proxy url/i)).toBeNull();
    expect(screen.getAllByText("API key ID").length).toBeGreaterThan(0);
    expect(screen.getAllByText("API secret").length).toBeGreaterThan(0);

    // Credentials were moved to the per-connection secret; nothing else is left in the keyring.
    expect(secrets.get("t212_auth_c1")).toBe(btoa("AKID1234:shh"));
    expect(secrets.has("t212_connections")).toBe(false);
  });

  it("settings: updating a flagged connection's credentials verifies then clears the flag", async () => {
    const { ctx, secrets, storage, request } = makeCtx({ secrets: V1() });
    renderPage(SettingsPage, ctx);
    await waitFor(() => expect(screen.getByText("Old ISA")).toBeTruthy());

    // The flagged row opens its credentials form automatically; the add form has the same labels.
    const keyInputs = screen.getAllByPlaceholderText("API key ID");
    const secretInputs = screen.getAllByPlaceholderText("API secret");
    fireEvent.change(keyInputs[0], { target: { value: "NEWKEY5555" } });
    fireEvent.change(secretInputs[0], { target: { value: "newsecret" } });
    fireEvent.click(screen.getByText("Verify & save"));

    await waitFor(() => expect(secrets.get("t212_auth_c2")).toBe(btoa("NEWKEY5555:newsecret")));
    const conns = JSON.parse(storage.get("t212_connections")!);
    expect(conns.find((c: { id: string }) => c.id === "c2")).toMatchObject({ keyIdLast4: "5555" });
    expect(conns.find((c: { id: string }) => c.id === "c2").needsCredentials).toBeUndefined();
    expect(secrets.has("t212_auth_pending_c2")).toBe(false);
    // Verified against the live API via the broker with the temporary secret.
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { type: "basic", secretKey: "t212_auth_pending_c2" } }),
    );
  });

  it("dashboard: banners connections that need credentials and cards render", async () => {
    const { ctx } = makeCtx({ secrets: V1() });
    renderPage(DashboardPage, ctx);

    await waitFor(() => expect(screen.getByText("Old ISA")).toBeTruthy());
    // Both the page banner and the connection card tell the user to re-enter credentials.
    expect(screen.getAllByText(/re-enter the API key\s+ID and secret in Settings/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Invest").length).toBeGreaterThan(0);
  });

  it("settings: the Cash ISA is added from several CSV exports, with no API key fields", async () => {
    const { ctx, storage } = makeCtx();
    renderPage(SettingsPage, ctx);
    await waitFor(() => expect(screen.getByText("Cash ISA")).toBeTruthy());
    fireEvent.click(screen.getByText("Cash ISA"));

    expect(screen.queryByPlaceholderText("API key ID")).toBeNull();
    expect((screen.getByPlaceholderText("Trading 212 Cash ISA") as HTMLInputElement).value).toBe(
      "Trading 212 Cash ISA",
    );
    const input = screen.getByTestId("t212-cash-isa-files") as HTMLInputElement;
    expect(input.multiple).toBe(true);

    const header = "Action,Time (UTC),Notes,ID,Total,Currency (Total)";
    const a = "Deposit,2025-12-10 09:00:00+00:00,Bank Transfer,id-1,500.00,GBP";
    const b = "Interest on cash,2026-01-03 06:45:21+00:00,Interest on cash,id-2,1.50,GBP";
    // jsdom's File has no text(); the host's browser does.
    const csv = (name: string, rows: string[]) => {
      const body = [header, ...rows].join("\n");
      return Object.assign(new File([body], name, { type: "text/csv" }), { text: async () => body });
    };
    const files = [csv("2025.csv", [a]), csv("2026.csv", [a, b])];
    fireEvent.change(input, { target: { files } });

    await waitFor(() => expect(screen.getByText("2026.csv")).toBeTruthy());
    expect(screen.getByText("2025.csv")).toBeTruthy();
    // The deposit in both exports is imported once.
    fireEvent.click(screen.getByText("Import 2 rows"));
    await waitFor(() => expect(screen.getByText(/2 imported, 0 already there/)).toBeTruthy());
    expect(ctx.api.accounts.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Trading 212 Cash ISA", accountType: "CASH" }),
    );
    expect(JSON.parse(storage.get("t212_cash_isa")!)).toMatchObject({ accountId: "wf-new" });
  });

  it("settings: ?add=cash-isa opens Add account on the Cash ISA", async () => {
    const { ctx } = makeCtx();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SettingsPage ctx={ctx} location={{ search: "?add=cash-isa" } as AddonRouteLocation} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("t212-cash-isa-files")).toBeTruthy());
  });

  const dashboardCtx = (extractCard: boolean) =>
    makeCtx({
      storage: [
        [
          "t212_connections",
          JSON.stringify([
            { id: "c1", name: "T212 Invest", keyIdLast4: "1234", accountId: "acc-1", kind: "invest", cardAccountId: "card-1" },
            // A stale card id on an ISA connection is not shown.
            { id: "c2", name: "T212 ISA", keyIdLast4: "5678", accountId: "acc-2", kind: "isa", cardAccountId: "card-2" },
          ]),
        ],
        ["t212_settings", JSON.stringify({ env: "live", extractCard })],
        ["t212_cash_isa", JSON.stringify({ accountId: "cash-isa", lastImport: "2026-10-01T10:00:00Z" })],
      ],
      accounts: [
        { id: "acc-1", providerAccountId: "1", trackingMode: "TRANSACTIONS" },
        { id: "acc-2", providerAccountId: "2", trackingMode: "TRANSACTIONS" },
        { id: "card-1", name: "T212 Invest Card", accountType: "CASH" },
        { id: "card-2", name: "T212 ISA Card", accountType: "CASH" },
        { id: "cash-isa", name: "My Cash ISA", accountType: "CASH" },
      ],
    });

  it("dashboard: lists the card account and the Cash ISA next to the API connections", async () => {
    const { ctx } = dashboardCtx(true);
    renderPage(DashboardPage, ctx);

    await waitFor(() => expect(screen.getByText("My Cash ISA")).toBeTruthy());
    expect(screen.getByText("T212 Invest")).toBeTruthy();
    expect(screen.getByText("T212 ISA")).toBeTruthy();
    expect(screen.getByText("T212 Invest Card")).toBeTruthy();
    expect(screen.queryByText("T212 ISA Card")).toBeNull();
    expect(screen.queryByText("Import Cash ISA")).toBeNull();

    fireEvent.click(screen.getByText("Import CSV"));
    expect(ctx.api.navigation.navigate).toHaveBeenCalledWith("/addons/trading212-addon/settings?add=cash-isa");
  });

  it("dashboard: no card account card while card extraction is off", async () => {
    const { ctx } = dashboardCtx(false);
    renderPage(DashboardPage, ctx);
    await waitFor(() => expect(screen.getByText("My Cash ISA")).toBeTruthy());
    expect(screen.queryByText("T212 Invest Card")).toBeNull();
  });
});
