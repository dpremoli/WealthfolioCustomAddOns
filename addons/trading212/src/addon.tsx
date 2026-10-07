import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AddonContext, AddonEnableFunction } from "@wealthfolio/addon-sdk";
import { Icons } from "@wealthfolio/ui";
import React from "react";
import DashboardPage from "./pages/dashboard-page";
import SettingsPage from "./pages/settings-page";
import { startAutoSync } from "./lib/auto-sync";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      gcTime: 1000 * 60 * 10,
    },
  },
});

const enable: AddonEnableFunction = (context) => {
  context.api.logger.info("Trading 212 addon enabling");

  const addedItems: { remove: () => void }[] = [];
  let autoSync: { stop: () => void } | undefined;

  try {
    const sidebarItem = context.sidebar.addItem({
      id: "trading212",
      label: "Trading 212",
      icon: <Icons.TrendingUp size={16} weight="duotone" />,
      route: "/addons/trading212",
      order: 161,
    });
    addedItems.push(sidebarItem);

    const wrap = (Component: React.ComponentType<{ ctx: AddonContext }>) => () => (
      <QueryClientProvider client={queryClient}>
        <Component ctx={context} />
      </QueryClientProvider>
    );

    context.router.add({
      path: "/addons/trading212",
      component: React.lazy(() => Promise.resolve({ default: wrap(DashboardPage) })),
    });

    context.router.add({
      path: "/addons/trading212/settings",
      component: React.lazy(() => Promise.resolve({ default: wrap(SettingsPage) })),
    });

    // Refresh already-synced accounts in the background (≈ daily + on portfolio
    // refresh) so HOLDINGS snapshots build a history without a manual click.
    autoSync = startAutoSync(context);

    context.api.logger.info("Trading 212 addon enabled");
  } catch (error) {
    context.api.logger.error(
      "Failed to enable Trading 212 addon: " + (error as Error).message,
    );
    throw error;
  }

  context.onDisable(() => {
    context.api.logger.info("Trading 212 addon disabling");
    autoSync?.stop();
    addedItems.forEach((item) => {
      try {
        item.remove();
      } catch (err) {
        context.api.logger.error("Error removing item: " + (err as Error).message);
      }
    });
  });
};

export default enable;
