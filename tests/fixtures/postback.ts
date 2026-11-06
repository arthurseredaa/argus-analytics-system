// Fixture: signed postbacks, a user with a click, test partners and reads of conversions and quarantine.
import { env } from "cloudflare:test";
import { encrypt, importAesKey } from "../../src/domain/crypto.ts";
import { signPayload } from "../../src/domain/signature.ts";
import { call, captureQueue } from "./events.ts";
import { TEST_PARTNER_SECRETS } from "./facts.ts";
import { newCookie } from "./http.ts";

export type PostbackOpts = {
  secret?: string;
  t?: number;
  // A string replaces the X-Signature header; null sends none.
  header?: string | null;
  contentType?: string;
  // The exact body bytes; without it the body is JSON.stringify(body).
  raw?: string;
};

export async function signatureHeader(secret: string, raw: string, t?: number): Promise<string> {
  const ts = t ?? Math.floor(Date.now() / 1000);
  return `t=${ts},v1=${await signPayload(secret, ts, raw)}`;
}

// Signs with the partner's test secret and the current time unless told otherwise. A partner
// without a test secret, such as an unknown one, is signed with a random secret.
export async function postback(
  partner: string,
  body: unknown,
  opts: PostbackOpts = {},
  envOverride?: Partial<Env>,
): Promise<Response> {
  const raw = opts.raw ?? JSON.stringify(body);
  const secret = opts.secret ?? TEST_PARTNER_SECRETS.get(partner) ?? crypto.randomUUID();
  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? "application/json",
  };
  const signature =
    opts.header === undefined ? await signatureHeader(secret, raw, opts.t) : opts.header;
  if (signature !== null) headers["x-signature"] = signature;
  return call(`/postback/v1/${partner}`, { method: "POST", body: raw, headers }, envOverride);
}

export function leadBody(
  clickId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "lead",
    click_id: clickId,
    transaction_id: `T-${crypto.randomUUID()}`,
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

const visitIdOf = (html: string) => html.match(/data-visit="([^"]+)"/)?.[1] ?? "";

// A new user through the quiz and /go: women + asia gives offer 003 of partnerA.
export async function userWithClick(
  offerAnswers: { gender: string; ethnicity: string } = { gender: "women", ethnicity: "asia" },
): Promise<{ cookie: string; clickId: string }> {
  const cookie = newCookie();
  const { queue } = captureQueue();
  const page = await call("/p/demo", { cookie }, { EVENTS_QUEUE: queue });
  const visit = visitIdOf(await page.text());
  const done = await call(
    "/api/complete",
    {
      method: "POST",
      cookie,
      body: JSON.stringify({
        prelander_id: "demo",
        visit_id: visit,
        answers: offerAnswers,
        email: "user1@example.com",
      }),
    },
    { EVENTS_QUEUE: queue },
  );
  if (done.status !== 200) throw new Error(`completion answered ${done.status}`);
  const go = await call(`/go?prelander=demo&visit=${visit}`, { cookie }, { EVENTS_QUEUE: queue });
  const clickId = /[?&]click_id=([0-9a-f]{32})$/.exec(go.headers.get("location") ?? "")?.[1];
  if (clickId === undefined) throw new Error(`/go answered ${go.status} without a click id`);
  return { cookie, clickId };
}

export type ConversionRow = {
  partner_id: string;
  type: string;
  transaction_id: string;
  occurred_at: number;
  payout: number | null;
  currency: string | null;
  partner_user_id: string | null;
};

export async function conversionsOf(clickId: string): Promise<ConversionRow[]> {
  const { results } = await env.FACTS.prepare(
    `SELECT partner_id, type, transaction_id, occurred_at, payout, currency, partner_user_id
     FROM conversions WHERE click_id = ? ORDER BY id`,
  )
    .bind(clickId)
    .all<ConversionRow>();
  return results;
}

export type QuarantineRow = {
  partner_id: string;
  type: string | null;
  transaction_id: string | null;
  click_id: string | null;
  body: string;
  reason: string;
};

export async function quarantineOf(transactionId: string): Promise<QuarantineRow[]> {
  const { results } = await env.FACTS.prepare(
    `SELECT partner_id, type, transaction_id, click_id, body, reason
     FROM quarantine WHERE transaction_id = ? ORDER BY id`,
  )
    .bind(transactionId)
    .all<QuarantineRow>();
  return results;
}

// A partner row made by a test; the caller removes it with deleteTestPartner in `finally`.
export async function insertTestPartner(input: {
  id: string;
  active: boolean;
  current: string;
  previous?: string;
}): Promise<void> {
  const key = await importAesKey(env.MASTER_KEY, "MASTER_KEY");
  await env.FACTS.prepare(
    `INSERT INTO partners (id, name, active, secret_current_enc, secret_previous_enc)
     VALUES (?1, ?1, ?2, ?3, ?4)`,
  )
    .bind(
      input.id,
      input.active ? 1 : 0,
      await encrypt(key, input.current),
      input.previous === undefined ? null : await encrypt(key, input.previous),
    )
    .run();
}

export async function deleteTestPartner(id: string): Promise<void> {
  await env.FACTS.batch([
    env.FACTS.prepare("DELETE FROM quarantine WHERE partner_id = ?").bind(id),
    env.FACTS.prepare("DELETE FROM postback_counts WHERE partner_id = ?").bind(id),
    env.FACTS.prepare("DELETE FROM partners WHERE id = ?").bind(id),
  ]);
}

export async function currentCatalogVersion(): Promise<number> {
  const row = await env.FACTS.prepare("SELECT MAX(version) AS v FROM catalog_history").first<{
    v: number;
  }>();
  return row!.v;
}
