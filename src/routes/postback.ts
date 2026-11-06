// Route: POST /postback/v1/:partner, a partner's signed Lead or Purchase.
// Implements ADR 0007 (contract, HMAC over timestamp and raw body, dedup, quarantine); serves PB-1 to PB-5, PB-8, Q-11, Q-24, R-4, R-6, R-11, R-12.
// No identity middleware: a partner server has no cookie, and the user comes from the click.
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { findClickForPostback } from "../db/clicks.ts";
import { insertConversion, insertQuarantine, readPartner } from "../db/conversions.ts";
import { recordPostback } from "../db/postback-counts.ts";
import { ConfigError, decrypt, importAesKey } from "../domain/crypto.ts";
import { verifySignature } from "../domain/signature.ts";
import { derivedEventId, makeServerEvent } from "../events/envelope.ts";
import { EventsUnavailable, sendEvent } from "../events/producer.ts";
import { isD1Overload } from "../ops/metrics.ts";

export const MAX_POSTBACK_BYTES = 16_384;
const PARTNER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RETRY_AFTER_S = "30";

// Unknown fields are dropped, not rejected (PB-2).
const bodySchema = z.object({
  type: z.enum(["lead", "purchase"]),
  // Not our own click id format, so a foreign id is quarantined rather than rejected.
  click_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  transaction_id: z.string().regex(/^[\x21-\x7e]{1,128}$/),
  occurred_at: z.iso.datetime(),
  payout: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,4})?$/)
    .optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  partner_user_id: z.string().min(1).max(128).optional(),
});

type Outcome = "accepted" | "duplicate" | "quarantined" | "rejected";

type Answer = {
  status: 200 | 202 | 400 | 401 | 500 | 503;
  body: Record<string, unknown>;
  // The partner id only once it was found in `partners`; never a request value.
  partner: string | null;
  outcome: Outcome;
  reason?: string;
};

// A D1 call failed; the partner retries after Retry-After.
// The D1 error stays as `cause` so the route can tag an overload; it is never logged.
class Unavailable extends Error {
  constructor(cause: unknown) {
    super("facts database unavailable", { cause });
    this.name = "Unavailable";
  }
}

async function d1<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw new Unavailable(err);
  }
}

const unauthorized = (partner: string | null, reason: string): Answer => ({
  status: 401,
  body: { error: "unauthorized" },
  partner,
  outcome: "rejected",
  reason,
});

const badRequest = (partner: string, error: string, extra: Record<string, unknown> = {}) =>
  ({
    status: 400,
    body: { error, ...extra },
    partner,
    outcome: "rejected",
    reason: error,
  }) satisfies Answer;

// Reads at most `limit` bytes of the body; null means the body is longer.
async function readLimited(req: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length"));
  if (declared > limit) return null;
  if (req.body === null) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function handle(c: Context<AppEnv>): Promise<Answer> {
  const pathPartner = c.req.param("partner") ?? "";
  if (!PARTNER_ID.test(pathPartner)) return unauthorized(null, "unknown_partner");

  const bytes = await readLimited(c.req.raw, MAX_POSTBACK_BYTES);
  if (bytes === null)
    return {
      status: 400,
      body: { error: "too_large" },
      partner: null,
      outcome: "rejected",
      reason: "too_large",
    };
  const text = new TextDecoder().decode(bytes);
  const now = Date.now();

  const row = await d1(() => readPartner(c.env.FACTS, pathPartner));
  if (row === null) return unauthorized(null, "unknown_partner");
  const partnerId = pathPartner;
  if (!row.active) return unauthorized(partnerId, "inactive_partner");

  let secrets: string[];
  try {
    const key = await importAesKey(c.env.MASTER_KEY, "MASTER_KEY");
    secrets = [await decrypt(key, row.secretCurrentEnc)];
    if (row.secretPreviousEnc !== null) secrets.push(await decrypt(key, row.secretPreviousEnc));
  } catch (err) {
    const reason = err instanceof ConfigError ? "config_error" : "partner_secret_unreadable";
    return {
      status: 500,
      body: { error: "config_error" },
      partner: partnerId,
      outcome: "rejected",
      reason,
    };
  }

  const check = await verifySignature({
    header: c.req.header("x-signature"),
    body: text,
    secrets,
    nowMs: now,
  });
  if (check !== "ok") return unauthorized(partnerId, check);

  const mediaType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (mediaType !== "application/json") return badRequest(partnerId, "unsupported_content_type");

  // The parse error is not logged: V8 quotes part of the input in its message.
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return badRequest(partnerId, "invalid_body", { fields: [] });
  }
  const parsed = bodySchema.safeParse(raw);
  const occurredAt = parsed.success ? Date.parse(parsed.data.occurred_at) : Number.NaN;
  if (!parsed.success || Number.isNaN(occurredAt)) {
    const fields = parsed.success
      ? ["occurred_at"]
      : [...new Set(parsed.error.issues.map((i) => i.path.join(".")))].filter((f) => f !== "");
    return badRequest(partnerId, "invalid_body", { fields });
  }
  const body = parsed.data;

  const click = await d1(() => findClickForPostback(c.env.FACTS, body.click_id));
  if (click === null) {
    await d1(() =>
      insertQuarantine(c.env.FACTS, {
        partnerId,
        type: body.type,
        transactionId: body.transaction_id,
        clickId: body.click_id,
        body: text,
        reason: "unknown_click",
        receivedAt: now,
      }),
    );
    return {
      status: 202,
      body: { status: "quarantined" },
      partner: partnerId,
      outcome: "quarantined",
      reason: "unknown_click",
    };
  }
  if (click.offerPartnerId !== partnerId) return badRequest(partnerId, "click_partner_mismatch");

  const { inserted } = await d1(() =>
    insertConversion(c.env.FACTS, {
      partnerId,
      type: body.type,
      transactionId: body.transaction_id,
      clickId: click.clickId,
      occurredAt,
      acceptedAt: now,
      payout: body.payout === undefined ? null : Number(body.payout),
      currency: body.currency ?? null,
      partnerUserId: body.partner_user_id ?? null,
    }),
  );

  // A duplicate sends the event again with the same EventID, so an event lost to a Queue
  // failure on the first try reaches analytics on the retry, and only once (ADR 0007).
  const event = makeServerEvent({
    type: body.type,
    userId: click.userId,
    visitId: click.visitId,
    prelanderId: click.prelanderId,
    payload: {
      click_id: click.clickId,
      offer_id: click.offerId,
      partner_id: partnerId,
      transaction_id: body.transaction_id,
      occurred_at: occurredAt,
      payout: body.payout ?? null,
      currency: body.currency ?? null,
    },
    now,
    eventId: await derivedEventId([partnerId, body.type, body.transaction_id]),
  });
  try {
    await sendEvent(c.env, event);
  } catch (err) {
    if (!(err instanceof EventsUnavailable)) throw err;
    return {
      status: 503,
      body: { error: "unavailable" },
      partner: partnerId,
      outcome: "rejected",
      reason: "queue_unavailable",
    };
  }

  return inserted
    ? { status: 202, body: { status: "accepted" }, partner: partnerId, outcome: "accepted" }
    : { status: 200, body: { status: "duplicate" }, partner: partnerId, outcome: "duplicate" };
}

export function postbackRoute(): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.post("/v1/:partner", async (c) => {
    let answer: Answer;
    try {
      answer = await handle(c);
    } catch (err) {
      if (!(err instanceof Unavailable)) throw err;
      if (isD1Overload(err.cause)) c.set("errorTag", "d1_overload");
      answer = {
        status: 503,
        body: { error: "unavailable" },
        partner: null,
        outcome: "rejected",
        reason: "d1_unavailable",
      };
    }
    // Only a partner found in `partners` is counted, so random traffic cannot fill the table.
    // `accepted` and `duplicate` are acceptances; every other outcome is a request only.
    if (answer.partner !== null) {
      const partnerId = answer.partner;
      const accepted = answer.outcome === "accepted" || answer.outcome === "duplicate";
      c.executionCtx.waitUntil(
        recordPostback(c.env.FACTS, { at: Date.now(), partnerId, accepted }).catch(
          (err: unknown) => {
            console.log(
              JSON.stringify({
                msg: "postback_count_failed",
                name: err instanceof Error ? err.name : "unknown",
              }),
            );
          },
        ),
      );
    }
    // One line per request. It never carries the body, the signature or the transaction id.
    console.log(
      JSON.stringify({
        msg: "postback",
        partner: answer.partner,
        outcome: answer.outcome,
        ...(answer.reason === undefined ? {} : { reason: answer.reason }),
      }),
    );
    const headers: Record<string, string> =
      answer.status === 503 ? { "retry-after": RETRY_AFTER_S } : {};
    return c.json(answer.body, answer.status, headers);
  });

  return route;
}
