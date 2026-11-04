import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.FACTS, env.TEST_FACTS_MIGRATIONS);
  await applyD1Migrations(env.EVENTS, env.TEST_EVENTS_MIGRATIONS);
});
