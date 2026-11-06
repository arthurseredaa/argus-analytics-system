import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eventsBucketName, readWranglerConfig } from "../../scripts/lib/wrangler-config.ts";
import { retryDelaySeconds } from "../../src/events/consumer.ts";
import { LOADER_CRON } from "../../src/events/loader.ts";
import { ALERT_CRON, parseThresholds } from "../../src/ops/alerts.ts";

const config = readWranglerConfig(readFileSync("wrangler.jsonc", "utf8"));

describe("wrangler.jsonc", () => {
  it("NFR-3 the loader cron runs every minute", () => {
    expect(LOADER_CRON).toBe("* * * * *");
    expect(config.triggers?.crons).toContain(LOADER_CRON);
  });

  it("NFR-5 consumer write failure goes to the dead letter queue after 10 retries", () => {
    const consumers = config.queues?.consumers ?? [];
    const events = consumers.find((c) => c.queue === "events");
    expect(events?.max_retries).toBe(10);
    expect(events?.dead_letter_queue).toBe("events-dlq");
    expect(consumers.some((c) => c.queue === "events-dlq")).toBe(false);

    const delays = Array.from({ length: 10 }, (_, i) => retryDelaySeconds(i + 1));
    expect(delays).toEqual([60, 120, 240, 480, 960, 1920, 3600, 3600, 3600, 3600]);
    expect(delays.reduce((sum, d) => sum + d, 0)).toBe(18180);
  });

  it("NFR-5 the bucket name comes from the config", () => {
    expect(eventsBucketName(config)).toBe("funnels-events");
  });

  it("NFR-5 a config that does not parse is refused", () => {
    expect(() => readWranglerConfig("{ not json")).toThrow("does not parse");
  });

  it("NFR-6 the alert cron runs every 5 minutes beside the loader", () => {
    expect(ALERT_CRON).toBe("*/5 * * * *");
    expect(config.triggers?.crons).toEqual(["* * * * *", "*/5 * * * *"]);
  });

  it("NFR-6 alert thresholds in wrangler.jsonc match nfr.md", () => {
    const thresholds = config.vars?.["ALERT_THRESHOLDS"];
    expect(thresholds).toEqual({
      freshness_lag_ms: 900_000,
      pending_oldest_file_ms: 3_600_000,
      postbacks_min_requests: 5,
      postbacks_window_ms: 900_000,
      d1_facts_size_bytes: 7_000_000_000,
      d1_events_size_bytes: 7_000_000_000,
      selection_p95_ms: 300,
      worker_5xx_rate: 0.01,
      d1_overload_errors_per_hour: 10,
    });
    expect(parseThresholds(thresholds)).not.toBeNull();
  });

  it("NFR-5 the dead letter queue is bound for its backlog only", () => {
    const producers = config.queues?.producers ?? [];
    expect(producers.find((p) => p.binding === "EVENTS_DLQ")?.queue).toBe("events-dlq");
    expect(config.queues?.consumers?.some((c) => c.queue === "events-dlq")).toBe(false);
  });
});
