import type { AddonEnableFunction } from "@wealthfolio/addon-sdk";
import { migrateSecretsToStorage, registerPages } from "@wf-addons/kit";
import { ACCOUNTS_KEY, ADDON_ID } from "./constants";
import CsvImportPage from "./pages/csv-import-page";
import DashboardPage from "./pages/dashboard-page";

const enable: AddonEnableFunction = (ctx) => {
  registerPages(ctx, ADDON_ID, [
    { id: "revolut", component: DashboardPage },
    { id: "revolut-import", path: "import", component: CsvImportPage },
  ]);

  // v1.x kept the account mapping in the keyring; it is not a secret.
  migrateSecretsToStorage(ctx, [ACCOUNTS_KEY]).catch((err) =>
    ctx.api.logger.warn(`Revolut settings migration failed: ${(err as Error).message}`),
  );
};

export default enable;
