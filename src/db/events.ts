// Events database: multi-row inserts into the events table, the MVP stand-in for BigQuery.
// Implements ADR 0005; serves ID-1 (one row per event_id), ID-4 (any payload kept), NFR-8.
// D1 binds at most 100 parameters per query, so 9 rows of 10 columns (90) go in one statement.
import type { StoredEvent } from "../events/envelope.ts";

export type Statement = { sql: string; params: (string | number | null)[] };

export const EVENT_COLUMNS = [
  "event_id",
  "schema_version",
  "type",
  "client_time",
  "received_at",
  "user_id",
  "visit_id",
  "seq",
  "prelander_id",
  "payload",
] as const;

export const ROWS_PER_INSERT = 9;

const rowPlaceholders = `(${EVENT_COLUMNS.map(() => "?").join(", ")})`;

export function eventInsertStatements(events: readonly StoredEvent[]): Statement[] {
  const statements: Statement[] = [];
  for (let i = 0; i < events.length; i += ROWS_PER_INSERT) {
    const rows = events.slice(i, i + ROWS_PER_INSERT);
    statements.push({
      sql:
        `INSERT INTO events (${EVENT_COLUMNS.join(", ")}) VALUES ` +
        `${rows.map(() => rowPlaceholders).join(", ")} ON CONFLICT (event_id) DO NOTHING`,
      params: rows.flatMap((e) => [
        e.event_id,
        e.schema_version,
        e.type,
        e.client_time,
        e.received_at,
        e.user_id,
        e.visit_id,
        e.seq,
        e.prelander_id,
        JSON.stringify(e.payload),
      ]),
    });
  }
  return statements;
}

// One db.batch is one transaction: all rows of the batch are stored, or none.
export async function insertEvents(db: D1Database, events: readonly StoredEvent[]): Promise<void> {
  const statements = eventInsertStatements(events);
  if (statements.length === 0) return;
  await db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.params)));
}
