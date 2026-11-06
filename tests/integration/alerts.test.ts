import { createScheduledController, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storedEvent } from "../fixtures/events.ts";
import worker from "../../src/index.ts";
import { ALERT_CRON, runAlerts } from "../../src/ops/alerts.ts";
import {
  alertLines,
  logLines,
  putAlertState,
  queueWithBacklog,
  queueWithoutMetrics,
  testThresholds,
} from "../fixtures/alerts.ts";
import { clearBucket, loadNow, putPending } from "../fixtures/files.ts";
import { recordingDataset } from "../fixtures/metrics.ts";
import { leadBody, postback } from "../fixtures/postback.ts";

const HOUR = 3_600_000;

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

    await runAlerts(alertEnv(recordingDataset()), start + 1000);
    const first = alertLines(log).filter((l) => l["id"] === "rejected_new_file");
    expect(first).toHaveLength(1);
    expect(first[0]?.["value"]).toBe(1);
    expect(first[0]?.["threshold"]).toBe(0);

    log.mockClear();
    await runAlerts(alertEnv(recordingDataset()), start + 2000);
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

    await runAlerts(alertEnv(recordingDataset()), Date.now() + 1000);
    const first = alertLines(log).filter((l) => l["id"] === "quarantine_new_row");
    expect(first).toHaveLength(1);
    expect(first[0]?.["value"]).toBeGreaterThanOrEqual(1);

    log.mockClear();
    await runAlerts(alertEnv(recordingDataset()), Date.now() + 2000);
    expect(alertLines(log).some((l) => l["id"] === "quarantine_new_row")).toBe(false);

    expect(log.mock.calls.some((args) => String(args[0]).includes("user1@example.com"))).toBe(
      false,
    );
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
});
