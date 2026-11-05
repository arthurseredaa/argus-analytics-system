import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REPORT_SQL } from "../../src/db/report.ts";
import { call } from "../fixtures/events.ts";
import {
  AN2_DAY,
  DAY_1,
  DAY_2,
  HOUR,
  addClick,
  addConversion,
  addEvents,
  addUser,
  an1Fixture,
  report,
  uniquePrelander,
} from "../fixtures/report.ts";

type Row = Record<string, unknown> & { day: string; prelander_id: string; offers: Row[] };
type Rep = Record<string, unknown> & { rows: Row[] };

const DAY_2_TEXT = "2001-02-04";
const cohort = (prelander: string, extra: Record<string, string> = {}) =>
  report({ from: DAY_2_TEXT, to: DAY_2_TEXT, prelander, ...extra }) as Promise<Rep>;
const postback = (prelander: string, from: string, to: string) =>
  report({ view: "postback", from, to, prelander }) as Promise<Rep>;

const pick = (o: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.map((k) => [k, o[k]]));

const without = (r: Record<string, unknown>) => {
  const { as_of: _a, events_newest_at: _e, ...rest } = r;
  return rest;
};
const sumOf = (rows: Row[], key: string) => rows.reduce((t, r) => t + (r[key] as number), 0);
const rowOf = async (id: string) => (await cohort(id)).rows.find((r) => r.prelander_id === id);

afterEach(() => vi.restoreAllMocks());

describe("report", () => {
  it("AN-7 empty store gives zeros", async () => {
    const prelander = uniquePrelander();
    const r = await cohort(prelander);
    for (const key of ["visits", "visitors", "started", "step_1", "step_2", "step_3", "completed"])
      expect(r[key], key).toBe(0);
    for (const key of ["dropoff_step_1", "dropoff_step_2", "dropoff_step_3"])
      expect(r[key], key).toBe(0);
    for (const key of ["went_to_offer", "transitions", "lead", "purchase"])
      expect(r[key], key).toBe(0);
    expect(Object.values(r.rates as Record<string, unknown>).every((v) => v === null)).toBe(true);
    expect(r.rows).toEqual([]);

    const p = await postback(prelander, DAY_2_TEXT, DAY_2_TEXT);
    expect(pick(p, ["lead", "purchase", "purchase_without_lead", "payout", "rows"])).toEqual({
      lead: 0,
      purchase: 0,
      purchase_without_lead: 0,
      payout: [],
      rows: [],
    });
  });

  it("AN-1 fixture gives expected start, steps, drop-offs, transitions, Leads, Purchases", async () => {
    const { prelander } = await an1Fixture();
    const r = await cohort(prelander);
    expect(
      pick(r, [
        "visits",
        "started",
        "step_1",
        "step_2",
        "step_3",
        "completed",
        "dropoff_step_1",
        "dropoff_step_2",
        "dropoff_step_3",
        "went_to_offer",
        "transitions",
        "lead",
        "purchase",
      ]),
    ).toEqual({
      visits: 3,
      started: 3,
      step_1: 3,
      step_2: 2,
      step_3: 2,
      completed: 1,
      dropoff_step_1: 1,
      dropoff_step_2: 0,
      dropoff_step_3: 1,
      went_to_offer: 1,
      transitions: 1,
      lead: 1,
      purchase: 1,
    });
  });

  it("AN-7 fixture gives expected numbers", async () => {
    const { prelander } = await an1Fixture();
    const r = await cohort(prelander);
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0]!;
    expect(row.day).toBe(DAY_2_TEXT);
    expect(row.offers).toHaveLength(1);
    expect(row.offers[0]).toEqual({
      offer_id: "003",
      went_to_offer: 1,
      transitions: 1,
      lead: 1,
      purchase: 1,
      rates: { offer_to_lead: 1, lead_to_purchase: 1 },
    });
  });

  it("AN-5 R-7 late purchase moves the click-date cohort and lands on today in the postback view", async () => {
    const { prelander } = await an1Fixture();
    const one = await report({ from: "2001-02-03", to: "2001-02-03", prelander });
    expect(pick(one, ["purchase", "transitions", "started"])).toEqual({
      purchase: 1,
      transitions: 1,
      started: 0,
    });
    const day2 = await postback(prelander, DAY_2_TEXT, DAY_2_TEXT);
    expect(pick(day2, ["lead", "purchase", "purchase_without_lead", "payout"])).toEqual({
      lead: 1,
      purchase: 2,
      purchase_without_lead: 1,
      payout: [
        { currency: "EUR", amount: 10 },
        { currency: "USD", amount: 25 },
      ],
    });
    const day1 = await postback(prelander, "2001-02-03", "2001-02-03");
    expect(day1.purchase).toBe(0);
  });

  it("AN-5 Q-12 a closed day in the postback view does not change when a late postback arrives", async () => {
    const { prelander } = await an1Fixture();
    const before = without(await postback(prelander, DAY_2_TEXT, DAY_2_TEXT));
    const clickD = (
      await env.FACTS.prepare(
        "SELECT click_id FROM clicks WHERE prelander_id = ?1 AND created_at < ?2",
      )
        .bind(prelander, DAY_2)
        .first<{ click_id: string }>()
    )?.click_id;
    await addConversion({ clickId: clickD!, type: "purchase", at: DAY_2 + 48 * HOUR, payout: 1 });
    expect(without(await postback(prelander, DAY_2_TEXT, DAY_2_TEXT))).toEqual(before);
    const day1 = await report({ from: "2001-02-03", to: "2001-02-03", prelander });
    expect(day1.purchase).toBe(2);
  });

  it("AN-1 Q-23 a second Lead for the same user and offer counts once", async () => {
    const prelander = uniquePrelander();
    const user = await addUser();
    const first = await addClick({ userId: user, prelander, at: DAY_1 + HOUR });
    const second = await addClick({ userId: user, prelander, at: DAY_2 + HOUR });
    await addConversion({
      clickId: first,
      type: "lead",
      at: DAY_1 + 2 * HOUR,
      payout: 5,
      currency: "USD",
    });
    await addConversion({
      clickId: second,
      type: "lead",
      at: DAY_2 + 2 * HOUR,
      payout: 5,
      currency: "USD",
    });

    const c = (await report({ from: "2001-02-03", to: DAY_2_TEXT, prelander })) as Rep;
    expect(c.lead).toBe(1);
    expect(c.rows.map((r) => [r.day, r.lead])).toEqual([
      ["2001-02-03", 1],
      [DAY_2_TEXT, 0],
    ]);
    const p = await postback(prelander, "2001-02-03", DAY_2_TEXT);
    expect(p.lead).toBe(1);
    expect(p.payout).toEqual([{ currency: "USD", amount: 10 }]);
  });

  it("AN-1 a Lead on a click without a user counts once per click", async () => {
    const prelander = uniquePrelander();
    const one = await addClick({ userId: null, prelander, at: DAY_2 + HOUR });
    const two = await addClick({ userId: null, prelander, at: DAY_2 + 2 * HOUR });
    await addConversion({ clickId: one, type: "lead", at: DAY_2 + 3 * HOUR });
    await addConversion({ clickId: two, type: "lead", at: DAY_2 + 4 * HOUR });
    expect(pick(await cohort(prelander), ["went_to_offer", "lead"])).toEqual({
      went_to_offer: 2,
      lead: 2,
    });
    await addConversion({ clickId: one, type: "lead", at: DAY_2 + 5 * HOUR });
    expect((await cohort(prelander)).lead).toBe(2);
  });

  it("AN-4 Q-26 two visits by one user count one user and two visits", async () => {
    const prelander = uniquePrelander();
    const user = await addUser();
    const at = DAY_2 + HOUR;
    await addEvents([
      { userId: user, prelander, type: "prelander_viewed", at, visit: "v1" },
      { userId: user, prelander, type: "step_viewed", at, visit: "v1", step: 1 },
      { userId: user, prelander, type: "prelander_viewed", at: at + HOUR, visit: "v2" },
      { userId: user, prelander, type: "step_viewed", at: at + HOUR, visit: "v2", step: 1 },
    ]);
    const r = await cohort(prelander);
    expect(pick(r, ["visits", "visitors", "started"])).toEqual({
      visits: 2,
      visitors: 1,
      started: 1,
    });
    expect((r.rates as Record<string, unknown>).visits_per_user).toBe(2);
  });

  it("AN-4 Q-21 lead return is not counted as started", async () => {
    const prelander = uniquePrelander();
    const user = await addUser();
    await addEvents([
      {
        userId: user,
        prelander,
        type: "prelander_viewed",
        at: DAY_2 + HOUR,
        reason: "lead_return",
      },
    ]);
    await addClick({ userId: user, prelander, at: DAY_2 + HOUR, reason: "lead_return" });
    expect(
      pick(await cohort(prelander), ["visits", "started", "transitions", "went_to_offer"]),
    ).toEqual({ visits: 1, started: 0, transitions: 1, went_to_offer: 0 });
  });

  it("AN-4 a period counts distinct users over the whole period, not the sum of days", async () => {
    const prelander = uniquePrelander();
    const user = await addUser();
    await addEvents([
      { userId: user, prelander, type: "step_viewed", at: DAY_1 + HOUR, step: 1 },
      { userId: user, prelander, type: "step_viewed", at: DAY_2 + HOUR, step: 1 },
    ]);
    const r = (await report({ from: "2001-02-03", to: DAY_2_TEXT, prelander })) as Rep;
    expect(r.rows.map((row) => row.started)).toEqual([1, 1]);
    expect(r.started).toBe(1);
  });

  it("AN-3 Q-13 started counts step 1 shown, not the page view or an answer", async () => {
    const prelander = uniquePrelander();
    const user = await addUser();
    await addEvents([
      { userId: user, prelander, type: "prelander_viewed", at: DAY_2 + HOUR },
      { userId: user, prelander, type: "step_answered", at: DAY_2 + HOUR, step: 1 },
    ]);
    expect(pick(await cohort(prelander), ["visits", "started"])).toEqual({ visits: 1, started: 0 });
  });

  it("AN-2 breakdowns sum to the total", async () => {
    const [p, q] = [uniquePrelander(), uniquePrelander()];
    const plan = [
      { prelander: p, offerId: "003", lead: true, purchase: true },
      { prelander: p, offerId: "004", lead: true, purchase: false },
      { prelander: p, offerId: "003", lead: false, purchase: false },
      { prelander: q, offerId: "004", lead: true, purchase: true },
      { prelander: q, offerId: "003", lead: true, purchase: false },
    ];
    for (const item of plan) {
      const userId = await addUser();
      const at = AN2_DAY + 2 * HOUR;
      await addEvents([{ userId, prelander: item.prelander, type: "step_viewed", at, step: 1 }]);
      const clickId = await addClick({
        userId,
        prelander: item.prelander,
        at,
        offerId: item.offerId,
      });
      if (item.lead) await addConversion({ clickId, type: "lead", at: at + HOUR });
      if (item.purchase) await addConversion({ clickId, type: "purchase", at: at + 2 * HOUR });
    }
    const date = "2001-06-01";

    const all = (await report({ from: date, to: date })) as Rep;
    // Other tests write no row on this day, so the two prelanders are the only ones here.
    const mine = all.rows.filter((r) => r.prelander_id === p || r.prelander_id === q);
    expect(mine).toHaveLength(2);
    expect(mine).toHaveLength(all.rows.length);
    for (const key of ["transitions", "lead", "purchase", "started"])
      expect(all[key], key).toBe(sumOf(all.rows, key));
    for (const key of ["transitions", "lead", "purchase"])
      expect(all[key], key).toBe(
        sumOf(
          all.rows.flatMap((r) => r.offers),
          key,
        ),
      );
    expect(pick(all, ["started", "transitions", "lead", "purchase"])).toEqual({
      started: 5,
      transitions: 5,
      lead: 4,
      purchase: 2,
    });

    const byP = (await report({ from: date, to: date, prelander: p })) as Rep;
    expect(byP.rows).toHaveLength(1);
    for (const key of ["started", "transitions", "lead", "purchase", "went_to_offer"])
      expect(byP[key], key).toBe(byP.rows[0]![key]);

    const byOffer = (await report({ from: date, to: date, offer: "004" })) as Rep;
    const offerCells = all.rows.flatMap((r) => r.offers).filter((o) => o.offer_id === "004");
    expect(byOffer.transitions).toBe(sumOf(offerCells, "transitions"));
    expect(byOffer.lead).toBe(sumOf(offerCells, "lead"));
    expect(byOffer.started).toBeNull();

    const next = await report({ from: "2001-06-02", to: "2001-06-02" });
    expect(pick(next, ["transitions", "lead", "purchase"])).toEqual({
      transitions: 0,
      lead: 0,
      purchase: 0,
    });
  });

  it("AN-2 Q-22 a Lead belongs to the prelander of its click", async () => {
    const [p, q] = [uniquePrelander(), uniquePrelander()];
    const userId = await addUser();
    await addEvents([{ userId, prelander: p, type: "step_viewed", at: DAY_2 + HOUR, step: 1 }]);
    const click = await addClick({ userId, prelander: q, at: DAY_2 + 2 * HOUR });
    await addConversion({ clickId: click, type: "lead", at: DAY_2 + 3 * HOUR });
    expect((await rowOf(q))?.lead).toBe(1);
    expect((await rowOf(p))?.lead).toBe(0);
  });

  it("AN-2 bad report parameters give 400", async () => {
    const res = await call("/api/report?from=2026-02-30", {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_query" });
  });

  it("AN-6 the report API sets no cookie and is not cached", async () => {
    const res = await call(`/api/report?prelander=${uniquePrelander()}`, {});
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  });

  it("R-12 the report carries no user id or email", async () => {
    const { prelander, userIds } = await an1Fixture();
    const res = await call(
      `/api/report?${new URLSearchParams({ from: "2001-02-03", to: DAY_2_TEXT, prelander })}`,
      {},
    );
    const text = await res.text();
    expect(text).not.toContain("@");
    for (const id of userIds) expect(text).not.toContain(id);
  });

  it("R-17 every events query searches by index", async () => {
    const events = Object.entries(REPORT_SQL).filter(([, q]) => q.db === "events");
    expect(events.length).toBeGreaterThan(0);
    for (const [name, { sql }] of events) {
      const count = Math.max(...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])), 0);
      const { results } = await env.EVENTS.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...Array<null>(count).fill(null))
        .all<{ detail: string }>();
      expect(results.length, name).toBeGreaterThan(0);
      for (const row of results)
        expect(row.detail.startsWith("SCAN events"), `${name}: ${row.detail}`).toBe(false);
    }
  });

  it("R-17 report rows read stays flat as events grow", async () => {
    const { prelander } = await an1Fixture();
    const log = vi.spyOn(console, "log");
    const rowsRead = async () => {
      log.mockClear();
      await cohort(prelander);
      const lines = log.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.includes('"msg":"report"'));
      expect(lines).toHaveLength(1);
      return (JSON.parse(lines[0]!) as { rows_read_events: number }).rows_read_events;
    };
    const before = await rowsRead();
    expect(before).toBeGreaterThan(0);

    const other = uniquePrelander();
    const user = await addUser();
    await addEvents(
      Array.from({ length: 500 }, () => ({
        userId: user,
        prelander: other,
        type: "step_viewed" as const,
        at: DAY_2 + 30 * 86_400_000,
        step: 1,
      })),
    );
    expect(await rowsRead()).toBe(before);
  });
});
