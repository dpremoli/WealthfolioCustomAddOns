import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/** Shared Vitest config: jsdom + globals, used by every workspace package. */
export function sharedVitestConfig() {
  return defineConfig({
    plugins: [react()],
    test: {
      globals: true,
      environment: "jsdom",
      include: ["src/**/*.test.{ts,tsx}"],
    },
  });
}
