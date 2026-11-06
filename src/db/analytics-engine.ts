// DB: the Analytics Engine SQL API client and the three alert queries over the metrics dataset.
// Implements metrics-and-operations.md "Latency target" step 2 and "Alerts" (decision 16 of the stage 6 plan); serves NFR-6.
// The token goes into one request header. It is never put into an error, so a log line cannot carry it.
import { SELECTION_ENDPOINTS } from "../ops/metrics.ts";

// The dataset of the METRICS binding in wrangler.jsonc; a unit test checks that they agree.
export const METRICS_DATASET = "funnels_metrics";

export type AnalyticsSql = (sql: string) => Promise<Record<string, unknown>[]>;

// The message names the status only: the response body and the request headers stay out of it.
export class AnalyticsSqlError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Analytics Engine SQL API answered ${status}`);
    this.name = "AnalyticsSqlError";
    this.status = status;
  }
}

export function analyticsSql(
  creds: { accountId: string; token: string },
  fetcher?: typeof fetch,
): AnalyticsSql {
  // Looked up per call, so a stubbed global fetch is the one used.
  const send = fetcher ?? ((input, init) => fetch(input, init));
  const url = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/analytics_engine/sql`;
  return async (sql) => {
    const res = await send(url, {
      method: "POST",
      headers: { authorization: `Bearer ${creds.token}` },
      body: sql,
    });
    if (!res.ok) throw new AnalyticsSqlError(res.status);
    const body = (await res.json()) as { data?: Record<string, unknown>[] };
    return body.data ?? [];
  };
}

const endpointList = SELECTION_ENDPOINTS.map((e) => `'${e}'`).join(", ");

// p95 per selection endpoint over 15 minutes. Analytics Engine samples at high write rates, so every
// figure is weighted by `_sample_interval`.
export const SELECTION_P95_SQL = `SELECT index1 AS endpoint, quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms, SUM(_sample_interval) AS requests FROM ${METRICS_DATASET} WHERE blob1 = 'request' AND index1 IN (${endpointList}) AND timestamp > NOW() - INTERVAL '15' MINUTE GROUP BY endpoint FORMAT JSON`;

// 5xx responses (double2 is the HTTP status) among all requests over 5 minutes.
export const WORKER_5XX_SQL = `SELECT SUM(IF(double2 >= 500, _sample_interval, 0)) AS errors, SUM(_sample_interval) AS requests FROM ${METRICS_DATASET} WHERE blob1 = 'request' AND timestamp > NOW() - INTERVAL '5' MINUTE FORMAT JSON`;

// Requests tagged `d1_overload` (blob4) over an hour.
export const D1_OVERLOAD_SQL = `SELECT SUM(_sample_interval) AS errors FROM ${METRICS_DATASET} WHERE blob1 = 'request' AND blob4 = 'd1_overload' AND timestamp > NOW() - INTERVAL '1' HOUR FORMAT JSON`;

export type SqlSignals = {
  selectionP95: { endpoint: string; p95_ms: number; requests: number }[];
  worker5xx: { errors: number; requests: number };
  d1Overload: number;
};

// 64-bit integers can come back as strings, and a sum over no rows as null.
const num = (value: unknown): number => Number(value ?? 0);

export async function readSqlSignals(sql: AnalyticsSql): Promise<SqlSignals> {
  const [selection, worker, overload] = await Promise.all([
    sql(SELECTION_P95_SQL),
    sql(WORKER_5XX_SQL),
    sql(D1_OVERLOAD_SQL),
  ]);
  return {
    selectionP95: selection.map((row) => ({
      endpoint: String(row["endpoint"]),
      p95_ms: num(row["p95_ms"]),
      requests: num(row["requests"]),
    })),
    worker5xx: { errors: num(worker[0]?.["errors"]), requests: num(worker[0]?.["requests"]) },
    d1Overload: num(overload[0]?.["errors"]),
  };
}
