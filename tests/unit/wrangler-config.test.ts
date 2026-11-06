import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eventsBucketName, readWranglerConfig } from "../../scripts/lib/wrangler-config.ts";
import { retryDelaySeconds } from "../../src/events/consumer.ts";
import { LOADER_CRON } from "../../src/events/loader.ts";

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
});
