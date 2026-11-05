// Route: GET /__test/state and POST /__test/reset, answered only while TEST_ROUTES is "on".
// Implements ADR 0003 (facts in D1); serves ID-1, ID-4, PB-3, R-12, DEMO-2.
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { readFacts } from "../db/facts.ts";
import { readTestEvents, readTestState, resetTestData } from "../db/test-state.ts";
import { decrypt, importAesKey } from "../domain/crypto.ts";

// True when there is at least one partner and every secret decrypts under MASTER_KEY.
// A wrong or malformed key gives false, not an error: the state is how a mismatch is found.
async function partnerSecretsOk(masterKey: string, secrets: readonly string[]): Promise<boolean> {
  if (secrets.length === 0) return false;
  try {
    const key = await importAesKey(masterKey, "MASTER_KEY");
    for (const secret of secrets) await decrypt(key, secret);
    return true;
  } catch {
    return false;
  }
}

export function testRoute(): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.use("*", async (c, next) => {
    if (c.env.TEST_ROUTES !== "on") return c.notFound();
    await next();
  });

  route.get("/state", async (c) => {
    const userId = c.get("userId");
    const [read, state, events] = await Promise.all([
      readFacts(c.env.FACTS, userId),
      readTestState(c.env.FACTS, userId),
      readTestEvents(c.env.EVENTS, userId),
    ]);
    return c.json({
      me: { user_id: userId, user: state.user, answers: read.facts.answers, events: events.events },
      catalog: { version: read.catalog.version, offers: read.catalog.offers.length },
      counts: { ...state.counts, events: events.total },
      partner_secrets_ok: await partnerSecretsOk(c.env.MASTER_KEY, state.partnerSecrets),
    });
  });

  route.post("/reset", async (c) => {
    await resetTestData(c.env.FACTS, c.env.EVENTS);
    return c.json({ ok: true });
  });

  return route;
}
