// DB: the two reads of the alert run, new quarantine rows and the size of a D1 database.
// Implements metrics-and-operations.md "Alerts"; serves PB-4, Q-11, MVP-5.

// Rows received after `after` and at or before `upTo`, so a row is counted by exactly one run.
export async function countQuarantineBetween(
  db: D1Database,
  after: number,
  upTo: number,
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM quarantine WHERE received_at > ?1 AND received_at <= ?2")
    .bind(after, upTo)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// `meta.size_after` is the figure `wrangler d1 info` prints; any statement reports it.
export async function databaseSize(db: D1Database): Promise<number> {
  const result = await db.prepare("SELECT 1").run();
  return result.meta.size_after;
}
