import { describe, expect, it } from "vitest";
import {
  evaluateAlerts,
  parseThresholds,
  type AlertReadings,
  type AlertThresholds,
} from "../../src/ops/alerts.ts";
import type { PipelineHealth } from "../../src/events/health.ts";

// The values of ALERT_THRESHOLDS in wrangler.jsonc; a wrangler-config test pins that file.
const T: AlertThresholds = {
  freshness_lag_ms: 900_000,
  pending_oldest_file_ms: 3_600_000,
  postbacks_min_requests: 5,
  postbacks_window_ms: 900_000,
  d1_facts_size_bytes: 7_000_000_000,
  d1_events_size_bytes: 7_000_000_000,
  selection_p95_ms: 300,
  worker_5xx_rate: 0.01,
  d1_overload_errors_per_hour: 10,
};

function health(overrides: Partial<PipelineHealth> = {}): PipelineHealth {
  return {
    as_of: 0,
    loader_paused: false,
    pending_files: 0,
    pending_truncated: false,
    pending_oldest_age_ms: null,
    open_batches: 0,
    last_load_at: null,
    events_newest_at: null,
    freshness_ms: null,
    ...overrides,
  };
}

// Every reading is quiet unless a case sets it.
function readings(overrides: Partial<AlertReadings> = {}): AlertReadings {
  return {
    health: health(),
    queueBacklog: 0,
    dlqBacklog: 0,
    rejectedNew: 0,
    quarantineNew: 0,
    postbacks: [],
    sizes: null,
    ...overrides,
  };
}

const ids = (r: AlertReadings) => evaluateAlerts(r, T).map((f) => f.id);

describe("evaluateAlerts", () => {
  it("NFR-3 freshness_lag fires above 15 minutes when files or messages wait", () => {
    const waiting = readings({ health: health({ freshness_ms: 900_001, pending_files: 1 }) });
    expect(evaluateAlerts(waiting, T)).toEqual([
      { id: "freshness_lag", value: 900_001, threshold: 900_000 },
    ]);

    const atThreshold = readings({ health: health({ freshness_ms: 900_000, pending_files: 1 }) });
    expect(ids(atThreshold)).toEqual([]);

    const idle = readings({ health: health({ freshness_ms: 900_001, pending_files: 0 }) });
    expect(ids(idle)).toEqual([]);

    const queued = readings({
      health: health({ freshness_ms: 900_001, pending_files: 0 }),
      queueBacklog: 3,
    });
    expect(ids(queued)).toEqual(["freshness_lag"]);

    const unknownBacklog = readings({
      health: health({ freshness_ms: 900_001, pending_files: 0 }),
      queueBacklog: null,
    });
    expect(ids(unknownBacklog)).toEqual(["freshness_lag"]);

    const emptyTable = readings({ health: health({ freshness_ms: null, pending_files: 1 }) });
    expect(ids(emptyTable)).toEqual([]);

    expect(ids(readings({ health: null, queueBacklog: null }))).toEqual([]);
  });

  it("NFR-5 pending_oldest_file fires above one hour", () => {
    const over = readings({
      health: health({ pending_files: 1, pending_oldest_age_ms: 3_600_001 }),
    });
    expect(evaluateAlerts(over, T)).toEqual([
      { id: "pending_oldest_file", value: 3_600_001, threshold: 3_600_000 },
    ]);
    const at = readings({
      health: health({ pending_files: 1, pending_oldest_age_ms: 3_600_000 }),
    });
    expect(ids(at)).toEqual([]);
  });

  it("NFR-5 rejected_new_file fires on any new file", () => {
    expect(evaluateAlerts(readings({ rejectedNew: 1 }), T)).toEqual([
      { id: "rejected_new_file", value: 1, threshold: 0 },
    ]);
    expect(ids(readings({ rejectedNew: 0 }))).toEqual([]);
    expect(ids(readings({ rejectedNew: null }))).toEqual([]);
  });

  it("PB-4 Q-11 quarantine_new_row fires on any new row", () => {
    expect(evaluateAlerts(readings({ quarantineNew: 1 }), T)).toEqual([
      { id: "quarantine_new_row", value: 1, threshold: 0 },
    ]);
    expect(ids(readings({ quarantineNew: 0 }))).toEqual([]);
    expect(ids(readings({ quarantineNew: null }))).toEqual([]);
  });

  it("PB-3 postbacks_without_conversions fires at 5 requests with none accepted", () => {
    const fires = readings({ postbacks: [{ partner_id: "p1", requests: 5, accepted: 0 }] });
    expect(evaluateAlerts(fires, T)).toEqual([
      { id: "postbacks_without_conversions", value: 5, threshold: 5, partner_id: "p1" },
    ]);
    const few = readings({ postbacks: [{ partner_id: "p1", requests: 4, accepted: 0 }] });
    expect(ids(few)).toEqual([]);
    const converting = readings({ postbacks: [{ partner_id: "p1", requests: 9, accepted: 1 }] });
    expect(ids(converting)).toEqual([]);
    expect(ids(readings({ postbacks: null }))).toEqual([]);
  });

  it("NFR-5 dlq_not_empty fires on any message", () => {
    expect(evaluateAlerts(readings({ dlqBacklog: 2 }), T)).toEqual([
      { id: "dlq_not_empty", value: 2, threshold: 0 },
    ]);
    expect(ids(readings({ dlqBacklog: 0 }))).toEqual([]);
    expect(ids(readings({ dlqBacklog: null }))).toEqual([]);
  });

  it("MVP-5 d1_facts_size and d1_events_size fire above 7 GB", () => {
    const over = readings({ sizes: { facts: 7_000_000_001, events: 7_000_000_001 } });
    expect(evaluateAlerts(over, T)).toEqual([
      { id: "d1_facts_size", value: 7_000_000_001, threshold: 7_000_000_000 },
      { id: "d1_events_size", value: 7_000_000_001, threshold: 7_000_000_000 },
    ]);
    const at = readings({ sizes: { facts: 7_000_000_000, events: 7_000_000_000 } });
    expect(ids(at)).toEqual([]);
    expect(ids(readings({ sizes: null }))).toEqual([]);
  });
});

describe("parseThresholds", () => {
  it("NFR-6 parseThresholds accepts the full object", () => {
    expect(parseThresholds(T)).toEqual(T);
  });

  it("NFR-6 parseThresholds rejects a missing, negative or non-number value", () => {
    const { freshness_lag_ms: _missing, ...withoutOne } = T;
    expect(parseThresholds(withoutOne)).toBeNull();
    expect(parseThresholds({ ...T, selection_p95_ms: -1 })).toBeNull();
    expect(parseThresholds({ ...T, worker_5xx_rate: "0.01" })).toBeNull();
    expect(parseThresholds(null)).toBeNull();
    expect(parseThresholds("soon")).toBeNull();
  });
});
