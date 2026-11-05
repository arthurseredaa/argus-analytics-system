import { describe, expect, it } from "vitest";
import {
  buildReport,
  type CellKey,
  parseReportQuery,
  ratio,
  type ClickCell,
  type CohortReport,
  type FunnelCell,
  type LeadCell,
  type PayoutCell,
  type PostbackReport,
  type PurchaseCell,
  type ReportInput,
  type ReportQuery,
} from "../../src/domain/report.ts";

const NOW = Date.UTC(2026, 10, 5, 13, 0);

const parse = (qs: string, now = NOW) => parseReportQuery(new URLSearchParams(qs), now);

const baseQuery: ReportQuery = {
  view: "cohort",
  from: "2026-11-05",
  to: "2026-11-05",
  fromMs: Date.UTC(2026, 10, 5),
  toMs: Date.UTC(2026, 10, 6),
  prelander: null,
  offer: null,
};

const DAY = "2026-11-05";
const TOTAL = { day: null, prelander_id: null, offer_id: null };
const PRE = { day: DAY, prelander_id: "demo", offer_id: null };
const off = (offer_id: string) => ({ day: DAY, prelander_id: "demo", offer_id });

const funnel = (key: CellKey, over: Partial<FunnelCell> = {}): FunnelCell => ({
  ...key,
  visits: 0,
  visitors: 0,
  started: 0,
  step_2: 0,
  step_3: 0,
  completed: 0,
  ...over,
});
const click = (key: CellKey, over: Partial<ClickCell> = {}): ClickCell => ({
  ...key,
  went_to_offer: 0,
  transitions: 0,
  ...over,
});
const lead = (key: CellKey, over: Partial<LeadCell> = {}): LeadCell => ({
  ...key,
  lead: 0,
  lead_with_purchase: 0,
  lead_users: 0,
  ...over,
});
const purchase = (key: CellKey, over: Partial<PurchaseCell> = {}): PurchaseCell => ({
  ...key,
  purchase: 0,
  purchase_without_lead: 0,
  ...over,
});

const at = (day: string, prelander_id: string, offer_id: string | null) => ({
  day,
  prelander_id,
  offer_id,
});
const payout = (offer_id: string, currency: string | null, amount: number): PayoutCell => ({
  ...off(offer_id),
  currency,
  amount,
});

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  query: baseQuery,
  asOf: NOW,
  eventsNewestAt: NOW - 1000,
  funnel: [],
  clicks: [],
  leads: [],
  purchases: [],
  payouts: [],
  ...over,
});

const cohort = (over: Partial<ReportInput> = {}): CohortReport => {
  const report = buildReport(input(over));
  if (report.view !== "cohort") throw new Error("expected the cohort view");
  return report;
};

describe("report parameters", () => {
  it("AN-2 report defaults to today UTC and the cohort view", () => {
    expect(parse("")).toEqual(baseQuery);
    expect(parse("", Date.UTC(2026, 10, 5, 23, 59, 59))?.from).toBe("2026-11-05");
  });

  it("AN-2 from alone runs to today", () => {
    const q = parse("from=2026-11-01");
    expect(q?.from).toBe("2026-11-01");
    expect(q?.to).toBe("2026-11-05");
    expect(q?.fromMs).toBe(Date.UTC(2026, 10, 1));
    expect(q?.toMs).toBe(Date.UTC(2026, 10, 6));
  });

  it("AN-2 to alone is one day", () => {
    const q = parse("to=2026-11-03");
    expect(q?.from).toBe("2026-11-03");
    expect(q?.to).toBe("2026-11-03");
    expect(q?.toMs).toBe(Date.UTC(2026, 10, 4));
  });

  it("AN-2 empty prelander and offer mean no filter", () => {
    const q = parse("prelander=&offer=");
    expect(q?.prelander).toBeNull();
    expect(q?.offer).toBeNull();
    const set = parse("prelander=demo&offer=003&view=postback");
    expect(set).toMatchObject({ prelander: "demo", offer: "003", view: "postback" });
  });

  it("AN-2 unknown parameters are ignored", () => {
    expect(parse("format=csv")).toEqual(baseQuery);
  });

  it("AN-2 bad parameters are rejected", () => {
    const bad = [
      "from=2026-02-30",
      "from=20261105",
      "from=2026-11-06&to=2026-11-05",
      "from=2026-01-01&to=2026-04-03",
      "view=finance",
      "prelander=bad id!",
      "prelander=' OR 1=1",
      `offer=${"a".repeat(65)}`,
    ];
    for (const qs of bad) expect(parse(qs), qs).toBeNull();
    expect(parse("from=2026-01-01&to=2026-04-02")).not.toBeNull();
    expect(parse(`offer=${"a".repeat(64)}`)).not.toBeNull();
  });
});

describe("report arithmetic", () => {
  const stepFunnel = [funnel(TOTAL, { started: 3, step_2: 2, step_3: 2, completed: 1 })];

  it("AN-1 drop-offs are reached N minus reached N+1", () => {
    const r = cohort({ funnel: stepFunnel });
    expect([r.step_1, r.started]).toEqual([3, 3]);
    expect([r.dropoff_step_1, r.dropoff_step_2, r.dropoff_step_3]).toEqual([1, 0, 1]);
    expect(r.rates.dropoff_step_1_share).toBe(0.3333);
    expect(r.rates.dropoff_step_2_share).toBe(0);
    expect(r.rates.dropoff_step_3_share).toBe(0.5);
  });

  it("AN-3 M-20 step 1 to step 2", () => {
    expect(cohort({ funnel: stepFunnel }).rates.step_1_to_2).toBe(0.6667);
  });

  it("AN-3 M-21 step 2 to step 3", () => {
    expect(cohort({ funnel: stepFunnel }).rates.step_2_to_3).toBe(1);
  });

  it("AN-3 M-22 step 3 to completion", () => {
    expect(cohort({ funnel: stepFunnel }).rates.step_3_to_completion).toBe(0.5);
  });

  it("AN-3 M-24 start to offer counts users across offers", () => {
    const r = cohort({
      funnel: [funnel(TOTAL, { started: 3 }), funnel(PRE, { started: 3 })],
      clicks: [
        click(TOTAL, { went_to_offer: 1 }),
        click(PRE, { went_to_offer: 1 }),
        click(off("003"), { went_to_offer: 1 }),
        click(off("004"), { went_to_offer: 1 }),
      ],
    });
    expect(r.rates.start_to_offer).toBe(0.3333);
    expect(r.rows[0]?.rates.start_to_offer).toBe(0.3333);
  });

  it("AN-3 M-25 offer to Lead", () => {
    const r = cohort({
      clicks: [click(off("003"), { went_to_offer: 2 })],
      leads: [lead(off("003"), { lead: 1, lead_with_purchase: 0, lead_users: 1 })],
    });
    expect(r.rows[0]?.offers[0]?.rates.offer_to_lead).toBe(0.5);
  });

  it("AN-3 M-26 Lead to Purchase", () => {
    const r = cohort({
      leads: [lead(off("003"), { lead: 2, lead_with_purchase: 1 })],
    });
    expect(r.rows[0]?.offers[0]?.rates.lead_to_purchase).toBe(0.5);
  });

  it("AN-3 M-27 start to Lead", () => {
    const r = cohort({
      funnel: [funnel(TOTAL, { started: 4 })],
      leads: [lead(TOTAL, { lead_users: 1 }), lead(off("003"), { lead: 1, lead_users: 1 })],
    });
    expect(r.rates.start_to_lead).toBe(0.25);
  });

  it("AN-3 M-28 visits per user", () => {
    const r = cohort({ funnel: [funnel(TOTAL, { visits: 3, visitors: 2 })] });
    expect(r.rates.visits_per_user).toBe(1.5);
  });

  it("AN-3 ratio rounds to 4 decimals and gives null for a zero or null denominator", () => {
    expect(ratio(1, 3)).toBe(0.3333);
    expect(ratio(2, 3)).toBe(0.6667);
    expect(ratio(1, 0)).toBeNull();
    expect(ratio(1, null)).toBeNull();
    expect(ratio(null, 5)).toBeNull();
    expect(ratio(0, 5)).toBe(0);
  });

  it("AN-3 a zero denominator gives null, never NaN or Infinity", () => {
    const r = cohort({
      funnel: [funnel(TOTAL), funnel(PRE)],
      clicks: [click(PRE), click(off("003"))],
      leads: [lead(PRE), lead(off("003"))],
    });
    expect(Object.values(r.rates).every((v) => v === null)).toBe(true);
    expect(r.rows[0]?.offers[0]?.rates).toEqual({ offer_to_lead: null, lead_to_purchase: null });
    const json = JSON.stringify(r);
    expect(json).not.toContain("NaN");
    expect(json).not.toContain("Infinity");
  });

  it("AN-1 totals take distinct users from their own cell and sums from the offer cells", () => {
    const r = cohort({
      clicks: [
        click(TOTAL, { went_to_offer: 1 }),
        click(off("003"), { went_to_offer: 1, transitions: 1 }),
        click(off("004"), { went_to_offer: 1, transitions: 2 }),
      ],
      leads: [lead(off("003"), { lead: 1 }), lead(off("004"), { lead: 2 })],
      purchases: [purchase(off("003"), { purchase: 1 }), purchase(off("004"), { purchase: 4 })],
    });
    expect(r.transitions).toBe(3);
    expect(r.went_to_offer).toBe(1);
    expect(r.lead).toBe(3);
    expect(r.purchase).toBe(5);
  });

  it("AN-2 an offer filter leaves the funnel null", () => {
    const r = cohort({
      query: { ...baseQuery, offer: "003" },
      clicks: [click(TOTAL, { went_to_offer: 1 }), click(off("003"), { transitions: 2 })],
    });
    expect(r.started).toBeNull();
    expect(r.step_1).toBeNull();
    expect(r.dropoff_step_1).toBeNull();
    expect(r.rates.start_to_offer).toBeNull();
    expect(r.rates.step_1_to_2).toBeNull();
    expect(r.transitions).toBe(2);
    expect(r.rows[0]?.started).toBeNull();
  });

  it("AN-2 rows keep a cell with clicks but no events", () => {
    const r = cohort({
      funnel: [funnel({ day: "2026-11-04", prelander_id: "demo", offer_id: null }, { started: 1 })],
      clicks: [click(PRE, { went_to_offer: 1 }), click(off("003"), { went_to_offer: 1 })],
    });
    expect(r.rows.map((row) => row.day)).toEqual(["2026-11-04", DAY]);
    expect(r.rows[1]?.started).toBe(0);
    expect(r.rows[1]?.went_to_offer).toBe(1);
  });

  it("AN-2 rows sort by day, then prelander, and offers by id", () => {
    const r = cohort({
      clicks: [
        click(at("2026-11-05", "b", "004")),
        click(at("2026-11-05", "b", "003")),
        click(at("2026-11-05", "a", "003")),
        click(at("2026-11-04", "z", "003")),
      ],
    });
    expect(r.rows.map((row) => `${row.day}/${row.prelander_id}`)).toEqual([
      "2026-11-04/z",
      "2026-11-05/a",
      "2026-11-05/b",
    ]);
    expect(r.rows[2]?.offers.map((o) => o.offer_id)).toEqual(["003", "004"]);
  });

  it("AN-1 the report echoes the query and the freshness", () => {
    const r = cohort({ query: { ...baseQuery, prelander: "demo" } });
    expect(r).toMatchObject({
      view: "cohort",
      from: DAY,
      to: DAY,
      prelander: "demo",
      offer: null,
      as_of: NOW,
      events_newest_at: NOW - 1000,
    });
  });

  it("AN-5 the postback view carries Leads, Purchases, the flag and payouts only", () => {
    const report = buildReport(
      input({
        query: { ...baseQuery, view: "postback" },
        leads: [lead(off("003"), { lead: 1 }), lead(off("004"), { lead: 2 })],
        purchases: [
          purchase(off("003"), { purchase: 2, purchase_without_lead: 1 }),
          purchase(off("004"), { purchase: 1 }),
        ],
        payouts: [payout("003", "USD", 25), payout("004", "USD", 5), payout("004", "EUR", 10)],
      }),
    ) as PostbackReport;
    expect(Object.keys(report)).toEqual([
      "view",
      "from",
      "to",
      "prelander",
      "offer",
      "as_of",
      "events_newest_at",
      "lead",
      "purchase",
      "purchase_without_lead",
      "payout",
      "rows",
    ]);
    expect(report.payout).toEqual([
      { currency: "EUR", amount: 10 },
      { currency: "USD", amount: 30 },
    ]);
    expect([report.lead, report.purchase, report.purchase_without_lead]).toEqual([3, 3, 1]);
    const row = report.rows[0];
    expect(Object.keys(row ?? {})).toEqual([
      "day",
      "prelander_id",
      "lead",
      "purchase",
      "purchase_without_lead",
      "payout",
      "offers",
    ]);
    expect(row?.offers.map((o) => o.offer_id)).toEqual(["003", "004"]);
    expect(row?.offers[0]).toEqual({
      offer_id: "003",
      lead: 1,
      purchase: 2,
      purchase_without_lead: 1,
      payout: [{ currency: "USD", amount: 25 }],
    });
  });

  it("AN-5 payouts sort by currency with null last", () => {
    const report = buildReport(
      input({
        query: { ...baseQuery, view: "postback" },
        payouts: [payout("003", null, 1), payout("003", "USD", 2), payout("003", "EUR", 3)],
      }),
    ) as PostbackReport;
    expect(report.payout.map((x) => x.currency)).toEqual(["EUR", "USD", null]);
  });
});
