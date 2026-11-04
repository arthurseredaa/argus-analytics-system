import { env } from "cloudflare:test";
import { expect, it } from "vitest";

const LIST_TABLES = `SELECT name FROM sqlite_master
  WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'
    AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations'
  ORDER BY name`;

async function tableNames(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare(LIST_TABLES).all<{ name: string }>();
  return results.map((r) => r.name);
}

it("MVP-2 facts database has the eight tables of the data model", async () => {
  expect(await tableNames(env.FACTS)).toEqual([
    "catalog_history",
    "clicks",
    "conversions",
    "offers",
    "partners",
    "quarantine",
    "user_answers",
    "users",
  ]);
});

it("MVP-2 events database has only the events table", async () => {
  expect(await tableNames(env.EVENTS)).toEqual(["events"]);
});

it("MVP-2 the worker has every binding the design names", () => {
  for (const name of ["FACTS", "EVENTS", "EVENTS_QUEUE", "EVENTS_BUCKET", "METRICS"]) {
    expect(env[name as keyof Env], name).toBeDefined();
  }
});
