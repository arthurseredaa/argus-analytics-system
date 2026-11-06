import { createScheduledController, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storedEvent } from "../fixtures/events.ts";
import worker from "../../src/index.ts";
import {
  AnalyticsSqlError,
  analyticsSql,
  D1_OVERLOAD_SQL,
  SELECTION_P95_SQL,
  WORKER_5XX_SQL,
  type AnalyticsSql,
} from "../../src/db/analytics-engine.ts";
import { ALERT_CRON, WINDOW_LAG_MS, runAlerts } from "../../src/ops/alerts.ts";
import { ALERT_STATE_KEY } from "../../src/events/files.ts";
import {
  alertLines,
  logLines,
  putAlertState,
  queueWithBacklog,
  queueWithoutMetrics,
  testThresholds,
} from "../fixtures/alerts.ts";
import { clearBucket, loadNow, putPending } from "../fixtures/files.ts";
import { failingFacts, recordingDataset } from "../fixtures/metrics.ts";
import { leadBody, postback } from "../fixtures/postback.ts";

const HOUR = 3_600_000;
// Each window ends this long before the run (WINDOW_LAG_MS in src/ops/alerts.ts).
const LAG = 30_000;

beforeEach(clearBucket);
afterEach(() => {
  vi.restoreAllMocks();
});

// The alert run against the test bindings; `override` swaps what a case needs to control.
function alertEnv(rec: ReturnType<typeof recordingDataset>, override: Partial<Env> = {}): Env {
  return {
    ...env,
    METRICS: rec.dataset,
    EVENTS_QUEUE: queueWithBacklog(0),
    EVENTS_DLQ: queueWithBacklog(0),
    ...override,
  };
}

// Quiet Analytics Engine answers, for the cases that are not about the SQL alerts.
const quietSql = { sql: (async () => []) as AnalyticsSql };

const failingSql: AnalyticsSql = async () => {
  throw new AnalyticsSqlError(500);
};

// Readings above all three thresholds.
const highSql: AnalyticsSql = async (query) => {
  if (query === SELECTION_P95_SQL) return [{ endpoint: "GET /go", p95_ms: "450", requests: "80" }];
  if (query === WORKER_5XX_SQL) return [{ errors: "3", requests: "100" }];
  if (query === D1_OVERLOAD_SQL) return [{ errors: "12" }];
  return [];
};

// One answer is not a number.
const malformedSql: AnalyticsSql = async (query) =>
  query === D1_OVERLOAD_SQL ? [{ errors: "many" }] : [];

const readState = async () =>
  JSON.parse(await (await env.EVENTS_BUCKET.get(ALERT_STATE_KEY))!.text()) as Record<
    string,
    number
  >;

const pointsOf = (rec: ReturnType<typeof recordingDataset>, kind: string) =>
  rec.points.filter((p) => p.indexes?.[0] === kind);

describe("alert run", () => {
  it("NFR-5 the dead letter queue binding answers metrics in the test runtime", async () => {
    expect(typeof (await env.EVENTS_DLQ.metrics()).backlogCount).toBe("number");
  });

  it("NFR-3 freshness_lag fires when the newest event is old and files wait", async () => {
    const log = vi.spyOn(console, "log");
    await putPending([storedEvent()]);
    await loadNow();
    await putPending([storedEvent()]);

    await runAlerts(alertEnv(recordingDataset()), Date.now() + 16 * 60_000);

    const line = alertLines(log).find((l) => l["id"] === "freshness_lag");
    expect(line?.["value"]).toBeGreaterThan(900_000);
    expect(line?.["threshold"]).toBe(900_000);
  });

  it("NFR-3 freshness_lag stays silent when nothing waits", async () => {
    const log = vi.spyOn(console, "log");
    await putPending([storedEvent()]);
    await loadNow();

    await runAlerts(alertEnv(recordingDataset()), Date.now() + 16 * 60_000);

    expect(alertLines(log).some((l) => l["id"] === "freshness_lag")).toBe(false);
  });

  it("NFR-5 pending_oldest_file fires when the oldest pending file is older than an hour", async () => {
    const log = vi.spyOn(console, "log");
    await putPending([storedEvent()]);

    await runAlerts(alertEnv(recordingDataset()), Date.now() + 61 * 60_000);

    const line = alertLines(log).find((l) => l["id"] === "pending_oldest_file");
    expect(line?.["value"]).toBeGreaterThanOrEqual(3_660_000);
    expect(line?.["threshold"]).toBe(3_600_000);
  });

  it("NFR-5 rejected_new_file fires once for a file written since the last run", async () => {
    const log = vi.spyOn(console, "log");
    const start = Date.now();
    await putAlertState({ checked_at: start - 1000, sizes_checked_at: start });
    await env.EVENTS_BUCKET.put(`rejected/t-${crypto.randomUUID()}.ndjson`, "{}\n");

    await runAlerts(alertEnv(recordingDataset()), start + LAG + 1000);
    const first = alertLines(log).filter((l) => l["id"] === "rejected_new_file");
    expect(first).toHaveLength(1);
    expect(first[0]?.["value"]).toBe(1);
    expect(first[0]?.["threshold"]).toBe(0);

    log.mockClear();
    await runAlerts(alertEnv(recordingDataset()), start + LAG + 2000);
    expect(alertLines(log).some((l) => l["id"] === "rejected_new_file")).toBe(false);
  });

  it("PB-4 Q-11 quarantine_new_row fires once for a signed postback with an unknown click", async () => {
    const log = vi.spyOn(console, "log");
    const start = Date.now();
    await putAlertState({ checked_at: start - 1000, sizes_checked_at: start });

    const res = await postback(
      "partnerA",
      leadBody(`unknown-${crypto.randomUUID()}`, { partner_user_id: "user1@example.com" }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "quarantined" });

    await runAlerts(alertEnv(recordingDataset()), Date.now() + LAG + 1000);
    const first = alertLines(log).filter((l) => l["id"] === "quarantine_new_row");
    expect(first).toHaveLength(1);
    expect(first[0]?.["value"]).toBeGreaterThanOrEqual(1);

    log.mockClear();
    await runAlerts(alertEnv(recordingDataset()), Date.now() + LAG + 2000);
    expect(alertLines(log).some((l) => l["id"] === "quarantine_new_row")).toBe(false);

    expect(log.mock.calls.some((args) => String(args[0]).includes("user1@example.com"))).toBe(
      false,
    );
  });

  it("NFR-5 a failed rejected listing keeps its window, so the next run still sees the file", async () => {
    const log = vi.spyOn(console, "log");
    const start = Date.now();
    await putAlertState({
      rejected_checked_at: start - 1000,
      quarantine_checked_at: start - 1000,
      sizes_checked_at: start,
    });
    await env.EVENTS_BUCKET.put(`rejected/t-${crypto.randomUUID()}.ndjson`, "{}\n");

    // Only the listing fails; the state write at the end of the run uses the real bucket.
    const failingList = new Proxy(env.EVENTS_BUCKET, {
      get: (target, prop) => {
        if (prop === "list")
          return async () => {
            throw new Error("r2 list down");
          };
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await runAlerts(
      alertEnv(recordingDataset(), { EVENTS_BUCKET: failingList }),
      start + LAG + 1000,
    );
    expect(logLines(log, "alert_source_unavailable").map((l) => l["source"])).toContain("rejected");
    const state = await readState();
    expect(state["rejected_checked_at"]).toBe(start - 1000);
    expect(state["quarantine_checked_at"]).toBe(start + 1000);

    log.mockClear();
    await runAlerts(alertEnv(recordingDataset()), start + LAG + 2000);
    expect(alertLines(log).filter((l) => l["id"] === "rejected_new_file")).toHaveLength(1);
    expect((await readState())["rejected_checked_at"]).toBe(start + 2000);
  });

  it("PB-4 Q-11 a failed quarantine read keeps its window, so the next run still sees the row", async () => {
    const log = vi.spyOn(console, "log");
    const start = Date.now();
    await putAlertState({
      rejected_checked_at: start - 1000,
      quarantine_checked_at: start - 1000,
      sizes_checked_at: start,
    });
    const res = await postback("partnerA", leadBody(`unknown-${crypto.randomUUID()}`));
    expect(await res.json()).toEqual({ status: "quarantined" });

    const failedAt = Date.now() + LAG + 1000;
    await runAlerts(alertEnv(recordingDataset(), { FACTS: failingFacts() }), failedAt);
    expect(logLines(log, "alert_source_unavailable").map((l) => l["source"])).toContain(
      "quarantine",
    );
    expect((await readState())["quarantine_checked_at"]).toBe(start - 1000);

    log.mockClear();
    await runAlerts(alertEnv(recordingDataset()), failedAt + 1000);
    expect(
      alertLines(log).filter((l) => l["id"] === "quarantine_new_row").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("NFR-5 a state with the single checked_at is read as both windows", async () => {
    const log = vi.spyOn(console, "log");
    const start = Date.now();
    await putAlertState({ checked_at: start - 1000, sizes_checked_at: start });
    await env.EVENTS_BUCKET.put(`rejected/t-${crypto.randomUUID()}.ndjson`, "{}\n");

    await runAlerts(alertEnv(recordingDataset()), start + LAG + 1000);

    expect(alertLines(log).filter((l) => l["id"] === "rejected_new_file")).toHaveLength(1);
    const state = await readState();
    expect(state["rejected_checked_at"]).toBe(start + 1000);
    expect(state["quarantine_checked_at"]).toBe(start + 1000);
    expect(state).not.toHaveProperty("checked_at");
  });

  it("NFR-5 each window ends 30 seconds before the run and that end is the next start", async () => {
    const log = vi.spyOn(console, "log");
    expect(WINDOW_LAG_MS).toBe(LAG);
    const start = Date.now();
    await putAlertState({
      rejected_checked_at: start - 1000,
      quarantine_checked_at: start - 1000,
      sizes_checked_at: start,
    });
    await env.EVENTS_BUCKET.put(`rejected/t-${crypto.randomUUID()}.ndjson`, "{}\n");

    // The file was uploaded about `start`, inside the last 30 seconds of this run: not counted yet.
    await runAlerts(alertEnv(recordingDataset()), start + 10_000);
    expect(alertLines(log).some((l) => l["id"] === "rejected_new_file")).toBe(false);
    expect((await readState())["rejected_checked_at"]).toBe(start + 10_000 - LAG);

    // The next window starts where the last one ended, so the file is counted once.
    await runAlerts(alertEnv(recordingDataset()), start + 60_000);
    expect(alertLines(log).filter((l) => l["id"] === "rejected_new_file")).toHaveLength(1);
    expect((await readState())["rejected_checked_at"]).toBe(start + 60_000 - LAG);
  });

  it("NFR-5 a read error on the state aborts the run and leaves the state as it was", async () => {
    const log = vi.spyOn(console, "log");
    const start = Date.now();
    const state = {
      rejected_checked_at: start - 5000,
      quarantine_checked_at: start - 4000,
      sizes_checked_at: start - 3000,
    };
    await putAlertState(state);
    const unreadable = new Proxy(env.EVENTS_BUCKET, {
      get: (target, prop) => {
        if (prop === "get")
          return async () => {
            throw new Error("r2 get down");
          };
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(
      runAlerts(alertEnv(recordingDataset(), { EVENTS_BUCKET: unreadable }), start + LAG + 1000),
    ).rejects.toThrow("r2 get down");

    expect(await readState()).toEqual(state);
    expect(logLines(log, "alert_run")).toHaveLength(0);
  });

  it("NFR-5 a malformed state object is read as no state", async () => {
    const log = vi.spyOn(console, "log");
    await env.EVENTS_BUCKET.put(ALERT_STATE_KEY, "{not json");

    await runAlerts(alertEnv(recordingDataset()), Date.now());

    expect(logLines(log, "alert_run")).toHaveLength(1);
    expect(await readState()).toHaveProperty("rejected_checked_at");
  });

  it("NFR-3 R10 freshness_lag ignores an unreadable Queue backlog and counts files in pending", async () => {
    const log = vi.spyOn(console, "log");
    await putPending([storedEvent()]);
    await loadNow();
    const lateRun = Date.now() + 16 * 60_000;

    await runAlerts(
      alertEnv(recordingDataset(), { EVENTS_QUEUE: queueWithoutMetrics() }),
      lateRun,
      quietSql,
    );
    expect(logLines(log, "alert_source_unavailable").map((l) => l["source"])).toContain(
      "events_queue",
    );
    expect(alertLines(log).some((l) => l["id"] === "freshness_lag")).toBe(false);

    await putPending([storedEvent()]);
    await runAlerts(
      alertEnv(recordingDataset(), { EVENTS_QUEUE: queueWithoutMetrics() }),
      lateRun,
      quietSql,
    );
    expect(alertLines(log).some((l) => l["id"] === "freshness_lag")).toBe(true);
  });

  it("NFR-5 dlq_not_empty fires on messages in the dead letter queue", async () => {
    const log = vi.spyOn(console, "log");

    await runAlerts(alertEnv(recordingDataset(), { EVENTS_DLQ: queueWithBacklog(2) }), Date.now());

    const line = alertLines(log).find((l) => l["id"] === "dlq_not_empty");
    expect(line?.["value"]).toBe(2);
    expect(line?.["threshold"]).toBe(0);
  });

  it("NFR-5 a failing source logs alert_source_unavailable and the other alerts still run", async () => {
    const log = vi.spyOn(console, "log");
    await putPending([storedEvent()]);

    await runAlerts(
      alertEnv(recordingDataset(), { EVENTS_DLQ: queueWithoutMetrics() }),
      Date.now() + 61 * 60_000,
      quietSql,
    );

    const unavailable = logLines(log, "alert_source_unavailable");
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]).toMatchObject({
      source: "dlq",
      alerts: ["dlq_not_empty"],
      name: "Error",
    });
    expect(alertLines(log).some((l) => l["id"] === "pending_oldest_file")).toBe(true);
    expect(logLines(log, "alert_run")[0]?.["unavailable"]).toEqual(["dlq"]);
    expect(log.mock.calls.some((args) => String(args[0]).includes("queue metrics down"))).toBe(
      false,
    );
  });

  it("MVP-5 the D1 sizes are read once a day and written as data points", async () => {
    const start = Date.now();

    const first = recordingDataset();
    await runAlerts(alertEnv(first), start);
    const sizes = pointsOf(first, "d1_size");
    expect(sizes.map((p) => p.blobs)).toEqual([
      ["d1_size", "facts"],
      ["d1_size", "events"],
    ]);
    for (const p of sizes) expect(p.doubles?.[0]).toBeGreaterThan(0);

    const hourLater = recordingDataset();
    await runAlerts(alertEnv(hourLater), start + HOUR);
    expect(pointsOf(hourLater, "d1_size")).toHaveLength(0);

    const dayLater = recordingDataset();
    await runAlerts(alertEnv(dayLater), start + 25 * HOUR);
    expect(pointsOf(dayLater, "d1_size")).toHaveLength(2);
  });

  it("MVP-5 d1_events_size fires above its threshold", async () => {
    const log = vi.spyOn(console, "log");
    const rec = recordingDataset();

    await runAlerts(
      alertEnv(rec, { ALERT_THRESHOLDS: testThresholds({ d1_events_size_bytes: 1 }) }),
      Date.now(),
    );

    const bytes = pointsOf(rec, "d1_size").find((p) => p.blobs?.[1] === "events")?.doubles?.[0];
    const line = alertLines(log).find((l) => l["id"] === "d1_events_size");
    expect(bytes).toBeGreaterThan(1);
    expect(line?.["value"]).toBe(bytes);
    expect(line?.["threshold"]).toBe(1);
  });

  it("NFR-5 the alert run writes one pipeline point", async () => {
    const rec = recordingDataset();

    await runAlerts(alertEnv(rec), Date.now());

    const points = pointsOf(rec, "pipeline");
    expect(points).toHaveLength(1);
    expect(points[0]?.doubles).toHaveLength(6);
  });

  it("NFR-6 an invalid threshold object stops the run with alert_config_error", async () => {
    const log = vi.spyOn(console, "log");
    await putPending([storedEvent()]);

    const result = await runAlerts(
      alertEnv(recordingDataset(), { ALERT_THRESHOLDS: { freshness_lag_ms: "soon" } }),
      Date.now() + 61 * 60_000,
    );

    expect(logLines(log, "alert_config_error")).toHaveLength(1);
    expect(alertLines(log)).toEqual([]);
    expect(result).toEqual({ firing: [], unavailable: [] });
  });

  it("NFR-6 the alert cron runs the evaluator", async () => {
    const log = vi.spyOn(console, "log");
    const rec = recordingDataset();

    await worker.scheduled(createScheduledController({ cron: ALERT_CRON }), alertEnv(rec));

    expect(logLines(log, "alert_run")).toHaveLength(1);
  });

  it("NFR-6 without the token the SQL alerts log one alert_source_unavailable line", async () => {
    const log = vi.spyOn(console, "log");
    await putPending([storedEvent()]);

    await runAlerts(alertEnv(recordingDataset()), Date.now() + 61 * 60_000);

    const lines = logLines(log, "alert_source_unavailable").filter(
      (l) => l["source"] === "analytics_engine_sql",
    );
    expect(lines).toEqual([
      {
        msg: "alert_source_unavailable",
        source: "analytics_engine_sql",
        reason: "no_token",
        alerts: ["selection_p95", "worker_5xx_rate", "d1_overload_errors"],
      },
    ]);
    expect(logLines(log, "alert_run")[0]?.["unavailable"]).toContain("analytics_engine_sql");
    expect(alertLines(log).some((l) => l["id"] === "pending_oldest_file")).toBe(true);
  });

  it("NFR-6 a failing SQL API logs alert_source_unavailable with the status", async () => {
    const log = vi.spyOn(console, "log");
    await runAlerts(alertEnv(recordingDataset()), Date.now(), { sql: failingSql });

    const lines = logLines(log, "alert_source_unavailable");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      source: "analytics_engine_sql",
      status: 500,
      alerts: ["selection_p95", "worker_5xx_rate", "d1_overload_errors"],
    });
    expect(lines[0]).not.toHaveProperty("reason");
  });

  it("NFR-6 a hung SQL API times out, logs TimeoutError and the run still writes its state", async () => {
    const log = vi.spyOn(console, "log");
    // A fetch that answers only by rejecting when the request is aborted.
    const hung = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const sql = analyticsSql({ accountId: "acc-test", token: "tok-test" }, hung, 50);

    await runAlerts(alertEnv(recordingDataset()), Date.now(), { sql });

    const line = logLines(log, "alert_source_unavailable").find(
      (l) => l["source"] === "analytics_engine_sql",
    );
    expect(line?.["name"]).toBe("TimeoutError");
    expect(logLines(log, "alert_run")).toHaveLength(1);
    expect(await readState()).toHaveProperty("rejected_checked_at");
  });

  it("NFR-6 a malformed number in the SQL answer counts the source as unavailable", async () => {
    const log = vi.spyOn(console, "log");
    await runAlerts(alertEnv(recordingDataset()), Date.now(), { sql: malformedSql });

    const line = logLines(log, "alert_source_unavailable").find(
      (l) => l["source"] === "analytics_engine_sql",
    );
    expect(line?.["name"]).toBe("AnalyticsSqlShapeError");
  });

  it("NFR-6 SQL readings above the thresholds fire their alerts", async () => {
    const log = vi.spyOn(console, "log");
    await runAlerts(alertEnv(recordingDataset()), Date.now(), { sql: highSql });

    const fired = alertLines(log).filter((l) =>
      ["selection_p95", "worker_5xx_rate", "d1_overload_errors"].includes(String(l["id"])),
    );
    expect(fired).toEqual([
      { msg: "alert", id: "selection_p95", value: 450, threshold: 300, endpoint: "GET /go" },
      { msg: "alert", id: "worker_5xx_rate", value: 0.03, threshold: 0.01 },
      { msg: "alert", id: "d1_overload_errors", value: 12, threshold: 10 },
    ]);
  });

  it("R-12 the SQL token never appears in a log line", async () => {
    const log = vi.spyOn(console, "log");
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ errors: [{ message: "bad tok-secret-test" }] }), {
          status: 401,
        }),
    );

    try {
      await runAlerts(
        alertEnv(recordingDataset(), {
          AE_SQL_TOKEN: "tok-secret-test",
          CF_ACCOUNT_ID: "acc-test",
        }),
        Date.now(),
      );
    } finally {
      vi.unstubAllGlobals();
    }

    const failed = logLines(log, "alert_source_unavailable").find(
      (l) => l["source"] === "analytics_engine_sql",
    );
    expect(failed?.["status"]).toBe(401);
    expect(log.mock.calls.some((args) => String(args[0]).includes("tok-secret-test"))).toBe(false);
    expect(log.mock.calls.some((args) => String(args[0]).includes("acc-test"))).toBe(false);
  });
});
