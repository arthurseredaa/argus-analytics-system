// Domain: funnel report parameters and arithmetic, pure functions with no I/O.
// Implements design "Two report views" and "Metric definitions"; serves AN-1 to AN-5, Q-14.
export type ReportView = "cohort" | "postback";

export type ReportQuery = {
  view: ReportView;
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
  prelander: string | null;
  offer: string | null;
};

export const MAX_REPORT_DAYS = 92;

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// A UTC date YYYY-MM-DD to the start of that day in ms, or null if it is not a real date.
function dayStart(value: string): number | null {
  if (!DATE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) || isoDay(ms) !== value ? null : ms;
}

// An absent or empty parameter is "not given" (null). `undefined` means given and invalid.
function optionalId(params: URLSearchParams, name: string): string | null | undefined {
  const value = params.get(name);
  if (value === null || value === "") return null;
  return ID.test(value) ? value : undefined;
}

export function parseReportQuery(params: URLSearchParams, nowMs: number): ReportQuery | null {
  const viewParam = params.get("view");
  const view = viewParam === null || viewParam === "" ? "cohort" : viewParam;
  if (view !== "cohort" && view !== "postback") return null;

  const to = params.get("to") || isoDay(nowMs);
  const from = params.get("from") || to;
  const fromStart = dayStart(from);
  const toStart = dayStart(to);
  if (fromStart === null || toStart === null || fromStart > toStart) return null;
  if ((toStart - fromStart) / DAY_MS + 1 > MAX_REPORT_DAYS) return null;

  const prelander = optionalId(params, "prelander");
  const offer = optionalId(params, "offer");
  if (prelander === undefined || offer === undefined) return null;

  return { view, from, to, fromMs: fromStart, toMs: toStart + DAY_MS, prelander, offer };
}

// The grain is in the nulls: offer cells have all three, prelander cells have offer_id null,
// the total has all three null.
export type CellKey = { day: string | null; prelander_id: string | null; offer_id: string | null };

export type FunnelCell = CellKey & {
  visits: number;
  visitors: number;
  started: number;
  step_2: number;
  step_3: number;
  completed: number;
};
export type ClickCell = CellKey & { went_to_offer: number; transitions: number };
export type LeadCell = CellKey & { lead: number; lead_with_purchase: number; lead_users: number };
export type PurchaseCell = CellKey & { purchase: number; purchase_without_lead: number };
export type PayoutCell = CellKey & { currency: string | null; amount: number };

export type ReportInput = {
  query: ReportQuery;
  asOf: number;
  eventsNewestAt: number | null;
  funnel: FunnelCell[];
  clicks: ClickCell[];
  leads: LeadCell[];
  purchases: PurchaseCell[];
  payouts: PayoutCell[];
};

export function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  const value = Math.round((numerator / denominator) * 10_000) / 10_000;
  return Number.isFinite(value) ? value : null;
}

type N = number | null;
type Payout = { currency: string | null; amount: number };

type Rates = {
  step_1_to_2: N;
  step_2_to_3: N;
  step_3_to_completion: N;
  dropoff_step_1_share: N;
  dropoff_step_2_share: N;
  dropoff_step_3_share: N;
  start_to_offer: N;
  start_to_lead: N;
  visits_per_user: N;
};

type CohortCounts = {
  visits: N;
  visitors: N;
  started: N;
  step_1: N;
  step_2: N;
  step_3: N;
  completed: N;
  dropoff_step_1: N;
  dropoff_step_2: N;
  dropoff_step_3: N;
  went_to_offer: number;
  transitions: number;
  lead: number;
  purchase: number;
  rates: Rates;
};

export type CohortOffer = {
  offer_id: string;
  went_to_offer: number;
  transitions: number;
  lead: number;
  purchase: number;
  rates: { offer_to_lead: N; lead_to_purchase: N };
};

export type CohortRow = CohortCounts & {
  day: string;
  prelander_id: string;
  offers: CohortOffer[];
};

export type CohortReport = CohortCounts & {
  view: "cohort";
  from: string;
  to: string;
  prelander: string | null;
  offer: string | null;
  as_of: number;
  events_newest_at: number | null;
  rows: CohortRow[];
};

type PostbackCounts = {
  lead: number;
  purchase: number;
  purchase_without_lead: number;
  payout: Payout[];
};

export type PostbackReport = {
  view: "postback";
  from: string;
  to: string;
  prelander: string | null;
  offer: string | null;
  as_of: number;
  events_newest_at: number | null;
  lead: number;
  purchase: number;
  purchase_without_lead: number;
  payout: Payout[];
  rows: ({ day: string; prelander_id: string } & PostbackCounts & {
      offers: ({ offer_id: string } & PostbackCounts)[];
    })[];
};

export type Report = CohortReport | PostbackReport;

const keyOf = (c: CellKey): string => JSON.stringify([c.day, c.prelander_id, c.offer_id]);
const sum = <T>(cells: readonly T[], pick: (c: T) => number): number =>
  cells.reduce((total, c) => total + pick(c), 0);
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const minus = (a: N, b: N): N => (a === null || b === null ? null : a - b);
const hasOffer = <T extends CellKey>(cells: readonly T[]): T[] =>
  cells.filter((c) => c.offer_id !== null);
const inRow = (c: CellKey, day: string, prelander: string): boolean =>
  c.day === day && c.prelander_id === prelander;

function index<T extends CellKey>(cells: readonly T[]): Map<string, T> {
  return new Map(cells.map((c) => [keyOf(c), c]));
}

function currencyOrder(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return byText(a, b);
}

function sortedPayouts(cells: readonly PayoutCell[]): Payout[] {
  const byCurrency = new Map<string | null, number>();
  for (const c of cells) byCurrency.set(c.currency, (byCurrency.get(c.currency) ?? 0) + c.amount);
  return [...byCurrency]
    .map(([currency, amount]) => ({ currency, amount: Math.round(amount * 10_000) / 10_000 }))
    .toSorted((a, b) => currencyOrder(a.currency, b.currency));
}

// Prelander rows exist for every (day, prelander) found in any cell of the view.
function rowKeys(cells: readonly CellKey[]): { day: string; prelander_id: string }[] {
  const seen = new Map<string, { day: string; prelander_id: string }>();
  for (const c of cells) {
    if (c.day === null || c.prelander_id === null) continue;
    seen.set(JSON.stringify([c.day, c.prelander_id]), { day: c.day, prelander_id: c.prelander_id });
  }
  return [...seen.values()].toSorted(
    (a, b) => byText(a.day, b.day) || byText(a.prelander_id, b.prelander_id),
  );
}

function offerIds(cells: readonly CellKey[]): string[] {
  const ids = new Set<string>();
  for (const c of cells) if (c.offer_id !== null) ids.add(c.offer_id);
  return [...ids].toSorted(byText);
}

type CohortSource = {
  funnel: FunnelCell | undefined;
  wentToOffer: number;
  leadUsers: number;
  clicks: readonly ClickCell[];
  leads: readonly LeadCell[];
  purchases: readonly PurchaseCell[];
};

// Counts and rates for one grain. Distinct-user counts come from the cell of that grain;
// pair and row counts are sums of the offer cells under it (decision 8).
function cohortCounts(src: CohortSource, offerFiltered: boolean): CohortCounts {
  const funnelValue = (pick: (c: FunnelCell) => number): N => {
    if (offerFiltered) return null;
    return src.funnel ? pick(src.funnel) : 0;
  };
  const visits = funnelValue((c) => c.visits);
  const visitors = funnelValue((c) => c.visitors);
  const started = funnelValue((c) => c.started);
  const step2 = funnelValue((c) => c.step_2);
  const step3 = funnelValue((c) => c.step_3);
  const completed = funnelValue((c) => c.completed);
  const drop1 = minus(started, step2);
  const drop2 = minus(step2, step3);
  const drop3 = minus(step3, completed);
  return {
    visits,
    visitors,
    started,
    step_1: started,
    step_2: step2,
    step_3: step3,
    completed,
    dropoff_step_1: drop1,
    dropoff_step_2: drop2,
    dropoff_step_3: drop3,
    went_to_offer: src.wentToOffer,
    transitions: sum(src.clicks, (c) => c.transitions),
    lead: sum(src.leads, (c) => c.lead),
    purchase: sum(src.purchases, (c) => c.purchase),
    rates: {
      step_1_to_2: ratio(step2, started),
      step_2_to_3: ratio(step3, step2),
      step_3_to_completion: ratio(completed, step3),
      dropoff_step_1_share: ratio(drop1, started),
      dropoff_step_2_share: ratio(drop2, step2),
      dropoff_step_3_share: ratio(drop3, step3),
      start_to_offer: ratio(src.wentToOffer, started),
      start_to_lead: ratio(src.leadUsers, started),
      visits_per_user: ratio(visits, visitors),
    },
  };
}

function buildCohort(input: ReportInput): CohortReport {
  const { query } = input;
  const offerFiltered = query.offer !== null;
  const funnelAt = index(input.funnel);
  const clickAt = index(input.clicks);
  const leadAt = index(input.leads);
  const purchaseAt = index(input.purchases);
  const offerClicks = hasOffer(input.clicks);
  const offerLeads = hasOffer(input.leads);
  const offerPurchases = hasOffer(input.purchases);

  const totalKey = keyOf({ day: null, prelander_id: null, offer_id: null });
  const totals = cohortCounts(
    {
      funnel: funnelAt.get(totalKey),
      wentToOffer: clickAt.get(totalKey)?.went_to_offer ?? 0,
      leadUsers: leadAt.get(totalKey)?.lead_users ?? 0,
      clicks: offerClicks,
      leads: offerLeads,
      purchases: offerPurchases,
    },
    offerFiltered,
  );

  const rows = rowKeys([...input.funnel, ...input.clicks, ...input.leads, ...input.purchases]).map(
    ({ day, prelander_id }): CohortRow => {
      const grainKey = keyOf({ day, prelander_id, offer_id: null });
      const clicks = offerClicks.filter((c) => inRow(c, day, prelander_id));
      const leads = offerLeads.filter((c) => inRow(c, day, prelander_id));
      const purchases = offerPurchases.filter((c) => inRow(c, day, prelander_id));
      const offers = offerIds([...clicks, ...leads, ...purchases]).map((offer_id): CohortOffer => {
        const key = keyOf({ day, prelander_id, offer_id });
        const went = clickAt.get(key)?.went_to_offer ?? 0;
        const leadCell = leadAt.get(key);
        const leadCount = leadCell?.lead ?? 0;
        return {
          offer_id,
          went_to_offer: went,
          transitions: clickAt.get(key)?.transitions ?? 0,
          lead: leadCount,
          purchase: purchaseAt.get(key)?.purchase ?? 0,
          rates: {
            offer_to_lead: ratio(leadCount, went),
            lead_to_purchase: ratio(leadCell?.lead_with_purchase ?? 0, leadCount),
          },
        };
      });
      return {
        day,
        prelander_id,
        ...cohortCounts(
          {
            funnel: funnelAt.get(grainKey),
            wentToOffer: clickAt.get(grainKey)?.went_to_offer ?? 0,
            leadUsers: leadAt.get(grainKey)?.lead_users ?? 0,
            clicks,
            leads,
            purchases,
          },
          offerFiltered,
        ),
        offers,
      };
    },
  );

  return {
    view: "cohort",
    from: query.from,
    to: query.to,
    prelander: query.prelander,
    offer: query.offer,
    as_of: input.asOf,
    events_newest_at: input.eventsNewestAt,
    ...totals,
    rows,
  };
}

function postbackCounts(
  leads: readonly LeadCell[],
  purchases: readonly PurchaseCell[],
  payouts: readonly PayoutCell[],
): PostbackCounts {
  return {
    lead: sum(leads, (c) => c.lead),
    purchase: sum(purchases, (c) => c.purchase),
    purchase_without_lead: sum(purchases, (c) => c.purchase_without_lead),
    payout: sortedPayouts(payouts),
  };
}

function buildPostback(input: ReportInput): PostbackReport {
  const { query } = input;
  const leads = hasOffer(input.leads);
  const purchases = hasOffer(input.purchases);
  const payouts = hasOffer(input.payouts);

  const rows = rowKeys([...leads, ...purchases, ...payouts]).map(({ day, prelander_id }) => {
    const l = leads.filter((c) => inRow(c, day, prelander_id));
    const p = purchases.filter((c) => inRow(c, day, prelander_id));
    const pay = payouts.filter((c) => inRow(c, day, prelander_id));
    return {
      day,
      prelander_id,
      ...postbackCounts(l, p, pay),
      offers: offerIds([...l, ...p, ...pay]).map((offer_id) => ({
        offer_id,
        ...postbackCounts(
          l.filter((c) => c.offer_id === offer_id),
          p.filter((c) => c.offer_id === offer_id),
          pay.filter((c) => c.offer_id === offer_id),
        ),
      })),
    };
  });

  return {
    view: "postback",
    from: query.from,
    to: query.to,
    prelander: query.prelander,
    offer: query.offer,
    as_of: input.asOf,
    events_newest_at: input.eventsNewestAt,
    ...postbackCounts(leads, purchases, payouts),
    rows,
  };
}

export function buildReport(input: ReportInput): Report {
  return input.query.view === "postback" ? buildPostback(input) : buildCohort(input);
}
