import { describe, expect, it } from "vitest";
import {
  d1SizePoint,
  endpointOf,
  isD1Overload,
  loaderPoint,
  pipelinePoint,
  requestPoint,
} from "../../src/ops/metrics.ts";

describe("data point builders", () => {
  it("NFR-6 endpoint labels are fixed patterns, never the raw path", () => {
    expect(endpointOf("GET", "/p/demo")).toBe("GET /p/:prelander");
    expect(endpointOf("POST", "/postback/v1/partnerA")).toBe("POST /postback/v1/:partner");
    expect(endpointOf("GET", "/go")).toBe("GET /go");
    expect(endpointOf("GET", "/go/")).toBe("GET /go");
    expect(endpointOf("GET", "/__test/state")).toBe("GET /__test/*");
    expect(endpointOf("GET", "/p/demo/extra")).toBe("GET other");
    expect(endpointOf("GET", "/wp-login.php")).toBe("GET other");
    expect(endpointOf("GET", "/p/x")).toBe("GET /p/:prelander");
    expect(endpointOf("BREW", "/healthz")).toBe("OTHER other");
  });

  it("NFR-6 R-18 a request point has the endpoint as index, duration and status as doubles, country and colo as blobs", () => {
    expect(
      requestPoint({
        endpoint: "GET /go",
        durationMs: 42,
        status: 302,
        country: "DE",
        colo: "FRA",
        errorTag: "",
      }),
    ).toEqual({ indexes: ["GET /go"], blobs: ["request", "DE", "FRA", ""], doubles: [42, 302] });
  });

  it("NFR-3 the loader point carries freshness, files and rows", () => {
    expect(loaderPoint({ status: "done", freshnessMs: 1500, files: 3, rows: 9 })).toEqual({
      indexes: ["loader"],
      blobs: ["loader", "done"],
      doubles: [1500, 3, 9],
    });
    expect(loaderPoint({ status: "done", freshnessMs: null, files: 0, rows: 0 }).doubles?.[0]).toBe(
      -1,
    );
  });

  it("MVP-5 a size point names the database and its bytes", () => {
    expect(d1SizePoint("facts", 4096)).toEqual({
      indexes: ["d1_size"],
      blobs: ["d1_size", "facts"],
      doubles: [4096],
    });
  });

  it("NFR-5 the pipeline point writes -1 for an unknown reading", () => {
    expect(
      pipelinePoint({
        pendingFiles: 2,
        pendingOldestAgeMs: null,
        queueBacklog: 5,
        queueBacklogBytes: null,
        queueOldestAgeMs: null,
        dlqBacklog: 0,
      }),
    ).toEqual({
      indexes: ["pipeline"],
      blobs: ["pipeline"],
      doubles: [2, -1, 5, -1, -1, 0],
    });
  });

  it("NFR-6 D1 overload errors are recognised by their message", () => {
    expect(isD1Overload(new Error("D1 DB is overloaded. Requests queued for too long."))).toBe(
      true,
    );
    expect(isD1Overload(new Error("D1 DB is overloaded. Too many requests queued."))).toBe(true);
    expect(isD1Overload(new Error("D1_ERROR: no such table"))).toBe(false);
    expect(isD1Overload("overloaded")).toBe(false);
    expect(isD1Overload(undefined)).toBe(false);
  });
});
