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

it("MVP-2 events accepts a lead whose click lost its user", async () => {
  await env.EVENTS.prepare(
    `INSERT INTO events (event_id, schema_version, type, client_time, received_at, user_id, visit_id, seq, prelander_id, payload)
     VALUES ('evt-lead-1', 1, 'lead', NULL, 1700000000000, NULL, 'visit-1', NULL, 'pre-1', '{}')`,
  ).run();
  const row = await env.EVENTS.prepare(
    "SELECT user_id FROM events WHERE event_id = 'evt-lead-1'",
  ).first<{
    user_id: string | null;
  }>();
  expect(row?.user_id).toBeNull();
});

it("MVP-2 events rejects an event without event_id", async () => {
  await expect(
    env.EVENTS.prepare(
      `INSERT INTO events (event_id, schema_version, type, client_time, received_at, user_id, visit_id, seq, prelander_id, payload)
       VALUES (NULL, 1, 'lead', NULL, 1700000000000, NULL, 'visit-1', NULL, 'pre-1', '{}')`,
    ).run(),
  ).rejects.toThrow(/NOT NULL constraint failed: events.event_id/);
});

it("MVP-2 the worker has every binding the design names", () => {
  for (const name of ["FACTS", "EVENTS", "EVENTS_QUEUE", "EVENTS_BUCKET", "METRICS"]) {
    expect(env[name as keyof Env], name).toBeDefined();
  }
});
