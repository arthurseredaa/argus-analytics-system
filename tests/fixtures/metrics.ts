// Fixture: Analytics Engine datasets and facts databases for the metrics and probe tests.
// Serves NFR-3, NFR-6, R-12; the writers are in src/ops/metrics.ts.

// Miniflare's local dataset sends nowhere, so a test passes this one as `METRICS` and reads the points back.
export function recordingDataset(): {
  dataset: AnalyticsEngineDataset;
  points: AnalyticsEngineDataPoint[];
} {
  const points: AnalyticsEngineDataPoint[] = [];
  const dataset: AnalyticsEngineDataset = {
    writeDataPoint: (point) => {
      if (point !== undefined) points.push(point);
    },
  };
  return { dataset, points };
}

// A binding that throws on every write.
export function throwingDataset(): AnalyticsEngineDataset {
  return {
    writeDataPoint: () => {
      throw new Error("analytics engine down");
    },
  };
}

// A facts database whose every call fails with `message`.
function brokenFacts(message: string): D1Database {
  const fail = () => {
    throw new Error(message);
  };
  return { prepare: fail, batch: fail, exec: fail } as unknown as D1Database;
}

export const overloadedFacts = (): D1Database =>
  brokenFacts("D1 DB is overloaded. Requests queued for too long.");

export const failingFacts = (): D1Database => brokenFacts("D1_ERROR: no such table");
