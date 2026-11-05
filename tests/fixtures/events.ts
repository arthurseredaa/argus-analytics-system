// Fixture: stored events, queue batches and reads of the events table for the consumer tests.
import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import type { QueueResult } from "cloudflare:test";
import worker from "../../src/index.ts";
import { consumeEvents } from "../../src/events/consumer.ts";
import type { StoredEvent } from "../../src/events/envelope.ts";

export function storedEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    event_id: crypto.randomUUID(),
    schema_version: 1,
    type: "step_viewed",
    client_time: 1762300000000,
    received_at: Date.now(),
    user_id: crypto.randomUUID(),
    visit_id: "v1",
    seq: 1,
    prelander_id: "demo",
    payload: { step: 1, prefilled: false },
    ...overrides,
  };
}

// Without `db` the batch goes through the Worker's own queue handler, with `db` straight to the consumer.
export async function deliver(bodies: readonly unknown[], db?: D1Database): Promise<QueueResult> {
  const batch = createMessageBatch(
    "events",
    bodies.map((body, i) => ({ id: `m${i}`, timestamp: Date.now(), attempts: 1, body })),
  );
  const ctx = createExecutionContext();
  if (db) await consumeEvents(batch, db);
  else await worker.queue(batch, env);
  return getQueueResult(batch, ctx);
}

export type StoredRow = {
  event_id: string;
  type: string;
  schema_version: number;
  visit_id: string;
  seq: number | null;
  client_time: number | null;
  payload: Record<string, unknown>;
};

export async function eventsOf(userId: string): Promise<StoredRow[]> {
  const { results } = await env.EVENTS.prepare(
    `SELECT event_id, type, schema_version, visit_id, seq, client_time, payload
     FROM events WHERE user_id = ? ORDER BY received_at, seq`,
  )
    .bind(userId)
    .all<Omit<StoredRow, "payload"> & { payload: string }>();
  return results.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}
