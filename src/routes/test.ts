// Route: GET /__test/state, POST /__test/reset and POST /__test/seed, answered only while TEST_ROUTES is "on".
// Implements ADR 0003 (facts in D1); serves ID-1, ID-4, PB-3, OFF-3, OFF-4, R-12, DEMO-2.
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { readFacts } from "../db/facts.ts";
import { readTestEvents, readTestState, resetTestData, seedTestUser } from "../db/test-state.ts";
import {
  ConfigError,
  decrypt,
  emailHash,
  encrypt,
  importAesKey,
  importHmacKey,
} from "../domain/crypto.ts";

const seedSchema = z.object({
  answers: z.record(z.string(), z.string()).optional(),
  leads: z
    .array(z.object({ offer_id: z.string(), accepted_at: z.number().int().optional() }))
    .optional(),
  clicks: z
    .array(z.object({ offer_id: z.string(), created_at: z.number().int().optional() }))
    .optional(),
});

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
      me: {
        user_id: userId,
        user: state.user,
        answers: read.facts.answers,
        clicks: state.clicks,
        conversions: state.conversions,
        events: events.events,
      },
      catalog: { version: read.catalog.version, offers: read.catalog.offers.length },
      counts: { ...state.counts, events: events.total },
      partner_secrets_ok: await partnerSecretsOk(c.env.MASTER_KEY, state.partnerSecrets),
    });
  });

  route.post("/reset", async (c) => {
    await resetTestData(c.env.FACTS, c.env.EVENTS);
    return c.json({ ok: true });
  });

  // Builds a user that would take several visits to reach: answers, Leads and clicks.
  route.post("/seed", async (c) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
    const parsed = seedSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    const body = parsed.data;

    const userId = c.get("userId");
    const catalog = (await readFacts(c.env.FACTS, userId)).catalog;
    const known = new Set(catalog.offers.map((o) => o.id));
    const wanted = [...(body.leads ?? []), ...(body.clicks ?? [])].map((x) => x.offer_id);
    if (wanted.some((id) => !known.has(id))) return c.json({ error: "unknown_offer" }, 400);

    let emailEnc: string;
    let hash: string;
    try {
      const aes = await importAesKey(c.env.MASTER_KEY, "MASTER_KEY");
      const hmac = await importHmacKey(c.env.EMAIL_HASH_KEY, "EMAIL_HASH_KEY");
      emailEnc = await encrypt(aes, "seed@example.com");
      hash = await emailHash(hmac, "seed@example.com");
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      return c.json({ error: "config_error" }, 500);
    }

    const now = Date.now();
    const clicks = await seedTestUser(c.env.FACTS, {
      userId,
      emailEnc,
      emailHash: hash,
      answers: body.answers ?? {},
      // Without accepted_at the array order is the Lead order.
      leads: (body.leads ?? []).map((l, i) => ({
        offerId: l.offer_id,
        acceptedAt: l.accepted_at ?? now + i,
      })),
      clicks: (body.clicks ?? []).map((k) => ({
        offerId: k.offer_id,
        createdAt: k.created_at ?? now,
      })),
      now,
    });
    return c.json({ ok: true, clicks });
  });

  return route;
}
