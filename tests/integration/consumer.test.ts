import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { consumeEvents } from "../../src/events/consumer.ts";
import { makeServerEvent, SERVER_TYPES } from "../../src/events/envelope.ts";
import { deepPayload } from "../fixtures/event-bodies.ts";
import { deliver, eventsOf, storedEvent } from "../fixtures/events.ts";

// `prepare` is stubbed too: without it the mock failed with a TypeError before `batch` was reached.
const failingDb = {
  prepare: () => ({ bind: () => ({}) }),
  batch: () => Promise.reject(new Error("D1 is down")),
} as unknown as D1Database;

describe("queue consumer", () => {
  it("TEST-3 R-3 resending the same event stores it once", async () => {
    const event = storedEvent();
    const first = await deliver([event, event]);
    const second = await deliver([event]);
    expect(await eventsOf(event.user_id as string)).toHaveLength(1);
    expect(first.explicitAcks).toEqual(["m0", "m1"]);
    expect(second.explicitAcks).toEqual(["m0"]);
  });

  it("ID-1 every stored event has a unique event id", async () => {
    const userId = crypto.randomUUID();
    const events = [1, 2, 3].map((seq) => storedEvent({ user_id: userId, seq }));
    await deliver([...events, events[0]]);
    const rows = await eventsOf(userId);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.event_id)).size).toBe(3);
  });

  it("BIZ-2 every event type in the catalog is accepted and stored", async () => {
    const userId = crypto.randomUUID();
    const browser = [
      storedEvent({ user_id: userId, seq: 1 }),
      storedEvent({
        user_id: userId,
        seq: 2,
        type: "step_answered",
        payload: { step: 1, question_key: "gender", value: "women" },
      }),
    ];
    const server = SERVER_TYPES.map((type) =>
      makeServerEvent({
        type,
        userId,
        visitId: "v1",
        prelanderId: "demo",
        payload: {},
        now: Date.now(),
      }),
    );
    const result = await deliver([...browser, ...server]);
    expect(result.explicitAcks).toHaveLength(8);
    const types = (await eventsOf(userId)).map((r) => r.type);
    expect(new Set(types)).toEqual(new Set(["step_viewed", "step_answered", ...SERVER_TYPES]));
    expect(types).toHaveLength(8);
  });

  it("ID-4 unknown schema_version is stored and not dropped", async () => {
    const payload = { anything: { nested: true } };
    const event = storedEvent({ schema_version: 2, payload });
    await deliver([event]);
    const [row] = await eventsOf(event.user_id as string);
    expect(row?.schema_version).toBe(2);
    expect(row?.payload).toEqual(payload);
  });

  it("ID-4 a batch of 100 events is stored", async () => {
    const userId = crypto.randomUUID();
    const events = Array.from({ length: 100 }, (_, i) =>
      storedEvent({ user_id: userId, seq: i + 1 }),
    );
    const result = await deliver(events);
    expect(result.explicitAcks).toHaveLength(100);
    expect(await eventsOf(userId)).toHaveLength(100);
  });

  it("NFR-8 R-3 events arriving out of order are all stored and leave D1 unchanged", async () => {
    const userId = crypto.randomUUID();
    const now = Date.now();
    const answer = (seq: number) =>
      storedEvent({
        user_id: userId,
        seq,
        received_at: now,
        type: "step_answered",
        payload: { step: seq, question_key: "gender", value: "women" },
      });
    await deliver([answer(2)]);
    await deliver([answer(1)]);
    const rows = await eventsOf(userId);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    const answers = await env.FACTS.prepare("SELECT 1 FROM user_answers WHERE user_id = ?")
      .bind(userId)
      .all();
    expect(answers.results).toHaveLength(0);
  });

  it("NFR-8 a D1 failure retries the whole batch after 60 seconds", async () => {
    const batch = createMessageBatch(
      "events",
      [storedEvent(), storedEvent()].map((body, i) => ({
        id: `m${i}`,
        timestamp: Date.now(),
        attempts: 1,
        body,
      })),
    );
    // The plugin's retryAll() drops its argument, so the call itself is what the test checks.
    const retryAll = vi.spyOn(batch, "retryAll");
    await consumeEvents(batch, failingDb);
    expect(retryAll).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    const result = await getQueueResult(batch, createExecutionContext());
    expect(result.retryBatch.retry).toBe(true);
    expect(result.explicitAcks).toEqual([]);
  });

  it("NFR-8 a D1 failure logs the error class name and never its message", async () => {
    const log = vi.spyOn(console, "log");
    await deliver([storedEvent()], failingDb);
    const lines = log.mock.calls.map((args) => String(args[0]));
    const line = lines.find((l) => l.includes('"msg":"consumer_write_failed"'));
    expect(JSON.parse(line ?? "{}")).toEqual({
      msg: "consumer_write_failed",
      count: 1,
      name: "Error",
    });
    expect(lines.join("\n")).not.toContain("D1 is down");
    log.mockRestore();
  });

  it("NFR-8 a malformed message is retried alone and the rest are stored", async () => {
    const userId = crypto.randomUUID();
    const result = await deliver([
      storedEvent({ user_id: userId, seq: 1 }),
      { foo: 1 },
      storedEvent({ user_id: userId, seq: 2 }),
    ]);
    expect(await eventsOf(userId)).toHaveLength(2);
    // The plugin reports explicit retries as `retryMessages` ({ msgId }), not `explicitRetries`.
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["m1"]);
    expect(result.explicitAcks).toEqual(expect.arrayContaining(["m0", "m2"]));
    expect(result.explicitAcks).not.toContain("m1");
  });

  it("NFR-8 a deeply nested message is retried alone and the rest of the batch is stored", async () => {
    const userId = crypto.randomUUID();
    const deep = deepPayload(1001);
    const result = await deliver([
      storedEvent({ user_id: userId, seq: 1 }),
      storedEvent({
        user_id: userId,
        seq: 2,
        type: "page_error",
        schema_version: 2,
        payload: deep,
      }),
      storedEvent({ user_id: userId, seq: 3 }),
    ]);
    expect(await eventsOf(userId)).toHaveLength(2);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["m1"]);
    expect(result.explicitAcks).toEqual(expect.arrayContaining(["m0", "m2"]));
    expect(result.explicitAcks).not.toContain("m1");
  });

  it("NFR-5 the Worker's queue handler stores the batch", async () => {
    const event = storedEvent();
    await deliver([event]);
    expect(await eventsOf(event.user_id as string)).toHaveLength(1);
  });
});
