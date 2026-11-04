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
    test: {
      projects: [
        {
          test: {
            name: "unit",
            include: ["tests/unit/**/*.test.ts"],
            environment: "node",
          },
        },
        {
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
          test: {
            name: "integration",
            include: ["tests/integration/**/*.test.ts"],
            setupFiles: ["./tests/setup.ts"],
            // Files run one after another: /__test/reset empties tables other files may share.
            fileParallelism: false,
          },
        },
      ],
    },
  };
});
