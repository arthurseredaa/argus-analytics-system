import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cookieFrom, newCookie, postComplete, UUID_V4 } from "../fixtures/http.ts";

const body = {
  prelander_id: "demo",
  answers: { gender: "women", ethnicity: "asia" },
  email: "user1@example.com",
};

const userRows = async (id: string) =>
  (await env.FACTS.prepare("SELECT * FROM users WHERE id = ?").bind(id).all()).results;

describe("identity cookie", () => {
  it("ID-2 cookie is HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=34560000", async () => {
    const res = await postComplete(body);
    const header = res.headers.get("set-cookie")!;
    expect(header).toMatch(/^uid=[0-9a-f-]{36};/);
    expect(cookieFrom(res).slice(4)).toMatch(UUID_V4);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toContain("Max-Age=34560000");
    expect(header.toLowerCase()).not.toContain("domain");
  });

  it("ID-2 second visit with the same cookie keeps the user id", async () => {
    const cookie = newCookie();
    const res = await postComplete(body, cookie);
    expect(cookieFrom(res)).toBe(cookie);
  });

  it("ID-2 R-1 visit without the cookie creates a new user", async () => {
    const a = cookieFrom(await postComplete(body));
    const b = cookieFrom(await postComplete(body));
    expect(a).not.toBe(b);
    expect(await userRows(a.slice(4))).toHaveLength(1);
    expect(await userRows(b.slice(4))).toHaveLength(1);
  });

  it("ID-2 malformed cookie value is replaced", async () => {
    const res = await postComplete(body, "uid=not-a-uuid");
    const id = cookieFrom(res).slice(4);
    expect(id).not.toBe("not-a-uuid");
    expect(id).toMatch(UUID_V4);
    expect(await userRows(id)).toHaveLength(1);
  });

  it("ID-2 user id in the completion body is ignored", async () => {
    const cookie = newCookie();
    const other = crypto.randomUUID();
    const res = await postComplete({ ...body, user_id: other }, cookie);
    expect(res.status).toBe(200);
    expect(await userRows(cookie.slice(4))).toHaveLength(1);
    expect(await userRows(other)).toHaveLength(0);
  });

  it("ID-1 complete creates the users row", async () => {
    const cookie = newCookie();
    await postComplete(body, cookie);
    const rows = await userRows(cookie.slice(4));
    expect(rows).toHaveLength(1);
    const row = rows[0] as { created_at: number; last_completed_at: number };
    expect(row.created_at).toBe(row.last_completed_at);
  });
});
