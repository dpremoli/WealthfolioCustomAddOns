import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AddonContext, AddonEnableFunction } from "@wealthfolio/addon-sdk";
import React from "react";
import CsvImportPage from "./pages/csv-import-page";
import DashboardPage from "./pages/dashboard-page";
import SettingsPage from "./pages/settings-page";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 10, // 10 minutes
    },
  },
});

const enable: AddonEnableFunction = (context) => {
  context.api.logger.info("Monzo addon enabling");

  const addedItems: { remove: () => void }[] = [];

  try {
    const sidebarItem = context.sidebar.addItem({
      id: "monzo",
      label: "Monzo Sync",
      icon: <span style={{ fontSize: "16px" }}>&#127974;</span>,
      route: "/addons/monzo",
      order: 160,
    });
    addedItems.push(sidebarItem);

    const wrap = (Component: React.ComponentType<{ ctx: AddonContext }>) => () => (
      <QueryClientProvider client={queryClient}>
        <Component ctx={context} />
      </QueryClientProvider>
    );

    context.router.add({
      path: "/addons/monzo",
      component: React.lazy(() => Promise.resolve({ default: wrap(DashboardPage) })),
    });

    context.router.add({
      path: "/addons/monzo/settings",
      component: React.lazy(() => Promise.resolve({ default: wrap(SettingsPage) })),
    });

    context.router.add({
      path: "/addons/monzo/import",
      component: React.lazy(() => Promise.resolve({ default: wrap(CsvImportPage) })),
    });

    context.api.logger.info("Monzo addon enabled");
  } catch (error) {
    context.api.logger.error("Failed to enable Monzo addon: " + (error as Error).message);
    throw error;
  }

  context.onDisable(() => {
    context.api.logger.info("Monzo addon disabling");
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
