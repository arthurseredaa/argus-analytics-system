// Ops: the alert evaluator that runs on the */5 cron, with the checks the Worker can make directly.
// Implements metrics-and-operations.md "Alerts", ADR 0005 and ADR 0006 "Watch"; serves NFR-3, NFR-5, NFR-6, MVP-5, PB-4, Q-11.
// An alert is a rule over `AlertReadings`. A reading that is `null` is unknown or not due, and an unknown reading never fires.
import { z } from "zod";
import { countQuarantineBetween, databaseSize } from "../db/ops.ts";
import { ALERT_STATE_KEY, REJECTED_PREFIX, listKeys } from "../events/files.ts";
import { readHealth, type PipelineHealth } from "../events/health.ts";
import { d1SizePoint, pipelinePoint, writePoint } from "./metrics.ts";

export const ALERT_CRON = "*/5 * * * *";
export const SIZE_CHECK_EVERY_MS = 86_400_000;
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
  sizes: { facts: number; events: number } | null;
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

// Tasks 3 and 4 append their rules here. The order is the order of the log lines.
const RULES: Rule[] = [
  freshnessLag,
  ({ health }, t) =>
    above("pending_oldest_file", health?.pending_oldest_age_ms ?? null, t.pending_oldest_file_ms),
  // Any new file. Two overlapping loader runs can write rows that D1 already holds to `rejected/`
  // (stage 5 notes), so the action is to check the file's event ids against D1 before moving it back.
  ({ rejectedNew }) => above("rejected_new_file", rejectedNew, 0),
  ({ quarantineNew }) => above("quarantine_new_row", quarantineNew, 0),
  ({ dlqBacklog }) => above("dlq_not_empty", dlqBacklog, 0),
  ({ sizes }, t) => above("d1_facts_size", sizes?.facts ?? null, t.d1_facts_size_bytes),
  ({ sizes }, t) => above("d1_events_size", sizes?.events ?? null, t.d1_events_size_bytes),
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
>;

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

type Reading<T> = { source: string; alerts: AlertId[]; value: T | null; failure: string | null };

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
    return { source, alerts, value: null, failure: err instanceof Error ? err.name : "unknown" };
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

export async function runAlerts(
  env: AlertEnv,
  now: number,
): Promise<{ firing: AlertFiring[]; unavailable: string[] }> {
  const thresholds = parseThresholds(env.ALERT_THRESHOLDS);
  if (thresholds === null) {
    console.log(JSON.stringify({ msg: "alert_config_error" }));
    return { firing: [], unavailable: [] };
  }

  const state = await readState(env.EVENTS_BUCKET);
  const after = state?.checked_at ?? now - LOOK_BACK_MS;
  const sizesDue = state === null || now - state.sizes_checked_at >= SIZE_CHECK_EVERY_MS;

  const [health, rejected, quarantine, queue, dlq, sizes] = await Promise.all([
    readSource("pipeline_health", ["freshness_lag", "pending_oldest_file"], () =>
      readHealth(env, now),
    ),
    readSource("rejected", ["rejected_new_file"], () =>
      countRejectedBetween(env.EVENTS_BUCKET, after, now),
    ),
    readSource("quarantine", ["quarantine_new_row"], () =>
      countQuarantineBetween(env.FACTS, after, now),
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
  ]);

  const unavailable: string[] = [];
  for (const r of [health, rejected, quarantine, queue, dlq, sizes]) {
    if (r.failure === null) continue;
    unavailable.push(r.source);
    console.log(
      JSON.stringify({
        msg: "alert_source_unavailable",
        source: r.source,
        alerts: r.alerts,
        name: r.failure,
      }),
    );
  }

  const readings: AlertReadings = {
    health: health.value,
    queueBacklog: queue.value?.backlog ?? null,
    dlqBacklog: dlq.value?.backlog ?? null,
    rejectedNew: rejected.value,
    quarantineNew: quarantine.value,
    sizes: sizes.value,
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

  // Last, so a run that throws looks at the same window again. A failed size read stays due.
  const next: AlertState = {
    checked_at: now,
    sizes_checked_at: sizes.value === null ? (state?.sizes_checked_at ?? 0) : now,
  };
  await env.EVENTS_BUCKET.put(ALERT_STATE_KEY, JSON.stringify(next));

  console.log(JSON.stringify({ msg: "alert_run", firing: firing.length, unavailable }));
  return { firing, unavailable };
}
