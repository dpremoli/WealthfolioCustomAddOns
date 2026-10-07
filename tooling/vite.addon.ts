import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";

/**
 * Packages the Wealthfolio sandbox provides at runtime (see `HOST_DEPENDENCIES`
 * in @wealthfolio/addon-sdk). They must stay external so every add-on shares the
 * host's single React instance; anything not listed here is bundled into
 * `dist/addon.js` (including @wf-addons/kit, which is source-only).
 */
export const HOST_PROVIDED = [
  "@tanstack/react-query",
  "@wealthfolio/addon-sdk",
  "@wealthfolio/addon-sdk/host-api",
  "@wealthfolio/addon-sdk/host-dependencies",
  "@wealthfolio/addon-sdk/manifest",
  "@wealthfolio/addon-sdk/permissions",
  "@wealthfolio/addon-sdk/types",
  "@wealthfolio/addon-sdk/utils",
  "@wealthfolio/ui",
  "@wealthfolio/ui/chart",
  "date-fns",
  "lucide-react",
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-dev-runtime",
  "react/jsx-runtime",
  "recharts",
];

/** Shared Vite config for building an add-on into a single ES module. */
export function addonViteConfig(overrides: UserConfig = {}) {
  return defineConfig({
    plugins: [react(), tailwindcss()],
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    build: {
      // Wealthfolio's sandbox runtime floor (Chrome 107 / Safari 16).
      target: ["chrome107", "edge107", "firefox104", "safari16"],
      lib: {
        entry: "src/addon.tsx",
        fileName: () => "addon.js",
        formats: ["es"],
      },
      rollupOptions: { external: HOST_PROVIDED },
      outDir: "dist",
      minify: true,
      sourcemap: false,
    },
    ...overrides,
  });
}
