import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import catalogJson from "../../config/catalog-v1.json";
import { createApp } from "../../src/app.ts";
import { parseFlow } from "../../src/domain/flow.ts";
import fourSteps from "../fixtures/flows/four-steps.json";
import { cookieFrom, getPath, newCookie, postComplete } from "../fixtures/http.ts";

const idOf = (cookie: string) => cookie.slice(4);
const userRow = (cookie: string) =>
  env.FACTS.prepare("SELECT id FROM users WHERE id = ?").bind(idOf(cookie)).first();

// The HTML of one step section.
const section = (html: string, key: string) =>
  html.match(new RegExp(`<section[^>]*data-step="${key}"[^>]*>[\\s\\S]*?</section>`))?.[0] ?? "";
const stepKeys = (html: string) => [...html.matchAll(/data-step="([^"]+)"/g)].map((m) => m[1]);

describe("GET /p/:prelander", () => {
  it("ID-1 first visit sets a user id cookie and writes no D1 row", async () => {
    const res = await getPath("/p/demo");
    expect(res.status).toBe(200);
    const cookie = cookieFrom(res);
    expect(cookie).toMatch(/^uid=[0-9a-f-]{36}$/);
    expect(await userRow(cookie)).toBeNull();
  });

  it("ID-2 cookie is HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=34560000 on the page", async () => {
    const res = await getPath("/p/demo");
    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toContain("Max-Age=34560000");
    expect(header).not.toContain("Domain");
  });

  it("ID-2 the 500 path from onError still carries the identity cookie", async () => {
    const app = createApp(new Map());
    app.get("/api/boom", () => {
      throw new Error("boom");
    });
    const res = await getPath("/api/boom", undefined, app);
    expect(res.status).toBe(500);
    expect(cookieFrom(res)).toMatch(/^uid=[0-9a-f-]{36}$/);
  });

  it("ID-2 second visit with the same cookie keeps the user id", async () => {
    const cookie = newCookie();
    const res = await getPath("/p/demo", cookie);
    expect(cookieFrom(res)).toBe(cookie);
  });

  it("ID-2 malformed cookie value is replaced", async () => {
    const res = await getPath("/p/demo", "uid=not-a-uuid");
    expect(cookieFrom(res)).toMatch(/^uid=[0-9a-f-]{36}$/);
    expect(cookieFrom(res)).not.toBe("uid=not-a-uuid");
  });

  it("QZ-7 the demo page holds the three steps and posts once to /api/complete", async () => {
    const res = await getPath("/p/demo");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(stepKeys(html)).toEqual(["gender", "ethnicity", "email"]);
    expect(html.split("/api/complete").length - 1).toBe(1);
  });

  it("QZ-1 step 1 offers women and men", async () => {
    const html = await (await getPath("/p/demo")).text();
    const gender = section(html, "gender");
    expect(gender).toContain('data-value="women"');
    expect(gender).toContain('data-value="men"');
  });

  it("QZ-2 step 2 wording on the page is filled from the step 1 answer", async () => {
    const html = await (await getPath("/p/demo")).text();
    expect(section(html, "ethnicity")).toContain('<span data-answer="gender"></span>');
    expect(section(html, "gender")).toContain('data-next="ethnicity"');
  });

  it("OFF-8 page shows the no-offer text", async () => {
    const html = await (await getPath("/p/demo")).text();
    expect(html).toContain("No offer available");
  });

  it("OFF-10 page script holds no catalog or selection logic", async () => {
    const html = await (await getPath("/p/demo")).text();
    for (const offer of (catalogJson as { offers: { name: string; url: string }[] }).offers) {
      expect(html).not.toContain(offer.name);
      expect(html).not.toContain(offer.url);
    }
    expect(html.toLowerCase()).not.toContain("epu");
  });

  it("QZ-1 unknown prelander gives 404", async () => {
    const res = await getPath("/p/nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  it("QZ-5 Q-1 entry after completion without a Lead shows an empty quiz", async () => {
    const cookie = newCookie();
    const done = await postComplete(
      {
        prelander_id: "demo",
        answers: { gender: "women", ethnicity: "asia" },
        email: "user1@example.com",
      },
      cookie,
    );
    expect(done.status).toBe(200);
    const res = await getPath("/p/demo", cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(section(html, "gender")).not.toContain("hidden");
    expect(html).not.toMatch(/\sselected[\s=>]/);
    expect(html).not.toMatch(/\schecked[\s=>]/);
  });

  it("QZ-7 a fourth step added to the flow config renders and is validated without a code change", async () => {
    const app = createApp(new Map([["four", parseFlow(fourSteps)]]));
    const html = await (await getPath("/p/four", undefined, app)).text();
    expect(stepKeys(html)).toEqual(["gender", "ethnicity", "age", "email"]);
    const age = section(html, "age");
    for (const v of ["18-29", "30-44", "45+"]) expect(age).toContain(`data-value="${v}"`);

    const cookie = newCookie();
    const body = (answers: Record<string, string>) => ({
      prelander_id: "four",
      answers,
      email: "user3@example.com",
    });
    const ok = await postComplete(
      body({ gender: "women", ethnicity: "asia", age: "30-44" }),
      cookie,
      app,
    );
    expect(ok.status).toBe(200);
    const row = await env.FACTS.prepare(
      "SELECT value FROM user_answers WHERE user_id = ? AND question_key = 'age'",
    )
      .bind(idOf(cookie))
      .first<{ value: string }>();
    expect(row?.value).toBe('"30-44"');

    const bad = await postComplete(body({ gender: "women", ethnicity: "asia" }), newCookie(), app);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ fields: ["answers.age"] });
  });

  it("DEMO-2 new user takes the quiz and gets 003", async () => {
    const page = await getPath("/p/demo");
    const cookie = cookieFrom(page);
    const res = await postComplete(
      {
        prelander_id: "demo",
        answers: { gender: "women", ethnicity: "asia" },
        email: "user1@example.com",
      },
      cookie,
    );
    const json = (await res.json()) as { offer_id: string; reason: string };
    expect({ offer_id: json.offer_id, reason: json.reason }).toEqual({
      offer_id: "003",
      reason: "best_epu",
    });
  });
});
