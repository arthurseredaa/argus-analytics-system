// Page: the funnel report as server-rendered HTML, no script, over the value GET /api/report returns.
// Implements design "Two report views" (ADR 0003, ADR 0005); serves AN-6.
import type {
  CohortOffer,
  CohortReport,
  CohortRow,
  PostbackReport,
  Report,
} from "../domain/report.ts";

const NONE = "–";

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// A count, or a dash where the report holds null (funnel counts under an offer filter).
function count(value: number | null): string {
  return value === null ? NONE : String(value);
}

function percent(value: number | null): string {
  return value === null ? NONE : `${Math.round(value * 10_000) / 100}%`;
}

type Payout = { currency: string | null; amount: number };

function payoutText(payout: readonly Payout[]): string {
  if (payout.length === 0) return NONE;
  return payout
    .map((p) => (p.currency === null ? String(p.amount) : `${p.amount} ${p.currency}`))
    .join(", ");
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

function otherViewHref(report: Report): string {
  const params = new URLSearchParams({
    view: report.view === "cohort" ? "postback" : "cohort",
    from: report.from,
    to: report.to,
  });
  if (report.prelander !== null) params.set("prelander", report.prelander);
  if (report.offer !== null) params.set("offer", report.offer);
  return `/report?${params.toString()}`;
}

function filterForm(report: Report): string {
  const option = (value: string, label: string) =>
    `<option value="${value}"${report.view === value ? " selected" : ""}>${label}</option>`;
  return `<form method="get" action="/report">
  <label>From <input type="date" name="from" value="${esc(report.from)}"></label>
  <label>To <input type="date" name="to" value="${esc(report.to)}"></label>
  <label>Prelander <input type="text" name="prelander" value="${esc(report.prelander ?? "")}"></label>
  <label>Offer <input type="text" name="offer" value="${esc(report.offer ?? "")}"></label>
  <label>View <select name="view">${option("cohort", "Cohort")}${option("postback", "Postback")}</select></label>
  <button type="submit">Show</button>
</form>`;
}

type Column = { key: string; label: string };

function totalsTable(columns: readonly Column[], cell: (key: string) => string): string {
  const body = columns
    .map(
      (c) =>
        `<tr><th scope="row">${esc(c.label)}</th><td data-metric="${c.key}">${cell(c.key)}</td></tr>`,
    )
    .join("\n    ");
  return `<table data-table="totals">
  <tbody>
    ${body}
  </tbody>
</table>`;
}

// The first two cells of a row (day and prelander) are row headers.
function dataTable(
  name: string,
  heads: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const head = heads.map((h) => `<th scope="col">${esc(h)}</th>`).join("");
  const body = rows
    .map(
      (cells) =>
        `<tr>${cells.map((c, i) => (i < 2 ? `<th scope="row">${c}</th>` : `<td>${c}</td>`)).join("")}</tr>`,
    )
    .join("\n    ");
  const empty = `<tr><td colspan="${heads.length}">No rows in this period</td></tr>`;
  return `<table data-table="${name}">
  <thead><tr>${head}</tr></thead>
  <tbody>
    ${body || empty}
  </tbody>
</table>`;
}

const COHORT_COUNTS: Column[] = [
  { key: "visits", label: "Visits" },
  { key: "visitors", label: "Visitors" },
  { key: "started", label: "Started" },
  { key: "step_2", label: "Step 2" },
  { key: "step_3", label: "Step 3" },
  { key: "completed", label: "Completed" },
  { key: "dropoff_step_1", label: "Drop-off at step 1" },
  { key: "dropoff_step_2", label: "Drop-off at step 2" },
  { key: "dropoff_step_3", label: "Drop-off at step 3" },
  { key: "went_to_offer", label: "Went to offer" },
  { key: "transitions", label: "Transitions" },
  { key: "lead", label: "Leads" },
  { key: "purchase", label: "Purchases" },
];

const COHORT_RATES: Column[] = [
  { key: "step_1_to_2", label: "Step 1 to 2" },
  { key: "step_2_to_3", label: "Step 2 to 3" },
  { key: "step_3_to_completion", label: "Step 3 to completion" },
  { key: "dropoff_step_1_share", label: "Drop-off share at step 1" },
  { key: "dropoff_step_2_share", label: "Drop-off share at step 2" },
  { key: "dropoff_step_3_share", label: "Drop-off share at step 3" },
  { key: "start_to_offer", label: "Start to offer" },
  { key: "start_to_lead", label: "Start to Lead" },
  { key: "visits_per_user", label: "Visits per user" },
];

type CountKey = keyof Omit<CohortRow, "day" | "prelander_id" | "offers" | "rates">;
type RateKey = keyof CohortRow["rates"];

// Shown as a plain ratio, not a percentage.
const PLAIN_RATES = new Set<string>(["visits_per_user"]);

function rate(key: string, value: number | null): string {
  return PLAIN_RATES.has(key) ? count(value) : percent(value);
}

function cohortRowCells(row: CohortRow): string[] {
  return [
    esc(row.day),
    esc(row.prelander_id),
    ...COHORT_COUNTS.map((c) => count(row[c.key as CountKey])),
    ...COHORT_RATES.map((c) => rate(c.key, row.rates[c.key as RateKey])),
  ];
}

function cohortOfferCells(day: string, prelander: string, o: CohortOffer): string[] {
  return [
    esc(day),
    esc(prelander),
    esc(o.offer_id),
    String(o.went_to_offer),
    String(o.transitions),
    String(o.lead),
    String(o.purchase),
    percent(o.rates.offer_to_lead),
    percent(o.rates.lead_to_purchase),
  ];
}

function cohortBody(report: CohortReport): string {
  const totals = totalsTable([...COHORT_COUNTS, ...COHORT_RATES], (key) =>
    key in report.rates ? rate(key, report.rates[key as RateKey]) : count(report[key as CountKey]),
  );
  const rows = dataTable(
    "rows",
    ["Day", "Prelander", ...COHORT_COUNTS.map((c) => c.label), ...COHORT_RATES.map((c) => c.label)],
    report.rows.map(cohortRowCells),
  );
  const offers = dataTable(
    "offers",
    [
      "Day",
      "Prelander",
      "Offer",
      "Went to offer",
      "Transitions",
      "Leads",
      "Purchases",
      "Offer to Lead",
      "Lead to Purchase",
    ],
    report.rows.flatMap((r) => r.offers.map((o) => cohortOfferCells(r.day, r.prelander_id, o))),
  );
  return `<h2>Totals</h2>
${totals}
<h2>Days and prelanders</h2>
<div class="scroll">${rows}</div>
<h2>Offers</h2>
<div class="scroll">${offers}</div>`;
}

const POSTBACK_COUNTS: Column[] = [
  { key: "lead", label: "Leads" },
  { key: "purchase", label: "Purchases" },
  { key: "purchase_without_lead", label: "Purchases without a Lead" },
  { key: "payout", label: "Payout" },
];

type PostbackCounts = {
  lead: number;
  purchase: number;
  purchase_without_lead: number;
  payout: Payout[];
};

function postbackCells(c: PostbackCounts): string[] {
  return [
    String(c.lead),
    String(c.purchase),
    String(c.purchase_without_lead),
    esc(payoutText(c.payout)),
  ];
}

function postbackBody(report: PostbackReport): string {
  const totals = totalsTable(POSTBACK_COUNTS, (key) =>
    key === "payout"
      ? esc(payoutText(report.payout))
      : String(report[key as "lead" | "purchase" | "purchase_without_lead"]),
  );
  const labels = POSTBACK_COUNTS.map((c) => c.label);
  const rows = dataTable(
    "rows",
    ["Day", "Prelander", ...labels],
    report.rows.map((r) => [esc(r.day), esc(r.prelander_id), ...postbackCells(r)]),
  );
  const offers = dataTable(
    "offers",
    ["Day", "Prelander", "Offer", ...labels],
    report.rows.flatMap((r) =>
      r.offers.map((o) => [esc(r.day), esc(r.prelander_id), esc(o.offer_id), ...postbackCells(o)]),
    ),
  );
  return `<h2>Totals</h2>
${totals}
<h2>Days and prelanders</h2>
<div class="scroll">${rows}</div>
<h2>Offers</h2>
<div class="scroll">${offers}</div>`;
}

export function renderReportPage(report: Report): string {
  const other = report.view === "cohort" ? "postback" : "cohort";
  const newest =
    report.events_newest_at === null
      ? "no events yet"
      : `<span data-events-newest-at="${isoTime(report.events_newest_at)}">${isoTime(report.events_newest_at)}</span>`;
  const body = report.view === "cohort" ? cohortBody(report) : postbackBody(report);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Funnel report</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem 1rem; }
  main { max-width: 72rem; margin: 0 auto; }
  form { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: end; }
  table { border-collapse: collapse; margin: 0.5rem 0 1.5rem; }
  th, td { border: 1px solid #ccc; padding: 0.25rem 0.5rem; text-align: left; font-variant-numeric: tabular-nums; }
  .scroll { overflow-x: auto; }
</style>
</head>
<body>
<main data-view="${report.view}">
<h1>Funnel report: ${report.view} view</h1>
<p data-as-of="${isoTime(report.as_of)}">As of ${isoTime(report.as_of)}. Newest event: ${newest}.</p>
${filterForm(report)}
<p><a href="${esc(otherViewHref(report))}">Show the ${other} view</a></p>
${body}
</main>
</body>
</html>
`;
}
