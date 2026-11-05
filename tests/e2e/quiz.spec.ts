// Browser test: a visitor takes the quiz in a real browser and gets the offer for their answers.
// Serves QZ-1, ID-4 and R-12: the events reach the store in order, and the email travels in one request only.
import { expect, test } from "@playwright/test";

const EMAIL = "user1@example.com";
const ENCODED = encodeURIComponent(EMAIL);
const EXPECTED_TYPES = [
  "prelander_viewed",
  "step_viewed",
  "step_answered",
  "step_viewed",
  "step_answered",
  "step_viewed",
  "quiz_completed",
  "offer_selected",
];

type StoredEvent = { type: string; seq: number | null; visit_id: string };
type State = { me: { events: StoredEvent[] } };

test("QZ-1 ID-4 R-12 a visitor takes the quiz, gets Asia Connect, and the email stays out of every other request", async ({
  page,
}) => {
  test.setTimeout(75_000);
  const requests: { method: string; url: string; body: string }[] = [];
  page.on("request", (r) => {
    requests.push({ method: r.method(), url: r.url(), body: r.postData() ?? "" });
  });

  await page.goto("/p/demo");
  const visit = await page.locator("main").getAttribute("data-visit");
  expect(visit).toBeTruthy();

  await page.locator('button[data-value="women"]').click();
  await page.locator('button[data-value="asia"]').click();
  await page.locator('input[name="email"]').fill(EMAIL);
  await page.locator('[data-email-form] button[type="submit"]').click();

  await expect(page.locator('section[data-result="offer"]')).toBeVisible();
  await expect(page.locator("[data-offer-name]")).toHaveText("Asia Connect");

  // The Queue consumer writes the events in batches; the local queue holds a batch up to 30 s (max_batch_timeout),
  // so wait up to 45 s for all eight before asserting.
  let state: State | undefined;
  let raw = "";
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await page.request.get("/__test/state");
    raw = await response.text();
    state = JSON.parse(raw) as State;
    if (state.me.events.length >= EXPECTED_TYPES.length) break;
    await page.waitForTimeout(250);
  }
  expect(state).toBeDefined();
  // The API lists events by arrival, then seq. Only the browser numbers its events (1 to 5); server events have seq null.
  const events = state?.me.events ?? [];
  // quiz_completed and offer_selected share one received_at and both have seq null, so their relative order is undefined.
  const types = events.map((e) => e.type);
  expect(types.slice(0, 6)).toEqual(EXPECTED_TYPES.slice(0, 6));
  expect(types.slice(6).toSorted()).toEqual(["offer_selected", "quiz_completed"]);
  expect(events.map((e) => e.seq)).toEqual([null, 1, 2, 3, 4, 5, null, null]);
  for (const e of events) expect(e.visit_id).toBe(visit);

  expect(raw).not.toContain(EMAIL);
  expect(raw).not.toContain(ENCODED);

  for (const r of requests) {
    expect(r.url).not.toContain(EMAIL);
    expect(r.url).not.toContain(ENCODED);
  }
  // Exactly one request carries the address: the completion POST.
  const withEmail = requests.filter((r) => r.body.includes(EMAIL) || r.body.includes(ENCODED));
  expect(withEmail.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
    "POST /api/complete",
  ]);
});
