import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changeCatalog } from "../fixtures/catalog.ts";
import { browserEvent } from "../fixtures/event-bodies.ts";
import { call, captureQueue, deliver, eventsOf, postEvent } from "../fixtures/events.ts";
import { newCookie, UUID_V4 } from "../fixtures/http.ts";

type State = {
  me: { clicks: { click_id: string; offer_id: string; reason: string; created_at: number }[] };
};

const idOf = (cookie: string) => cookie.slice(4);
const visitIdOf = (html: string) => html.match(/data-visit="([^"]+)"/)?.[1] ?? "";
const clickIdOf = (res: Response) =>
  /[?&]click_id=([0-9a-f]{32})$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";

// A page load, then the completion with the page's visit id; returns that visit id.
async function completeVisit(cookie: string, queue: Queue, ethnicity: string): Promise<string> {
  const page = await call("/p/demo", { cookie }, { EVENTS_QUEUE: queue });
  const visit = visitIdOf(await page.text());
  const res = await call(
    "/api/complete",
    {
      method: "POST",
      cookie,
      body: JSON.stringify({
        prelander_id: "demo",
        visit_id: visit,
        answers: { gender: "women", ethnicity },
        email: "user1@example.com",
      }),
    },
    { EVENTS_QUEUE: queue },
  );
  expect(res.status).toBe(200);
  return visit;
}

const go = (cookie: string, query: string, queue: Queue, method = "GET") =>
  call(`/go${query}`, { method, cookie }, { EVENTS_QUEUE: queue });

const stateOf = async (cookie: string) =>
  (await (await call("/__test/state", { cookie })).json()) as State;

const clickRow = (clickId: string) =>
  env.FACTS.prepare("SELECT offer_id, visit_id, reason, user_id FROM clicks WHERE click_id = ?")
    .bind(clickId)
    .first<{ offer_id: string; visit_id: string; reason: string; user_id: string }>();

afterEach(() => vi.restoreAllMocks());

describe("GET /go", () => {
  it("OFF-11 transition answers 302 with Location and click id", async () => {
    const cookie = newCookie();
    const { queue } = captureQueue();
    const visit = await completeVisit(cookie, queue, "asia");
    const res = await go(cookie, `?prelander=demo&visit=${visit}`, queue);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(
      /^https:\/\/asia-connect\.example\/\?click_id=[0-9a-f]{32}$/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("OFF-11 click row exists before the 302", async () => {
    const cookie = newCookie();
    const { queue } = captureQueue();
    const visit = await completeVisit(cookie, queue, "asia");
    const res = await go(cookie, `?prelander=demo&visit=${visit}`, queue);
    const clickId = clickIdOf(res);
    expect(clickId).toMatch(/^[0-9a-f]{32}$/);
    const state = await stateOf(cookie);
    expect(state.me.clicks).toHaveLength(1);
    expect(state.me.clicks[0]).toMatchObject({
      click_id: clickId,
      offer_id: "003",
      reason: "best_epu",
    });
    expect(await clickRow(clickId)).toMatchObject({ visit_id: visit, user_id: idOf(cookie) });
  });

  it("OFF-11 R-9 offer disabled after selection is re-selected at /go", async () => {
    const cookie = newCookie();
    const { queue } = captureQueue();
    const visit = await completeVisit(cookie, queue, "asia");
    try {
      await changeCatalog({ kind: "status", offerId: "003", active: false });
      const res = await go(cookie, `?prelander=demo&visit=${visit}`, queue);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toMatch(
        /^https:\/\/asia-women\.example\/\?click_id=[0-9a-f]{32}$/,
      );
      expect(await clickRow(clickIdOf(res))).toMatchObject({ offer_id: "001", reason: "best_epu" });
    } finally {
      await changeCatalog({ kind: "status", offerId: "003", active: true });
    }
  });

  it("OFF-11 the URL cannot choose the offer", async () => {
    const cookie = newCookie();
    const { queue } = captureQueue();
    const visit = await completeVisit(cookie, queue, "asia");
    const path = await go(cookie, `/004?prelander=demo&visit=${visit}`, queue);
    expect(path.status).toBe(404);
    const query = await go(cookie, `?prelander=demo&visit=${visit}&offer=004`, queue);
    expect(query.status).toBe(302);
    expect(query.headers.get("location")).toMatch(/^https:\/\/asia-connect\.example\//);
    const state = await stateOf(cookie);
    expect(state.me.clicks.map((c) => c.offer_id)).toEqual(["003"]);
  });

  it("Q-30 a user without a users row is sent to the quiz", async () => {
    const cookie = newCookie();
    const { queue, sent } = captureQueue();
    const res = await go(cookie, "?prelander=demo", queue);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/p/demo");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await stateOf(cookie)).me.clicks).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("OFF-8 no offer at /go shows the message", async () => {
    const log = vi.spyOn(console, "log");
    const cookie = newCookie();
    const { queue, sent } = captureQueue();
    const visit = await completeVisit(cookie, queue, "latam");
    sent.length = 0;
    try {
      await changeCatalog({ kind: "status", offerId: "007", active: false });
      const res = await go(cookie, `?prelander=demo&visit=${visit}`, queue);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toContain("No offer available");
      expect((await stateOf(cookie)).me.clicks).toHaveLength(0);
      expect(sent).toHaveLength(0);
      expect(log.mock.calls.flat().join("\n")).toContain('{"msg":"go_no_offer"}');
    } finally {
      await changeCatalog({ kind: "status", offerId: "007", active: true });
    }
  });

  it("OFF-11 a double press makes two clicks", async () => {
    const cookie = newCookie();
    const { queue } = captureQueue();
    const visit = await completeVisit(cookie, queue, "asia");
    const first = await go(cookie, `?prelander=demo&visit=${visit}`, queue);
    const second = await go(cookie, `?prelander=demo&visit=${visit}`, queue);
    expect(first.status).toBe(302);
    expect(second.status).toBe(302);
    const ids = [clickIdOf(first), clickIdOf(second)];
    expect(ids[0]).not.toBe(ids[1]);
    const stored = (await stateOf(cookie)).me.clicks.map((c) => c.click_id);
    expect(stored.toSorted()).toEqual(ids.toSorted());
  });

  it("OFF-11 HEAD and an unknown prelander write nothing", async () => {
    const cookie = newCookie();
    const { queue, sent } = captureQueue();
    const visit = await completeVisit(cookie, queue, "asia");
    sent.length = 0;
    const head = await go(cookie, `?prelander=demo&visit=${visit}`, queue, "HEAD");
    expect(head.status).toBe(405);
    const unknown = await go(cookie, `?prelander=nope&visit=${visit}`, queue);
    expect(unknown.status).toBe(404);
    expect((await stateOf(cookie)).me.clicks).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("QZ-4 a malformed visit is replaced", async () => {
    const cookie = newCookie();
    const { queue, sent } = captureQueue();
    await completeVisit(cookie, queue, "asia");
    sent.length = 0;
    const res = await go(cookie, `?prelander=demo&visit=${encodeURIComponent("bad id!")}`, queue);
    expect(res.status).toBe(302);
    const row = await clickRow(clickIdOf(res));
    expect(row?.visit_id).toMatch(UUID_V4);
    expect(sent[0]?.body.visit_id).toBe(row?.visit_id);
  });

  it("NFR-1 one full visit produces nine events", async () => {
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
      { EVENTS_QUEUE: queue },
    );
    expect(done.status).toBe(200);
    const res = await go(cookie, `?prelander=demo&visit=${visit}`, queue);
    const clickId = clickIdOf(res);

    await deliver(sent.map((s) => s.body));
    const rows = await eventsOf(idOf(cookie));
    expect(rows).toHaveLength(9);
    expect(new Set(rows.map((r) => r.visit_id))).toEqual(new Set([visit]));
    const clicks = rows.filter((r) => r.type === "offer_click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.payload).toEqual({
      click_id: clickId,
      offer_id: "003",
      catalog_version: expect.any(Number),
      reason: "best_epu",
    });
    // Two requests can share a millisecond, so "last" is checked as "no event after it".
    const { results } = await env.EVENTS.prepare(
      "SELECT type, received_at FROM events WHERE user_id = ?",
    )
      .bind(idOf(cookie))
      .all<{ type: string; received_at: number }>();
    const clickAt = results.find((r) => r.type === "offer_click")!.received_at;
    expect(results.every((r) => r.received_at <= clickAt)).toBe(true);
  });
});
