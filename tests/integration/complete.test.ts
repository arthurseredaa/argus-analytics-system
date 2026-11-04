import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.ts";
import { decrypt, emailHash, importAesKey, importHmacKey } from "../../src/domain/crypto.ts";
import { prelanderFlows } from "../../src/domain/prelanders.ts";
import { newCookie, postComplete } from "../fixtures/http.ts";

type Chosen = { offer_id: string | null; reason: string };

const make = (gender: string, ethnicity: string, email = "user1@example.com") => ({
  prelander_id: "demo",
  answers: { gender, ethnicity },
  email,
});

const idOf = (cookie: string) => cookie.slice(4);
const userRow = (cookie: string) =>
  env.FACTS.prepare("SELECT * FROM users WHERE id = ?").bind(idOf(cookie)).first<{
    email_enc: string;
    email_hash: string;
    created_at: number;
    last_completed_at: number;
  }>();
const answerOf = async (cookie: string, key: string) =>
  (
    await env.FACTS.prepare("SELECT value FROM user_answers WHERE user_id = ? AND question_key = ?")
      .bind(idOf(cookie), key)
      .first<{ value: string }>()
  )?.value;

const spyConsole = () => [
  vi.spyOn(console, "log"),
  vi.spyOn(console, "error"),
  vi.spyOn(console, "warn"),
];

afterEach(() => vi.restoreAllMocks());

describe("POST /api/complete", () => {
  it("DEMO-2 new user gets 003 for women+asia", async () => {
    const res = await postComplete(make("women", "asia"), newCookie());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      offer_id: "003",
      name: "Asia Connect",
      url: "https://asia-connect.example",
      reason: "best_epu",
      catalog_version: expect.any(Number),
    });
  });

  it("OFF-10 complete returns name and url of the chosen offer", async () => {
    const res = await postComplete(make("men", "europe"), newCookie());
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      offer_id: "005",
      name: "Europe Connect",
      url: "https://europe-connect.example",
    });
    expect(Object.keys(json).toSorted()).toEqual([
      "catalog_version",
      "name",
      "offer_id",
      "reason",
      "url",
    ]);
  });

  it.each(["women", "men"])("QZ-1 accepts %s", async (gender) => {
    const cookie = newCookie();
    expect((await postComplete(make(gender, "asia"), cookie)).status).toBe(200);
    expect(await answerOf(cookie, "gender")).toBe(JSON.stringify(gender));
  });

  it("QZ-1 rejects other values and stores nothing", async () => {
    const cookie = newCookie();
    const res = await postComplete(make("robots", "asia"), cookie);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body", fields: ["answers.gender"] });
    expect(await userRow(cookie)).toBeNull();
  });

  it("QZ-2 accepts asia, europe and latam", async () => {
    for (const ethnicity of ["asia", "europe", "latam"]) {
      const cookie = newCookie();
      expect((await postComplete(make("women", ethnicity), cookie)).status).toBe(200);
      expect(await answerOf(cookie, "ethnicity")).toBe(JSON.stringify(ethnicity));
    }
  });

  it("QZ-2 rejects africa", async () => {
    const cookie = newCookie();
    const res = await postComplete(make("women", "africa"), cookie);
    expect(res.status).toBe(400);
    expect(await userRow(cookie)).toBeNull();
  });

  it("QZ-3 same answers with different emails give the same offer", async () => {
    const c1 = newCookie();
    const c2 = newCookie();
    const r1 = (await (
      await postComplete(make("women", "asia", "user1@example.com"), c1)
    ).json()) as Chosen;
    const r2 = (await (
      await postComplete(make("women", "asia", "user2@example.com"), c2)
    ).json()) as Chosen;
    expect(r1).toMatchObject({ offer_id: "003", reason: "best_epu" });
    expect(r2).toMatchObject({ offer_id: "003", reason: "best_epu" });
    expect((await userRow(c1))!.email_hash).not.toBe((await userRow(c2))!.email_hash);
  });

  it("QZ-3 row 26 email creates no Lead", async () => {
    const cookie = newCookie();
    await postComplete(make("women", "asia"), cookie);
    const leads = await env.FACTS.prepare(
      `SELECT c.offer_id, v.accepted_at FROM conversions v
       JOIN clicks c ON c.click_id = v.click_id
       WHERE c.user_id = ?1 AND v.type = 'lead'`,
    )
      .bind(idOf(cookie))
      .all();
    expect(leads.results).toHaveLength(0);
    const clicks = await env.FACTS.prepare("SELECT COUNT(*) AS n FROM clicks WHERE user_id = ?")
      .bind(idOf(cookie))
      .first<{ n: number }>();
    expect(clicks!.n).toBe(0);
  });

  it("DEMO-8 email is stored encrypted", async () => {
    const cookie = newCookie();
    await postComplete(make("women", "asia", "user1@example.com"), cookie);
    const row = (await userRow(cookie))!;
    expect(row.email_enc.startsWith("v1:")).toBe(true);
    expect(row.email_enc).not.toContain("user1");
    const aes = await importAesKey(env.MASTER_KEY, "MASTER_KEY");
    expect(await decrypt(aes, row.email_enc)).toBe("user1@example.com");
    const hmac = await importHmacKey(env.EMAIL_HASH_KEY, "EMAIL_HASH_KEY");
    expect(row.email_hash).toBe(await emailHash(hmac, "user1@example.com"));
  });

  it("QZ-4 Q-4 latest completion received wins", async () => {
    const cookie = newCookie();
    await postComplete(make("women", "asia", "user1@example.com"), cookie);
    const first = (await userRow(cookie))!;
    await new Promise((r) => setTimeout(r, 5));
    await postComplete(make("men", "asia", "user2@example.com"), cookie);
    const second = (await userRow(cookie))!;
    expect(await answerOf(cookie, "gender")).toBe('"men"');
    const aes = await importAesKey(env.MASTER_KEY, "MASTER_KEY");
    expect(await decrypt(aes, second.email_enc)).toBe("user2@example.com");
    expect(second.created_at).toBe(first.created_at);
    expect(second.last_completed_at).toBeGreaterThan(first.last_completed_at);
    const n = await env.FACTS.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?")
      .bind(idOf(cookie))
      .first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("QZ-1 unknown prelander in the body is rejected", async () => {
    const cookie = newCookie();
    const res = await postComplete({ ...make("women", "asia"), prelander_id: "nope" }, cookie);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown_prelander" });
    expect(await userRow(cookie)).toBeNull();
  });

  it("QZ-1 an email of 300 characters is rejected", async () => {
    const cookie = newCookie();
    const email = `${"a".repeat(290)}@example.com`;
    const res = await postComplete(make("women", "asia", email), cookie);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body", fields: ["email"] });
    expect(await userRow(cookie)).toBeNull();
  });

  it("R-12 malformed completion body with an email is rejected without logging the email", async () => {
    const spies = spyConsole();
    const app = createApp(prelanderFlows);
    const cookie = newCookie();
    const cut = '{"answers":{"gender":"women"},"email":"user2@example.com"';
    const r1 = await postComplete(cut, cookie, app);
    const r2 = await postComplete(make("women", "asia", "user2@example"), cookie, app);
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);
    const texts = [await r1.text(), await r2.text()];
    const logged = spies.flatMap((s) => s.mock.calls.flat().map(String));
    for (const t of [...texts, ...logged]) {
      expect(t).not.toContain("user2@example");
      expect(t).not.toContain(idOf(cookie));
    }
  });

  it("R-12 an answer key holding an email is not echoed or logged", async () => {
    const spies = spyConsole();
    const app = createApp(prelanderFlows);
    const cookie = newCookie();
    const res = await postComplete(
      {
        prelander_id: "demo",
        answers: { gender: "women", ethnicity: "asia", "user2@example.com": "x" },
        email: "user1@example.com",
      },
      cookie,
      app,
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "invalid_body", fields: ["answers.<unknown>"] });
    const logged = spies.flatMap((s) => s.mock.calls.flat().map(String));
    for (const t of [text, ...logged]) expect(t).not.toContain("user2@example");
    expect(await userRow(cookie)).toBeNull();
  });

  it("R-12 exception path names EMAIL_HASH_KEY when that secret is bad", async () => {
    const spies = spyConsole();
    const app = createApp(prelanderFlows);
    const cookie = newCookie();
    const res = await postComplete(make("women", "asia"), cookie, app, {
      EMAIL_HASH_KEY: "not-base64",
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "config_error" });
    const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
    expect(logged).toContain("EMAIL_HASH_KEY");
    expect(logged).not.toContain("user1@example.com");
    expect(await userRow(cookie)).toBeNull();
  });

  it("R-12 exception path redacts the request body", async () => {
    const spies = spyConsole();
    const app = createApp(prelanderFlows);
    const cookie = newCookie();
    const res = await postComplete(make("women", "asia"), cookie, app, {
      MASTER_KEY: "not-base64",
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "config_error" });
    const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
    expect(logged).toContain("MASTER_KEY");
    expect(logged).not.toContain("user1@example.com");
    expect(await userRow(cookie)).toBeNull();
  });
});
