// Fixture: users, events, clicks and conversions written straight into the two databases,
// and the AN-1 fixture, for the report tests. Report tests use a unique prelander id per test.
import { env } from "cloudflare:test";
import { expect } from "vitest";
import { insertClick, type Click } from "../../src/db/clicks.ts";
import { insertConversion } from "../../src/db/conversions.ts";
import { insertEvents } from "../../src/db/events.ts";
import { call, storedEvent } from "./events.ts";

export const DAY_1 = Date.UTC(2001, 1, 3);
export const DAY_2 = DAY_1 + 86_400_000;
export const AN2_DAY = Date.UTC(2001, 5, 1);

const hex = (bytes: number): string =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export const uniquePrelander = (): string => `r-${hex(4)}`;

export async function addUser(): Promise<string> {
  const id = crypto.randomUUID();
  await env.FACTS.prepare(
    `INSERT INTO users (id, email_enc, email_hash, created_at, last_completed_at)
     VALUES (?1, 'v1:AAAA:AAAA', ?2, 0, 0)`,
  )
    .bind(id, hex(16))
    .run();
  return id;
}

type EventRow = {
  userId: string;
  prelander: string;
  type: "prelander_viewed" | "step_viewed" | "step_answered" | "quiz_completed";
  at: number;
  visit?: string;
  step?: number;
  reason?: string;
};

function payloadOf(row: EventRow): Record<string, unknown> {
  switch (row.type) {
    case "prelander_viewed":
      return { reason: row.reason ?? "quiz" };
    case "step_viewed":
      return { step: row.step ?? 1, prefilled: false };
    case "step_answered":
      return { step: row.step ?? 1, question_key: "gender", value: "women" };
    case "quiz_completed":
      return { answers: { gender: "women", ethnicity: "asia" } };
  }
}

// A visit defaults to one per user, so two users never share a visit id.
export async function addEvents(rows: EventRow[]): Promise<void> {
  await insertEvents(
    env.EVENTS,
    rows.map((row) =>
      storedEvent({
        type: row.type,
        user_id: row.userId,
        prelander_id: row.prelander,
        received_at: row.at,
        visit_id: row.visit ?? `v-${row.userId}`,
        payload: payloadOf(row),
      }),
    ),
  );
}

export async function addClick(input: {
  userId: string | null;
  prelander: string;
  at: number;
  offerId?: string;
  reason?: Click["reason"];
}): Promise<string> {
  const clickId = `c${hex(15)}`;
  await insertClick(env.FACTS, {
    clickId,
    userId: input.userId,
    offerId: input.offerId ?? "003",
    catalogVersion: 1,
    prelanderId: input.prelander,
    visitId: `v-${clickId}`,
    reason: input.reason ?? "best_epu",
    createdAt: input.at,
  });
  return clickId;
}

export async function addConversion(input: {
  clickId: string;
  type: "lead" | "purchase";
  at: number;
  payout?: number;
  currency?: string;
}): Promise<void> {
  const partner = await env.FACTS.prepare(
    `SELECT o.partner_id FROM clicks c
     JOIN offers o ON o.version = c.catalog_version AND o.id = c.offer_id
     WHERE c.click_id = ?1`,
  )
    .bind(input.clickId)
    .first<{ partner_id: string }>();
  if (partner === null) throw new Error("no such click");
  await insertConversion(env.FACTS, {
    partnerId: partner.partner_id,
    type: input.type,
    transactionId: `t-${hex(8)}`,
    clickId: input.clickId,
    occurredAt: input.at,
    acceptedAt: input.at,
    payout: input.payout ?? null,
    currency: input.currency ?? null,
    partnerUserId: null,
  });
}

export const HOUR = 3_600_000;

// AN-1 on DAY_2: A starts only, B reaches step 3, C completes, clicks 003, gets a Lead and a
// Purchase of 25 USD. D (AN-5) has no events, clicked 003 on DAY_1 and bought for 10 EUR on DAY_2.
export async function an1Fixture(): Promise<{ prelander: string; userIds: string[] }> {
  const prelander = uniquePrelander();
  const [a, b, c, d] = [await addUser(), await addUser(), await addUser(), await addUser()];
  const at = DAY_2 + 9 * HOUR;
  const view = (userId: string, step: number) =>
    ({ userId, prelander, type: "step_viewed", at, step }) as const;
  const opened = (userId: string) => ({ userId, prelander, type: "prelander_viewed", at }) as const;
  await addEvents([
    opened(a),
    view(a, 1),
    opened(b),
    view(b, 1),
    view(b, 2),
    view(b, 3),
    opened(c),
    view(c, 1),
    view(c, 2),
    view(c, 3),
    { userId: c, prelander, type: "quiz_completed", at },
  ]);
  const clickC = await addClick({ userId: c, prelander, at: at + HOUR });
  await addConversion({ clickId: clickC, type: "lead", at: at + 2 * HOUR });
  await addConversion({
    clickId: clickC,
    type: "purchase",
    at: at + 3 * HOUR,
    payout: 25,
    currency: "USD",
  });
  const clickD = await addClick({ userId: d, prelander, at: DAY_1 + 9 * HOUR });
  await addConversion({
    clickId: clickD,
    type: "purchase",
    at: DAY_2 + 5 * HOUR,
    payout: 10,
    currency: "EUR",
  });
  return { prelander, userIds: [a, b, c, d] };
}

export async function report(query: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await call(`/api/report?${new URLSearchParams(query)}`, {});
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}
