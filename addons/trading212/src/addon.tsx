import type { AddonEnableFunction } from "@wealthfolio/addon-sdk";
import { registerPages } from "@wf-addons/kit";
import { ADDON_ID, ROUTE_DASHBOARD, ROUTE_SETTINGS } from "./constants";
import { ensureMigrated } from "./hooks/use-config";
import { startAutoSync } from "./lib/auto-sync";
import DashboardPage from "./pages/dashboard-page";
import SettingsPage from "./pages/settings-page";

const enable: AddonEnableFunction = (ctx) => {
  registerPages(ctx, ADDON_ID, [
    { id: ROUTE_DASHBOARD, component: DashboardPage },
    { id: ROUTE_SETTINGS, path: "settings", component: SettingsPage },
  ]);

  // v1.x kept everything — including the connections list, settings and sync state — in
  // the keyring, with the API key + secret inline and a proxy URL. Move it to the v2
  // layout (credentials in a per-connection secret, the rest in add-on storage).
  ensureMigrated(ctx).then(
    (report) => {
      if (report.migrated) {
        ctx.api.logger.info(
          `Trading 212 v1 → v2 migration done${
            report.needsCredentials > 0
              ? `; ${report.needsCredentials} connection(s) need the API key ID + secret re-entered`
              : ""
          }.`,
        );
      }
    },
    (err) => ctx.api.logger.warn(`Trading 212 migration failed: ${(err as Error).message}`),
  );

  // Refresh already-synced accounts in the background (≈ daily + on portfolio refresh)
  // so HOLDINGS snapshots build a history without a manual click.
  const autoSync = startAutoSync(ctx);
  ctx.onDisable(() => autoSync.stop());
};

export default enable;
