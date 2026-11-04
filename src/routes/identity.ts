// Route: the identity cookie middleware.
// Implements ADR 0002 (first-party cookie holding a random UUID); serves ID-1, ID-2, R-1.
import { getCookie, setCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.ts";

const COOKIE = "uid";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// 400 days, the longest lifetime browsers accept.
const MAX_AGE = 34560000;

export function identity(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const sent = getCookie(c, COOKIE);
    const returning = sent !== undefined && UUID_V4.test(sent);
    const userId = returning ? sent : crypto.randomUUID();
    c.set("userId", userId);
    c.set("returning", returning);
    // Host-only on purpose: no Domain, because workers.dev is a public suffix.
    setCookie(c, COOKIE, userId, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: MAX_AGE,
    });
    await next();
  };
}
