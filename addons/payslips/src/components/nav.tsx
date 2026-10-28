import type { AddonContext } from "@wealthfolio/addon-sdk";
import { Button, Icons } from "@wealthfolio/ui";
import { addonRoute } from "@wf-addons/kit";
import type { IconName } from "@wealthfolio/ui";
import { ADDON_ID } from "../constants";

const PAGES: { key: string; label: string; path?: string; icon: IconName }[] = [
  { key: "payslips", label: "Payslips", icon: "Receipt" },
  { key: "tax", label: "Tax", path: "tax", icon: "BarChart" },
  { key: "pension", label: "Pension", path: "pension", icon: "PiggyBank" },
  { key: "settings", label: "Settings", path: "settings", icon: "Settings" },
];

/** Buttons to the four pages of the add-on; the current one is filled. */
export function PayslipsNav({ ctx, current }: { ctx: AddonContext; current: "payslips" | "tax" | "pension" | "settings" }) {
  return (
    <nav className="flex flex-wrap items-center gap-2" aria-label="Payslips pages">
      {PAGES.map((p) => {
        const Icon = Icons[p.icon];
        return (
          <Button
            key={p.key}
            size="sm"
            variant={p.key === current ? "default" : "outline"}
            aria-current={p.key === current ? "page" : undefined}
            onClick={() => ctx.api.navigation.navigate(addonRoute(ADDON_ID, p.path))}
          >
            <Icon size={14} className="mr-1" weight="duotone" />
            {p.label}
          </Button>
        );
      })}
    </nav>
  );
}
