import type { AddonEnableFunction } from "@wealthfolio/addon-sdk";
import { registerPages } from "@wf-addons/kit";
import { ADDON_ID } from "./constants";
import PayslipsPage from "./pages/payslips-page";
import PensionPage from "./pages/pension-page";
import SettingsPage from "./pages/settings-page";
import TaxPage from "./pages/tax-page";

const enable: AddonEnableFunction = (ctx) => {
  registerPages(ctx, ADDON_ID, [
    { id: "payslips", component: PayslipsPage },
    { id: "payslips-tax", path: "tax", component: TaxPage },
    { id: "payslips-pension", path: "pension", component: PensionPage },
    { id: "payslips-settings", path: "settings", component: SettingsPage },
  ]);
};

export default enable;
