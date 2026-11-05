import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { prelanderFlows } from "../../src/domain/prelanders.ts";
import { call, storedEvent, deliver } from "../fixtures/events.ts";
import { cookieFrom, getPath, newCookie, postComplete } from "../fixtures/http.ts";

type State = {
  me: {
    user_id: string;
    user: { email_hash: string } | null;
    answers: Record<string, unknown>;
    events: { event_id: string; type: string; seq: number | null }[];
    clicks: { click_id: string; offer_id: string; reason: string; created_at: number }[];
    conversions: { type: string; offer_id: string; transaction_id: string }[];
  };
  catalog: { version: number; offers: number };
  counts: {
    users: number;
    clicks: number;
    conversions: number;
    events: number;
    quarantine: number;
  };
  partner_secrets_ok: boolean;
};

const complete = (cookie: string) =>
  postComplete(
    {
      prelander_id: "demo",
      answers: { gender: "women", ethnicity: "asia" },
      email: "user1@example.com",
    },
    cookie,
  );

const seed = (body: unknown, cookie?: string, override?: Partial<Env>) =>
  call(
    "/__test/seed",
    { method: "POST", body: JSON.stringify(body), ...(cookie === undefined ? {} : { cookie }) },
    override,
  );

describe("test routes", () => {
  it("ID-1 test state shows the caller's user id and no users row before completion", async () => {
    const cookie = newCookie();
    const res = await getPath("/__test/state", cookie);
    expect(res.status).toBe(200);
    const state = (await res.json()) as State;
    expect(state.me.user_id).toBe(cookie.slice(4));
    expect(state.me.user).toBeNull();
    expect(state.me.answers).toEqual({});
  });

  it("ID-4 test state lists the caller's events", async () => {
    const cookie = newCookie();
    const userId = cookie.slice(4);
    const later = storedEvent({ user_id: userId, seq: 2, received_at: 1762300000000 });
    const earlier = storedEvent({ user_id: userId, seq: 1, received_at: 1762300000000 });
    await deliver([later, earlier]);
    const state = (await (await getPath("/__test/state", cookie)).json()) as State;
    expect(state.me.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(state.me.events.map((e) => e.event_id)).toEqual([earlier.event_id, later.event_id]);
    expect(state.counts.events).toBeGreaterThanOrEqual(2);
  });

  it("R-12 test state never shows the email or its ciphertext", async () => {
    const cookie = newCookie();
    await complete(cookie);
    const text = await (await getPath("/__test/state", cookie)).text();
    expect(text).not.toContain("user1@example.com");
    expect(text).not.toContain("v1:");
    expect(text).not.toContain("email_enc");
    const state = JSON.parse(text) as State;
    expect(state.me.user?.email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(state.me.answers).toEqual({ gender: "women", ethnicity: "asia" });
  });

  it("R-12 test endpoints answer 404 in production", async () => {
    const app = createApp(prelanderFlows);
    const off = { TEST_ROUTES: "off" };
    expect((await getPath("/__test/state", undefined, app, off)).status).toBe(404);
    expect((await getPath("/__test/reset", undefined, app, off, "POST")).status).toBe(404);
  });

  it.each([
    ["ON", { TEST_ROUTES: "ON" }],
    ["empty", { TEST_ROUTES: "" }],
    // The variable is absent, not just empty; the cast is for exactOptionalPropertyTypes.
    ["missing", { TEST_ROUTES: undefined } as unknown as Partial<Env>],
  ] as const)("R-12 test endpoints answer 404 when TEST_ROUTES is %s", async (_label, override) => {
    const app = createApp(prelanderFlows);
    expect((await getPath("/__test/state", undefined, app, override)).status).toBe(404);
    expect((await getPath("/__test/reset", undefined, app, override, "POST")).status).toBe(404);
  });

  it("PB-3 test state confirms partner secrets decrypt under the worker key", async () => {
    const ok = (await (await getPath("/__test/state")).json()) as State;
    expect(ok.partner_secrets_ok).toBe(true);

    const app = createApp(prelanderFlows);
    const res = await getPath("/__test/state", undefined, app, {
      MASTER_KEY: btoa("another-test-only-key-32-bytes!!"),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as State).partner_secrets_ok).toBe(false);
  });

  it("DEMO-2 reset clears users and keeps the catalog", async () => {
    const cookie = newCookie();
    await complete(cookie);
    const reset = await getPath("/__test/reset", cookie, undefined, undefined, "POST");
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ ok: true });
    const row = await env.FACTS.prepare("SELECT id FROM users WHERE id = ?")
      .bind(cookie.slice(4))
      .first();
    expect(row).toBeNull();
    const state = (await (await getPath("/__test/state", cookie)).json()) as State;
    expect(state.catalog.offers).toBe(7);
    expect(state.counts.users).toBe(0);
  });

  describe("seed", () => {
    it("OFF-3 seed creates a user with answers and a Lead", async () => {
      const res = await seed({
        answers: { gender: "women", ethnicity: "asia" },
        leads: [{ offer_id: "001" }],
      });
      expect(res.status).toBe(200);
      const cookie = cookieFrom(res);
      expect(cookie).toMatch(/^uid=/);
      const out = (await res.json()) as { ok: boolean; clicks: string[] };
      expect(out.ok).toBe(true);
      expect(out.clicks).toHaveLength(1);
      expect(out.clicks[0]).toMatch(/^[0-9a-f]{32}$/);

      const state = (await (await getPath("/__test/state", cookie)).json()) as State;
      expect(state.me.answers).toEqual({ gender: "women", ethnicity: "asia" });
      expect(state.me.user).not.toBeNull();
      expect(state.me.clicks).toHaveLength(1);
      expect(state.me.clicks[0]).toMatchObject({
        click_id: out.clicks[0],
        offer_id: "001",
        reason: "best_epu",
      });
      expect(state.me.conversions).toHaveLength(1);
      expect(state.me.conversions[0]).toMatchObject({ type: "lead", offer_id: "001" });
      expect(state.me.conversions[0]?.transaction_id).toMatch(/^seed-/);
    });

    it("OFF-4 seeded Leads keep their array order", async () => {
      const res = await seed({ leads: [{ offer_id: "001" }, { offer_id: "004" }] });
      const userId = cookieFrom(res).slice(4);
      const { results } = await env.FACTS.prepare(
        `SELECT c.offer_id, v.accepted_at FROM conversions v
         JOIN clicks c ON c.click_id = v.click_id WHERE c.user_id = ?`,
      )
        .bind(userId)
        .all<{ offer_id: string; accepted_at: number }>();
      const at = (id: string) => results.find((r) => r.offer_id === id)!.accepted_at;
      expect(at("004")).toBeGreaterThan(at("001"));
    });

    it("OFF-3 seed keeps plain clicks after the Lead clicks and honours given times", async () => {
      const res = await seed({
        leads: [{ offer_id: "001", accepted_at: 1762300000000 }],
        clicks: [{ offer_id: "002", created_at: 1762200000000 }],
      });
      const out = (await res.json()) as { clicks: string[] };
      expect(out.clicks).toHaveLength(2);
      const state = (await (await getPath("/__test/state", cookieFrom(res))).json()) as State;
      const plain = state.me.clicks.find((c) => c.click_id === out.clicks[1]);
      expect(plain).toMatchObject({ offer_id: "002", created_at: 1762200000000 });
      expect(state.me.conversions).toHaveLength(1);
    });

    it("OFF-3 seed with an offer id outside the catalog or a bad body answers 400", async () => {
      expect((await seed({ leads: [{ offer_id: "999" }] })).status).toBe(400);
      expect((await seed({ leads: "x" })).status).toBe(400);
    });

    it("R-12 seeded user's email is not in the state", async () => {
      const res = await seed({ answers: { gender: "men" }, leads: [{ offer_id: "002" }] });
      const text = await (await getPath("/__test/state", cookieFrom(res))).text();
      expect(text).not.toContain("@");
      expect(text).not.toContain("email_enc");
      expect(text).not.toContain("v1:");
      expect((JSON.parse(text) as State).counts.quarantine).toBeTypeOf("number");
    });

    it("PB-3 seed answers 404 when test routes are off", async () => {
      const res = await seed({ leads: [{ offer_id: "001" }] }, undefined, { TEST_ROUTES: "off" });
      expect(res.status).toBe(404);
    });
  });
});
