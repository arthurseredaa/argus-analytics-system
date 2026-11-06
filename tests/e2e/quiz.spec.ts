// Browser test: a visitor takes the quiz in a real browser and gets the offer for their answers.
// Serves QZ-1, ID-4, R-12 and DEMO-9: the browser's events reach the store in seq order, the email travels in one request only,
// and the offer link points at /go but the browser never follows it.
import { expect, test } from "@playwright/test";

const EMAIL = "user1@example.com";
const ENCODED = encodeURIComponent(EMAIL);
const BROWSER_TYPES = [
  "step_viewed",
  "step_answered",
  "step_viewed",
  "step_answered",
  "step_viewed",
];
const SERVER_TYPES = ["prelander_viewed", "quiz_completed", "offer_selected"];
const EVENT_COUNT = BROWSER_TYPES.length + SERVER_TYPES.length;

type StoredEvent = { type: string; seq: number | null; visit_id: string };
type State = { me: { events: StoredEvent[] } };

test("QZ-1 ID-4 R-12 DEMO-9 a visitor takes the quiz, gets Asia Connect, and the email stays out of every other request", async ({
  page,
}) => {
  test.setTimeout(150_000);
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
  await expect(page.locator('section[data-result="offer"] a')).toHaveAttribute(
    "href",
    `/go?prelander=demo&visit=${visit}`,
  );

  // The Queue holds a batch up to 30 s (max_batch_timeout), the consumer writes it to R2, and the loader moves it
  // into D1 on its next run (the dev server ticks every 10 s, the deployed cron once a minute),
  // so wait up to 120 s for all eight before asserting.
  let state: State | undefined;
  let raw = "";
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await page.request.get("/__test/state");
    raw = await response.text();
    state = JSON.parse(raw) as State;
    if (state.me.events.length >= EVENT_COUNT) break;
    await page.waitForTimeout(250);
  }
  expect(state).toBeDefined();
  // The API lists events by arrival (received_at, seq). QZ-1 promises order by seq within a visit, and only for the
  // browser's events (seq 1 to 5). Arrival order across the outbox and a direct request is not promised: the outbox
  // can send its last batch after the page's own POST /api/complete, so the server events may arrive first.
  // So the test asserts seq order for the browser events and set membership for the server events (seq null).
  const events = state?.me.events ?? [];
  const browser = events
    .filter((e) => e.seq !== null)
    .toSorted((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const server = events.filter((e) => e.seq === null);
  expect(browser.map((e) => e.type)).toEqual(BROWSER_TYPES);
  expect(browser.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(server.map((e) => e.type).toSorted()).toEqual(SERVER_TYPES.toSorted());
  // The page view happens before any browser event, so it is still the first event by arrival.
  expect(events[0]?.type).toBe("prelander_viewed");
  expect(events).toHaveLength(EVENT_COUNT);
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
  // DEMO-9: the offer link is shown, but the test never clicks it.
  expect(requests.filter((r) => new URL(r.url).pathname === "/go")).toEqual([]);
});
