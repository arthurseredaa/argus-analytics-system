import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.ts";
import { prelanderFlows } from "../../src/domain/prelanders.ts";
import { browserEvent, deepPayload } from "../fixtures/event-bodies.ts";
import { captureQueue, deliver, eventsOf, failingQueue, postEvent } from "../fixtures/events.ts";
import { newCookie } from "../fixtures/http.ts";

const idOf = (cookie: string) => cookie.slice(4);

const spyConsole = () => [
  vi.spyOn(console, "log"),
  vi.spyOn(console, "error"),
  vi.spyOn(console, "warn"),
];
const logged = (spies: ReturnType<typeof spyConsole>) =>
  JSON.stringify(spies.flatMap((s) => s.mock.calls));

afterEach(() => vi.restoreAllMocks());

describe("POST /api/events", () => {
  it("TEST-3 R-3 the same body posted twice is accepted twice and stored once", async () => {
    const cookie = newCookie();
    const { queue, sent } = captureQueue();
    const body = browserEvent();
    const first = await postEvent(body, cookie, { EVENTS_QUEUE: queue });
    const second = await postEvent(body, cookie, { EVENTS_QUEUE: queue });
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.body.event_id).toBe(sent[1]?.body.event_id);
    await deliver(sent.map((s) => s.body));
    expect(await eventsOf(idOf(cookie))).toHaveLength(1);
  });

  it("NFR-5 events go to the Queue as json with the user id and receive time", async () => {
    const cookie = newCookie();
    const { queue, sent } = captureQueue();
    const before = Date.now();
    const res = await postEvent(browserEvent(), cookie, { EVENTS_QUEUE: queue });
    const after = Date.now();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.contentType).toBe("json");
    expect(sent[0]?.body.user_id).toBe(idOf(cookie));
    expect(sent[0]?.body.received_at).toBeGreaterThanOrEqual(before);
    expect(sent[0]?.body.received_at).toBeLessThanOrEqual(after);
  });

  it("ID-2 user id in the event body is ignored", async () => {
    const cookie = newCookie();
    const { queue, sent } = captureQueue();
    const res = await postEvent(
      browserEvent({ user_id: crypto.randomUUID(), received_at: 1 }),
      cookie,
      { EVENTS_QUEUE: queue },
    );
    expect(res.status).toBe(202);
    expect(sent[0]?.body.user_id).toBe(idOf(cookie));
    expect(sent[0]?.body.received_at).toBeGreaterThan(1);
  });

  it("ID-1 event without event id is rejected and nothing is sent", async () => {
    const { queue, sent } = captureQueue();
    const { event_id: _id, ...body } = browserEvent();
    const res = await postEvent(body, newCookie(), { EVENTS_QUEUE: queue });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body", fields: ["event_id"] });
    expect(sent).toHaveLength(0);
  });

  it("BIZ-2 a client cannot post a server-only type", async () => {
    const { queue, sent } = captureQueue();
    const res = await postEvent(browserEvent({ type: "lead" }), newCookie(), {
      EVENTS_QUEUE: queue,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "server_only_type" });
    expect(sent).toHaveLength(0);
  });

  it("R-12 envelope has no email field: an event carrying one never reaches the Queue", async () => {
    const spies = spyConsole();
    const { queue, sent } = captureQueue();
    const res = await postEvent(browserEvent({ email: "user2@example.com" }), newCookie(), {
      EVENTS_QUEUE: queue,
    });
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
    expect(await res.text()).not.toContain("user2@example");
    expect(logged(spies)).not.toContain("user2@example");
  });

  it("R-23 R-12 an email field in the payload of an unknown type is removed before the Queue", async () => {
    const spies = spyConsole();
    const { queue, sent } = captureQueue();
    const res = await postEvent(
      browserEvent({
        type: "page_error",
        payload: {
          email: "user2@example.com",
          nested: { contactEmail: "user2@example.com" },
          page: 2,
        },
      }),
      newCookie(),
      { EVENTS_QUEUE: queue },
    );
    expect(res.status).toBe(202);
    expect(JSON.stringify(sent)).not.toContain("user2");
    expect(sent[0]?.body.payload).toEqual({ nested: {}, page: 2 });
    const lines = spies.flatMap((s) => s.mock.calls.map((args) => String(args[0])));
    expect(
      lines.some((l) => l.includes('"msg":"payload_sanitized"') && l.includes('"removed":2')),
    ).toBe(true);
    expect(logged(spies)).not.toContain("user2");
  });

  it("R-12 a malformed event body with an email is rejected without logging it", async () => {
    const spies = spyConsole();
    const { queue, sent } = captureQueue();
    const res = await postEvent(
      '{"event_id":"x","payload":{"note":"user2@example.com"',
      newCookie(),
      { EVENTS_QUEUE: queue },
    );
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
    expect(await res.text()).not.toContain("user2@example");
    expect(logged(spies)).not.toContain("user2@example");
  });

  it("R-14 an event body over 4 KB is rejected with 413", async () => {
    const { queue, sent } = captureQueue();
    const res = await postEvent(
      browserEvent({ type: "page_error", payload: { note: "x".repeat(5000) } }),
      newCookie(),
      { EVENTS_QUEUE: queue },
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });
    expect(sent).toHaveLength(0);
  });

  it("R-14 a deeply nested payload is rejected at the edge and nothing is sent", async () => {
    const { queue, sent } = captureQueue();
    const deep = deepPayload(1001);
    const res = await postEvent(browserEvent({ type: "page_error", payload: deep }), newCookie(), {
      EVENTS_QUEUE: queue,
    });
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("ID-1 a JSON array body is rejected and nothing is sent", async () => {
    const { queue, sent } = captureQueue();
    const res = await postEvent([browserEvent()], newCookie(), { EVENTS_QUEUE: queue });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body", fields: [] });
    expect(sent).toHaveLength(0);
  });

  it("QZ-1 an event for an unknown prelander is rejected and nothing is sent", async () => {
    const { queue, sent } = captureQueue();
    const res = await postEvent(browserEvent({ prelander_id: "nope" }), newCookie(), {
      EVENTS_QUEUE: queue,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unknown_prelander" });
    expect(sent).toHaveLength(0);
  });

  it("R-14 a body under 4096 characters but over 4096 bytes is rejected with 413", async () => {
    const { queue, sent } = captureQueue();
    const text = JSON.stringify(
      browserEvent({ type: "page_error", payload: { note: "ї".repeat(2500) } }),
    );
    expect(text.length).toBeLessThan(4096);
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(4096);
    const res = await postEvent(text, newCookie(), { EVENTS_QUEUE: queue });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });
    expect(sent).toHaveLength(0);
  });

  it("R-14 a content-length header over 4 KB is rejected with 413 before the body is read", async () => {
    const { queue, sent } = captureQueue();
    const req = new Request("https://example.com/api/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "5000",
        cookie: newCookie(),
      },
      body: JSON.stringify(browserEvent()),
    });
    // The runtime may replace the header with the real length; the test needs the 5000 to survive.
    expect(req.headers.get("content-length")).toBe("5000");
    const ctx = createExecutionContext();
    const res = await createApp(prelanderFlows).fetch(req, { ...env, EVENTS_QUEUE: queue }, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });
    expect(sent).toHaveLength(0);
  });

  it("NFR-4 the event answers 503 with Retry-After when the Queue refuses", async () => {
    const spies = spyConsole();
    const res = await postEvent(browserEvent(), newCookie(), { EVENTS_QUEUE: failingQueue() });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(logged(spies)).toContain("queue_send_failed");
  });

  it("QZ-4 answer events do not change D1", async () => {
    const cookie = newCookie();
    const { queue } = captureQueue();
    const gender = await postEvent(browserEvent(), cookie, { EVENTS_QUEUE: queue });
    const ethnicity = await postEvent(
      browserEvent({ payload: { step: 2, question_key: "ethnicity", value: "asia" } }),
      cookie,
      { EVENTS_QUEUE: queue },
    );
    expect([gender.status, ethnicity.status]).toEqual([202, 202]);
    const id = idOf(cookie);
    const user = await env.FACTS.prepare("SELECT id FROM users WHERE id = ?").bind(id).first();
    const answers = await env.FACTS.prepare("SELECT 1 FROM user_answers WHERE user_id = ?")
      .bind(id)
      .first();
    expect(user).toBeNull();
    expect(answers).toBeNull();
  });
});
