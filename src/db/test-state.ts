// DB: the reads, seed writes and deletes behind the test routes, kept apart from the facts the product uses.
// Implements ADR 0003 (facts in D1) and ADR 0005 (events table); serves ID-1, PB-3, OFF-3, OFF-4, R-12, DEMO-2.
import { newClickId } from "../domain/clicks.ts";

export type TestEvent = {
  event_id: string;
  type: string;
  visit_id: string;
  seq: number | null;
  schema_version: number;
  payload: unknown;
};

export type TestClick = { click_id: string; offer_id: string; reason: string; created_at: number };
export type TestConversion = { type: string; offer_id: string; transaction_id: string };

export type TestStateRead = {
  user: { created_at: number; last_completed_at: number; email_hash: string } | null;
  clicks: TestClick[];
  conversions: TestConversion[];
  counts: { users: number; clicks: number; conversions: number; quarantine: number };
  partnerSecrets: string[];
};

// The user row leaves out email_enc on purpose: the test state never carries a ciphertext.
export async function readTestState(db: D1Database, userId: string): Promise<TestStateRead> {
  const [user, clicks, conversions, counts, partners] = await db.batch([
    db
      .prepare("SELECT created_at, last_completed_at, email_hash FROM users WHERE id = ?1")
      .bind(userId),
    db
      .prepare(
        `SELECT click_id, offer_id, reason, created_at
         FROM clicks WHERE user_id = ?1 ORDER BY created_at, rowid`,
      )
      .bind(userId),
    db
      .prepare(
        `SELECT v.type, c.offer_id, v.transaction_id
         FROM conversions v JOIN clicks c ON c.click_id = v.click_id
         WHERE c.user_id = ?1 ORDER BY v.accepted_at, v.id`,
      )
      .bind(userId),
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM clicks) AS clicks,
              (SELECT COUNT(*) FROM conversions) AS conversions,
              (SELECT COUNT(*) FROM quarantine) AS quarantine`,
    ),
    db.prepare("SELECT secret_current_enc FROM partners ORDER BY id"),
  ]);
  return {
    user: (user?.results[0] as TestStateRead["user"] | undefined) ?? null,
    clicks: (clicks?.results ?? []) as TestClick[],
    conversions: (conversions?.results ?? []) as TestConversion[],
    counts: counts?.results[0] as TestStateRead["counts"],
    partnerSecrets: ((partners?.results ?? []) as { secret_current_enc: string }[]).map(
      (p) => p.secret_current_enc,
    ),
  };
}

export type SeedInput = {
  userId: string;
  emailEnc: string;
  emailHash: string;
  answers: Record<string, string>;
  leads: { offerId: string; acceptedAt: number }[];
  clicks: { offerId: string; createdAt: number }[];
  now: number;
};

// Writes a user, answers, a click and a lead conversion per Lead, and the plain clicks, in one
// batch. Offers are read from the current catalog version inside the statements. Returns the
// click ids: the Lead clicks first, then the plain ones, each in input order.
export async function seedTestUser(db: D1Database, input: SeedInput): Promise<string[]> {
  const current = "(SELECT MAX(version) FROM catalog_history)";
  const clickSql = `INSERT INTO clicks (click_id, user_id, offer_id, catalog_version, prelander_id, visit_id, reason, created_at)
    SELECT ?1, ?2, id, version, 'demo', ?3, 'best_epu', ?4 FROM offers WHERE version = ${current} AND id = ?5`;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO users (id, email_enc, email_hash, created_at, last_completed_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT (id) DO UPDATE
           SET email_enc = excluded.email_enc, email_hash = excluded.email_hash,
               last_completed_at = excluded.last_completed_at`,
      )
      .bind(input.userId, input.emailEnc, input.emailHash, input.now),
    ...Object.entries(input.answers).map(([key, value]) =>
      db
        .prepare(
          `INSERT INTO user_answers (user_id, question_key, value, received_at)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (user_id, question_key) DO UPDATE
             SET value = excluded.value, received_at = excluded.received_at`,
        )
        .bind(input.userId, key, JSON.stringify(value), input.now),
    ),
  ];
  const clickIds: string[] = [];
  for (const lead of input.leads) {
    const clickId = newClickId();
    clickIds.push(clickId);
    statements.push(
      db
        .prepare(clickSql)
        .bind(clickId, input.userId, crypto.randomUUID(), lead.acceptedAt, lead.offerId),
      db
        .prepare(
          `INSERT INTO conversions (partner_id, type, transaction_id, click_id, occurred_at, accepted_at)
           SELECT partner_id, 'lead', ?1, ?2, ?3, ?3 FROM offers WHERE version = ${current} AND id = ?4`,
        )
        .bind(`seed-${crypto.randomUUID()}`, clickId, lead.acceptedAt, lead.offerId),
    );
  }
  for (const click of input.clicks) {
    const clickId = newClickId();
    clickIds.push(clickId);
    statements.push(
      db
        .prepare(clickSql)
        .bind(clickId, input.userId, crypto.randomUUID(), click.createdAt, click.offerId),
    );
  }
  await db.batch(statements);
  return clickIds;
}

// The caller's events in arrival order, and the size of the whole table.
export async function readTestEvents(
  events: D1Database,
  userId: string,
): Promise<{ events: TestEvent[]; total: number }> {
  const [mine, total] = await events.batch([
    events
      .prepare(
        `SELECT event_id, type, visit_id, seq, schema_version, payload
         FROM events WHERE user_id = ?1 ORDER BY received_at, seq`,
      )
      .bind(userId),
    events.prepare("SELECT COUNT(*) AS total FROM events"),
  ]);
  const rows = (mine?.results ?? []) as (Omit<TestEvent, "payload"> & { payload: string })[];
  return {
    events: rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown })),
    total: (total?.results[0] as { total: number } | undefined)?.total ?? 0,
  };
}

// Keeps partners, catalog_history and offers. Answers go with their users (ON DELETE CASCADE).
export async function resetTestData(facts: D1Database, events: D1Database): Promise<void> {
  await facts.batch([
    facts.prepare("DELETE FROM conversions"),
    facts.prepare("DELETE FROM clicks"),
    facts.prepare("DELETE FROM quarantine"),
    facts.prepare("DELETE FROM users"),
  ]);
  await events.prepare("DELETE FROM events").run();
}
