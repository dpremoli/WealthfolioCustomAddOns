import type { AddonEnableFunction } from "@wealthfolio/addon-sdk";
import { registerPages } from "@wf-addons/kit";
import { ADDON_ID } from "./constants";
import { ensureMigrated } from "./lib/migrate";
import CsvImportPage from "./pages/csv-import-page";
import DashboardPage from "./pages/dashboard-page";
import SettingsPage from "./pages/settings-page";

const enable: AddonEnableFunction = (ctx) => {
  registerPages(ctx, ADDON_ID, [
    { id: "monzo", component: DashboardPage },
    { id: "monzo-settings", path: "settings", component: SettingsPage },
    { id: "monzo-import", path: "import", component: CsvImportPage },
  ]);

  // v1.x kept everything (tokens, account mapping, proxy URL…) in the keyring; move it over.
  // Failures are logged inside; pages and syncs await the same promise before reading state.
  void ensureMigrated(ctx);
};

export default enable;
