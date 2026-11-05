// DB: the report queries over the events database (funnel steps) and the facts database (clicks, Leads, Purchases).
// Implements design "Metric definitions" and "Two report views" (ADR 0003, ADR 0005); serves AN-1 to AN-8, R-17.
import type {
  ClickCell,
  FunnelCell,
  LeadCell,
  PayoutCell,
  PurchaseCell,
  ReportQuery,
} from "../domain/report.ts";

type Grain = "total" | "prelander" | "offer";
const GRAINS: readonly Grain[] = ["total", "prelander", "offer"];

// The columns of a result row that name its cell. `day`, `prelander_id` and `offer_id` are
// column names of the source (a CTE or the events table), so a grain keeps or nulls each one.
const KEY_COLUMNS: Record<Grain, string> = {
  total: "NULL AS day, NULL AS prelander_id, NULL AS offer_id",
  prelander: "day, prelander_id, NULL AS offer_id",
  offer: "day, prelander_id, offer_id",
};
const GROUP_BY: Record<Grain, string> = {
  total: "",
  prelander: "GROUP BY 1, 2",
  offer: "GROUP BY 1, 2, 3",
};

// A UTC date from a millisecond column. Range filters use the raw column, never this (R-17).
const dayOf = (column: string): string => `strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch')`;

// ?1 from (inclusive, ms), ?2 to (exclusive, ms), ?3 prelander or null, ?4 offer or null.
const eventsRange = `received_at >= ?1 AND received_at < ?2 AND (?3 IS NULL OR prelander_id = ?3)`;
const clickFilters = `(?3 IS NULL OR c.prelander_id = ?3) AND (?4 IS NULL OR c.offer_id = ?4)`;

// Decision 2: a click whose user was deleted counts as its own user.
const USER_KEY = `COALESCE(c.user_id, 'click:' || c.click_id)`;

// Decision 3 (Q-23): the Lead `l` on click `c` is the first accepted Lead of its (user, offer)
// pair, ordered by accepted_at, then conversions.id. A click without a user is its own pair.
const NO_EARLIER_LEAD = `
    AND NOT EXISTS (
      SELECT 1 FROM clicks c2 CROSS JOIN conversions l2 INDEXED BY conversions_click ON l2.click_id = c2.click_id AND l2.type = 'lead'
      WHERE c.user_id IS NOT NULL AND c2.user_id = c.user_id AND c2.offer_id = c.offer_id
        AND (l2.accepted_at, l2.id) < (l.accepted_at, l.id))
    AND NOT EXISTS (
      SELECT 1 FROM conversions l3 INDEXED BY conversions_click
      WHERE c.user_id IS NULL AND l3.click_id = l.click_id AND l3.type = 'lead'
        AND (l3.accepted_at, l3.id) < (l.accepted_at, l.id))`;

// M-26: the pair of Lead `l` has at least one Purchase on that offer, on any of the user's clicks.
const PAIR_HAS_PURCHASE = `(
      EXISTS (SELECT 1 FROM clicks c3 CROSS JOIN conversions p3 ON p3.click_id = c3.click_id AND p3.type = 'purchase'
              WHERE c.user_id IS NOT NULL AND c3.user_id = c.user_id AND c3.offer_id = c.offer_id)
      OR EXISTS (SELECT 1 FROM conversions p4
                 WHERE c.user_id IS NULL AND p4.click_id = l.click_id AND p4.type = 'purchase'))`;

// Decision 4 (M-15): the Purchase `p` on click `c` has no Lead for the pair accepted at or before it.
const PURCHASE_WITHOUT_LEAD = `(
      NOT EXISTS (SELECT 1 FROM clicks c2 CROSS JOIN conversions l2 INDEXED BY conversions_click ON l2.click_id = c2.click_id AND l2.type = 'lead'
                  WHERE c.user_id IS NOT NULL AND c2.user_id = c.user_id AND c2.offer_id = c.offer_id
                    AND l2.accepted_at <= p.accepted_at)
      AND NOT EXISTS (SELECT 1 FROM conversions l3 INDEXED BY conversions_click
                      WHERE c.user_id IS NULL AND l3.click_id = p.click_id AND l3.type = 'lead'
                        AND l3.accepted_at <= p.accepted_at))`;

export type ReportStatement = { db: "events" | "facts"; sql: string };

const statement = (db: "events" | "facts", header: string, body: string): ReportStatement => ({
  db,
  sql: `-- ${header}\n${body}`,
});

const stepUsers = (step: number): string =>
  `COUNT(DISTINCT CASE WHEN type = 'step_viewed' AND json_extract(payload, '$.step') = ${step} THEN user_id END)`;

// Funnel steps, one statement per grain (the funnel has no offer). Distinct users come from
// COUNT(DISTINCT ...) at that grain, so a period counts each user once (decision 8).
// json_extract gives an integer step.
function funnel(grain: "total" | "prelander"): ReportStatement {
  const columns =
    grain === "total"
      ? KEY_COLUMNS.total
      : `${dayOf("received_at")} AS day, prelander_id, NULL AS offer_id`;
  return statement(
    "events",
    `M-1, M-2, M-3, M-4, M-5, M-8: visits, visitors and users per funnel step, by ${grain}`,
    `SELECT ${columns},
  COUNT(DISTINCT CASE WHEN type = 'prelander_viewed' THEN visit_id END) AS visits,
  COUNT(DISTINCT CASE WHEN type = 'prelander_viewed' THEN user_id END) AS visitors,
  ${stepUsers(1)} AS started,
  ${stepUsers(2)} AS step_2,
  ${stepUsers(3)} AS step_3,
  COUNT(DISTINCT CASE WHEN type = 'quiz_completed' THEN user_id END) AS completed
FROM events
WHERE ${eventsRange} AND type IN ('prelander_viewed', 'step_viewed', 'quiz_completed')
${GROUP_BY[grain]}`,
  );
}

const NEWEST_EVENT = statement(
  "events",
  "M-1, M-3, M-8: the newest received_at, the freshness printed next to the as-of time",
  "SELECT MAX(received_at) AS newest_at FROM events",
);

// M-10 and M-11 by the click's own day (cohort view).
function cohortClicks(grain: Grain): ReportStatement {
  return statement(
    "facts",
    `M-10, M-11: users who went to an offer and transitions, by ${grain}, cohort view`,
    `WITH base AS (
  SELECT ${dayOf("c.created_at")} AS day, c.prelander_id AS prelander_id, c.offer_id AS offer_id,
         c.click_id AS click_id, c.reason AS reason, ${USER_KEY} AS ukey
  FROM clicks c
  WHERE c.created_at >= ?1 AND c.created_at < ?2 AND ${clickFilters}
)
SELECT ${KEY_COLUMNS[grain]},
  COUNT(DISTINCT CASE WHEN reason != 'lead_return' THEN ukey END) AS went_to_offer,
  COUNT(*) AS transitions
FROM base
${GROUP_BY[grain]}`,
  );
}

// M-13, M-26, M-27: the first Lead of each pair, on the day of its click (cohort) or the day it
// was accepted (postback). The postback view does not show M-26, so its `lead_with_purchase` is 0.
function leads(view: "cohort" | "postback", grain: Grain): ReportStatement {
  const cohort = view === "cohort";
  return statement(
    "facts",
    `M-13: Leads (first accepted Lead per user and offer), users with a Lead and Leads with a Purchase, by ${grain}, ${view} view`,
    `WITH base AS (
  SELECT ${dayOf(cohort ? "c.created_at" : "l.accepted_at")} AS day, c.prelander_id AS prelander_id,
         c.offer_id AS offer_id, ${USER_KEY} AS ukey,
         ${cohort ? PAIR_HAS_PURCHASE : "0"} AS has_purchase
  FROM ${
    cohort
      ? "clicks c CROSS JOIN conversions l ON l.click_id = c.click_id AND l.type = 'lead'"
      : "conversions l CROSS JOIN clicks c ON c.click_id = l.click_id AND l.type = 'lead'"
  }
  WHERE ${
    cohort
      ? "c.created_at >= ?1 AND c.created_at < ?2"
      : "l.accepted_at >= ?1 AND l.accepted_at < ?2"
  } AND ${clickFilters}${NO_EARLIER_LEAD}
)
SELECT ${KEY_COLUMNS[grain]},
  COUNT(*) AS lead,
  COALESCE(SUM(has_purchase), 0) AS lead_with_purchase,
  COUNT(DISTINCT ukey) AS lead_users
FROM base
${GROUP_BY[grain]}`,
  );
}

// M-14 and M-15, offer grain only: a Purchase belongs to one offer, so the prelander and total
// counts are sums of these cells.
function purchases(view: "cohort" | "postback"): ReportStatement {
  const cohort = view === "cohort";
  return statement(
    "facts",
    `M-14, M-15: Purchases and Purchases without a Lead, by offer, ${view} view`,
    `WITH base AS (
  SELECT ${dayOf(cohort ? "c.created_at" : "p.accepted_at")} AS day, c.prelander_id AS prelander_id,
         c.offer_id AS offer_id, ${PURCHASE_WITHOUT_LEAD} AS without_lead
  FROM ${
    cohort
      ? "clicks c CROSS JOIN conversions p ON p.click_id = c.click_id AND p.type = 'purchase'"
      : "conversions p CROSS JOIN clicks c ON c.click_id = p.click_id AND p.type = 'purchase'"
  }
  WHERE ${
    cohort
      ? "c.created_at >= ?1 AND c.created_at < ?2"
      : "p.accepted_at >= ?1 AND p.accepted_at < ?2"
  } AND ${clickFilters}
)
SELECT ${KEY_COLUMNS.offer}, COUNT(*) AS purchase, COALESCE(SUM(without_lead), 0) AS purchase_without_lead
FROM base
${GROUP_BY.offer}`,
  );
}

// M-16, postback view, offer grain: every accepted Lead and Purchase adds its payout.
const POSTBACK_PAYOUTS = statement(
  "facts",
  "M-16: payout received per currency, by offer, postback view",
  `WITH base AS (
  SELECT ${dayOf("v.accepted_at")} AS day, c.prelander_id AS prelander_id, c.offer_id AS offer_id,
         v.currency AS currency, v.payout AS payout
  FROM conversions v CROSS JOIN clicks c ON c.click_id = v.click_id
  WHERE v.type IN ('lead', 'purchase') AND v.accepted_at >= ?1 AND v.accepted_at < ?2
    AND v.payout IS NOT NULL AND ${clickFilters}
)
SELECT day, prelander_id, offer_id, currency, ROUND(SUM(payout), 4) AS amount
FROM base
GROUP BY 1, 2, 3, 4`,
);

function byGrain(make: (grain: Grain) => ReportStatement, prefix: string) {
  return GRAINS.map((grain) => [`${prefix}_${grain}`, make(grain)] as const);
}

// Every statement the report can run, at every grain and in both views. Raw SQL stays in this file.
export const REPORT_SQL: Readonly<Record<string, ReportStatement>> = Object.fromEntries([
  ["events_funnel_total", funnel("total")],
  ["events_funnel_prelander", funnel("prelander")],
  ["events_newest", NEWEST_EVENT],
  ...byGrain(cohortClicks, "cohort_clicks"),
  ...byGrain((grain) => leads("cohort", grain), "cohort_leads"),
  ["cohort_purchases_offer", purchases("cohort")],
  ...byGrain((grain) => leads("postback", grain), "postback_leads"),
  ["postback_purchases_offer", purchases("postback")],
  ["postback_payouts_offer", POSTBACK_PAYOUTS],
]);

type Row = Record<string, string | number | null>;

function run(db: D1Database, name: string, params: (string | number | null)[]) {
  const entry = REPORT_SQL[name];
  if (entry === undefined) throw new Error(`unknown report statement ${name}`);
  return db.prepare(entry.sql).bind(...params);
}

const rowsOf = (result: D1Result): Row[] => result.results as Row[];
const rowsReadOf = (results: D1Result[]): number =>
  results.reduce((total, r) => total + (r.meta.rows_read ?? 0), 0);

const key = (r: Row) => ({
  day: r.day as string | null,
  prelander_id: r.prelander_id as string | null,
  offer_id: r.offer_id as string | null,
});
const num = (r: Row, name: string): number => (r[name] as number | null) ?? 0;

const toLeads = (rows: Row[]): LeadCell[] =>
  rows.map((r) => ({
    ...key(r),
    lead: num(r, "lead"),
    lead_with_purchase: num(r, "lead_with_purchase"),
    lead_users: num(r, "lead_users"),
  }));

const toPurchases = (rows: Row[]): PurchaseCell[] =>
  rows.map((r) => ({
    ...key(r),
    purchase: num(r, "purchase"),
    purchase_without_lead: num(r, "purchase_without_lead"),
  }));

export async function readEventsReport(
  db: D1Database,
  q: ReportQuery,
): Promise<{ funnel: FunnelCell[]; newestAt: number | null; rowsRead: number }> {
  const params = [q.fromMs, q.toMs, q.prelander];
  // Funnel steps have no offer (decision 10), and the postback view shows none.
  const withFunnel = q.view === "cohort" && q.offer === null;
  const names = [
    ...(withFunnel ? ["events_funnel_total", "events_funnel_prelander"] : []),
    "events_newest",
  ];
  const results = await db.batch(
    names.map((name) => run(db, name, name === "events_newest" ? [] : params)),
  );
  const newest = rowsOf(results[results.length - 1]!)[0];
  return {
    funnel: results
      .slice(0, names.length - 1)
      .flatMap(rowsOf)
      .map((r) => ({
        ...key(r),
        visits: num(r, "visits"),
        visitors: num(r, "visitors"),
        started: num(r, "started"),
        step_2: num(r, "step_2"),
        step_3: num(r, "step_3"),
        completed: num(r, "completed"),
      })),
    newestAt: (newest?.newest_at as number | null | undefined) ?? null,
    rowsRead: rowsReadOf(results),
  };
}

export async function readFactsReport(
  db: D1Database,
  q: ReportQuery,
): Promise<{
  clicks: ClickCell[];
  leads: LeadCell[];
  purchases: PurchaseCell[];
  payouts: PayoutCell[];
  rowsRead: number;
}> {
  const params = [q.fromMs, q.toMs, q.prelander, q.offer];
  const cohort = q.view === "cohort";
  const names = cohort
    ? [
        ...GRAINS.map((g) => `cohort_clicks_${g}`),
        ...GRAINS.map((g) => `cohort_leads_${g}`),
        "cohort_purchases_offer",
      ]
    : ["postback_leads_offer", "postback_purchases_offer", "postback_payouts_offer"];
  const results = await db.batch(names.map((name) => run(db, name, params)));
  const rowsFor = (prefix: string): Row[] =>
    names.flatMap((name, i) => (name.startsWith(prefix) ? rowsOf(results[i]!) : []));
  return {
    clicks: rowsFor("cohort_clicks").map((r) => ({
      ...key(r),
      went_to_offer: num(r, "went_to_offer"),
      transitions: num(r, "transitions"),
    })),
    leads: toLeads(rowsFor(cohort ? "cohort_leads" : "postback_leads")),
    purchases: toPurchases(rowsFor(cohort ? "cohort_purchases" : "postback_purchases")),
    payouts: rowsFor("postback_payouts").map((r) => ({
      ...key(r),
      currency: r.currency as string | null,
      amount: num(r, "amount"),
    })),
    rowsRead: rowsReadOf(results),
  };
}
