// Route: GET /__probe, the synthetic probe's target.
// Implements the design in metrics-and-operations.md "Latency target" step 4; serves NFR-6.
// No identity middleware, no cookie, no event and no write: the fixed UserID has no rows.
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { readFacts } from "../db/facts.ts";
import { select } from "../domain/select.ts";

export const PROBE_USER_ID = "00000000-0000-4000-8000-000000000000";

export function probeRoute(): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.get("/", async (c) => {
    const start = Date.now();
    const read = await readFacts(c.env.FACTS, PROBE_USER_ID);
    const d1Ms = Math.max(0, Date.now() - start);
    select(read.facts, read.catalog, "entry");
    return c.json({ ok: true, d1_ms: d1Ms }, 200, { "cache-control": "no-store" });
  });

  return route;
}
