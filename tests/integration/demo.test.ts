import { describe, expect, it } from "vitest";
import { buildPostbackRequest } from "../../scripts/lib/postback-request.ts";
import { browserEvent } from "../fixtures/event-bodies.ts";
import { call, captureQueue, deliver, postEvent } from "../fixtures/events.ts";
import { TEST_PARTNER_SECRETS } from "../fixtures/facts.ts";
import { newCookie } from "../fixtures/http.ts";
import { userWithClick } from "../fixtures/postback.ts";

type State = {
  me: { conversions: { type: string; offer_id: string; transaction_id: string }[] };
};

const SECRET = TEST_PARTNER_SECRETS.get("partnerA")!;
const visitIdOf = (html: string) => html.match(/data-visit="([^"]+)"/)?.[1] ?? "";
const clickIdOf = (res: Response) =>
  /[?&]click_id=([0-9a-f]{32})$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";

// Builds the request the way scripts/postback.ts does and sends it to the app.
async function send(
  type: "lead" | "purchase",
  clickId: string,
  transactionId: string,
  extra: { payout?: string; currency?: string } = {},
): Promise<Response> {
  const { url, init } = await buildPostbackRequest({
    base: "https://example.com",
    partner: "partnerA",
    type,
    clickId,
    transactionId,
    secret: SECRET,
    nowMs: Date.now(),
    ...extra,
  });
  return call(new URL(url).pathname, {
    method: init.method as string,
    body: init.body as string,
    headers: init.headers as Record<string, string>,
  });
}

const stateOf = async (cookie: string) =>
  (await (await call("/__test/state", { cookie })).json()) as State;

describe("the postback helper", () => {
  it("PB-7 helper produces a signature the endpoint accepts", async () => {
    const { clickId } = await userWithClick();
    const res = await send("lead", clickId, `L-${crypto.randomUUID()}`);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "accepted" });
  });

  it("PB-7 the request is signed, JSON and never follows a redirect", async () => {
    const { url, init } = await buildPostbackRequest({
      base: "https://example.com/",
      partner: "partnerA",
      type: "purchase",
      clickId: "abc",
      transactionId: "P1",
      secret: SECRET,
      nowMs: 1762300000000,
      payout: "25.00",
      currency: "USD",
    });
    expect(url).toBe("https://example.com/postback/v1/partnerA");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["X-Signature"]).toMatch(/^t=1762300000,v1=[0-9a-f]{64}$/);
    expect(JSON.parse(init.body as string)).toEqual({
      type: "purchase",
      click_id: "abc",
      transaction_id: "P1",
      occurred_at: "2025-11-04T23:46:40.000Z",
      payout: "25.00",
      currency: "USD",
    });
  });
});

describe.sequential("the demo path", () => {
  const cookie = newCookie();
  const { queue } = captureQueue();
  const leadTxn = `L-${crypto.randomUUID()}`;
  let firstClick = "";

  it("DEMO-3 a test Lead for that user's transition", async () => {
    const page = await call("/p/demo", { cookie }, { EVENTS_QUEUE: queue });
    const visit = visitIdOf(await page.text());
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
    const go = await call(`/go?prelander=demo&visit=${visit}`, { cookie }, { EVENTS_QUEUE: queue });
    expect(go.status).toBe(302);
    firstClick = clickIdOf(go);
    expect(firstClick).not.toBe("");

    const lead = await send("lead", firstClick, leadTxn);
    expect(lead.status).toBe(202);
    expect((await stateOf(cookie)).me.conversions).toEqual([
      { type: "lead", offer_id: "003", transaction_id: leadTxn },
    ]);
  });

  it("DEMO-4 the same user returns without the quiz", async () => {
    const back = await call("/p/demo", { cookie }, { EVENTS_QUEUE: queue });
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toMatch(
      /^https:\/\/asia-connect\.example\/\?click_id=[0-9a-f]{32}$/,
    );
    const secondClick = clickIdOf(back);
    expect(secondClick).not.toBe("");
    expect(secondClick).not.toBe(firstClick);
  });

  it("DEMO-6 repeating a postback does not double the numbers", async () => {
    const purchaseTxn = `DEMO-P1-${crypto.randomUUID()}`;
    const extra = { payout: "25.00", currency: "USD" };
    const first = await send("purchase", firstClick, purchaseTxn, extra);
    expect(first.status).toBe(202);
    const again = await send("purchase", firstClick, purchaseTxn, extra);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "duplicate" });
    expect((await send("lead", firstClick, leadTxn)).status).toBe(200);

    const conversions = (await stateOf(cookie)).me.conversions;
    expect(conversions.map((c) => c.type).toSorted()).toEqual(["lead", "purchase"]);
  });
});

describe("the Lead return", () => {
  it("A-4 Lead is used by the very next entry", async () => {
    const { cookie, clickId } = await userWithClick();
    expect((await send("lead", clickId, `L-${crypto.randomUUID()}`)).status).toBe(202);
    const { queue } = captureQueue();
    const entry = await call("/p/demo", { cookie }, { EVENTS_QUEUE: queue });
    expect(entry.status).toBe(302);
    expect(clickIdOf(entry)).not.toBe(clickId);
  });
});

const today = () => new Date().toISOString().slice(0, 10);

const readReport = async (): Promise<Record<string, number>> => {
  const query = new URLSearchParams({ prelander: "demo", from: today(), to: today() });
  const res = await call(`/api/report?${query}`, {});
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, number>;
};

describe.sequential("the report through the demo", () => {
  it("DEMO-5 a Purchase changes the report", async () => {
    const { clickId } = await userWithClick();
    expect((await send("lead", clickId, `L-${crypto.randomUUID()}`)).status).toBe(202);
    const before = await readReport();
    const extra = { payout: "25.00", currency: "USD" };
    expect((await send("purchase", clickId, `P-${crypto.randomUUID()}`, extra)).status).toBe(202);
    const after = await readReport();
    expect(after["purchase"]).toBe(before["purchase"]! + 1);
    expect(after["lead"]).toBe(before["lead"]);
  });

  it("DEMO-7 the demo moves the report by the expected cells", async () => {
    const a = await readReport();

    const cookie = newCookie();
    const { queue, sent } = captureQueue();
    const env = { EVENTS_QUEUE: queue };
    const visit = visitIdOf(await (await call("/p/demo", { cookie }, env)).text());
    expect(visit).not.toBe("");

    let seq = 1;
    const post = async (overrides: Record<string, unknown>) =>
      (await postEvent(browserEvent({ visit_id: visit, seq: seq++, ...overrides }), cookie, env))
        .status;
    for (const step of [1, 2, 3]) {
      expect(await post({ type: "step_viewed", payload: { step, prefilled: false } })).toBe(202);
    }
    const answers = [
      { step: 1, question_key: "gender", value: "women" },
      { step: 2, question_key: "ethnicity", value: "asia" },
    ];
    for (const payload of answers) {
      expect(await post({ type: "step_answered", payload })).toBe(202);
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
      env,
    );
    expect(done.status).toBe(200);
    const go = await call(`/go?prelander=demo&visit=${visit}`, { cookie }, env);
    expect(go.status).toBe(302);
    const clickId = clickIdOf(go);
    expect(clickId).not.toBe("");

    expect((await send("lead", clickId, `L-${crypto.randomUUID()}`)).status).toBe(202);
    expect((await call("/p/demo", { cookie }, env)).status).toBe(302);
    const txn = `P-${crypto.randomUUID()}`;
    expect((await send("purchase", clickId, txn)).status).toBe(202);
    expect((await send("purchase", clickId, txn)).status).toBe(200);

    await deliver(sent.map((m) => m.body));
    const b = await readReport();
    const delta = (key: string) => b[key]! - a[key]!;
    expect({
      visits: delta("visits"),
      started: delta("started"),
      step_1: delta("step_1"),
      step_2: delta("step_2"),
      step_3: delta("step_3"),
      completed: delta("completed"),
      went_to_offer: delta("went_to_offer"),
      transitions: delta("transitions"),
      lead: delta("lead"),
      purchase: delta("purchase"),
    }).toEqual({
      visits: 2,
      started: 1,
      step_1: 1,
      step_2: 1,
      step_3: 1,
      completed: 1,
      went_to_offer: 1,
      transitions: 2,
      lead: 1,
      purchase: 1,
    });
  });
});
