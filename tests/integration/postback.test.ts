import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertClick } from "../../src/db/clicks.ts";
import { newClickId } from "../../src/domain/clicks.ts";
import { derivedEventId } from "../../src/events/envelope.ts";
import { changeCatalog } from "../fixtures/catalog.ts";
import { call, captureQueue, deliver, eventsOf, failingQueue } from "../fixtures/events.ts";
import { TEST_PARTNER_SECRETS } from "../fixtures/facts.ts";
import { failingBucket } from "../fixtures/files.ts";
import { newCookie } from "../fixtures/http.ts";
import {
  conversionsOf,
  currentCatalogVersion,
  deleteTestPartner,
  insertTestPartner,
  leadBody,
  postback,
  quarantineOf,
  signatureHeader,
  userWithClick,
} from "../fixtures/postback.ts";

type State = {
  me: { conversions: { type: string; offer_id: string; transaction_id: string }[] };
};

const idOf = (cookie: string) => cookie.slice(4);
const SECRET_A = TEST_PARTNER_SECRETS.get("partnerA")!;
const SECRET_B = TEST_PARTNER_SECRETS.get("partnerB")!;

const stateOf = async (cookie: string) =>
  (await (await call("/__test/state", { cookie })).json()) as State;

const clickRow = (clickId: string) =>
  env.FACTS.prepare("SELECT user_id, visit_id, prelander_id FROM clicks WHERE click_id = ?")
    .bind(clickId)
    .first<{ user_id: string | null; visit_id: string; prelander_id: string }>();

// Runs `send` and checks that the click's conversions and the transaction's quarantine rows did
// not change. The caller checks that its captured Queue stayed empty.
async function unchanged(
  clickId: string,
  txn: string,
  send: () => Promise<Response>,
): Promise<Response> {
  const before = { c: await conversionsOf(clickId), q: await quarantineOf(txn) };
  const res = await send();
  expect({ c: await conversionsOf(clickId), q: await quarantineOf(txn) }).toEqual(before);
  return res;
}

const uniqueId = (prefix: string) => `${prefix}${crypto.randomUUID().slice(0, 8)}`;

// A Lead padded to exactly `size` bytes; every character is ASCII.
function padded(clickId: string, size: number): string {
  const body = leadBody(clickId);
  const base = JSON.stringify({ ...body, pad: "" }).length;
  const raw = JSON.stringify({ ...body, pad: "x".repeat(size - base) });
  if (new TextEncoder().encode(raw).length !== size) throw new Error("padding is off");
  return raw;
}

const UNAUTHORISED = { status: 401, body: { error: "unauthorized" }, sent: 0, unchanged: true };

// Sends a Lead for a fresh user's click and reports what came back and whether anything changed.
async function sendUnauthorised(
  send: (body: Record<string, unknown>, envOverride: Partial<Env>) => Promise<Response>,
): Promise<{ status: number; body: unknown; sent: number; unchanged: boolean }> {
  const user = await userWithClick();
  const { queue, sent } = captureQueue();
  const body = leadBody(user.clickId);
  const txn = body.transaction_id as string;
  const before = { c: await conversionsOf(user.clickId), q: await quarantineOf(txn) };
  const res = await send(body, { EVENTS_QUEUE: queue });
  const after = { c: await conversionsOf(user.clickId), q: await quarantineOf(txn) };
  return {
    status: res.status,
    body: await res.json(),
    sent: sent.length,
    unchanged: JSON.stringify(before) === JSON.stringify(after),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("POST /postback/v1/:partner", () => {
  it("PB-1 signed lead is accepted", async () => {
    const user = await userWithClick();
    const { queue, sent } = captureQueue();
    const body = leadBody(user.clickId);
    const res = await postback("partnerA", body, {}, { EVENTS_QUEUE: queue });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "accepted" });
    expect(res.headers.get("set-cookie")).toBeNull();

    const rows = await conversionsOf(user.clickId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      partner_id: "partnerA",
      type: "lead",
      transaction_id: body.transaction_id,
      occurred_at: Date.parse(body.occurred_at as string),
      payout: null,
      currency: null,
    });

    const click = await clickRow(user.clickId);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.contentType).toBe("json");
    expect(sent[0]?.body).toMatchObject({
      event_id: await derivedEventId(["partnerA", "lead", body.transaction_id as string]),
      type: "lead",
      user_id: idOf(user.cookie),
      visit_id: click!.visit_id,
      prelander_id: click!.prelander_id,
      payload: {
        click_id: user.clickId,
        offer_id: "003",
        partner_id: "partnerA",
        transaction_id: body.transaction_id,
        occurred_at: Date.parse(body.occurred_at as string),
        payout: null,
        currency: null,
      },
    });
  });

  it("PB-1 signed purchase is accepted", async () => {
    const user = await userWithClick();
    const { queue, sent } = captureQueue();
    const res = await postback(
      "partnerA",
      leadBody(user.clickId, { type: "purchase" }),
      {},
      { EVENTS_QUEUE: queue },
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "accepted" });
    expect((await conversionsOf(user.clickId)).map((r) => r.type)).toEqual(["purchase"]);
    expect(sent.map((s) => s.body.type)).toEqual(["purchase"]);
  });

  it("PB-1 unknown type is rejected", async () => {
    const user = await userWithClick();
    const { queue, sent } = captureQueue();
    const body = leadBody(user.clickId, { type: "refund" });
    const res = await unchanged(user.clickId, body.transaction_id as string, () =>
      postback("partnerA", body, {}, { EVENTS_QUEUE: queue }),
    );
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  for (const field of ["type", "click_id", "transaction_id", "occurred_at"]) {
    it(`PB-2 a missing required field is rejected: ${field}`, async () => {
      const user = await userWithClick();
      const { queue, sent } = captureQueue();
      const body = leadBody(user.clickId);
      const txn = body.transaction_id as string;
      delete body[field];
      const res = await unchanged(user.clickId, txn, () =>
        postback("partnerA", body, {}, { EVENTS_QUEUE: queue }),
      );
      expect(res.status).toBe(400);
      expect(sent).toHaveLength(0);
    });
  }

  it("PB-2 optional payout and currency accepted", async () => {
    const user = await userWithClick();
    const { queue, sent } = captureQueue();
    const body = leadBody(user.clickId, { type: "purchase", payout: "25.00", currency: "USD" });
    const res = await postback("partnerA", body, {}, { EVENTS_QUEUE: queue });
    expect(res.status).toBe(202);
    expect(await conversionsOf(user.clickId)).toEqual([
      expect.objectContaining({ payout: 25, currency: "USD" }),
    ]);
    expect(sent[0]?.body.payload).toMatchObject({ payout: "25.00", currency: "USD" });
  });

  it("PB-2 unknown extra field ignored", async () => {
    const user = await userWithClick();
    const { queue, sent } = captureQueue();
    const body = leadBody(user.clickId, { campaign: "spring", extra: { nested: true } });
    const res = await postback("partnerA", body, {}, { EVENTS_QUEUE: queue });
    expect(res.status).toBe(202);
    expect(await conversionsOf(user.clickId)).toHaveLength(1);
    expect(Object.keys(sent[0]!.body.payload).toSorted()).toEqual(
      [
        "click_id",
        "currency",
        "occurred_at",
        "offer_id",
        "partner_id",
        "payout",
        "transaction_id",
      ].toSorted(),
    );
  });

  it("PB-2 version is in the path", async () => {
    const user = await userWithClick();
    const raw = JSON.stringify(leadBody(user.clickId));
    const res = await call("/postback/v2/partnerA", {
      method: "POST",
      body: raw,
      headers: { "x-signature": await signatureHeader(SECRET_A, raw) },
    });
    expect(res.status).toBe(404);
    expect(await conversionsOf(user.clickId)).toHaveLength(0);
  });

  it("PB-3 R-11 no signature gives 401", async () => {
    const got = await sendUnauthorised((body, e) =>
      postback("partnerA", body, { header: null }, e),
    );
    expect(got).toEqual(UNAUTHORISED);
  });

  it("PB-3 R-11 wrong signature gives 401", async () => {
    const got = await sendUnauthorised((body, e) =>
      postback("partnerA", body, { secret: "not-the-partner-secret" }, e),
    );
    expect(got).toEqual(UNAUTHORISED);
  });

  it("PB-3 R-11 stale timestamp gives 401", async () => {
    const sixMinutesAgo = Math.floor(Date.now() / 1000) - 6 * 60;
    const got = await sendUnauthorised((body, e) =>
      postback("partnerA", body, { t: sixMinutesAgo }, e),
    );
    expect(got).toEqual(UNAUTHORISED);
  });

  it("PB-3 R-11 signature from another partner gives 401", async () => {
    const got = await sendUnauthorised((body, e) =>
      postback("partnerA", body, { secret: SECRET_B }, e),
    );
    expect(got).toEqual(UNAUTHORISED);
  });

  it("PB-3 R-11 unknown partner gives 401", async () => {
    const got = await sendUnauthorised((body, e) =>
      postback("partnerZ", body, { secret: SECRET_A }, e),
    );
    expect(got).toEqual(UNAUTHORISED);
  });

  it("PB-3 an inactive partner gives 401", async () => {
    const id = uniqueId("partnerI");
    await insertTestPartner({ id, active: false, current: "inactive-secret" });
    try {
      const got = await sendUnauthorised((body, e) =>
        postback(id, body, { secret: "inactive-secret" }, e),
      );
      expect(got).toEqual(UNAUTHORISED);
    } finally {
      await deleteTestPartner(id);
    }
  });

  it("PB-3 rotation: signatures with the current and the previous secret are both accepted", async () => {
    const id = uniqueId("partnerR");
    await insertTestPartner({ id, active: true, current: "r-current", previous: "r-previous" });
    try {
      for (const secret of ["r-current", "r-previous"]) {
        const { queue, sent } = captureQueue();
        const body = leadBody(newClickId());
        const res = await postback(id, body, { secret }, { EVENTS_QUEUE: queue });
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ status: "quarantined" });
        expect(await quarantineOf(body.transaction_id as string)).toHaveLength(1);
        expect(sent).toHaveLength(0);
      }
      const wrong = await postback(id, leadBody(newClickId()), { secret: "r-older" });
      expect(wrong.status).toBe(401);
    } finally {
      await deleteTestPartner(id);
    }
  });

  it("PB-4 lead lands on the click's user and offer", async () => {
    const a = await userWithClick({ gender: "women", ethnicity: "asia" });
    const b = await userWithClick({ gender: "women", ethnicity: "europe" });
    const { queue } = captureQueue();
    const body = leadBody(a.clickId);
    const res = await postback("partnerA", body, {}, { EVENTS_QUEUE: queue });
    expect(res.status).toBe(202);
    expect((await stateOf(a.cookie)).me.conversions).toEqual([
      { type: "lead", offer_id: "003", transaction_id: body.transaction_id },
    ]);
    expect((await stateOf(b.cookie)).me.conversions).toEqual([]);
    expect(await conversionsOf(b.clickId)).toHaveLength(0);
  });

  it("PB-4 Q-11 unknown click is quarantined with 202", async () => {
    const { queue, sent } = captureQueue();
    const clickId = newClickId();
    const body = leadBody(clickId);
    const raw = JSON.stringify(body);
    const res = await postback("partnerA", body, { raw }, { EVENTS_QUEUE: queue });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "quarantined" });
    expect(await quarantineOf(body.transaction_id as string)).toEqual([
      {
        partner_id: "partnerA",
        type: "lead",
        transaction_id: body.transaction_id,
        click_id: clickId,
        body: raw,
        reason: "unknown_click",
      },
    ]);
    expect(await conversionsOf(clickId)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("PB-4 R-6 quarantined postback matches once the click exists", async () => {
    const { queue, sent } = captureQueue();
    const clickId = newClickId();
    const body = leadBody(clickId);
    const first = await postback("partnerA", body, {}, { EVENTS_QUEUE: queue });
    expect(await first.json()).toEqual({ status: "quarantined" });

    await insertClick(env.FACTS, {
      clickId,
      userId: null,
      offerId: "003",
      catalogVersion: await currentCatalogVersion(),
      prelanderId: "demo",
      visitId: crypto.randomUUID(),
      reason: "best_epu",
      createdAt: Date.now(),
    });
    const again = await postback("partnerA", body, {}, { EVENTS_QUEUE: queue });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ status: "accepted" });
    expect(await conversionsOf(clickId)).toHaveLength(1);
    expect(sent.map((s) => s.body.type)).toEqual(["lead"]);
  });

  it("PB-4 Q-24 offer mismatch is rejected", async () => {
    const user = await userWithClick({ gender: "women", ethnicity: "europe" });
    const { queue, sent } = captureQueue();
    const body = leadBody(user.clickId);
    const res = await unchanged(user.clickId, body.transaction_id as string, () =>
      postback("partnerA", body, {}, { EVENTS_QUEUE: queue }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "click_partner_mismatch" });
    expect(sent).toHaveLength(0);
  });

  it("PB-4 Q-24 lead on a disabled offer is counted without a redirect right", async () => {
    const user = await userWithClick();
    const { queue } = captureQueue();
    try {
      await changeCatalog({ kind: "status", offerId: "003", active: false });
      const res = await postback("partnerA", leadBody(user.clickId), {}, { EVENTS_QUEUE: queue });
      expect(res.status).toBe(202);
      expect((await stateOf(user.cookie)).me.conversions).toHaveLength(1);
      const entry = await call("/p/demo", { cookie: user.cookie }, { EVENTS_QUEUE: queue });
      // Rule 3: a Lead only on a disabled offer gives no Lead return; the answers pick 001.
      expect(entry.status).toBe(302);
      expect(entry.headers.get("location")).toMatch(/^https:\/\/asia-women\.example\//);
    } finally {
      await changeCatalog({ kind: "status", offerId: "003", active: true });
    }
  });

  it("PB-4 a lead for a click without a user is accepted", async () => {
    const clickId = newClickId();
    await insertClick(env.FACTS, {
      clickId,
      userId: null,
      offerId: "003",
      catalogVersion: await currentCatalogVersion(),
      prelanderId: "demo",
      visitId: crypto.randomUUID(),
      reason: "best_epu",
      createdAt: Date.now(),
    });
    const { queue, sent } = captureQueue();
    const res = await postback("partnerA", leadBody(clickId), {}, { EVENTS_QUEUE: queue });
    expect(res.status).toBe(202);
    expect(await conversionsOf(clickId)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.user_id).toBeNull();
  });

  it("PB-5 R-4 same postback twice counts once", async () => {
    const user = await userWithClick();
    const { queue, sent } = captureQueue();
    const raw = JSON.stringify(leadBody(user.clickId));
    const header = await signatureHeader(SECRET_A, raw);
    const first = await postback("partnerA", null, { raw, header }, { EVENTS_QUEUE: queue });
    const second = await postback("partnerA", null, { raw, header }, { EVENTS_QUEUE: queue });
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: "duplicate" });
    expect(await conversionsOf(user.clickId)).toHaveLength(1);

    expect(sent).toHaveLength(2);
    expect(sent[0]?.body.event_id).toBe(sent[1]?.body.event_id);
    await deliver(sent.map((s) => s.body));
    const leads = (await eventsOf(idOf(user.cookie))).filter((e) => e.type === "lead");
    expect(leads).toHaveLength(1);
  });

  it("PB-5 two purchases with different transaction ids count twice", async () => {
    const user = await userWithClick();
    const { queue } = captureQueue();
    for (const txn of ["P-1", "P-2"].map((p) => `${p}-${crypto.randomUUID()}`)) {
      const res = await postback(
        "partnerA",
        leadBody(user.clickId, { type: "purchase", transaction_id: txn }),
        {},
        { EVENTS_QUEUE: queue },
      );
      expect(res.status).toBe(202);
    }
    expect((await conversionsOf(user.clickId)).map((r) => r.type)).toEqual([
      "purchase",
      "purchase",
    ]);
  });

  it("PB-5 Q-23 second lead for the same user and offer is stored", async () => {
    const user = await userWithClick();
    const { queue } = captureQueue();
    const first = await postback("partnerA", leadBody(user.clickId), {}, { EVENTS_QUEUE: queue });
    const second = await postback("partnerA", leadBody(user.clickId), {}, { EVENTS_QUEUE: queue });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect((await conversionsOf(user.clickId)).map((r) => r.type)).toEqual(["lead", "lead"]);
  });

  it("PB-5 R-5 missing transaction id is handled as the design says", async () => {
    const user = await userWithClick();
    const { queue, sent } = captureQueue();
    const body = leadBody(user.clickId);
    const txn = body.transaction_id as string;
    delete body.transaction_id;
    const res = await unchanged(user.clickId, txn, () =>
      postback("partnerA", body, {}, { EVENTS_QUEUE: queue }),
    );
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("PB-5 the postback event retried after a queue failure reaches analytics once", async () => {
    const user = await userWithClick();
    const raw = JSON.stringify(leadBody(user.clickId));
    const failed = await postback(
      "partnerA",
      null,
      { raw },
      { EVENTS_QUEUE: failingQueue(), EVENTS_BUCKET: failingBucket() },
    );
    expect(failed.status).toBe(503);
    expect(failed.headers.get("retry-after")).toBe("30");
    expect(await conversionsOf(user.clickId)).toHaveLength(1);

    const { queue, sent } = captureQueue();
    const retry = await postback("partnerA", null, { raw }, { EVENTS_QUEUE: queue });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ status: "duplicate" });
    expect(sent).toHaveLength(1);
    await deliver([sent[0]!.body, sent[0]!.body]);
    const leads = (await eventsOf(idOf(user.cookie))).filter((e) => e.type === "lead");
    expect(leads).toHaveLength(1);
    expect(await conversionsOf(user.clickId)).toHaveLength(1);
  });

  it("PB-6 a quiz email is not a Lead", async () => {
    const cookie = newCookie();
    const { queue } = captureQueue();
    const done = await call(
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
      { EVENTS_QUEUE: queue },
    );
    expect(done.status).toBe(200);
    expect((await stateOf(cookie)).me.conversions).toEqual([]);
    const entry = await call("/p/demo", { cookie }, { EVENTS_QUEUE: queue });
    expect(entry.status).toBe(200);
    expect(await entry.text()).toContain("data-email-form");
  });

  describe("PB-8 malformed postback changes nothing", () => {
    type Case = { body: unknown; raw?: string; contentType?: string };
    const cases: [string, (clickId: string) => Case, string][] = [
      ["invalid JSON", () => ({ body: null, raw: '{"type":"lead",' }), "invalid_body"],
      [
        "content-type text/plain",
        (c) => ({ body: leadBody(c), contentType: "text/plain" }),
        "unsupported_content_type",
      ],
      ["a body of 16,385 bytes", (c) => ({ body: null, raw: padded(c, 16_385) }), "too_large"],
      ["unknown type", (c) => ({ body: leadBody(c, { type: "chargeback" }) }), "invalid_body"],
      ["negative payout", (c) => ({ body: leadBody(c, { payout: "-1.00" }) }), "invalid_body"],
      [
        "occurred_at without a time zone",
        (c) => ({ body: leadBody(c, { occurred_at: "2026-11-05T12:00:00" }) }),
        "invalid_body",
      ],
    ];

    for (const [name, make, error] of cases) {
      it(`PB-8 malformed postback changes nothing: ${name}`, async () => {
        const user = await userWithClick();
        const { queue, sent } = captureQueue();
        const { body, ...opts } = make(user.clickId);
        const fields = (body ?? {}) as Record<string, unknown>;
        const txn = (fields.transaction_id as string | undefined) ?? "none";
        const res = await unchanged(user.clickId, txn, () =>
          postback("partnerA", body, opts, { EVENTS_QUEUE: queue }),
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error });
        expect(sent).toHaveLength(0);
      });
    }
  });

  it("PB-8 D1 unavailable gives 503", async () => {
    const user = await userWithClick();
    const { queue, sent } = captureQueue();
    const broken = {
      prepare: () => {
        throw new Error("D1 unavailable");
      },
      batch: async () => {
        throw new Error("D1 unavailable");
      },
    } as unknown as D1Database;
    const res = await postback(
      "partnerA",
      leadBody(user.clickId),
      {},
      { EVENTS_QUEUE: queue, FACTS: broken },
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(await conversionsOf(user.clickId)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("R-12 postback logs carry no body, signature or transaction id", async () => {
    const log = vi.spyOn(console, "log");
    const user = await userWithClick();
    log.mockClear();
    const { queue } = captureQueue();
    const body = leadBody(user.clickId);
    const raw = JSON.stringify(body);
    const header = await signatureHeader(SECRET_A, raw);
    const v1 = header.split("v1=")[1]!;
    await postback("partnerA", null, { raw, header }, { EVENTS_QUEUE: queue });
    await postback("partnerA", null, { raw, header }, { EVENTS_QUEUE: queue });
    const badRaw = JSON.stringify({ ...body, payout: "-1" });
    await postback("partnerA", null, { raw: badRaw }, { EVENTS_QUEUE: queue });
    await postback("partnerA", null, { raw, header: `t=1,v1=${v1}` }, { EVENTS_QUEUE: queue });

    const lines = log.mock.calls.flat().map(String);
    const postbackLines = lines.map((l) => JSON.parse(l)).filter((l) => l.msg === "postback");
    expect(postbackLines.map((l) => l.outcome)).toEqual([
      "accepted",
      "duplicate",
      "rejected",
      "rejected",
    ]);
    for (const line of lines) {
      expect(line).not.toContain(body.transaction_id as string);
      expect(line).not.toContain(v1);
      expect(line).not.toContain(user.clickId);
      expect(line).not.toContain(SECRET_A);
    }
  });

  it("TEST-3 R-4 a redelivered Lead and a second real Purchase", async () => {
    const user = await userWithClick();
    const { queue } = captureQueue();
    const suffix = crypto.randomUUID();
    const lead = JSON.stringify(leadBody(user.clickId, { transaction_id: `T1-${suffix}` }));
    const statuses: number[] = [];
    for (const raw of [lead, lead]) {
      statuses.push((await postback("partnerA", null, { raw }, { EVENTS_QUEUE: queue })).status);
    }
    for (const txn of [`P1-${suffix}`, `P2-${suffix}`]) {
      const body = leadBody(user.clickId, { type: "purchase", transaction_id: txn });
      statuses.push((await postback("partnerA", body, {}, { EVENTS_QUEUE: queue })).status);
    }
    expect(statuses).toEqual([202, 200, 202, 202]);
    const types = (await conversionsOf(user.clickId)).map((r) => r.type);
    expect(types.filter((t) => t === "lead")).toHaveLength(1);
    expect(types.filter((t) => t === "purchase")).toHaveLength(2);
  });
});
