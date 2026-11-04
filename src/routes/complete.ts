// Route: POST /api/complete, the quiz completion.
// Implements ADR 0002, ADR 0004 and "Quiz completion" of data-model.md; serves ID-1, QZ-1 to QZ-4, OFF-2, OFF-10, DEMO-8, R-12.
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { completeQuiz } from "../db/facts.ts";
import { ConfigError, emailHash, encrypt, importAesKey, importHmacKey } from "../domain/crypto.ts";
import { validateAnswers, type Flow } from "../domain/flow.ts";
import { select } from "../domain/select.ts";

const bodySchema = z.object({
  prelander_id: z.string(),
  visit_id: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  email: z.string(),
});

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// One JSON object per line; callers pass field names and counts, never request values.
const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));

function rejected(fields: string[]): { error: "invalid_body"; fields: string[] } {
  log({ msg: "complete_rejected", fields });
  return { error: "invalid_body", fields };
}

export function completeRoute(flows: ReadonlyMap<string, Flow>): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.post("/complete", async (c) => {
    // The parse error is not logged: V8 quotes part of the input in its message.
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return c.json(rejected([]), 400);
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))].filter(
        (f) => f !== "",
      );
      return c.json(rejected(fields), 400);
    }
    const body = parsed.data;

    const flow = flows.get(body.prelander_id);
    if (flow === undefined) return c.json({ error: "unknown_prelander" }, 400);

    const checked = validateAnswers(flow, body.answers);
    if (!checked.ok) return c.json(rejected(checked.fields), 400);

    const email = body.email.trim();
    if (email.length < 3 || email.length > 254 || !EMAIL_FORMAT.test(email))
      return c.json(rejected(["email"]), 400);

    let emailEnc: string;
    let hash: string;
    try {
      const aes = await importAesKey(c.env.MASTER_KEY, "MASTER_KEY");
      const hmac = await importHmacKey(c.env.EMAIL_HASH_KEY, "EMAIL_HASH_KEY");
      emailEnc = await encrypt(aes, email);
      hash = await emailHash(hmac, email);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      // The message starts with the variable's name and holds no value.
      log({ msg: "config_error", name: err.message.split(" ")[0] });
      return c.json({ error: "config_error" }, 500);
    }

    const read = await completeQuiz(c.env.FACTS, {
      userId: c.get("userId"),
      emailEnc,
      emailHash: hash,
      answers: checked.answers,
      receivedAt: Date.now(),
    });
    for (const e of read.catalogErrors)
      log({ msg: "catalog_config_error", offer_id: e.offerId, problem: e.problem });
    if (read.catalog.offers.length === 0) log({ msg: "catalog_empty" });

    const selection = select(read.facts, read.catalog, "completion");
    const offer = read.catalog.offers.find((o) => o.id === selection.offerId);
    return c.json({
      offer_id: offer?.id ?? null,
      name: offer?.name ?? null,
      url: offer?.url ?? null,
      reason: selection.reason,
      catalog_version: selection.catalogVersion,
    });
  });

  return route;
}
