import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { browserEvent } from "../fixtures/event-bodies.ts";
import { call, captureQueue, deliver, eventsOf, postEvent } from "../fixtures/events.ts";
import { filesWith } from "../fixtures/files.ts";
import { recordingDataset } from "../fixtures/metrics.ts";
import { leadBody, postback } from "../fixtures/postback.ts";

// One visit through every route that touches the address, then everything the Worker said or wrote
// is searched for it. Serves DEMO-8, R-12 and ADR 0002 (the UserID is not in a log or a URL either).
const EMAIL = "user1@example.com";
const ENCODED = "user1%40example.com";
const FORMS = [EMAIL, ENCODED];

const visitIdOf = (html: string) => html.match(/data-visit="([^"]+)"/)?.[1] ?? "";
const printed = (arg: unknown): string =>
  arg instanceof Error
    ? `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`
    : typeof arg === "string"
      ? arg
      : JSON.stringify(arg);

function expectNone(texts: readonly string[]): void {
  for (const text of texts) for (const form of FORMS) expect(text).not.toContain(form);
}

let userId = "";
const logged: string[] = [];
const urls: string[] = [];
const locations: string[] = [];
const bodies: string[] = [];
const points: string[] = [];
let spies: MockInstance<(...data: unknown[]) => void>[] = [];

beforeAll(async () => {
  spies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
  ];
  const { queue, sent } = captureQueue();
  const rec = recordingDataset();
  const override = { EVENTS_QUEUE: queue, METRICS: rec.dataset };

  // Every request goes through here, so its URL and Location header are kept.
  const send = async (
    path: string,
    init: { method?: string; cookie?: string; body?: string },
  ): Promise<Response> => {
    urls.push(`https://example.com${path}`);
    const res = await call(path, init, override);
    const location = res.headers.get("location");
    if (location !== null) locations.push(location);
    return res;
  };

  const entry = await send("/p/demo", {});
  const cookie = (entry.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  userId = cookie.slice(4);
  const visit = visitIdOf(await entry.text());

  const event = (seq: number, type: string, payload: Record<string, unknown>) =>
    browserEvent({ type, seq, visit_id: visit, payload });
  const post = async (body: Record<string, unknown>) => {
    urls.push("https://example.com/api/events");
    return postEvent(body, cookie, override);
  };
  await post(event(1, "step_viewed", { step: 1, prefilled: false }));
  await post(event(2, "step_answered", { step: 1, question_key: "gender", value: "women" }));
  await post(event(3, "step_viewed", { step: 2, prefilled: false }));
  await post(event(4, "step_answered", { step: 2, question_key: "ethnicity", value: "asia" }));
  await post(event(5, "step_viewed", { step: 3, prefilled: false }));

  await send("/api/complete", {
    method: "POST",
    cookie,
    body: JSON.stringify({
      prelander_id: "demo",
      visit_id: visit,
      answers: { gender: "women", ethnicity: "asia" },
      email: EMAIL,
    }),
  });
  const go = await send(`/go?prelander=demo&visit=${visit}`, { cookie });
  const clickId = /[?&]click_id=([0-9a-f]{32})$/.exec(go.headers.get("location") ?? "")?.[1] ?? "";
  urls.push("https://example.com/postback/v1/partnerA");
  await postback("partnerA", leadBody(clickId), {}, override);

  // The failure paths: invalid JSON around the address, and an email key in an event payload.
  await send("/api/complete", {
    method: "POST",
    cookie,
    body: `{"answers":{"gender":"women"},"email":"${EMAIL}"`,
  });
  await post(
    event(6, "step_answered", { step: 1, question_key: "gender", value: "women", email: EMAIL }),
  );

  bodies.push(...sent.map((s) => JSON.stringify(s.body)));
  await deliver(sent.map((s) => s.body));
  points.push(...rec.points.map((p) => JSON.stringify(p)));
  logged.push(...spies.flatMap((spy) => spy.mock.calls.flatMap((args) => args.map(printed))));
});

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

describe("the address and the user id in everything the Worker says", () => {
  it("DEMO-8 R-12 email absent from captured logs", () => {
    expect(userId).not.toBe("");
    // The invalid completion body and the stripped email key both log a line.
    expect(logged.length).toBeGreaterThan(0);
    expectNone(logged);
  });

  it("DEMO-8 R-12 email absent from every request URL and Location header", () => {
    expect(urls.length).toBeGreaterThan(5);
    expect(locations.length).toBeGreaterThan(0);
    expectNone([...urls, ...locations]);
  });

  it("DEMO-8 R-12 email absent from Queue messages, R2 files and the events table", async () => {
    expect(bodies.length).toBeGreaterThan(5);
    expectNone(bodies);

    const files = await filesWith("loaded/", userId);
    expect(files.length).toBeGreaterThan(0);
    for (const key of files) expectNone([(await (await env.EVENTS_BUCKET.get(key))?.text()) ?? ""]);

    const rows = await eventsOf(userId);
    expect(rows.length).toBeGreaterThan(5);
    expectNone(rows.map((row) => JSON.stringify(row)));

    expect(points.length).toBeGreaterThan(5);
    expectNone(points);
  });

  it("DEMO-8 R-12 ADR 0002 user id absent from logs and URLs", () => {
    for (const text of [...logged, ...urls, ...locations]) expect(text).not.toContain(userId);
  });
});
