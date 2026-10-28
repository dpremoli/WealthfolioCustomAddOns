import type { AddonEnableFunction } from "@wealthfolio/addon-sdk";
import { registerPages, type AddonPageProps } from "@wf-addons/kit";
import { PageShell } from "@wf-addons/kit/ui";
import { ADDON_ID } from "./constants";

// Placeholder pages; later tasks replace them.
const placeholder = (heading: string) =>
  function PlaceholderPage(_props: AddonPageProps) {
    return <PageShell heading={heading}>{null}</PageShell>;
  };

const enable: AddonEnableFunction = (ctx) => {
  registerPages(ctx, ADDON_ID, [
    { id: "payslips", component: placeholder("Payslips") },
    { id: "payslips-tax", path: "tax", component: placeholder("Tax") },
    { id: "payslips-pension", path: "pension", component: placeholder("Pension") },
    { id: "payslips-settings", path: "settings", component: placeholder("Settings") },
  ]);
};

export default enable;
