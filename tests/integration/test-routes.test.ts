import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { prelanderFlows } from "../../src/domain/prelanders.ts";
import { storedEvent, deliver } from "../fixtures/events.ts";
import { getPath, newCookie, postComplete } from "../fixtures/http.ts";

type State = {
  me: {
    user_id: string;
    user: { email_hash: string } | null;
    answers: Record<string, unknown>;
    events: { event_id: string; type: string; seq: number | null }[];
  };
  catalog: { version: number; offers: number };
  counts: { users: number; clicks: number; conversions: number; events: number };
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
});
