// Ops: Workers Analytics Engine data points, one per request, per loader run, per pipeline reading and per size reading.
// Implements metrics-and-operations.md "Latency target (NFR-6)" and ADR 0006 "Freshness"; serves NFR-3, NFR-6, R-12, R-18.
// A point holds a fixed label, numbers and a country code. It never holds a path, a query, a body or an id.
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.ts";
import { newestEventAt } from "../db/events.ts";
import type { LoaderRun } from "../events/loader.ts";

// The endpoints whose p95 is alerted on (the selection target).
export const SELECTION_ENDPOINTS = ["GET /p/:prelander", "POST /api/complete", "GET /go"] as const;

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

// Paths that match exactly, whatever the method.
const EXACT_PATHS = new Set(["/api/events", "/api/complete", "/api/report", "/report", "/__probe"]);

const oneSegment = (rest: string): boolean => rest !== "" && !rest.includes("/");

// The label comes from this fixed list and never from the raw path, so a crafted path cannot reach Analytics Engine.
export function endpointOf(method: string, path: string): string {
  const m = METHODS.has(method) ? method : "OTHER";
  if (m === "GET" && path === "/healthz") return "GET /healthz";
  if (EXACT_PATHS.has(path)) return `${m} ${path}`;
  if (path === "/go" || path === "/go/") return `${m} /go`;
  if (path.startsWith("/p/") && oneSegment(path.slice(3))) return `${m} /p/:prelander`;
  if (path.startsWith("/postback/v1/") && oneSegment(path.slice(13)))
    return `${m} /postback/v1/:partner`;
  if (path.startsWith("/__test/")) return `${m} /__test/*`;
  return `${m} other`;
}

// D1 reports "D1 DB is overloaded. Requests queued for too long." and "... Too many requests queued.".
// The message is read for the match only and never logged.
export function isD1Overload(err: unknown): boolean {
  return err instanceof Error && /overloaded/i.test(err.message);
}

export type ErrorTag = "" | "d1_overload";

export function requestPoint(input: {
  endpoint: string;
  durationMs: number;
  status: number;
  country: string;
  colo: string;
  errorTag: ErrorTag;
}): AnalyticsEngineDataPoint {
  return {
    indexes: [input.endpoint],
    blobs: ["request", input.country, input.colo, input.errorTag],
    doubles: [input.durationMs, input.status],
  };
}

// -1 stands for a reading that is not known, so a query can tell it from 0.
const known = (value: number | null): number => value ?? -1;

export function loaderPoint(input: {
  status: string;
  freshnessMs: number | null;
  files: number;
  rows: number;
}): AnalyticsEngineDataPoint {
  return {
    indexes: ["loader"],
    blobs: ["loader", input.status],
    doubles: [known(input.freshnessMs), input.files, input.rows],
  };
}

export function pipelinePoint(input: {
  pendingFiles: number;
  pendingOldestAgeMs: number | null;
  queueBacklog: number | null;
  queueBacklogBytes: number | null;
  queueOldestAgeMs: number | null;
  dlqBacklog: number | null;
}): AnalyticsEngineDataPoint {
  return {
    indexes: ["pipeline"],
    blobs: ["pipeline"],
    doubles: [
      input.pendingFiles,
      known(input.pendingOldestAgeMs),
      known(input.queueBacklog),
      known(input.queueBacklogBytes),
      known(input.queueOldestAgeMs),
      known(input.dlqBacklog),
    ],
  };
}

export function d1SizePoint(database: "facts" | "events", bytes: number): AnalyticsEngineDataPoint {
  return { indexes: ["d1_size"], blobs: ["d1_size", database], doubles: [bytes] };
}

// A broken binding must not fail the request or the cron run that writes.
export function writePoint(dataset: AnalyticsEngineDataset, point: AnalyticsEngineDataPoint): void {
  try {
    dataset.writeDataPoint(point);
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    console.log(JSON.stringify({ msg: "metrics_write_failed", name }));
  }
}

// One request point after the response is built. Duration is receipt to response, so it excludes waitUntil work.
export function requestMetrics(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const start = Date.now();
    await next();
    const durationMs = Math.max(0, Date.now() - start);
    const cf = c.req.raw.cf;
    writePoint(
      c.env.METRICS,
      requestPoint({
        endpoint: endpointOf(c.req.method, c.req.path),
        durationMs,
        status: c.res.status,
        country: typeof cf?.country === "string" ? cf.country : "",
        colo: typeof cf?.colo === "string" ? cf.colo : "",
        errorTag: c.get("errorTag") ?? "",
      }),
    );
  };
}

// One freshness point per loader run: the age of the newest events row, and what the run did.
export async function recordLoaderRun(
  env: Pick<Env, "METRICS" | "EVENTS">,
  run: LoaderRun,
  now: number,
): Promise<void> {
  // An unreadable events database is an unknown freshness (-1), not a lost point: the run's status still matters.
  let newest: number | null = null;
  try {
    newest = await newestEventAt(env.EVENTS);
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    console.log(JSON.stringify({ msg: "metrics_read_failed", name }));
  }
  writePoint(
    env.METRICS,
    loaderPoint({
      status: run.status,
      freshnessMs: newest === null ? null : Math.max(0, now - newest),
      files: run.files,
      rows: run.rows,
    }),
  );
}
