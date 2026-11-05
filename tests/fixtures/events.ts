// Fixture: stored events, queue batches and reads of the events table for the consumer tests.
import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import type { QueueResult } from "cloudflare:test";
import type { Hono } from "hono";
import { createApp, type AppEnv } from "../../src/app.ts";
import { prelanderFlows } from "../../src/domain/prelanders.ts";
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

// The request half: a Queue that records what is sent, one that refuses, and a call that drives the app directly.
export function captureQueue(): {
  queue: Queue;
  sent: { body: StoredEvent; contentType: string | undefined }[];
} {
  const sent: { body: StoredEvent; contentType: string | undefined }[] = [];
  const queue = {
    send: async (body: StoredEvent, options?: { contentType?: string }) => {
      sent.push({ body, contentType: options?.contentType });
    },
    sendBatch: async () => {
      throw new Error("sendBatch is not used");
    },
  } as unknown as Queue;
  return { queue, sent };
}

export function failingQueue(): Queue {
  return {
    send: async () => {
      throw new Error("queue down");
    },
    sendBatch: async () => {
      throw new Error("queue down");
    },
  } as unknown as Queue;
}

// `app.fetch` with a real execution context; waitUntil work is finished before the response is returned to the test.
export async function call(
  path: string,
  init: { method?: string; cookie?: string; body?: string },
  envOverride?: Partial<Env>,
  app: Hono<AppEnv> = createApp(prelanderFlows),
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.cookie !== undefined) headers.set("cookie", init.cookie);
  const req = new Request(`https://example.com${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const ctx = createExecutionContext();
  const res = await app.fetch(req, { ...env, ...envOverride }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export function postEvent(
  event: unknown,
  cookie: string,
  envOverride?: Partial<Env>,
): Promise<Response> {
  const body = typeof event === "string" ? event : JSON.stringify(event);
  return call("/api/events", { method: "POST", cookie, body }, envOverride);
}
