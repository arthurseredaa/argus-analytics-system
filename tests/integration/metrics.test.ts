import { createScheduledController, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOADER_CRON, type LoaderRun } from "../../src/events/loader.ts";
import worker from "../../src/index.ts";
import { recordLoaderRun } from "../../src/ops/metrics.ts";
import { browserEvent } from "../fixtures/event-bodies.ts";
import { call, postEvent, storedEvent } from "../fixtures/events.ts";
import { clearBucket, pauseLoader, putPending, resumeLoader } from "../fixtures/files.ts";
import { newCookie } from "../fixtures/http.ts";
import {
  failingEvents,
  failingFacts,
  overloadedFacts,
  recordingDataset,
  throwingDataset,
} from "../fixtures/metrics.ts";

const logLines = (log: { mock: { calls: unknown[][] } }) =>
  log.mock.calls.map((args) => String(args[0]));

const runLoaderCron = (rec: ReturnType<typeof recordingDataset>) =>
  worker.scheduled(createScheduledController({ cron: LOADER_CRON }), {
    ...env,
    METRICS: rec.dataset,
  });

beforeEach(clearBucket);
afterEach(async () => {
  vi.restoreAllMocks();
  await resumeLoader();
});

describe("request data points", () => {
  it("NFR-6 every request writes one data point", async () => {
    const cookie = newCookie();
    const rec = recordingDataset();
    const override = { METRICS: rec.dataset };
    const statuses = [
      (await call("/healthz", {}, override)).status,
      (await call("/p/demo", { cookie }, override)).status,
      (await postEvent(browserEvent(), cookie, override)).status,
      (await call("/api/report", {}, override)).status,
      (await call("/__probe", {}, override)).status,
      (await call("/nope", {}, override)).status,
    ];

    expect(rec.points.map((p) => p.indexes?.[0])).toEqual([
      "GET /healthz",
      "GET /p/:prelander",
      "POST /api/events",
      "GET /api/report",
      "GET /__probe",
      "GET other",
    ]);
    expect(rec.points.map((p) => p.doubles?.[1])).toEqual(statuses);
    for (const point of rec.points) expect(point.doubles?.[0]).toBeGreaterThanOrEqual(0);
  });

  it("NFR-6 a handler that throws is recorded with status 500", async () => {
    const rec = recordingDataset();
    const res = await call(
      "/go?prelander=demo",
      { cookie: newCookie() },
      { METRICS: rec.dataset, FACTS: failingFacts() },
    );
    expect(res.status).toBe(500);
    expect(rec.points).toHaveLength(1);
    expect(rec.points[0]?.doubles?.[1]).toBe(500);
    expect(rec.points[0]?.blobs?.[3]).toBe("");
  });

  it("NFR-6 a D1 overload that reaches the error handler is tagged on its point", async () => {
    const log = vi.spyOn(console, "log");
    const rec = recordingDataset();
    const res = await call(
      "/go?prelander=demo",
      { cookie: newCookie() },
      { METRICS: rec.dataset, FACTS: overloadedFacts() },
    );
    expect(res.status).toBe(500);
    expect(rec.points[0]?.doubles?.[1]).toBe(500);
    expect(rec.points[0]?.blobs?.[3]).toBe("d1_overload");
    const lines = logLines(log);
    expect(lines.some((l) => l.includes('"msg":"unhandled"'))).toBe(true);
    expect(lines.some((l) => l.includes("overloaded"))).toBe(false);
  });

  it("NFR-6 a broken Analytics Engine binding never fails the request", async () => {
    const log = vi.spyOn(console, "log");
    const res = await call("/healthz", {}, { METRICS: throwingDataset() });
    expect(res.status).toBe(200);
    expect(logLines(log).some((l) => l.includes('"msg":"metrics_write_failed"'))).toBe(true);
  });

  it("R-12 a data point never carries the request path, query or body", async () => {
    const rec = recordingDataset();
    const cookie = newCookie();
    await call("/p/demo?email=user1%40example.com", { cookie }, { METRICS: rec.dataset });
    await call(
      "/api/complete",
      {
        method: "POST",
        cookie,
        body: JSON.stringify({
          prelander_id: "demo",
          answers: { gender: "male", ethnicity: "asian" },
          email: "user1@example.com",
        }),
      },
      { METRICS: rec.dataset },
    );
    expect(rec.points).toHaveLength(2);
    const text = JSON.stringify(rec.points);
    expect(text).not.toContain("user1@example.com");
    expect(text).not.toContain("user1%40example.com");
    expect(text).not.toContain("demo");
    expect(text).not.toContain(cookie.slice(4));
  });
});

describe("loader data points", () => {
  it("NFR-3 each loader run writes one freshness point", async () => {
    const rec = recordingDataset();
    await putPending([storedEvent()], 1);
    await runLoaderCron(rec);
    expect(rec.points).toHaveLength(1);
    expect(rec.points[0]?.indexes?.[0]).toBe("loader");
    expect(rec.points[0]?.blobs?.[1]).toBe("done");
    expect(typeof rec.points[0]?.doubles?.[0]).toBe("number");

    await pauseLoader();
    const paused = recordingDataset();
    await runLoaderCron(paused);
    expect(paused.points).toHaveLength(1);
    expect(paused.points[0]?.blobs?.[1]).toBe("paused");
  });

  it("NFR-3 a loader point is still written when the freshness read fails", async () => {
    const log = vi.spyOn(console, "log");
    const rec = recordingDataset();
    const run: LoaderRun = {
      status: "d1_unreachable",
      batchIds: [],
      files: 0,
      rows: 0,
      duplicates: 0,
      invalid: 0,
      rejected: 0,
    };

    await expect(
      recordLoaderRun({ METRICS: rec.dataset, EVENTS: failingEvents() }, run, Date.now()),
    ).resolves.toBeUndefined();

    expect(rec.points).toHaveLength(1);
    expect(rec.points[0]?.indexes?.[0]).toBe("loader");
    expect(rec.points[0]?.blobs?.[1]).toBe("d1_unreachable");
    expect(rec.points[0]?.doubles?.[0]).toBe(-1);
    expect(logLines(log).some((l) => l.includes('"msg":"metrics_read_failed"'))).toBe(true);
    expect(logLines(log).some((l) => l.includes("events database down"))).toBe(false);
  });
});
