import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserEvent } from "../fixtures/event-bodies.ts";
import {
  call,
  captureQueue,
  deliver,
  eventsOf,
  failingQueue,
  postEvent,
} from "../fixtures/events.ts";
import { newCookie, UUID_V4 } from "../fixtures/http.ts";

const idOf = (cookie: string) => cookie.slice(4);
const visitIdOf = (html: string) => html.match(/data-visit="([^"]+)"/)?.[1] ?? "";
const section = (html: string, key: string) =>
  html.match(new RegExp(`<section[^>]*data-step="${key}"[^>]*>`))?.[0] ?? "";

const completion = (cookie: string, extra: Record<string, unknown> = {}, queue?: Queue) =>
  call(
    "/api/complete",
    {
      method: "POST",
      cookie,
      body: JSON.stringify({
        prelander_id: "demo",
        answers: { gender: "women", ethnicity: "asia" },
        email: "user1@example.com",
        ...extra,
      }),
    },
    queue ? { EVENTS_QUEUE: queue } : undefined,
  );

afterEach(() => vi.restoreAllMocks());

describe("server events at entry and completion", () => {
  it("ID-1 entry emits prelander_viewed with the page's visit id", async () => {
    const cookie = newCookie();
    const { queue, sent } = captureQueue();
    const res = await call("/p/demo", { cookie }, { EVENTS_QUEUE: queue });
    expect(res.status).toBe(200);
    const visit = visitIdOf(await res.text());
    expect(visit).toMatch(UUID_V4);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.contentType).toBe("json");
    expect(sent[0]?.body).toMatchObject({
      type: "prelander_viewed",
      payload: { reason: "quiz" },
      visit_id: visit,
      user_id: idOf(cookie),
      client_time: null,
      seq: null,
      prelander_id: "demo",
    });
  });

  it("QZ-4 Q-26 each page load gets a new visit id", async () => {
    const cookie = newCookie();
    const { queue } = captureQueue();
    const first = visitIdOf(
      await (await call("/p/demo", { cookie }, { EVENTS_QUEUE: queue })).text(),
    );
    const second = visitIdOf(
      await (await call("/p/demo", { cookie }, { EVENTS_QUEUE: queue })).text(),
    );
    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(first).not.toBe(second);
  });

  it("QZ-4 an unknown prelander emits nothing", async () => {
    const { queue, sent } = captureQueue();
    const res = await call("/p/nope", { cookie: newCookie() }, { EVENTS_QUEUE: queue });
    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it("QZ-4 offer_selected carries reason and catalog version", async () => {
    const cookie = newCookie();
    const { queue, sent } = captureQueue();
    const page = await call("/p/demo", { cookie }, { EVENTS_QUEUE: queue });
    const visit = visitIdOf(await page.text());
    sent.length = 0;
    const res = await completion(cookie, { visit_id: visit }, queue);
    expect(res.status).toBe(200);
    expect(sent.map((s) => s.body.type)).toEqual(["quiz_completed", "offer_selected"]);
    expect(sent[0]?.body).toMatchObject({
      payload: { answers: { gender: "women", ethnicity: "asia" } },
      visit_id: visit,
      user_id: idOf(cookie),
      prelander_id: "demo",
    });
    expect(sent[1]?.body).toMatchObject({
      payload: {
        offer_id: "003",
        reason: "best_epu",
        moment: "completion",
        catalog_version: expect.any(Number),
      },
      visit_id: visit,
    });
    expect(JSON.stringify(sent)).not.toContain("@");
  });

  it("QZ-4 a completion without a visit id gets one from the Worker", async () => {
    const { queue, sent } = captureQueue();
    const res = await completion(newCookie(), {}, queue);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.body.visit_id).toMatch(UUID_V4);
    expect(sent[1]?.body.visit_id).toBe(sent[0]?.body.visit_id);
  });

  it.each([
    ["empty", ""],
    ["65 characters", "a".repeat(65)],
    ["an email", "user2@example.com"],
  ])(
    "QZ-4 an invalid visit id in the completion is replaced by one from the Worker (%s)",
    async (_label, bad) => {
      const { queue, sent } = captureQueue();
      const res = await completion(newCookie(), { visit_id: bad }, queue);
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(2);
      expect(sent[0]?.body.visit_id).toMatch(UUID_V4);
      expect(sent[1]?.body.visit_id).toBe(sent[0]?.body.visit_id);
      expect(JSON.stringify(sent)).not.toContain("user2");
    },
  );

  it("QZ-4 a rejected completion emits nothing", async () => {
    const { queue, sent } = captureQueue();
    const res = await completion(newCookie(), { email: "not-an-email" }, queue);
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("ID-4 quiz run stores properties and the visit events", async () => {
    const cookie = newCookie();
    const { queue, sent } = captureQueue();
    const page = await call("/p/demo", { cookie }, { EVENTS_QUEUE: queue });
    const visit = visitIdOf(await page.text());
    const browser = [
      { type: "step_viewed", payload: { step: 1, prefilled: false } },
      { type: "step_answered", payload: { step: 1, question_key: "gender", value: "women" } },
      { type: "step_viewed", payload: { step: 2, prefilled: false } },
      { type: "step_answered", payload: { step: 2, question_key: "ethnicity", value: "asia" } },
      { type: "step_viewed", payload: { step: 3, prefilled: false } },
    ];
    for (const [i, e] of browser.entries()) {
      const res = await postEvent(browserEvent({ ...e, visit_id: visit, seq: i + 1 }), cookie, {
        EVENTS_QUEUE: queue,
      });
      expect(res.status).toBe(202);
    }
    expect((await completion(cookie, { visit_id: visit }, queue)).status).toBe(200);

    await deliver(sent.map((s) => s.body));
    const rows = await eventsOf(idOf(cookie));
    expect(rows).toHaveLength(8);
    const count = (type: string) => rows.filter((r) => r.type === type).length;
    expect(count("prelander_viewed")).toBe(1);
    expect(count("step_viewed")).toBe(3);
    expect(count("step_answered")).toBe(2);
    expect(count("quiz_completed")).toBe(1);
    expect(count("offer_selected")).toBe(1);
    expect(new Set(rows.map((r) => r.visit_id))).toEqual(new Set([visit]));
    expect(new Set(rows.map((r) => r.event_id)).size).toBe(8);
    const user = await env.FACTS.prepare("SELECT id FROM users WHERE id = ?")
      .bind(idOf(cookie))
      .first();
    expect(user).not.toBeNull();
    expect(JSON.stringify(rows)).not.toContain("user1@example.com");
  });

  it("NFR-4 entry and completion answer while the Queue refuses", async () => {
    const log = vi.spyOn(console, "log");
    const cookie = newCookie();
    const queue = failingQueue();
    const page = await call("/p/demo", { cookie }, { EVENTS_QUEUE: queue });
    expect(page.status).toBe(200);
    const res = await completion(cookie, {}, queue);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { offer_id: string }).offer_id).toBe("003");
    expect(log.mock.calls.flat().join("\n")).toContain('"msg":"queue_send_failed"');
  });

  it("NFR-8 R-3 the completion received last decides the stored answers", async () => {
    const cookie = newCookie();
    const { queue, sent } = captureQueue();
    expect((await completion(cookie, {}, queue)).status).toBe(200);
    const late = await postEvent(
      browserEvent({ payload: { step: 1, question_key: "gender", value: "men" } }),
      cookie,
      { EVENTS_QUEUE: queue },
    );
    expect(late.status).toBe(202);
    await deliver(sent.map((s) => s.body));
    const row = await env.FACTS.prepare(
      "SELECT value FROM user_answers WHERE user_id = ? AND question_key = 'gender'",
    )
      .bind(idOf(cookie))
      .first<{ value: string }>();
    expect(row?.value).toBe('"women"');
  });

  it("QZ-5 reload before completion starts from step 1", async () => {
    const cookie = newCookie();
    const { queue } = captureQueue();
    const answered = await postEvent(
      browserEvent({ payload: { step: 1, question_key: "gender", value: "women" } }),
      cookie,
      { EVENTS_QUEUE: queue },
    );
    expect(answered.status).toBe(202);
    const html = await (await call("/p/demo", { cookie }, { EVENTS_QUEUE: queue })).text();
    expect(section(html, "gender")).not.toContain("hidden");
    expect(section(html, "ethnicity")).toContain("hidden");
  });

  it("QZ-1 each step section carries its 1-based step number", async () => {
    const { queue } = captureQueue();
    const html = await (
      await call("/p/demo", { cookie: newCookie() }, { EVENTS_QUEUE: queue })
    ).text();
    expect(section(html, "gender")).toContain('data-step-number="1"');
    expect(section(html, "ethnicity")).toContain('data-step-number="2"');
    expect(section(html, "email")).toContain('data-step-number="3"');
  });
});
