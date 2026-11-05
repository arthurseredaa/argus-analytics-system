// Route: GET /api/report (JSON) and GET /report (HTML), the funnel report in the cohort or the postback view.
// Implements design "Two report views" (ADR 0003, ADR 0005); serves AN-1 to AN-7, R-12, R-17.
// No identity middleware and no cookie: the report holds aggregate counts only.
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { readEventsReport, readFactsReport } from "../db/report.ts";
import { buildReport, parseReportQuery, type Report } from "../domain/report.ts";
import { renderReportPage } from "../pages/report.ts";

// The read both routes share. Null means the query is invalid.
async function loadReport(env: AppEnv["Bindings"], url: string): Promise<Report | null> {
  const now = Date.now();
  const query = parseReportQuery(new URL(url).searchParams, now);
  if (query === null) return null;

  const [events, facts] = await Promise.all([
    readEventsReport(env.EVENTS, query),
    readFactsReport(env.FACTS, query),
  ]);
  // Names fields and counts only, never a value from the request.
  console.log(
    JSON.stringify({
      msg: "report",
      rows_read_events: events.rowsRead,
      rows_read_facts: facts.rowsRead,
    }),
  );
  return buildReport({
    query,
    asOf: now,
    eventsNewestAt: events.newestAt,
    funnel: events.funnel,
    clicks: facts.clicks,
    leads: facts.leads,
    purchases: facts.purchases,
    payouts: facts.payouts,
  });
}

export function reportRoute(): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.get("/api/report", async (c) => {
    const report = await loadReport(c.env, c.req.url);
    if (report === null) return c.json({ error: "invalid_query" }, 400);
    return c.json(report, 200, { "cache-control": "no-store" });
  });

  route.get("/report", async (c) => {
    const report = await loadReport(c.env, c.req.url);
    if (report === null) return c.text("Invalid report query", 400);
    return c.html(renderReportPage(report), 200, { "cache-control": "no-store" });
  });

  return route;
}
