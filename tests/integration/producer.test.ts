import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { derivedEventId } from "../../src/events/envelope.ts";
import { sendEvent } from "../../src/events/producer.ts";
import { browserEvent } from "../fixtures/event-bodies.ts";
import { call, failingQueue, postEvent, storedEvent } from "../fixtures/events.ts";
import { failingBucket, filesWith, linesOf } from "../fixtures/files.ts";
import { newCookie } from "../fixtures/http.ts";
import { leadBody, postback, userWithClick } from "../fixtures/postback.ts";

const idOf = (cookie: string) => cookie.slice(4);

const spyConsole = () => [
  vi.spyOn(console, "log"),
  vi.spyOn(console, "error"),
  vi.spyOn(console, "warn"),
];
const logged = (spies: ReturnType<typeof spyConsole>) =>
  JSON.stringify(spies.flatMap((s) => s.mock.calls));

const complete = (cookie: string, override: Partial<Env>) =>
  call(
    "/api/complete",
    {
      method: "POST",
      cookie,
      body: JSON.stringify({
        prelander_id: "demo",
        answers: { gender: "women", ethnicity: "asia" },
        email: "user1@example.com",
      }),
    },
    override,
  );

afterEach(() => vi.restoreAllMocks());

describe("the producer's R2 fallback", () => {
  it("NFR-4 an event the Queue refuses is written to R2 pending/ and answers 202", async () => {
    const cookie = newCookie();
    const event = browserEvent();
    const res = await postEvent(event, cookie, { EVENTS_QUEUE: failingQueue() });
    expect(res.status).toBe(202);
    const keys = await filesWith("pending/", event.event_id as string);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^pending/\\d{13}-e-${event.event_id}\\.ndjson$`));
    const lines = await linesOf(keys[0]!);
    expect(lines).toHaveLength(1);
    const stored = JSON.parse(lines[0]!) as {
      event_id: string;
      user_id: string;
      received_at: unknown;
    };
    expect(stored).toMatchObject({ event_id: event.event_id, user_id: idOf(cookie) });
    expect(typeof stored.received_at).toBe("number");
  });

  it("NFR-5 buffer at capacity behaves as ADR 0005 says: a send refused with Storage Limit Exceeded goes to R2", async () => {
    const queue = {
      send: async () => {
        throw new Error("Storage Limit Exceeded");
      },
    } as unknown as Queue;
    const event = storedEvent();
    const where = await sendEvent({ EVENTS_QUEUE: queue, EVENTS_BUCKET: env.EVENTS_BUCKET }, event);
    expect(where).toBe("r2");
    expect(await filesWith("pending/", event.event_id)).toHaveLength(1);
  });

  it("NFR-4 Queue and R2 both down answer 503 with Retry-After", async () => {
    const spies = spyConsole();
    const res = await postEvent(browserEvent(), newCookie(), {
      EVENTS_QUEUE: failingQueue(),
      EVENTS_BUCKET: failingBucket(),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.json()).toEqual({ error: "unavailable" });
    const text = logged(spies);
    expect(text).toContain("queue_send_failed");
    expect(text).toContain("r2_fallback_failed");
    expect(text).not.toContain("r2 down");
  });

  it("NFR-4 entry and completion still answer when the Queue and R2 both refuse", async () => {
    const cookie = newCookie();
    const down = { EVENTS_QUEUE: failingQueue(), EVENTS_BUCKET: failingBucket() };
    const page = await call("/p/demo", { cookie }, down);
    expect(page.status).toBe(200);
    const res = await complete(cookie, down);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { offer_id: string }).offer_id).toBe("003");
  });

  it("PB-5 a postback whose Queue send fails is written to R2 and answers 202", async () => {
    const user = await userWithClick();
    const body = leadBody(user.clickId);
    const res = await postback("partnerA", body, {}, { EVENTS_QUEUE: failingQueue() });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "accepted" });
    const eventId = await derivedEventId(["partnerA", "lead", body.transaction_id as string]);
    expect(await filesWith("pending/", eventId)).toHaveLength(1);
  });

  it("R-12 an event written to R2 carries no email", async () => {
    const cookie = newCookie();
    const down = { EVENTS_QUEUE: failingQueue() };
    await call("/p/demo", { cookie }, down);
    expect((await complete(cookie, down)).status).toBe(200);
    const keys = await filesWith("pending/", idOf(cookie));
    expect(keys.length).toBeGreaterThanOrEqual(3);
    for (const key of keys) {
      for (const line of await linesOf(key)) expect(line).not.toContain("@");
    }
  });
});
