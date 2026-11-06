// Ops: the alert evaluator that runs on the */5 cron, with the checks the Worker can make directly.
// Implements metrics-and-operations.md "Alerts", ADR 0005 and ADR 0006 "Watch"; serves NFR-3, NFR-5, NFR-6, MVP-5, PB-4, Q-11.
// An alert is a rule over `AlertReadings`. A reading that is `null` is unknown or not due, and an unknown reading never fires.
import { z } from "zod";
import { countQuarantineBetween, databaseSize } from "../db/ops.ts";
import {
  AnalyticsSqlError,
  analyticsSql,
  readSqlSignals,
  type AnalyticsSql,
  type SqlSignals,
} from "../db/analytics-engine.ts";
import { deletePostbackCountsBefore, postbackCountsSince } from "../db/postback-counts.ts";
import { ALERT_STATE_KEY, REJECTED_PREFIX, listKeys } from "../events/files.ts";
import { readHealth, type PipelineHealth } from "../events/health.ts";
import { d1SizePoint, pipelinePoint, writePoint } from "./metrics.ts";

export const ALERT_CRON = "*/5 * * * *";
export const SIZE_CHECK_EVERY_MS = 86_400_000;
// The run deletes postback counts older than this.
const POSTBACK_COUNTS_KEEP_MS = 86_400_000;
// A run with no stored state looks this far back for new files and rows.
export const LOOK_BACK_MS = 300_000;

// Counting of `rejected/` stops here; a bucket with more files than this is already an incident.
const REJECTED_LIST_MAX = 10_000;

export type AlertId =
  | "freshness_lag"
  | "pending_oldest_file"
  | "rejected_new_file"
  | "quarantine_new_row"
  | "dlq_not_empty"
  | "postbacks_without_conversions"
  | "d1_facts_size"
  | "d1_events_size"
  | "selection_p95"
  | "worker_5xx_rate"
  | "d1_overload_errors";

// The keys are the ALERT_THRESHOLDS var in wrangler.jsonc (docs/requirements/nfr.md, "Set in stage 4").
const thresholdsSchema = z.object({
  freshness_lag_ms: z.number().min(0),
  pending_oldest_file_ms: z.number().min(0),
  postbacks_min_requests: z.number().min(0),
  postbacks_window_ms: z.number().min(0),
  d1_facts_size_bytes: z.number().min(0),
  d1_events_size_bytes: z.number().min(0),
  selection_p95_ms: z.number().min(0),
  worker_5xx_rate: z.number().min(0),
  d1_overload_errors_per_hour: z.number().min(0),
});

export type AlertThresholds = z.infer<typeof thresholdsSchema>;

export function parseThresholds(raw: unknown): AlertThresholds | null {
  const parsed = thresholdsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// `checked_at` ends the window of the last run; `sizes_checked_at` is the last time both D1 sizes were read.
export type AlertState = { checked_at: number; sizes_checked_at: number };

export type AlertReadings = {
  health: PipelineHealth | null;
  queueBacklog: number | null;
  dlqBacklog: number | null;
  rejectedNew: number | null;
  quarantineNew: number | null;
  postbacks: { partner_id: string; requests: number; accepted: number }[] | null;
  sizes: { facts: number; events: number } | null;
  sql: SqlSignals | null;
};

export type AlertFiring = {
  id: AlertId;
  value: number;
  threshold: number;
  endpoint?: string;
  partner_id?: string;
};

type Rule = (readings: AlertReadings, t: AlertThresholds) => AlertFiring[];

const above = (id: AlertId, value: number | null, threshold: number): AlertFiring[] =>
  value !== null && value > threshold ? [{ id, value, threshold }] : [];

// The newest events row is older than the limit and something is waiting to be loaded. An idle system
// has an old newest row and nothing waiting, and must stay silent. An unreadable Queue backlog counts as waiting.
const freshnessLag: Rule = ({ health, queueBacklog }, t) => {
  if (health === null) return [];
  const waiting = health.pending_files > 0 || queueBacklog === null || queueBacklog > 0;
  return waiting ? above("freshness_lag", health.freshness_ms, t.freshness_lag_ms) : [];
};

// The order is the order of the log lines.
const RULES: Rule[] = [
  freshnessLag,
  ({ health }, t) =>
    above("pending_oldest_file", health?.pending_oldest_age_ms ?? null, t.pending_oldest_file_ms),
  // Any new file. Two overlapping loader runs can write rows that D1 already holds to `rejected/`
  // (stage 5 notes), so the action is to check the file's event ids against D1 before moving it back.
  ({ rejectedNew }) => above("rejected_new_file", rejectedNew, 0),
  ({ quarantineNew }) => above("quarantine_new_row", quarantineNew, 0),
  ({ dlqBacklog }) => above("dlq_not_empty", dlqBacklog, 0),
  // Per partner: enough requests in the window and none accepted (a wrong secret, a broken click lookup).
  ({ postbacks }, t) =>
    (postbacks ?? [])
      .filter((p) => p.requests >= t.postbacks_min_requests && p.accepted === 0)
      .map((p) => ({
        id: "postbacks_without_conversions" as const,
        value: p.requests,
        threshold: t.postbacks_min_requests,
        partner_id: p.partner_id,
      })),
  ({ sizes }, t) => above("d1_facts_size", sizes?.facts ?? null, t.d1_facts_size_bytes),
  ({ sizes }, t) => above("d1_events_size", sizes?.events ?? null, t.d1_events_size_bytes),
  // Per endpoint, from the Analytics Engine SQL API.
  ({ sql }, t) =>
    (sql?.selectionP95 ?? [])
      .filter((e) => e.p95_ms > t.selection_p95_ms)
      .map((e) => ({
        id: "selection_p95" as const,
        value: e.p95_ms,
        threshold: t.selection_p95_ms,
        endpoint: e.endpoint,
      })),
  // No requests in the window is no rate, so no line.
  ({ sql }, t) =>
    sql !== null &&
    sql.worker5xx.requests > 0 &&
    sql.worker5xx.errors / sql.worker5xx.requests > t.worker_5xx_rate
      ? [
          {
            id: "worker_5xx_rate" as const,
            value: sql.worker5xx.errors / sql.worker5xx.requests,
            threshold: t.worker_5xx_rate,
          },
        ]
      : [],
  ({ sql }, t) =>
    above("d1_overload_errors", sql?.d1Overload ?? null, t.d1_overload_errors_per_hour),
];

export function evaluateAlerts(readings: AlertReadings, t: AlertThresholds): AlertFiring[] {
  return RULES.flatMap((rule) => rule(readings, t));
}

export type AlertEnv = Pick<
  Env,
  | "EVENTS_BUCKET"
  | "EVENTS"
  | "FACTS"
  | "EVENTS_QUEUE"
  | "EVENTS_DLQ"
  | "METRICS"
  | "ALERT_THRESHOLDS"
  | "AE_SQL_TOKEN"
  | "CF_ACCOUNT_ID"
>;

// The alerts that need the Analytics Engine SQL API (decision 16).
const SQL_ALERTS: AlertId[] = ["selection_p95", "worker_5xx_rate", "d1_overload_errors"];

// Without both secrets (missing or empty) the SQL alerts are not evaluated.
function sqlClient(env: AlertEnv): AnalyticsSql | null {
  const token = env.AE_SQL_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  if (token === undefined || token === "" || accountId === undefined || accountId === "")
    return null;
  return analyticsSql({ accountId, token });
}

async function readState(bucket: R2Bucket): Promise<AlertState | null> {
  try {
    const object = await bucket.get(ALERT_STATE_KEY);
    if (object === null) return null;
    const parsed = JSON.parse(await object.text()) as Partial<AlertState>;
    if (typeof parsed.checked_at !== "number" || typeof parsed.sizes_checked_at !== "number")
      return null;
    return { checked_at: parsed.checked_at, sizes_checked_at: parsed.sizes_checked_at };
  } catch {
    return null;
  }
}

// `failure` holds the fields of the `alert_source_unavailable` line that say why: an error class `name`
// and, for the SQL API, the HTTP `status`; or a `reason`. It never holds a message.
type Failure = { name?: string; status?: number; reason?: string };
type Reading<T> = { source: string; alerts: AlertId[]; value: T | null; failure: Failure | null };

// One source of readings. A failure is kept for logging and the other sources still answer.
async function readSource<T>(
  source: string,
  alerts: AlertId[],
  read: (() => Promise<T>) | null,
): Promise<Reading<T>> {
  if (read === null) return { source, alerts, value: null, failure: null };
  try {
    return { source, alerts, value: await read(), failure: null };
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    const failure: Failure =
      err instanceof AnalyticsSqlError ? { name, status: err.status } : { name };
    return { source, alerts, value: null, failure };
  }
}

type QueueReading = { backlog: number; bytes: number; oldestAgeMs: number };

async function readQueue(queue: Queue, now: number): Promise<QueueReading> {
  const metrics = await queue.metrics();
  const oldest = metrics.oldestMessageTimestamp;
  return {
    backlog: metrics.backlogCount,
    bytes: metrics.backlogBytes,
    oldestAgeMs: oldest === undefined ? 0 : Math.max(0, now - oldest.getTime()),
  };
}

async function countRejectedBetween(bucket: R2Bucket, after: number, upTo: number) {
  const { keys } = await listKeys(bucket, REJECTED_PREFIX, REJECTED_LIST_MAX);
  return keys.filter((k) => k.uploaded > after && k.uploaded <= upTo).length;
}

// `deps.sql` replaces the Analytics Engine client in tests; `null` stands for no token.
export async function runAlerts(
  env: AlertEnv,
  now: number,
  deps: { sql?: AnalyticsSql | null } = {},
): Promise<{ firing: AlertFiring[]; unavailable: string[] }> {
  const thresholds = parseThresholds(env.ALERT_THRESHOLDS);
  if (thresholds === null) {
    console.log(JSON.stringify({ msg: "alert_config_error" }));
    return { firing: [], unavailable: [] };
  }

  const state = await readState(env.EVENTS_BUCKET);
  const after = state?.checked_at ?? now - LOOK_BACK_MS;
  const sizesDue = state === null || now - state.sizes_checked_at >= SIZE_CHECK_EVERY_MS;

  const sqlSource = deps.sql === undefined ? sqlClient(env) : deps.sql;
  const [health, rejected, quarantine, postbacks, queue, dlq, sizes, sql] = await Promise.all([
    readSource("pipeline_health", ["freshness_lag", "pending_oldest_file"], () =>
      readHealth(env, now),
    ),
    readSource("rejected", ["rejected_new_file"], () =>
      countRejectedBetween(env.EVENTS_BUCKET, after, now),
    ),
    readSource("quarantine", ["quarantine_new_row"], () =>
      countQuarantineBetween(env.FACTS, after, now),
    ),
    readSource("postback_counts", ["postbacks_without_conversions"], () =>
      postbackCountsSince(env.FACTS, now - thresholds.postbacks_window_ms),
    ),
    // An unreadable backlog makes freshness_lag fire as if messages wait, so it is listed here.
    readSource("events_queue", ["freshness_lag"], () => readQueue(env.EVENTS_QUEUE, now)),
    readSource("dlq", ["dlq_not_empty"], () => readQueue(env.EVENTS_DLQ, now)),
    readSource(
      "d1_size",
      ["d1_facts_size", "d1_events_size"],
      sizesDue
        ? async () => {
            const [facts, events] = await Promise.all([
              databaseSize(env.FACTS),
              databaseSize(env.EVENTS),
            ]);
            return { facts, events };
          }
        : null,
    ),
    sqlSource === null
      ? ({
          source: "analytics_engine_sql",
          alerts: SQL_ALERTS,
          value: null,
          failure: { reason: "no_token" },
        } satisfies Reading<SqlSignals>)
      : readSource("analytics_engine_sql", SQL_ALERTS, () => readSqlSignals(sqlSource)),
  ]);

  const unavailable: string[] = [];
  for (const r of [health, rejected, quarantine, postbacks, queue, dlq, sizes, sql]) {
    if (r.failure === null) continue;
    unavailable.push(r.source);
    console.log(
      JSON.stringify({
        msg: "alert_source_unavailable",
        source: r.source,
        alerts: r.alerts,
        ...r.failure,
      }),
    );
  }

  const readings: AlertReadings = {
    health: health.value,
    queueBacklog: queue.value?.backlog ?? null,
    dlqBacklog: dlq.value?.backlog ?? null,
    rejectedNew: rejected.value,
    quarantineNew: quarantine.value,
    postbacks: postbacks.value,
    sizes: sizes.value,
    sql: sql.value,
  };
  const firing = evaluateAlerts(readings, thresholds);
  for (const f of firing) console.log(JSON.stringify({ msg: "alert", ...f }));

  // -1 stands for an unknown reading (metrics.ts); no pending file is an age of 0.
  writePoint(
    env.METRICS,
    pipelinePoint({
      pendingFiles: health.value?.pending_files ?? -1,
      pendingOldestAgeMs: health.value === null ? null : (health.value.pending_oldest_age_ms ?? 0),
      queueBacklog: queue.value?.backlog ?? null,
      queueBacklogBytes: queue.value?.bytes ?? null,
      queueOldestAgeMs: queue.value?.oldestAgeMs ?? null,
      dlqBacklog: dlq.value?.backlog ?? null,
    }),
  );
  if (sizes.value !== null) {
    writePoint(env.METRICS, d1SizePoint("facts", sizes.value.facts));
    writePoint(env.METRICS, d1SizePoint("events", sizes.value.events));
  }

  // After the evaluation, so a failed delete never hides a firing.
  try {
    await deletePostbackCountsBefore(env.FACTS, now - POSTBACK_COUNTS_KEEP_MS);
  } catch (err) {
    console.log(
      JSON.stringify({
        msg: "postback_counts_delete_failed",
        name: err instanceof Error ? err.name : "unknown",
      }),
    );
  }

  // Last, so a run that throws looks at the same window again. A failed size read stays due.
  const next: AlertState = {
    checked_at: now,
    sizes_checked_at: sizes.value === null ? (state?.sizes_checked_at ?? 0) : now,
  };
  await env.EVENTS_BUCKET.put(ALERT_STATE_KEY, JSON.stringify(next));

  console.log(JSON.stringify({ msg: "alert_run", firing: firing.length, unavailable }));
  return { firing, unavailable };
}
