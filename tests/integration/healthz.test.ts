import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("DLV-1 healthz returns the commit sha", async () => {
  const res = await SELF.fetch("https://example.com/healthz");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(await res.json()).toEqual({ sha: env.GIT_SHA });
});
