import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const factsMigrations = await readD1Migrations(
    path.join(import.meta.dirname, "migrations/facts"),
  );
  const eventsMigrations = await readD1Migrations(
    path.join(import.meta.dirname, "migrations/events"),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_FACTS_MIGRATIONS: factsMigrations,
            TEST_EVENTS_MIGRATIONS: eventsMigrations,
          },
        },
      }),
    ],
    test: { include: ["tests/**/*.test.ts"], setupFiles: ["./tests/setup.ts"] },
  };
});
