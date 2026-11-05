import { describe, expect, it } from "vitest";
import { changeCatalog } from "../fixtures/catalog.ts";
import { call, captureQueue } from "../fixtures/events.ts";
import { cookieFrom, newCookie } from "../fixtures/http.ts";

// Decision table rows of docs/requirements/offer-selection.md that act at entry. Row 28 (a Lead
// for a removed offer) is not reachable through `pnpm offer`, which only changes status and EPU,
// so it stays covered by the select() unit test.

type State = {
  me: {
    user_id: string;
    clicks: { click_id: string; offer_id: string; reason: string; created_at: number }[];
  };
};

type Seed = {
  answers?: Record<string, string>;
  leads?: { offer_id: string }[];
};

async function seed(body: Seed): Promise<{ cookie: string; clicks: string[] }> {
  const res = await call("/__test/seed", { method: "POST", body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  const out = (await res.json()) as { clicks: string[] };
  return { cookie: cookieFrom(res), clicks: out.clicks };
}

const entry = (cookie: string, queue: Queue) =>
  call("/p/demo", { cookie }, { EVENTS_QUEUE: queue });

const stateOf = async (cookie: string) =>
  (await (await call("/__test/state", { cookie })).json()) as State;

const clickIdOf = (res: Response) =>
  /[?&]click_id=([0-9a-f]{32})$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";

// Turns the offers off for the body and back on afterwards, whatever the body does.
async function withDisabled(ids: readonly string[], body: () => Promise<void>): Promise<void> {
  const done: string[] = [];
  try {
    for (const id of ids) {
      await changeCatalog({ kind: "status", offerId: id, active: false });
      done.push(id);
    }
    await body();
  } finally {
    for (const id of done) await changeCatalog({ kind: "status", offerId: id, active: true });
  }
}

const location = (host: string) =>
  new RegExp(`^https://${host.replaceAll(".", "\\.")}/\\?click_id=[0-9a-f]{32}$`);

describe("entry with a Lead", () => {
  it("OFF-3 row 16 a Lead for active 001 skips the quiz and beats EPU", async () => {
    const user = await seed({
      answers: { gender: "women", ethnicity: "asia" },
      leads: [{ offer_id: "001" }],
    });
    const { queue, sent } = captureQueue();
    const res = await entry(user.cookie, queue);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(location("asia-women.example"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    const clickId = clickIdOf(res);
    expect(clickId).not.toBe(user.clicks[0]);

    const clicks = (await stateOf(user.cookie)).me.clicks;
    expect(clicks).toHaveLength(2);
    expect(clicks.find((c) => c.click_id === clickId)).toMatchObject({
      offer_id: "001",
      reason: "lead_return",
    });

    expect(sent.map((s) => s.body.type)).toEqual([
      "prelander_viewed",
      "offer_selected",
      "offer_click",
    ]);
    expect(sent[0]?.body.payload).toEqual({ reason: "lead_return" });
    expect(sent[1]?.body.payload).toMatchObject({
      offer_id: "001",
      reason: "lead_return",
      moment: "entry",
      catalog_version: expect.any(Number),
    });
    expect(sent[2]?.body.payload).toMatchObject({
      click_id: clickId,
      offer_id: "001",
      reason: "lead_return",
    });
    expect(new Set(sent.map((s) => s.body.visit_id)).size).toBe(1);
  });

  it("OFF-3 row 17 a Lead without answers skips the quiz", async () => {
    const user = await seed({ leads: [{ offer_id: "001" }] });
    const { queue } = captureQueue();
    const res = await entry(user.cookie, queue);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(location("asia-women.example"));
  });

  it("OFF-3 row 27 a Lead beats answers for another offer", async () => {
    const user = await seed({
      answers: { gender: "men", ethnicity: "europe" },
      leads: [{ offer_id: "001" }],
    });
    const { queue } = captureQueue();
    const res = await entry(user.cookie, queue);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(location("asia-women.example"));
  });

  it("OFF-9 row 18 a Lead for disabled 001 with full answers goes to 003", async () => {
    const user = await seed({
      answers: { gender: "women", ethnicity: "asia" },
      leads: [{ offer_id: "001" }],
    });
    await withDisabled(["001"], async () => {
      const { queue, sent } = captureQueue();
      const res = await entry(user.cookie, queue);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toMatch(location("asia-connect.example"));
      expect(sent[0]?.body).toMatchObject({
        type: "prelander_viewed",
        payload: { reason: "skip" },
      });
      const click = (await stateOf(user.cookie)).me.clicks.find(
        (c) => c.click_id === clickIdOf(res),
      );
      expect(click).toMatchObject({ offer_id: "003", reason: "best_epu" });
    });
  });

  it("OFF-9 row 19 a Lead for disabled 001 without full answers shows the quiz", async () => {
    const user = await seed({ answers: { gender: "women" }, leads: [{ offer_id: "001" }] });
    await withDisabled(["001"], async () => {
      const { queue, sent } = captureQueue();
      const res = await entry(user.cookie, queue);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('data-step="gender"');
      expect((await stateOf(user.cookie)).me.clicks).toHaveLength(1);
      expect(sent.map((s) => s.body.payload)).toEqual([{ reason: "quiz" }]);
    });
  });

  it("OFF-9 row 20 a Lead for disabled 001 with women + latam goes to 007", async () => {
    const user = await seed({
      answers: { gender: "women", ethnicity: "latam" },
      leads: [{ offer_id: "001" }],
    });
    await withDisabled(["001"], async () => {
      const { queue } = captureQueue();
      const res = await entry(user.cookie, queue);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toMatch(location("global-connect.example"));
      const click = (await stateOf(user.cookie)).me.clicks.find(
        (c) => c.click_id === clickIdOf(res),
      );
      expect(click).toMatchObject({ offer_id: "007", reason: "fallback_universal" });
    });
  });

  it("OFF-9 row 21 a Lead for disabled 001 with 007 disabled shows the no-offer page", async () => {
    const user = await seed({
      answers: { gender: "women", ethnicity: "latam" },
      leads: [{ offer_id: "001" }],
    });
    await withDisabled(["001", "007"], async () => {
      const { queue, sent } = captureQueue();
      const res = await entry(user.cookie, queue);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toContain("No offer available");
      expect((await stateOf(user.cookie)).me.clicks).toHaveLength(1);
      expect(sent.map((s) => s.body.type)).toEqual(["prelander_viewed", "offer_selected"]);
      expect(sent[0]?.body.payload).toEqual({ reason: "skip" });
      expect(sent[1]?.body.payload).toMatchObject({
        offer_id: null,
        reason: "no_offer",
        moment: "entry",
      });
    });
  });

  it("OFF-4 row 22 the most recent Lead wins", async () => {
    const user = await seed({
      answers: { gender: "women", ethnicity: "asia" },
      leads: [{ offer_id: "001" }, { offer_id: "004" }],
    });
    const { queue } = captureQueue();
    const res = await entry(user.cookie, queue);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(location("europe-women.example"));
  });

  it("OFF-4 row 23 the next Lead when the newest offer is disabled", async () => {
    const user = await seed({
      answers: { gender: "women", ethnicity: "asia" },
      leads: [{ offer_id: "001" }, { offer_id: "004" }],
    });
    await withDisabled(["004"], async () => {
      const { queue } = captureQueue();
      const res = await entry(user.cookie, queue);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toMatch(location("asia-women.example"));
      const click = (await stateOf(user.cookie)).me.clicks.find(
        (c) => c.click_id === clickIdOf(res),
      );
      expect(click).toMatchObject({ offer_id: "001", reason: "lead_return" });
    });
  });

  it("ID-3 earlier user's email in a new browser gives no lead return", async () => {
    const a = await seed({ leads: [{ offer_id: "003" }] });
    const { queue } = captureQueue();
    const completeAs = (cookie: string, ethnicity: string) =>
      call(
        "/api/complete",
        {
          method: "POST",
          cookie,
          body: JSON.stringify({
            prelander_id: "demo",
            answers: { gender: "women", ethnicity },
            email: "user1@example.com",
          }),
        },
        { EVENTS_QUEUE: queue },
      );
    // A's stored email becomes user1@example.com too.
    expect((await completeAs(a.cookie, "asia")).status).toBe(200);

    const b = newCookie();
    const done = await completeAs(b, "europe");
    expect(((await done.json()) as { offer_id: string }).offer_id).toBe("004");
    const res = await entry(b, queue);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data-step="gender"');
    expect((await stateOf(a.cookie)).me.user_id).not.toBe((await stateOf(b)).me.user_id);
    expect((await stateOf(b)).me.clicks).toHaveLength(0);
  });
});
