// DB: postback requests per partner and minute, for the postbacks_without_conversions alert.
// Implements metrics-and-operations.md "Alerts"; serves PB-3, PB-4, Q-11.

const MINUTE_MS = 60_000;

// Adds one request, and one acceptance when `accepted`, to the partner's row for the minute of `at`.
export async function recordPostback(
  db: D1Database,
  input: { at: number; partnerId: string; accepted: boolean },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO postback_counts (minute, partner_id, requests, accepted)
       VALUES (?1, ?2, 1, ?3)
       ON CONFLICT (minute, partner_id) DO UPDATE
       SET requests = requests + 1, accepted = accepted + excluded.accepted`,
    )
    .bind(input.at - (input.at % MINUTE_MS), input.partnerId, input.accepted ? 1 : 0)
    .run();
}

// Sums per partner over the minutes from the one that holds `since` onward.
export async function postbackCountsSince(
  db: D1Database,
  since: number,
): Promise<{ partner_id: string; requests: number; accepted: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT partner_id, SUM(requests) AS requests, SUM(accepted) AS accepted
       FROM postback_counts WHERE minute >= ?1 GROUP BY partner_id`,
    )
    .bind(since - (since % MINUTE_MS))
    .all<{ partner_id: string; requests: number; accepted: number }>();
  return results;
}

export async function deletePostbackCountsBefore(db: D1Database, before: number): Promise<void> {
  await db.prepare("DELETE FROM postback_counts WHERE minute < ?1").bind(before).run();
}
