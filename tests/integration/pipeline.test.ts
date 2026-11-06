import { createScheduledController, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index.ts";
import { LOADER_CRON } from "../../src/events/loader.ts";
import { browserEvent } from "../fixtures/event-bodies.ts";
import {
  call,
  captureQueue,
  deliver,
  eventsOf,
  postEvent,
  storedEvent,
} from "../fixtures/events.ts";
import {
  clearBucket,
  failingBucket,
  filesWith,
  keysUnder,
  linesOf,
  loadNow,
  pauseLoader,
  putPending,
  resumeLoader,
} from "../fixtures/files.ts";
import { newCookie } from "../fixtures/http.ts";
import { leadBody, postback } from "../fixtures/postback.ts";

const idOf = (cookie: string) => cookie.slice(4);
const visitIdOf = (html: string) => html.match(/data-visit="([^"]+)"/)?.[1] ?? "";
const clickIdOf = (res: Response) =>
  /[?&]click_id=([0-9a-f]{32})$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";

const today = () => new Date().toISOString().slice(0, 10);

const startedToday = async (): Promise<number> => {
  const query = new URLSearchParams({ prelander: "demo", from: today(), to: today() });
  const res = await call(`/api/report?${query}`, {});
  expect(res.status).toBe(200);
  return ((await res.json()) as { started: number }).started;
};

const runCron = (cron: string) => worker.scheduled(createScheduledController({ cron }), env);

beforeEach(clearBucket);
afterEach(async () => {
  vi.restoreAllMocks();
  await resumeLoader();
});

describe("the pipeline from the Queue to the events table", () => {
  it("NFR-5 R-16 events written while the loader is stopped are loaded once after it restarts", async () => {
    const userId = crypto.randomUUID();
    const events = [1, 2, 3].map((seq) => storedEvent({ user_id: userId, seq }));
    await pauseLoader();
    await deliver(events);
    expect(await eventsOf(userId)).toHaveLength(0);
    const pending = await filesWith("pending/", events[0]!.event_id);
    expect(pending).toHaveLength(1);

    await resumeLoader();
    await loadNow();
    expect(await eventsOf(userId)).toHaveLength(3);
    await loadNow();
    expect(await eventsOf(userId)).toHaveLength(3);

    expect(await keysUnder(pending[0]!)).toEqual([]);
    const loaded = await filesWith("loaded/", events[0]!.event_id);
    expect(loaded).toHaveLength(1);
    const ids = (await linesOf(loaded[0]!)).map((line) => JSON.parse(line).event_id);
    expect(ids).toEqual(events.map((e) => e.event_id));
  });

  it("NFR-5 R-8 drained rows have no duplicate event ids", async () => {
    const userId = crypto.randomUUID();
    const a = storedEvent({ user_id: userId, seq: 1 });
    const b = storedEvent({ user_id: userId, seq: 2 });
    await pauseLoader();
    await deliver([a, b]);
    await deliver([a, b]);
    await deliver([a]);
    await resumeLoader();
    await loadNow();
    const rows = await eventsOf(userId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.event_id)).size).toBe(2);
  });

  it("NFR-3 accepted event is counted in the report within the freshness window", async () => {
    const before = await startedToday();
    const cookie = newCookie();
    const { queue, sent } = captureQueue();
    const res = await postEvent(
      browserEvent({ type: "step_viewed", seq: 1, payload: { step: 1, prefilled: false } }),
      cookie,
      { EVENTS_QUEUE: queue },
    );
    expect(res.status).toBe(202);
    await deliver(
      sent.map((s) => s.body),
      { load: false },
    );
    expect(await startedToday()).toBe(before);

    await runCron(LOADER_CRON);
    expect(await startedToday()).toBe(before + 1);
  });

  it("NFR-3 the scheduled handler ignores an unknown cron", async () => {
    const log = vi.spyOn(console, "log");
    const key = await putPending([storedEvent()]);
    await runCron("0 0 * * *");
    expect(await keysUnder(key)).toEqual([key]);
    const lines = log.mock.calls.map((args) => String(args[0]));
    expect(lines.some((l) => l.includes('"msg":"scheduled_unknown_cron"'))).toBe(true);
    // Load it now so no later test finds the file.
    await loadNow();
  });

  it("NFR-5 a loader run that throws logs one error line and rethrows", async () => {
    const log = vi.spyOn(console, "log");
    const run = worker.scheduled(createScheduledController({ cron: LOADER_CRON }), {
      ...env,
      EVENTS_BUCKET: failingBucket(),
    });
    await expect(run).rejects.toThrow("r2 down");
    const lines = log.mock.calls.map((args) => String(args[0]));
    const errors = lines.filter((l) => l.includes('"msg":"loader_run"'));
    expect(errors.map((l) => JSON.parse(l))).toEqual([
      { msg: "loader_run", status: "error", name: "Error" },
    ]);
  });

  it("NFR-4 P-8 sink outage leaves entry, complete, transition and postback working", async () => {
    await pauseLoader();
    const cookie = newCookie();
    const { queue, sent } = captureQueue();
    const queueEnv = { EVENTS_QUEUE: queue };

    const page = await call("/p/demo", { cookie }, queueEnv);
    expect(page.status).toBe(200);
    const visit = visitIdOf(await page.text());
    const step = await postEvent(
      browserEvent({
        type: "step_viewed",
        visit_id: visit,
        seq: 1,
        payload: { step: 1, prefilled: false },
      }),
      cookie,
      queueEnv,
    );
    expect(step.status).toBe(202);
    const done = await call(
      "/api/complete",
      {
        method: "POST",
        cookie,
        body: JSON.stringify({
          prelander_id: "demo",
          visit_id: visit,
          answers: { gender: "women", ethnicity: "asia" },
          email: "user1@example.com",
        }),
      },
      queueEnv,
    );
    expect(done.status).toBe(200);
    expect(((await done.json()) as { offer_id: string }).offer_id).toBe("003");
    const go = await call(`/go?prelander=demo&visit=${visit}`, { cookie }, queueEnv);
    expect(go.status).toBe(302);
    const clickId = clickIdOf(go);
    expect(clickId).not.toBe("");
    const lead = await postback("partnerA", leadBody(clickId), {}, queueEnv);
    expect(lead.status).toBe(202);
    expect(await lead.json()).toEqual({ status: "accepted" });

    await deliver(sent.map((s) => s.body));
    expect(await eventsOf(idOf(cookie))).toHaveLength(0);

    await resumeLoader();
    await loadNow();
    expect(await eventsOf(idOf(cookie))).toHaveLength(6);
  });
});
