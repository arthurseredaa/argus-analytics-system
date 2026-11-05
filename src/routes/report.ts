// Route: GET /api/report, the funnel report as JSON in the cohort or the postback view.
// Implements design "Two report views" (ADR 0003, ADR 0005); serves AN-1 to AN-7, R-12, R-17.
// No identity middleware and no cookie: the report holds aggregate counts only.
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { readEventsReport, readFactsReport } from "../db/report.ts";
import { buildReport, parseReportQuery } from "../domain/report.ts";

export function reportRoute(): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.get("/api/report", async (c) => {
    const now = Date.now();
    const query = parseReportQuery(new URL(c.req.url).searchParams, now);
    if (query === null) return c.json({ error: "invalid_query" }, 400);

    const [events, facts] = await Promise.all([
      readEventsReport(c.env.EVENTS, query),
      readFactsReport(c.env.FACTS, query),
    ]);
    const report = buildReport({
      query,
      asOf: now,
      eventsNewestAt: events.newestAt,
      funnel: events.funnel,
      clicks: facts.clicks,
      leads: facts.leads,
      purchases: facts.purchases,
      payouts: facts.payouts,
    });
    // Names fields and counts only, never a value from the request.
    console.log(
      JSON.stringify({
        msg: "report",
        rows_read_events: events.rowsRead,
        rows_read_facts: facts.rowsRead,
      }),
    );
    return c.json(report, 200, { "cache-control": "no-store" });
  });

  return route;
}
