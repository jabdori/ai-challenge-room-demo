import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";
import { sitesMetadataCopyPlugin } from "./build/sites-vite-plugin";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    sitesMetadataCopyPlugin(),
    ...(mode === "test" ? [] : [cloudflare()]),
  ],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
    css: true,
    exclude: [...configDefaults.exclude, "worker/test/**/*.test.ts"],
  },
}));
