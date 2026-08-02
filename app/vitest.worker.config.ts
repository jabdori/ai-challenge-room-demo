import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, "drizzle"),
  );

  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          d1Databases: ["DB"],
          r2Buckets: ["ARTIFACTS"],
          bindings: {
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ["worker/test/**/*.test.ts"],
    },
  };
});
