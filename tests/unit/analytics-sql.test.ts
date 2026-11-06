import { describe, expect, it } from "vitest";
import {
  AnalyticsSqlError,
  D1_OVERLOAD_SQL,
  METRICS_DATASET,
  SELECTION_P95_SQL,
  WORKER_5XX_SQL,
  analyticsSql,
  readSqlSignals,
  type AnalyticsSql,
} from "../../src/db/analytics-engine.ts";
import { SELECTION_ENDPOINTS } from "../../src/ops/metrics.ts";

type Recorded = { url: string; init: RequestInit | undefined };

// A fetch that records its request and answers with `status` and `body`.
function fakeFetch(status: number, body: unknown) {
  const calls: Recorded[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetcher, calls };
}

// Every number comes back as a string, as the SQL API does for 64-bit integers.
const stringSql: AnalyticsSql = async (query) => {
  if (query === SELECTION_P95_SQL)
    return [{ endpoint: "GET /go", p95_ms: "312.5", requests: "40" }];
  if (query === WORKER_5XX_SQL) return [{ errors: "2", requests: "100" }];
  return [{ errors: "11" }];
};

describe("Analytics Engine SQL client", () => {
  it("NFR-6 the SQL client posts to the account's Analytics Engine endpoint with the token", async () => {
    const { fetcher, calls } = fakeFetch(200, { data: [{ n: 1 }] });
    const sql = analyticsSql({ accountId: "acc-test", token: "tok-test" }, fetcher);

    const rows = await sql("SELECT 1 AS n");

    expect(rows).toEqual([{ n: 1 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc-test/analytics_engine/sql",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer tok-test");
    expect(calls[0]?.init?.body).toBe("SELECT 1 AS n");
  });

  it("NFR-6 R-12 a failed SQL call throws the status and never the token", async () => {
    const { fetcher } = fakeFetch(403, { errors: [{ message: "denied for tok-test" }] });
    const sql = analyticsSql({ accountId: "acc-test", token: "tok-test" }, fetcher);

    const err = await sql("SELECT 1").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AnalyticsSqlError);
    expect((err as AnalyticsSqlError).status).toBe(403);
    expect(String(err)).not.toContain("tok-test");
    expect((err as AnalyticsSqlError).message).not.toContain("tok-test");
  });

  it("NFR-6 the latency queries weight by _sample_interval over their windows", () => {
    for (const q of [SELECTION_P95_SQL, WORKER_5XX_SQL, D1_OVERLOAD_SQL]) {
      expect(q).toContain(`FROM ${METRICS_DATASET}`);
      expect(q).toContain("_sample_interval");
    }

    expect(SELECTION_P95_SQL).toContain("index1 AS endpoint");
    expect(SELECTION_P95_SQL).toContain(
      "quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms",
    );
    expect(SELECTION_P95_SQL).toContain("SUM(_sample_interval) AS requests");
    expect(SELECTION_P95_SQL).toContain("blob1 = 'request'");
    expect(SELECTION_P95_SQL).toContain("timestamp > NOW() - INTERVAL '15' MINUTE");
    expect(SELECTION_P95_SQL).toContain("GROUP BY endpoint");
    expect(SELECTION_P95_SQL).toContain("FORMAT JSON");
    // Exactly the three selection endpoints, in the IN list and nowhere else.
    expect(SELECTION_P95_SQL).toContain(
      `index1 IN (${SELECTION_ENDPOINTS.map((e) => `'${e}'`).join(", ")})`,
    );
    expect(SELECTION_P95_SQL.match(/'[^']*\/[^']*'/g)).toHaveLength(SELECTION_ENDPOINTS.length);

    expect(WORKER_5XX_SQL).toContain("SUM(IF(double2 >= 500, _sample_interval, 0)) AS errors");
    expect(WORKER_5XX_SQL).toContain("SUM(_sample_interval) AS requests");
    expect(WORKER_5XX_SQL).toContain("blob1 = 'request'");
    expect(WORKER_5XX_SQL).toContain("INTERVAL '5' MINUTE");

    expect(D1_OVERLOAD_SQL).toContain("SUM(_sample_interval) AS errors");
    expect(D1_OVERLOAD_SQL).toContain("blob1 = 'request' AND blob4 = 'd1_overload'");
    expect(D1_OVERLOAD_SQL).toContain("INTERVAL '1' HOUR");
  });

  it("NFR-6 numbers that come back as strings are read as numbers", async () => {
    const sql = stringSql;

    const signals = await readSqlSignals(sql);

    expect(signals.selectionP95).toEqual([{ endpoint: "GET /go", p95_ms: 312.5, requests: 40 }]);
    expect(signals.worker5xx).toEqual({ errors: 2, requests: 100 });
    expect(signals.d1Overload).toBe(11);
  });

  it("NFR-6 a query that matched no rows reads as zero", async () => {
    const signals = await readSqlSignals(async () => []);

    expect(signals).toEqual({
      selectionP95: [],
      worker5xx: { errors: 0, requests: 0 },
      d1Overload: 0,
    });
  });
});
