import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { AddonContext, AddonRouteLocation } from "@wealthfolio/addon-sdk";
import type { ComponentType } from "react";

export interface AddonPageProps {
  ctx: AddonContext;
  location: AddonRouteLocation;
}

export interface AddonPage {
  /** Must match a `contributes.routes[].id` in manifest.json. */
  id: string;
  /** Path relative to `/addons/<addon-id>`, e.g. "settings". Omit for the root page. */
  path?: string;
  component: ComponentType<AddonPageProps>;
}

/** Absolute in-app route for an add-on page: `/addons/<addonId>[/<path>]`. */
export function addonRoute(addonId: string, path?: string): string {
  return path ? `/addons/${addonId}/${path.replace(/^\/+/, "")}` : `/addons/${addonId}`;
}

/**
 * Registers add-on pages with the host using the 3.6.1+ `component` API: the host
 * owns the single React root, so pages never call `createRoot` themselves. Each page
 * is wrapped in the add-on's sandbox-scoped React Query client and receives `ctx`.
 * Sidebar links are declared in manifest.json (`contributes.links.sidebar`).
 */
export function registerPages(ctx: AddonContext, addonId: string, pages: AddonPage[]): void {
  const client = ctx.api.query.getClient() as QueryClient;
  for (const page of pages) {
    const Page = page.component;
    const Wrapped = ({ location }: { location: AddonRouteLocation }) => (
      <QueryClientProvider client={client}>
        <Page ctx={ctx} location={location} />
      </QueryClientProvider>
    );
    Wrapped.displayName = `AddonPage(${page.id})`;
    ctx.router.add({ id: page.id, path: addonRoute(addonId, page.path), component: Wrapped });
  }
}
