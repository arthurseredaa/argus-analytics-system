// DB: the reads and deletes behind the test routes, kept apart from the facts the product uses.
// Implements ADR 0003 (facts in D1) and ADR 0005 (events table); serves ID-1, PB-3, R-12, DEMO-2.

export type TestStateRead = {
  user: { created_at: number; last_completed_at: number; email_hash: string } | null;
  counts: { users: number; clicks: number; conversions: number };
  partnerSecrets: string[];
};

// The user row leaves out email_enc on purpose: the test state never carries a ciphertext.
export async function readTestState(db: D1Database, userId: string): Promise<TestStateRead> {
  const [user, counts, partners] = await db.batch([
    db
      .prepare("SELECT created_at, last_completed_at, email_hash FROM users WHERE id = ?1")
      .bind(userId),
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM clicks) AS clicks,
              (SELECT COUNT(*) FROM conversions) AS conversions`,
    ),
    db.prepare("SELECT secret_current_enc FROM partners ORDER BY id"),
  ]);
  return {
    user: (user?.results[0] as TestStateRead["user"] | undefined) ?? null,
    counts: counts?.results[0] as TestStateRead["counts"],
    partnerSecrets: ((partners?.results ?? []) as { secret_current_enc: string }[]).map(
      (p) => p.secret_current_enc,
    ),
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
