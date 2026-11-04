import { createExecutionContext, env, SELF } from "cloudflare:test";
import type { Hono } from "hono";
import type { AppEnv } from "../../src/app.ts";

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function newCookie(): string {
  return `uid=${crypto.randomUUID()}`;
}

// The `uid=<id>` pair from a response's Set-Cookie header.
export function cookieFrom(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  return header.split(";")[0] ?? "";
}

export async function postComplete(
  body: unknown,
  cookie?: string,
  app?: Hono<AppEnv>,
  envOverride?: Partial<Env>,
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie !== undefined) headers.set("cookie", cookie);
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const init = { method: "POST", headers, body: text };
  if (app === undefined) return SELF.fetch("https://example.com/api/complete", init);
  const req = new Request("https://example.com/api/complete", init);
  return app.fetch(req, { ...env, ...envOverride }, createExecutionContext());
}
