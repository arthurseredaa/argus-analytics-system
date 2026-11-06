# Part 2 stage 4: the report, implementation plan

This stage is done, and its status lives in `docs/state/progress.json`. The checkboxes below were not kept up to date.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET /api/report` and the `/report` page count what the system recorded, in the cohort view and the postback view, and the demo scenario runs end to end against the deployed Worker as `pnpm test:e2e --base $BASE` (MVP-1).

**Architecture:** the report reads two D1 databases. Funnel steps come from the events database (M-1 to M-8); clicks, Leads and Purchases come from the facts database (M-10 to M-16), joined to their user, prelander and offer through `clicks` by `click_id`. `src/db/report.ts` holds every statement, each opening with the metric ids it implements (AN-8), and runs them in one batch per database. `src/domain/report.ts` is pure: it parses the query string and merges the cells of both databases by day, prelander and offer, then adds drop-offs and rates. `src/routes/report.ts` serves the JSON and the page from the same `Report` value. `scripts/demo.sh`, run as `pnpm test:e2e`, is the demo scenario of acceptance-checks.md with every expected answer asserted.

**Tech Stack:** as stage 3 (TypeScript 5.9, Hono 4, Zod 4, wrangler 4.157, vitest 4 with `@cloudflare/vitest-plugin` 1.5.1, Playwright 1.64.1). Bash and jq for the demo script. GitHub Actions `actions/cache@v4`.

**Spec:** [part2-mvp-stages.md](part2-mvp-stages.md), section "Stage 4: report". Read with it: [metrics-and-operations.md](../design/metrics-and-operations.md), "Metric definitions", "What the MVP report shows", "Two report views"; [data-model.md](../design/data-model.md), `clicks`, `conversions`, "MVP events database", "Types"; the cards AN-1 to AN-8, TEST-5, DEMO-5, DEMO-7, MVP-1, MVP-4, R-17 and the "Demo scenario" in [acceptance-checks.md](../testing/acceptance-checks.md); Q-8, Q-12, Q-13, Q-14, Q-21, Q-22, Q-23, Q-26 in [open-questions.md](../requirements/open-questions.md); R-17 in [risks.md](../requirements/risks.md).

## Decisions in this plan

Each one follows a default the design or the open questions imply, and each is reversible.

1. Raw SQL goes into `src/db/report.ts` and the arithmetic into `src/domain/report.ts`, not into `src/report/queries.ts`; tests go into `tests/unit/` and `tests/integration/`, not `tests/report.test.ts`. The subagent brief keeps raw SQL in `src/db/` only and puts the test level in the path.
2. A click whose user was deleted (`clicks.user_id` null) counts as its own user: in M-10, in M-13 (once per click, as the M-13 row already says) and wherever a rule says "the same user" (M-15, M-26, M-27). `COUNT(DISTINCT user_id)` alone would drop such clicks, and the M-13 row settles the rule for Leads.
3. Q-23: only the first accepted Lead of a (user, offer) pair counts in M-13, ordered by `accepted_at`, then `conversions.id`. The cohort view puts it on the day of that Lead's click, the postback view on the day it was accepted. Later Leads of the pair are stored and add only their payout (M-16). This is the M-13 and M-16 rows as written.
4. M-15: a Purchase is "without a Lead" when the pair had no Lead accepted at or before the Purchase's `accepted_at`. A Lead that arrives later does not clear the flag, so a closed day in the postback view never changes ("Postback view").
5. The report also returns M-2 (visitors) and M-11 (transitions). AN-1 and the DEMO-7 numbers expect transitions, and M-28 (visits per user) divides by M-2. "What the MVP report shows" lists neither and calls both BigQuery-only, so Task 3 corrects that paragraph.
6. The postback view carries M-13, M-14, M-15 and M-16 only, with no funnel steps and no rates, as the "Postback view" section lists. The cohort view carries everything else.
7. Each rate sits at the grain of its row in the metrics table. Prelander rows and the totals carry M-20 to M-24, M-27 and M-28; offer rows carry M-25 and M-26. A rate is rounded to 4 decimals and is `null` when its denominator is 0 or `null`.
8. Totals and prelander rows take distinct-user counts (`visits`, `visitors`, `started`, `step_2`, `step_3`, `completed`, `went_to_offer`, `lead_users`) from a query at their own grain, because a period counts distinct users over the whole period. Pair and row counts (`transitions`, `lead`, `lead_with_purchase`, `purchase`, `purchase_without_lead`, payouts) are sums of the offer cells, since a pair or a row belongs to exactly one offer.
9. Query parameters: `from` and `to` are UTC dates `YYYY-MM-DD` (Q-14), `to` inclusive. `to` defaults to today, `from` defaults to `to`. The span is at most 92 days, so rows read stay bounded (R-17). `prelander` and `offer` match `^[A-Za-z0-9_-]{1,64}$` and an empty value means no filter. A prelander id is not checked against the flow configs, because the report reads data, and a retired prelander keeps its history; an id with no data gives zeros. `view` is `cohort` (default) or `postback`. Unknown parameters are ignored, which leaves `format=csv` free for the stage 10 live task. Anything else gives `400 {"error":"invalid_query"}`.
10. With `offer` set, the funnel fields and the rates built on them are `null`: funnel steps have no offer ("The offer breakdown applies only from the click onward").
11. The report is open, sets no cookie and answers `cache-control: no-store`. design.md lists `/api/report` and `/report` with no access control, and the report holds aggregate counts only. `app.use("/api/*", identity())` becomes `identity()` on `/api/events` and `/api/complete`, so a reviewer's browser gets no user id from reading the report.
12. Indexes (R-17, whose mitigation is "indexed queries"): `events (received_at)` in the events database; `clicks (created_at)` and `conversions (type, accepted_at)` in the facts database. Every events statement filters on a `received_at` range, so rows read grow with the period, not with the store.
13. `as_of` (the time the query ran) and `events_newest_at` (`MAX(received_at)` in the events table, the freshness the cohort view prints next to "as of") are Unix milliseconds. Both change on every call, so every snapshot taken for a `diff` drops them with `jq -S 'del(.as_of, .events_newest_at)'`.
14. `pnpm test:e2e` is `bash scripts/demo.sh` with assertions; there is no `tests/e2e/demo.test.ts`. The stage text names `scripts/demo.sh` behind `pnpm test:e2e`, and a vitest project in Node for one file would only wrap curl. Without `--base` or `BASE`, the script starts its own `wrangler dev` through `scripts/lib/dev-server.sh`, which `scripts/test-browser.sh` then shares. The CI `e2e` job runs it after `pnpm test:browser`, as the test levels table promises from stage 4.
15. The demo script gains three `step_viewed` events through a new helper, `viewstep`. The script in acceptance-checks.md sends only `step_answered`, so `started` would stay 0 and contradict the DEMO-7 numbers (started 1, steps 1 to 3 at 1).
16. MVP-4: `grep -rni bigquery src/ wrangler.jsonc` prints two comments today (`src/db/events.ts:1` and `wrangler.jsonc:24`, both "MVP stand-in for BigQuery"). The check becomes a grep for a client or a credential, which is what the card's expected result names, and the comments stay.
17. AN-2's manual step runs users through `/p/demo2`, which does not exist. The step is changed to run offers 003 and 004 on `/p/demo` and to query a period that excludes today; the automated test covers two prelanders by writing rows with two prelander ids.
18. Report tests isolate their data by a unique prelander id (`r-<8 hex>`) and by fixture days in 2001 that no other test writes. The demo tests that go through the real routes on prelander `demo` and today assert differences between two reports, never absolute counts.

## Global Constraints

- Everything committed is in English, except `docs/requirements/open-questions.md`. No secrets, tokens, account ids, real emails or other personal data in a committed file. Tests use `@example.com` addresses only.
- The email never reaches an event, a Queue message, a URL, a log line, an error response, the report or localStorage. The report carries no user id. The report's log line is `{"msg":"report","rows_read_events":<n>,"rows_read_facts":<n>}` and prints nothing from the request.
- Raw SQL in `src/db/` only. Times are Unix milliseconds in UTC; a report day is the UTC date (Q-14).
- Each new file under `src/` opens with a comment of two or three lines naming the component, the ADR or design section and the requirement ids.
- Test names start with the requirement id, then any R-/Q- id. Filter with `pnpm test -t "X"`, never `pnpm test -- -t "X"`. Tests never assert a global count (decision 18).
- No test, script or card follows a redirect: no `curl -L`, no `redirect: "follow"`.
- Shell scripts run on the bash 3.2 of macOS and on CI's bash 5: no associative arrays, no `${var,,}`, no `mapfile`. `scripts/acceptance.sh` is also sourced from zsh.
- No new runtime or dev dependency. `actions/cache@v4` is a CI action, not a package.
- Work happens in the worktree `.claude/worktrees/part2-stage-4` on branch `part2-stage-4`. Each task commits there.

## Known setup traps

From stages 0 to 3, still true: `compatibility_date` stays `2026-11-03`; test-only bindings by augmenting `Cloudflare.Env` in `tests/env.d.ts`; `wrangler types` needs `--strict-vars=false`; D1 enforces foreign keys, so a click needs its `users` row (or `user_id` null) and `(catalog_version, offer_id)` in `offers`, and a conversion needs its partner and click; `app.fetch` never follows a `302`; tests that send events use `call()` with `captureQueue()` and store them with `deliver()`.

New for this stage:
- `COUNT(DISTINCT user_id)` skips nulls. Decision 2 needs a key such as `COALESCE(c.user_id, 'click:' || c.click_id)`.
- `json_extract(payload, '$.step')` returns an integer; compare it with `1`, not `'1'`.
- The day of a row is `strftime('%Y-%m-%d', <ms> / 1000, 'unixepoch')`; filter on the millisecond range, never on the formatted day, or the index is not used.
- Check that local D1 fills `meta.rows_read` on a `SELECT` before writing the R-17 test on it. If it reports 0 or nothing, stop and report `NEEDS_CONTEXT`; the query plan test still runs.
- `EXPLAIN QUERY PLAN` through D1 needs every `?N` bound; bind `null` for each.
- Hono runs middleware registered by `app.use("/api/*")` for every `/api` path, so `/api/report` would set a cookie unless the identity middleware is narrowed (decision 11).
- The Queue consumer waits up to 30 seconds for a batch (`max_batch_timeout`), locally and on Cloudflare. A report read right after a visit can miss its events; the demo script polls.
- `pnpm postback ...` prints pnpm's script banner to stdout. The demo script calls `pnpm -s postback`.
- `pnpm test:e2e --base <url>` forwards `--base <url>` to the script.
- `/usr/bin/view` exists on macOS and Linux, so the new shell helper is `viewstep`, not `view`.
- In GitHub Actions a cache hit restores the browser, not the system libraries Chromium needs. The hit path still runs `playwright install-deps chromium`.

## Review Focus

- A Lead or a click whose user was deleted: counted once per click, never dropped and never merged with other null-user clicks into one "user". Task 3 tests it.
- A second Lead for the same user and offer on another day: the count stays on the first Lead's click day in the cohort view and on its accepted day in the postback view, and the payout of both is summed. Task 3 tests it.
- An empty period, a prelander with no data, or a zero denominator: zeros and `null` rates, never `NaN` or `Infinity` (which `JSON.stringify` turns into `null` without a word). Tasks 2 and 3 test it.
- Events still in the Queue when the report is read: the report is "as of" the query time, and the demo script and the DEMO-5 diff wait until the funnel cells settle before comparing. Task 5 handles it.
- A hostile query string (`from=0000-00-00`, a span of years, `prelander=' OR 1=1`): `400`, and every value reaches SQL as a bound parameter. Tasks 2 and 3 test it.

---

### Task 1: CI, Playwright browsers cached and the install bounded

**Files:**
- Modify: `.github/workflows/ci.yml` (job `e2e` only)

**Interfaces:**
- Produces: in job `e2e`, after `pnpm install --frozen-lockfile`, in this order:
  - a step `Read the Playwright version`, id `pw`: `echo "version=$(pnpm exec playwright --version | awk '{print $2}')" >> "$GITHUB_OUTPUT"`
  - `actions/cache@v4`, id `pw-cache`, `path: ~/.cache/ms-playwright`, `key: playwright-${{ runner.os }}-${{ steps.pw.outputs.version }}`
  - `Install Chromium`: `if: steps.pw-cache.outputs.cache-hit != 'true'`, `timeout-minutes: 3`, `run: pnpm exec playwright install --with-deps chromium`
  - `Install Chromium system libraries`: `if: steps.pw-cache.outputs.cache-hit == 'true'`, `timeout-minutes: 3`, `run: pnpm exec playwright install-deps chromium`
- The job keeps `timeout-minutes: 10`. Jobs `check` and `deploy` do not change.

- [ ] **Step 1: Edit the workflow.** On 2026-11-05 the install step hung for 10 minutes twice, until the job timeout; it normally takes about 40 seconds.
- [ ] **Step 2: Check the file parses.** Run `ruby -ryaml -e 'w = YAML.load_file(".github/workflows/ci.yml"); puts w["jobs"]["e2e"]["timeout-minutes"]; puts w["jobs"]["e2e"]["steps"].map { |s| s["name"] || s["uses"] || s["run"] }'`. Expected: `10`, then the step list with the four new steps between `pnpm install --frozen-lockfile` and `Write .dev.vars`.
- [ ] **Step 3: Commit** `ci: cache Playwright browsers and bound the install to 3 minutes`. The real check is the PR run (closing): the first run misses the cache and the install step finishes within 3 minutes; a re-run of the job shows `Cache restored` and skips `Install Chromium`.

### Task 2: report parameters and arithmetic

**Files:**
- Create: `src/domain/report.ts`, `tests/unit/report.test.ts`

**Interfaces:**
- Produces, `src/domain/report.ts` (header: design "Two report views" and "Metric definitions"; serves AN-1 to AN-5, Q-14):
  - `type ReportView = "cohort" | "postback"`
  - `type ReportQuery = { view: ReportView; from: string; to: string; fromMs: number; toMs: number; prelander: string | null; offer: string | null }`; `toMs` is the start of the day after `to` (exclusive).
  - `MAX_REPORT_DAYS = 92`
  - `parseReportQuery(params: URLSearchParams, nowMs: number): ReportQuery | null`: decision 9; `null` means `400`.
  - `type CellKey = { day: string | null; prelander_id: string | null; offer_id: string | null }`. The grain is in the nulls: offer cells have all three, prelander cells have `offer_id` null, the total has all three null.
  - `type FunnelCell = CellKey & { visits: number; visitors: number; started: number; step_2: number; step_3: number; completed: number }` (prelander and total grains)
  - `type ClickCell = CellKey & { went_to_offer: number; transitions: number }` (all three grains)
  - `type LeadCell = CellKey & { lead: number; lead_with_purchase: number; lead_users: number }` (all three grains in the cohort view, offer grain in the postback view)
  - `type PurchaseCell = CellKey & { purchase: number; purchase_without_lead: number }` (offer grain)
  - `type PayoutCell = CellKey & { currency: string | null; amount: number }` (offer grain, postback view)
  - `type ReportInput = { query: ReportQuery; asOf: number; eventsNewestAt: number | null; funnel: FunnelCell[]; clicks: ClickCell[]; leads: LeadCell[]; purchases: PurchaseCell[]; payouts: PayoutCell[] }`
  - `ratio(numerator: number | null, denominator: number | null): number | null`: 4 decimals; `null` for a zero or null denominator.
  - `type CohortReport` and `type PostbackReport` with exactly these JSON keys (counts are `number`, or `number | null` where decision 10 applies):
    - cohort: `view`, `from`, `to`, `prelander`, `offer`, `as_of`, `events_newest_at`, `visits`, `visitors`, `started`, `step_1` (equals `started`, M-3; AN-1 names both), `step_2`, `step_3`, `completed`, `dropoff_step_1`, `dropoff_step_2`, `dropoff_step_3` (M-23 counts), `went_to_offer`, `transitions`, `lead`, `purchase`, `rates` { `step_1_to_2` M-20, `step_2_to_3` M-21, `step_3_to_completion` M-22, `dropoff_step_1_share`, `dropoff_step_2_share`, `dropoff_step_3_share` M-23, `start_to_offer` M-24, `start_to_lead` M-27, `visits_per_user` M-28 }, `rows`: [{ `day`, `prelander_id`, the same counts and `rates`, `offers`: [{ `offer_id`, `went_to_offer`, `transitions`, `lead`, `purchase`, `rates` { `offer_to_lead` M-25, `lead_to_purchase` M-26 } }] }]
    - postback: `view`, `from`, `to`, `prelander`, `offer`, `as_of`, `events_newest_at`, `lead`, `purchase`, `purchase_without_lead`, `payout`: [{ `currency`, `amount` }], `rows`: [{ `day`, `prelander_id`, `lead`, `purchase`, `purchase_without_lead`, `payout`, `offers`: [{ `offer_id`, `lead`, `purchase`, `purchase_without_lead`, `payout` }] }]
  - `type Report = CohortReport | PostbackReport`; `buildReport(input: ReportInput): Report`: decisions 6 to 8 and 10. Rows sort by `day`, then `prelander_id`; offers by `offer_id`; payouts by `currency`, null last. A prelander row exists for every key found in any cell; missing counts are 0.

- [ ] **Step 1: Write the failing tests** in `tests/unit/report.test.ts`, with `NOW = Date.UTC(2026, 10, 5, 13, 0)`:
  - `AN-2 report defaults to today UTC and the cohort view`: empty params give `{ view: "cohort", from: "2026-11-05", to: "2026-11-05", fromMs: Date.UTC(2026, 10, 5), toMs: Date.UTC(2026, 10, 6), prelander: null, offer: null }`; `Date.UTC(2026, 10, 5, 23, 59, 59)` still gives `2026-11-05`.
  - `AN-2 from alone runs to today` (`from=2026-11-01` gives `to` `2026-11-05`); `AN-2 to alone is one day` (`to=2026-11-03` gives `from` `2026-11-03`); `AN-2 empty prelander and offer mean no filter`.
  - `AN-2 bad parameters are rejected`, one `null` each: `from=2026-02-30`, `from=20261105`, `from=2026-11-06&to=2026-11-05`, `from=2026-01-01&to=2026-04-03` (93 days), `view=finance`, `prelander=bad id!`, `prelander=' OR 1=1`, an `offer` of 65 characters. `from=2026-01-01&to=2026-04-02` (92 days) passes.
  - `AN-1 drop-offs are reached N minus reached N+1`: total funnel started 3, step_2 2, step_3 2, completed 1 gives `dropoff_step_1` 1, `dropoff_step_2` 0, `dropoff_step_3` 1 and shares 0.3333, 0, 0.5.
  - One test per rate, each from hand-built cells: `AN-3 M-20 step 1 to step 2` (2 over 3 is 0.6667), `AN-3 M-21 step 2 to step 3` (2 over 2 is 1), `AN-3 M-22 step 3 to completion` (1 over 2 is 0.5), `AN-3 M-24 start to offer counts users across offers` (prelander click cell `went_to_offer` 1, two offer cells with 1 each, started 3: 0.3333), `AN-3 M-25 offer to Lead` (offer cell lead 1, went_to_offer 2: 0.5), `AN-3 M-26 Lead to Purchase` (lead 2, lead_with_purchase 1: 0.5), `AN-3 M-27 start to Lead` (lead_users 1, started 4: 0.25), `AN-3 M-28 visits per user` (visits 3, visitors 2: 1.5).
  - `AN-3 a zero denominator gives null, never NaN or Infinity`: all-zero cells give every rate `null`; `JSON.stringify(report)` contains neither `NaN` nor `Infinity`.
  - `AN-1 totals take distinct users from their own cell and sums from the offer cells`: offer cells with transitions 1 and 2 and went_to_offer 1 and 1, total click cell went_to_offer 1: totals `transitions` 3, `went_to_offer` 1.
  - `AN-2 an offer filter leaves the funnel null`: `offer: "003"` gives `started`, `step_1`, `dropoff_step_1` and `rates.start_to_offer` `null`, and `transitions` a number.
  - `AN-2 rows keep a cell with clicks but no events`: a prelander click cell for a day with no funnel cell gives a row with `started` 0.
  - `AN-5 the postback view carries Leads, Purchases, the flag and payouts only`: `Object.keys` of a postback report equals the postback key list above; payouts `USD 25` (offer 003) and `USD 5` (004) and `EUR 10` give `payout` `[{ currency: "EUR", amount: 10 }, { currency: "USD", amount: 30 }]`.
- [ ] **Step 2: Run `pnpm test -t "AN-1|AN-2|AN-3|AN-5"`.** Expected: FAIL, `src/domain/report.ts` cannot be resolved.
- [ ] **Step 3: Write `src/domain/report.ts`.**
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`.** Expected: all pass, exit 0.
- [ ] **Step 5: Commit** `feat: report parameters, drop-offs and rates`.

### Task 3: report queries, indexes and `GET /api/report`

**Files:**
- Create: `migrations/events/0002_report_indexes.sql`, `migrations/facts/0002_report_indexes.sql`, `src/db/report.ts`, `src/routes/report.ts`, `tests/fixtures/report.ts`, `tests/unit/report-sql.test.ts`, `tests/integration/report.test.ts`
- Modify: `src/app.ts` (identity on `/api/events` and `/api/complete` only; mount the report route), `docs/design/metrics-and-operations.md` ("What the MVP report shows" adds M-2 as the denominator of M-28 and M-11, and drops both from the BigQuery-only sentence; the M-10 row adds "a click whose user was deleted counts as its own user, as in M-13"; the M-15 row adds "no Lead accepted at or before the Purchase"), `docs/design/data-model.md` (the three new indexes in the `clicks`, `conversions` and "MVP events database" sections), `docs/testing/acceptance-checks.md` (the "Report" row of the endpoints table: parameters, defaults, `400 invalid_query`, no cookie, `no-store`, the two key lists of Task 2)

**Interfaces:**
- Consumes: `ReportQuery`, the cell types, `buildReport` (Task 2); `insertEvents` from `src/db/events.ts`; `insertClick` from `src/db/clicks.ts`; `insertConversion` from `src/db/conversions.ts`; `storedEvent`, `call` from `tests/fixtures/events.ts`.
- Produces, migrations: events `CREATE INDEX events_received_at ON events (received_at);`; facts `CREATE INDEX clicks_created_at ON clicks (created_at);` and `CREATE INDEX conversions_type_accepted ON conversions (type, accepted_at);`.
- Produces, `src/db/report.ts`:
  - `REPORT_SQL: Readonly<Record<string, { db: "events" | "facts"; sql: string }>>`: every statement the report can run, at every grain and in both views. Each `sql` opens with a line `-- M-<n>[, M-<n>...]: <what it counts>`. The funnel is one statement per grain with conditional `COUNT(DISTINCT ...)`; the newest event is `SELECT MAX(received_at) ...`.
  - `readEventsReport(db: D1Database, q: ReportQuery): Promise<{ funnel: FunnelCell[]; newestAt: number | null; rowsRead: number }>`: one `db.batch`; skipped (empty funnel) in the postback view and when `q.offer` is set, except the newest-event read.
  - `readFactsReport(db: D1Database, q: ReportQuery): Promise<{ clicks: ClickCell[]; leads: LeadCell[]; purchases: PurchaseCell[]; payouts: PayoutCell[]; rowsRead: number }>`: one `db.batch`. Cohort: the day is the click's `created_at`. Postback: the day is `conversions.accepted_at`. Decisions 2 to 4.
- Produces, `src/routes/report.ts`: `reportRoute(): Hono<AppEnv>` with `GET /api/report`: `parseReportQuery(new URL(c.req.url).searchParams, Date.now())`, `null` gives `400 {"error":"invalid_query"}`; both reads in parallel; `buildReport`; the log line of Global Constraints; `200` JSON with `cache-control: no-store`. Task 4 adds `GET /report` to the same route.
- Produces, `tests/fixtures/report.ts`:
  - `DAY_1 = Date.UTC(2001, 1, 3)` ("yesterday", `2001-02-03`), `DAY_2 = DAY_1 + 86_400_000` ("today", `2001-02-04`), `AN2_DAY = Date.UTC(2001, 5, 1)`
  - `uniquePrelander(): string` (`r-` and 8 hex characters)
  - `addUser(): Promise<string>`: a `users` row with `email_enc` `v1:AAAA:AAAA` and a random hex `email_hash`
  - `addEvents(rows: { userId: string; prelander: string; type: "prelander_viewed" | "step_viewed" | "step_answered" | "quiz_completed"; at: number; visit?: string; step?: number; reason?: string }[]): Promise<void>` through `insertEvents`
  - `addClick(input: { userId: string | null; prelander: string; at: number; offerId?: string; reason?: Click["reason"] }): Promise<string>`: offer `003` and reason `best_epu` by default, catalog version 1
  - `addConversion(input: { clickId: string; type: "lead" | "purchase"; at: number; payout?: number; currency?: string }): Promise<void>`: the partner of the click's offer in version 1, a fresh `transaction_id`, `occurred_at = accepted_at = at`
  - `an1Fixture(): Promise<{ prelander: string; userIds: string[] }>`: on a new prelander, user A (`prelander_viewed` with reason `quiz`, `step_viewed` 1), user B (`prelander_viewed`, `step_viewed` 1, 2, 3), user C (the same and `quiz_completed`, a click on 003, a Lead and a Purchase of `25` `USD`), all at `DAY_2`; and user D for AN-5, with no events, a click on 003 at `DAY_1` and a Purchase of `10` `EUR` accepted at `DAY_2`
  - `report(query: Record<string, string>): Promise<Record<string, unknown>>`: `call("/api/report?" + new URLSearchParams(query))`, expects `200`, returns the JSON

- [ ] **Step 1: Write the failing tests.**

  `tests/unit/report-sql.test.ts` (reads `docs/design/metrics-and-operations.md` with `node:fs`):
  - `AN-8 every report query names a metric id from the design`: every `REPORT_SQL` entry's `sql` starts with `-- `, its first line names at least one `M-<n>`, and each id has a row starting `| M-<n> |` in the metrics document.
  - `AN-8 every metric the MVP report shows has a query`: the first lines together name M-1, M-2, M-3, M-4, M-5, M-8, M-10, M-11, M-13, M-14, M-15 and M-16.

  `tests/integration/report.test.ts`, each test on its own `uniquePrelander()` unless it says otherwise; "cohort DAY_2" means `report({ from: "2001-02-04", to: "2001-02-04", prelander })`:
  - `AN-7 empty store gives zeros`: cohort DAY_2 on a new prelander: every count 0, every rate `null`, `rows` `[]`; the postback view the same.
  - `AN-1 fixture gives expected start, steps, drop-offs, transitions, Leads, Purchases`: `an1Fixture()`, cohort DAY_2: `visits` 3, `started` 3, `step_1` 3, `step_2` 2, `step_3` 2, `completed` 1, `dropoff_step_1` 1, `dropoff_step_2` 0, `dropoff_step_3` 1, `went_to_offer` 1, `transitions` 1, `lead` 1, `purchase` 1.
  - `AN-7 fixture gives expected numbers`: the same fixture gives one row, day `2001-02-04`, with one offer `003`: `went_to_offer` 1, `transitions` 1, `lead` 1, `purchase` 1, `rates` `{ offer_to_lead: 1, lead_to_purchase: 1 }`.
  - `AN-5 R-7 late purchase moves the click-date cohort and lands on today in the postback view`: cohort DAY_1: `purchase` 1, `transitions` 1, `started` 0. Postback DAY_2: `lead` 1, `purchase` 2, `purchase_without_lead` 1, `payout` `[{ currency: "EUR", amount: 10 }, { currency: "USD", amount: 25 }]`. Postback DAY_1: `purchase` 0.
  - `AN-5 Q-12 a closed day in the postback view does not change when a late postback arrives`: snapshot postback DAY_2 without `as_of` and `events_newest_at`; add a Purchase on D's click accepted at `DAY_2 + 2 days`; postback DAY_2 is equal to the snapshot; cohort DAY_1 `purchase` is 2.
  - `AN-1 Q-23 a second Lead for the same user and offer counts once`: one user, clicks on 003 at `DAY_1` and `DAY_2`, a Lead on each (`5` `USD`, the first accepted first); cohort over both days: `lead` 1, the `2001-02-03` row `lead` 1, the `2001-02-04` row `lead` 0. Postback over both days: `lead` 1, `payout` `[{ currency: "USD", amount: 10 }]`.
  - `AN-1 a Lead on a click without a user counts once per click`: two clicks with `userId` null, a Lead on each: `went_to_offer` 2, `lead` 2; a second Lead on the first click leaves `lead` at 2.
  - `AN-4 Q-26 two visits by one user count one user and two visits`: one user, two `prelander_viewed` with visits `v1` and `v2`, `step_viewed` 1 in each: `visits` 2, `visitors` 1, `started` 1, `rates.visits_per_user` 2.
  - `AN-4 Q-21 lead return is not counted as started`: `prelander_viewed` with reason `lead_return` and a click with reason `lead_return`: `visits` 1, `started` 0, `transitions` 1, `went_to_offer` 0.
  - `AN-4 a period counts distinct users over the whole period, not the sum of days`: one user with `step_viewed` 1 on `DAY_1` and `DAY_2`: each row `started` 1, the two-day total `started` 1.
  - `AN-3 Q-13 started counts step 1 shown, not the page view or an answer`: `prelander_viewed` and `step_answered` 1 only: `visits` 1, `started` 0.
  - `AN-2 breakdowns sum to the total`: on `AN2_DAY`, prelanders P and Q, users on offers 003 and 004 with clicks, Leads and Purchases. The report for that day without a prelander filter: `transitions`, `lead` and `purchase` equal the sum over rows and the sum over offer rows; `started` equals the sum of the rows' `started`. Filtered by P, the totals equal P's row. Filtered by `offer=004`: `transitions` equals the 004 cells, `started` is `null`. The next day gives zeros.
  - `AN-2 Q-22 a Lead belongs to the prelander of its click`: funnel events on P, the click and its Lead on Q: Q's row `lead` 1, P's row `lead` 0.
  - `AN-2 bad report parameters give 400`: `/api/report?from=2026-02-30` gives `400 {"error":"invalid_query"}`.
  - `AN-6 the report API sets no cookie and is not cached`: no `set-cookie`, `cache-control` `no-store`, `content-type` starting `application/json`.
  - `R-12 the report carries no user id or email`: after `an1Fixture()`, the response text contains no `@` and none of `userIds`.
  - `R-17 every events query searches by index`: for each `REPORT_SQL` entry with `db: "events"`, `EXPLAIN QUERY PLAN` on `env.EVENTS` with `null` for every parameter gives no `detail` starting `SCAN events`.
  - `R-17 report rows read stays flat as events grow`: `an1Fixture()`, cohort DAY_2 with `console.log` spied, read `rows_read_events` from the `report` log line (positive); insert 500 events on `DAY_2 + 30 days` for another prelander; the same report logs the same `rows_read_events`.
- [ ] **Step 2: Run `pnpm test -t "AN-|R-12 the report|R-17"`.** Expected: the new tests FAIL (`src/db/report.ts` cannot be resolved; `/api/report` answers `404`).
- [ ] **Step 3: Write the migrations, the queries, the route and the fixture; narrow the identity middleware; edit the three documents as listed.** Then `pnpm migrate:local`. Expected: both databases apply `0002_report_indexes.sql`.
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm lint:docs`.** Expected: all pass, exit 0, the stage 1 to 3 tests included.
- [ ] **Step 5: Commit** `feat: report queries in cohort and postback views`.

### Task 4: the `/report` page

**Files:**
- Create: `src/pages/report.ts`, `tests/integration/report-page.test.ts`
- Modify: `src/routes/report.ts`

**Interfaces:**
- Consumes: `Report`, `parseReportQuery`, `buildReport` (Task 2); `readEventsReport`, `readFactsReport` (Task 3); `an1Fixture`, `DAY_1`, `DAY_2` (Task 3).
- Produces, `src/pages/report.ts`: `renderReportPage(report: Report): string`: server-rendered HTML, no script. `<main data-view="cohort|postback">`; the "as of" time as `<p data-as-of="<ISO 8601 UTC>">` with the events' newest time next to it; a `GET` form with `from`, `to`, `prelander`, `offer` and `view`; a link to the other view with the same parameters; a totals table whose value cells are `<td data-metric="<json key>">`, in the cohort view at least `started`, `step_2`, `step_3`, `went_to_offer`, `lead`, `purchase`, `transitions`, and in the postback view `lead`, `purchase`, `purchase_without_lead`; then a table of rows and their offers. Every value written into HTML is escaped.
- Produces, `GET /report` in `src/routes/report.ts`: the same read as `/api/report`; `200` `text/html` with `cache-control: no-store`; an invalid query gives `400` with the text `Invalid report query`.

- [ ] **Step 1: Write the failing tests** in `tests/integration/report-page.test.ts`, on `an1Fixture()`:
  - `AN-6 report page renders the five counts`: `/report?from=2001-02-04&to=2001-02-04&prelander=<p>` gives `200`, `text/html`, and contains `data-metric="started">3<`, `data-metric="step_2">2<`, `data-metric="step_3">2<`, `data-metric="went_to_offer">1<`, `data-metric="lead">1<`, `data-metric="purchase">1<`.
  - `AN-6 the page switches between the cohort and the postback view`: the cohort page links to `/report?view=postback` with the same `from`, `to` and `prelander`; the postback page has `data-view="postback"`, `data-metric="purchase">2<` and no `data-metric="started"`.
  - `AN-6 the page prints the as-of time`: `data-as-of` matches `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$`.
  - `AN-6 a bad query gives 400 on the page` and `AN-6 the page sets no cookie and is not cached`.
- [ ] **Step 2: Run `pnpm test -t "AN-6"`.** Expected: the page tests FAIL with `404`; the API test of Task 3 passes.
- [ ] **Step 3: Write the page and the route.** Then open `http://localhost:8787/report` under `pnpm dev` after `pnpm migrate:local && pnpm seed --local`. Expected: the page renders with zeros and both view links work.
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`.** Expected: all pass, exit 0.
- [ ] **Step 5: Commit** `feat: report page with the view switch`.

### Task 5: the demo path end to end

**Files:**
- Create: `scripts/demo.sh`, `scripts/lib/dev-server.sh`
- Modify: `scripts/test-browser.sh` (uses `scripts/lib/dev-server.sh`, behaviour unchanged), `scripts/acceptance.sh` (helpers `viewstep`, `report`, `wait_report`), `package.json` (`"test:e2e": "bash scripts/demo.sh"`), `.github/workflows/ci.yml` (job `e2e`: `- run: pnpm test:e2e` after `pnpm test:browser`), `tests/integration/demo.test.ts`, `docs/testing/acceptance-checks.md` (the demo script: three `viewstep` lines after the entry, DEMO-5 with `report` snapshots and a `diff`; "Report after the script" becomes the DEMO-7 table below; AN-2 manual step per decision 17; MVP-4 manual step per decision 16; MVP-1 "staging url" becomes `$BASE`), `README.md` (a section "Expected results": the decision-table rows 1, 3, 5, 6 and 16, copied with their results, and the DEMO-7 table), `docs/plans/part2-mvp-stages.md` (the test levels row "End to end, HTTP" names `scripts/demo.sh` without `tests/e2e/demo.test.ts`)

**Interfaces:**
- Consumes: the report (Tasks 3 and 4); `pnpm postback` (stage 3); `call`, `captureQueue`, `deliver`, `postEvent` from `tests/fixtures/events.ts`; `browserEvent` from `tests/fixtures/event-bodies.ts`.
- Produces, `scripts/acceptance.sh`:
  - `viewstep <jar> <step> [seq]`: one `step_viewed` with payload `{"step":<step>,"prefilled":false}`, prints the HTTP status
  - `report [query]`: `curl -s "$BASE/api/report${1:+?$1}" | jq -S 'del(.as_of, .events_newest_at)'`
  - `wait_report <jq filter> <expected> [seconds]`: polls `/api/report` every 3 seconds until `jq -r <filter>` prints `<expected>`, default 90 seconds; returns 1 and prints the last value on timeout
- Produces, `scripts/lib/dev-server.sh`: `start_dev_server <log file>` (the port check, `wrangler dev --port 8787` in its own process group, `/healthz` within 60 seconds, the `/__test/state` `404` check, as `test-browser.sh` does today) and `stop_dev_server`.
- Produces, `scripts/demo.sh [--base <url>]`: the base is `--base`, then `BASE`, else a local `wrangler dev` started with `start_dev_server` and stopped on exit. It sources `scripts/acceptance.sh`, runs the demo script from an empty store with `pnpm -s postback`, prints `ok <step>` for each passed check, and on the first mismatch prints `FAIL <step>: expected <x>, got <y>` and exits 1. Checks, in order:
  - reset gives `{"ok":true}`
  - DEMO-2: entry `200`; `viewstep` 1, 2, 3 and `answer` gender, ethnicity each `202`; `complete` gives `{"offer_id":"003","reason":"best_epu"}`; `/go?prelander=demo` gives `302` with a 32-hex `click_id`; then `wait_report '[.visits,.started,.step_2,.step_3,.completed]|@csv' '1,1,1,1,1'`
  - DEMO-3: the Lead prints a line starting `202`; `.lead` is 1
  - DEMO-4: entry prints `302 https://asia-connect.example/?click_id=<32 hex>`, an id other than the first; `wait_report .visits 2`
  - DEMO-5: `report > $TMP/before.json`; the Purchase prints `202`; `report > $TMP/after.json`; prints `diff $TMP/before.json $TMP/after.json`; the changed scalar paths, computed with `jq` over both files, are exactly `purchase`, `rows.0.offers.0.purchase`, `rows.0.offers.0.rates.lead_to_purchase`, `rows.0.purchase`; `/report` contains `data-metric="purchase">1<`
  - DEMO-6: the Purchase again prints `200 {"status":"duplicate"}`, the Lead again starts with `200`; prints `jq -c '{lead,purchase}'`, which is `{"lead":1,"purchase":1}`
  - final: `[.visits,.started,.step_1,.step_2,.step_3,.completed,.went_to_offer,.transitions,.lead,.purchase]|@csv` is `2,1,1,1,1,1,1,2,1,1`; the last line is `demo passed against <base>`
- Produces, the DEMO-7 table (acceptance-checks.md and README), the report after each step from an empty store:

  | After | visits | started | step_1 | step_2 | step_3 | completed | went_to_offer | transitions | lead | purchase |
  |---|---|---|---|---|---|---|---|---|---|---|
  | reset | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
  | DEMO-2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 0 | 0 |
  | DEMO-3 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 0 |
  | DEMO-4 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 2 | 1 | 0 |
  | DEMO-5 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 2 | 1 | 1 |
  | DEMO-6 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 2 | 1 | 1 |

  Under it: DEMO-5 also moves offer 003's `lead_to_purchase` from 0 to 1, and these are the only cells the Purchase changes. The return visit counts as a visit and a transition, not as a start or a new user on the offer (Q-21).

- [ ] **Step 1: Write the failing tests** in `tests/integration/demo.test.ts`, in a new `describe.sequential("the report through the demo")`; `today` is the UTC date of `Date.now()` and every report read is `?prelander=demo&from=<today>&to=<today>`:
  - `DEMO-5 a Purchase changes the report`: a user from `userWithClick()` with a Lead; `purchase` after the Purchase is `purchase` before plus 1, `lead` unchanged.
  - `DEMO-7 the demo moves the report by the expected cells`: report A; then, with one `captureQueue()`, entry, `step_viewed` 1 to 3 and the two answers through `postEvent`, completion, `/go`, the Lead, the return entry, the Purchase and the Purchase again; `deliver` of every captured body; report B. B minus A: `visits` 2, `started` 1, `step_2` 1, `step_3` 1, `completed` 1, `went_to_offer` 1, `transitions` 2, `lead` 1, `purchase` 1.
- [ ] **Step 2: Run `pnpm test -t "DEMO-5|DEMO-7"`.** Expected: the two tests FAIL only if Tasks 3 and 4 are missing; with them in place they should pass at once, which shows the report counts what the real routes record. If either fails, the defect is in Task 3 or in the routes, not in the test.
- [ ] **Step 3: Write the helpers, `scripts/lib/dev-server.sh`, `scripts/demo.sh`, the `test:e2e` script and the CI step; move `test-browser.sh` onto the shared helper; edit acceptance-checks.md, README.md and part2-mvp-stages.md as listed.**
- [ ] **Step 4: Run the end-to-end checks locally.** `pnpm migrate:local && pnpm seed --local`, then `pnpm test:e2e`. Expected: an `ok` line per check, the diff, `{"lead":1,"purchase":1}`, `demo passed against http://localhost:8787`, exit 0. Then `pnpm test:browser`. Expected: passes as before, email scan included.
- [ ] **Step 5: Run the stage checks.** `pnpm test -t "AN-1|AN-5|AN-7"` (TEST-5); `pnpm test -t "AN-|R-17|DEMO-5|DEMO-7"`; `grep -rnE -- "curl .*-L( |$)|redirect: ?['\"]follow" tests/ scripts/ docs/testing/`; `grep -rniE "@google-cloud|googleapis|bigquery\.(googleapis|client)|GOOGLE_APPLICATION_CREDENTIALS" src/ wrangler.jsonc package.json`; `for f in src/*/*.ts; do head -3 "$f" | grep -qE "ADR|design" || echo "$f"; done`. Expected: both test runs pass; the three commands print nothing.
- [ ] **Step 6: Run the gate:** `pnpm check`. Expected: exit 0.
- [ ] **Step 7: Commit** `feat: demo scenario as pnpm test:e2e, in CI`.

### After the tasks: closing

From this stage on the stages run without an approval gate (Arthur, 2026-11-05). The AI merges the PR itself once CI is green, cleans up, checks the deploy and moves to the next stage.

- [ ] Explain-back questions, collected for Arthur in the PR description and in the stage notes; they do not block the merge: why can yesterday's row in the cohort view change today, and which view should finance read? Why does a second Lead for the same user and offer change the payout but not the Lead count? Where does a Lead on a click whose user was deleted go?
- [ ] Docs in the closing commit:
  - `docs/ai/plan-history.md`, appended at the bottom, `## 2026-11-05: stages run without an approval gate from stage 4`. What changed: from stage 4 on there is no approval gate and no blocking explain-back per stage; the AI merges each stage PR after CI is green, removes the worktree, checks the deploy, then starts the next stage; code generation runs on Sonnet through subagent-driven development; a Fable review at the end checks how accurately the remaining stages were implemented; explain-back questions are collected for Arthur and do not block. Who: Arthur. Then one paragraph on the report clarifications of this plan (decisions 2 to 5: null-user clicks, the first Lead of a pair, M-15 timing, M-2 and M-11 in the MVP report) and the demo script's `step_viewed` lines. No stage was added or moved.
  - `docs/plans/part2-mvp-stages.md`, "How the stages run": step 2 keeps open questions with defaults, and a decision with no default in the docs is collected for Arthur without stopping the stage; step 3 says code is written by Sonnet subagents through subagent-driven development, with a review per task; step 4 says the explain-back questions are collected for Arthur in the PR description and do not block; step 6 says the AI squash-merges the stage PR once CI is green, removes the worktree, pulls `main`, waits for the deploy run and checks the deployed Worker, then starts the next stage; a new last line says a Fable review checks the remaining stages against their plans once stage 10 is done. Stage 4's section: tick the boxes, and change its Files line to the files this plan created.
  - `docs/state/progress.json` through `pnpm stage:close 4 --verified "<the commands of Task 5 step 5 and step 6, with their counts>" --notes-file <file>`; the notes name the decisions above, the defects the reviews found, what was deferred, and say the deployed checks run right after the merge deploys.
- [ ] Open the PR with `gh pr create --body-file`, listing what the stage built, the decisions, the explain-back questions and the verify output in a details block. Wait with `gh pr checks --watch`. Expected: `check` and `e2e` green; in the `e2e` log, `Install Chromium` finishes within 3 minutes and `pnpm test:e2e` prints `demo passed against http://localhost:8787`. Re-run the `e2e` job once with `gh run rerun <run id> --job <e2e job id>`. Expected: `Cache restored from key: playwright-Linux-1.64.1` and `Install Chromium` skipped.
- [ ] Merge and clean up: `gh pr merge --squash --delete-branch`, subject `feat: funnel report in cohort and postback views`. From the main checkout: `git worktree remove .claude/worktrees/part2-stage-4`, `git checkout main && git pull --ff-only`, then `gh run watch "$(gh run list --branch main --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status`. Expected: the run ends green with the deploy job.
- [ ] Check the deployed Worker, from the main checkout with `.dev.vars.remote` present:

  ```sh
  export BASE=https://funnels-analytics-events.bblog.workers.dev
  curl -s $BASE/healthz                     # {"sha":"<git rev-parse HEAD>"}
  pnpm test:e2e --base $BASE                # MVP-1: ok lines, the DEMO-5 diff, {"lead":1,"purchase":1}, demo passed against https://funnels-analytics-events.bblog.workers.dev
  curl -sI "$BASE/api/report" | grep -ci '^set-cookie'                    # 0
  curl -s "$BASE/report" | grep -o 'data-metric="purchase">[0-9]*'      # data-metric="purchase">1
  grep -rniE "@google-cloud|googleapis|bigquery\.(googleapis|client)|GOOGLE_APPLICATION_CREDENTIALS" src/ wrangler.jsonc package.json   # MVP-4: nothing
  ```

  The DEMO-5 diff printed by `pnpm test:e2e` must change only `purchase` (total, row, offer 003) and offer 003's `lead_to_purchase`, the cells the DEMO-7 table lists. If a check fails, the fix goes in a new branch and PR before stage 5 starts.
- [ ] Tell Arthur in one paragraph what is left, with the explain-back questions and any decision that waits for him.
