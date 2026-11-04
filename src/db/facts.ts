// DB: reads and writes of the facts select() needs, each in one D1 batch (one transaction).
// Implements ADR 0003 and ADR 0004; serves ID-1, QZ-4, OFF-2, Q-4.
import { parseCatalog, type Catalog, type CatalogError, type OfferRow } from "../domain/catalog.ts";
import type { Facts } from "../domain/select.ts";

export type FactsRead = {
  facts: Facts;
  catalog: Catalog;
  catalogErrors: CatalogError[];
  userExists: boolean;
};

const READS = [
  "SELECT id FROM users WHERE id = ?1",
  "SELECT question_key, value FROM user_answers WHERE user_id = ?1",
  `SELECT c.offer_id, v.accepted_at
   FROM conversions v
   JOIN clicks c ON c.click_id = v.click_id
   WHERE c.user_id = ?1 AND v.type = 'lead'`,
  `SELECT c.offer_id
   FROM conversions v
   JOIN clicks c ON c.click_id = v.click_id
   WHERE c.user_id = ?1 AND v.type = 'purchase'`,
  "SELECT MAX(version) AS version FROM catalog_history",
  `SELECT id, partner_id, name, ethnicity, genders, epu, url, kind, active
   FROM offers
   WHERE version = (SELECT MAX(version) FROM catalog_history)
   ORDER BY id`,
];

function readStatements(db: D1Database, userId: string): D1PreparedStatement[] {
  return READS.map((sql) => db.prepare(sql).bind(...(sql.includes("?1") ? [userId] : [])));
}

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// `results` holds the six read results, in the order of READS.
function toFactsRead(results: readonly D1Result[]): FactsRead {
  const [user, answers, leads, purchases, version, offers] = results as [
    D1Result<{ id: string }>,
    D1Result<{ question_key: string; value: string }>,
    D1Result<{ offer_id: string; accepted_at: number }>,
    D1Result<{ offer_id: string }>,
    D1Result<{ version: number | null }>,
    D1Result<OfferRow>,
  ];
  const answerMap: Record<string, unknown> = {};
  for (const a of answers.results) answerMap[a.question_key] = parseValue(a.value);
  const { catalog, errors } = parseCatalog(version.results[0]?.version ?? null, offers.results);
  return {
    facts: {
      answers: answerMap,
      leads: leads.results.map((l) => ({ offerId: l.offer_id, acceptedAt: l.accepted_at })),
      purchases: purchases.results.map((p) => ({ offerId: p.offer_id })),
    },
    catalog,
    catalogErrors: errors,
    userExists: user.results.length > 0,
  };
}

export async function readFacts(db: D1Database, userId: string): Promise<FactsRead> {
  return toFactsRead(await db.batch(readStatements(db, userId)));
}

export type Completion = {
  userId: string;
  emailEnc: string;
  emailHash: string;
  answers: Readonly<Record<string, string>>;
  receivedAt: number;
};

// Upserts the user and the answers, then reads the facts back in the same transaction, so
// select() runs on what is stored even if a later completion won the received_at race.
export async function completeQuiz(db: D1Database, w: Completion): Promise<FactsRead> {
  const writes = [
    db
      .prepare(
        `INSERT INTO users (id, email_enc, email_hash, created_at, last_completed_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT (id) DO UPDATE
           SET email_enc = excluded.email_enc, email_hash = excluded.email_hash,
               last_completed_at = excluded.last_completed_at
           WHERE excluded.last_completed_at > users.last_completed_at`,
      )
      .bind(w.userId, w.emailEnc, w.emailHash, w.receivedAt),
    ...Object.entries(w.answers).map(([key, value]) =>
      db
        .prepare(
          `INSERT INTO user_answers (user_id, question_key, value, received_at)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (user_id, question_key) DO UPDATE
             SET value = excluded.value, received_at = excluded.received_at
             WHERE excluded.received_at > user_answers.received_at`,
        )
        .bind(w.userId, key, JSON.stringify(value), w.receivedAt),
    ),
  ];
  const results = await db.batch([...writes, ...readStatements(db, w.userId)]);
  return toFactsRead(results.slice(writes.length));
}
