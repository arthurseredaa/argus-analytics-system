# Part 2 stage 6: operations, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** latency and freshness are measured, alerts fire on the nfr.md thresholds, and the quiz email is absent everywhere it must be. Every request writes one Analytics Engine data point, the loader writes a freshness point per run, an alert cron every 5 minutes logs one JSON line per firing alert, `GET /__probe` measures the entry D1 batch, and `pnpm test:email-scan` also scans a `wrangler tail` capture and the R2 files and events rows on Cloudflare.

**Architecture:** `src/ops/metrics.ts` builds every data point (request, loader, pipeline, D1 size), writes it through `writePoint()` and holds the request middleware that `src/app.ts` mounts first. `src/routes/probe.ts` is `GET /__probe`. `src/ops/alerts.ts` is the alert evaluator: it reads its sources (pipeline health, R2 `rejected/`, `quarantine`, the Queue and dead letter queue backlogs, D1 sizes, postback counts, the Analytics Engine SQL API), turns them into readings, and a pure `evaluateAlerts()` compares the readings with the thresholds. `src/index.ts` runs it from `scheduled` on the alert cron. Raw SQL stays in `src/db/`: `src/db/ops.ts` (quarantine count, D1 size), `src/db/postback-counts.ts` (the counter table) and `src/db/analytics-engine.ts` (the SQL API client and its three queries). `scripts/email-scan.sh` gains a directory mode and a remote mode.

**Tech Stack:** as stage 5 (TypeScript 5.9, Hono 4, Zod 4, wrangler 4.157, vitest 4 with `@cloudflare/vitest-plugin` 1.5.1 on miniflare 5.20261103, Playwright 1.64.1). Analytics Engine through the Workers binding `METRICS` (dataset `funnels_metrics`, already in `wrangler.jsonc`). Queue backlogs through `Queue.metrics()`. The Analytics Engine SQL API through `fetch`.

**Spec:** [part2-mvp-stages.md](part2-mvp-stages.md), section "Stage 6: operations". Read with it: [metrics-and-operations.md](../design/metrics-and-operations.md) "Latency target (NFR-6)", "Reliability and alerts" and "MVP storage limits"; [data-model.md](../design/data-model.md) "Personal data" and "R2 layout"; the cards DEMO-8, R-12, NFR-3, NFR-6 and AN-5 in [acceptance-checks.md](../testing/acceptance-checks.md); the "Set in stage 4" rows of [nfr.md](../requirements/nfr.md#set-in-stage-4); the "Watch" lines in the Consequences of [ADR 0005](../adr/0005-event-ingestion-and-buffering.md) and [ADR 0006](../adr/0006-bigquery-delivery.md); ADR 0002 on the UserID in logs and URLs.

## Decisions in this plan

Each one follows a default that the ADRs, the design or an earlier stage plan implies. Number 21 is left for the controller.

1. Analytics Engine in tests. wrangler 4.157 and the plugin bind `analytics_engine_datasets`: `env.METRICS` exists in the test runtime (`MVP-2 the worker has every binding the design names` already checks it). Miniflare's `LocalAnalyticsEngineDataset.writeDataPoint` sends nowhere unless a remote dataset is configured, so a test cannot read a point back. The seam is the binding itself: every writer takes an `AnalyticsEngineDataset`, and tests pass a recorder as `METRICS` in the env override of `call()` or `worker.scheduled()`. No wrapper type beyond `writePoint()`, which catches a throwing binding so a metrics failure never fails a request.
2. Data point layout. metrics-and-operations.md step 1 names the fields; the positions are set here, and `blob1` is the kind so every query filters on one column:

   | Kind | `index1` | blobs | doubles |
   |---|---|---|---|
   | request | endpoint label | `request`, country, colo, error tag (`d1_overload` or `""`) | duration ms, HTTP status |
   | loader | `loader` | `loader`, run status | freshness ms (`-1` when the table is empty), files, rows |
   | pipeline | `pipeline` | `pipeline` | pending files, oldest pending age ms, Queue backlog count, Queue backlog bytes, oldest Queue message age ms, dead letter backlog count (`-1` for any unknown) |
   | d1_size | `d1_size` | `d1_size`, `facts` or `events` | bytes |

3. The endpoint label comes from a fixed list, never from the raw path: `GET /healthz`, `<M> /p/:prelander`, `<M> /api/events`, `<M> /api/complete`, `<M> /api/report`, `<M> /go`, `<M> /postback/v1/:partner`, `<M> /report`, `<M> /__probe`, `<M> /__test/*`, else `<M> other`. `<M>` is the method when it is one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS, else `OTHER`. A crafted path such as `/p/x?email=...` cannot reach Analytics Engine (R-12, data-model.md "Personal data"). Country and colo come from `request.cf` and are `""` when absent.
4. Duration is `Date.now()` after `await next()` minus `Date.now()` before it, so it is "receipt to response" (step 1) and excludes `waitUntil` work. In Workers the clock moves only across I/O, so the figure is the D1 and Queue wait plus anything before it; a CPU-only route reads near 0.
5. D1 overload. An error whose message matches `/overloaded/i` (D1 reports "D1 DB is overloaded. Requests queued for too long." and "... Too many requests queued.") sets the request's error tag to `d1_overload`. The message is read for the match only and never logged. `app.onError` sets it for errors that reach it; the postback route, which turns D1 errors into `503`, sets it from the error's `cause` (Task 3). `d1_overload_errors` counts tagged points over an hour through the SQL API (metrics-and-operations.md: "counted by the Worker").
6. `GET /__probe` (design step 4): no identity middleware, `readFacts()` for the fixed UserID `00000000-0000-4000-8000-000000000000`, then `select(..., "entry")`, then `200 {"ok":true,"d1_ms":<n>}` with `cache-control: no-store`. A D1 failure goes to `onError` and answers `500`, which is what an external probe must see. "Writes nothing" means no D1 write, no event, no R2 object and no cookie; the probe still gets its own request point (`GET /__probe`), which is how its server-side time is read, and the selection p95 query does not include it.
7. The alert cron is `*/5 * * * *` (`ALERT_CRON`) beside the loader's `* * * * *`. `scheduled` already dispatches on `controller.cron` (stage 5 decision 1), so the alert run is a second branch with its own `try`/`catch` that logs `{"msg":"alert_run","status":"error","name":<class>}` and rethrows. At minutes divisible by 5 both crons fire as two invocations.
8. Thresholds live in `wrangler.jsonc` as one object var, `ALERT_THRESHOLDS`, keyed by alert: `freshness_lag_ms` 900000, `pending_oldest_file_ms` 3600000, `postbacks_min_requests` 5, `postbacks_window_ms` 900000, `d1_facts_size_bytes` 7000000000, `d1_events_size_bytes` 7000000000 (Paid; the comment gives 350000000 for Free), `selection_p95_ms` 300, `worker_5xx_rate` 0.01, `d1_overload_errors_per_hour` 10. The values are the nfr.md rows; a unit test pins them. `parseThresholds()` validates with Zod; an invalid object logs `{"msg":"alert_config_error"}` and the run evaluates nothing. The "any" alerts have no threshold to configure: they fire on a value above 0.
9. Output is one log line per firing alert per run, `{"msg":"alert","id":<id>,"value":<n>,"threshold":<n>}` plus `endpoint` or `partner_id` where the alert has one. No once-an-hour throttle and no email or webhook: the stage table says "writes a log line", and the sender is design-only. A level alert such as `freshness_lag` repeats every 5 minutes while it holds. Task 2 rewrites the delivery paragraph of metrics-and-operations.md "Alerts" to say this.
10. Alert state is one R2 object, `control/alert-state.json`, `{ checked_at, sizes_checked_at }` (the design's "small R2 object"). "New" means after `checked_at` and at or before `now`; with no state the run looks back 5 minutes. The sizes are read when 24 hours have passed since `sizes_checked_at`, so the first run after a deploy reads them. The run writes the state last, so a run that throws looks at the same window again next time.
11. `freshness_lag` fires when the newest events row is older than 15 minutes and something is waiting: at least one `pending/` file, or a Queue backlog above 0 (an unreadable backlog counts as waiting). The design's literal rule, the newest row's age alone, fires every 5 minutes all night on the idle demo. Task 2 changes the signal cell of the `freshness_lag` row to say this. An empty events table gives no `freshness_lag`; `pending_oldest_file` still covers files that wait.
12. `rejected_new_file` fires on any new object in `rejected/` (the default), not on a rise over the previous run's count, because a steady failure would hide behind a steady rate. Next to it, in the code comment and in the alerts table: two overlapping loader runs can write rows that D1 already holds to `rejected/` (stage 5 notes), so the action is to check the file's event ids against D1 before moving it back to `pending/`.
13. `dlq_not_empty` can be read by the Worker. `Queue.metrics()` on a producer binding returns `backlogCount`, `backlogBytes` and `oldestMessageTimestamp` (the types of wrangler 4.157 have it, and miniflare's queue broker answers it). `wrangler.jsonc` gains a producer binding `EVENTS_DLQ` to `events-dlq`, with a comment that nothing sends to it; no consumer reads `events-dlq`, as before. This replaces the GraphQL Analytics API of the design and needs no token. If the deployed run logs `alert_source_unavailable` with source `dlq`, the alert moves to the design-only list in the follow-up PR (Verify step 3). The `events` backlog is read the same way for decision 11 and the pipeline point.
14. D1 sizes come from `meta.size_after` of `SELECT 1` on each database (the figure `wrangler d1 info` prints), written as two `d1_size` points and compared with the thresholds (metrics-and-operations.md "MVP storage limits").
15. `postbacks_without_conversions`. Migration `migrations/facts/0003_postback_counts.sql` (facts migrations are numbered `0001_init`, `0002_report_indexes`) creates `postback_counts (minute, partner_id, requests, accepted)`, one row per UTC minute and partner. The postback route adds one request per postback whose partner was found in `partners`, in `waitUntil`, logging `{"msg":"postback_count_failed","name"}` on failure. `accepted` counts the `accepted` and `duplicate` outcomes; `401`, `400` and `quarantined` count as requests only, so a wrong secret and a broken click lookup both show. An unknown partner is not counted, so random traffic cannot fill the table or fire the alert. The alert fires per partner with at least 5 requests and 0 accepted over the last 15 minutes; the alert run deletes rows older than 24 hours.
16. The SQL API alerts. `AE_SQL_TOKEN` and `CF_ACCOUNT_ID` are Worker secrets (no account id in a committed file). When either is missing the run logs one line, `{"msg":"alert_source_unavailable","source":"analytics_engine_sql","reason":"no_token","alerts":["selection_p95","worker_5xx_rate","d1_overload_errors"]}`, and evaluates every other alert. An HTTP error logs the same line with `status` instead of `reason`. The token never reaches a log line or an error message. Queries weight by `_sample_interval`: selection p95 per endpoint over 15 minutes, the share of `5xx` over 5 minutes (no line when there were no requests), tagged overloads over an hour. Three queries every 5 minutes is 864 a day, inside the 10,000 a day of the Free plan; Task 4 adds the row to nfr.md.
17. ADR 0005 "Watch": the alert run writes one pipeline point per run (pending files, oldest pending age, Queue backlog count and bytes, oldest Queue message age, dead letter backlog). The count of events written straight to R2 is read from the `event_written_to_r2` lines in Workers Logs; no data point, because the loader removes those files within a minute and the alert run would miss most of them.
18. The email scan on Cloudflare. wrangler 4.157 has no `r2 object list` (checked), so `GET /__test/files?since=<ms>` behind `TEST_ROUTES` lists the keys under `pending/`, `loaded/` and `rejected/` uploaded since then, keys only, and the script fetches each with `wrangler r2 object get --remote --pipe`. Queue messages on Cloudflare are scanned as those files: the consumer writes every message body as it came (stage 5 decision 3). A message still in the Queue or in `events-dlq` cannot be read (the main queue has a push consumer, the dead letter queue has none), so the scan relies on `dlq_not_empty` for those. A remote scan that finds no R2 file exits 2, because a scan over nothing proves nothing.
19. DEMO-8. The card names three automated cases that do not exist yet: `DEMO-8 R-12 email absent from captured logs`, `... from every request URL and Location header`, `... from Queue messages, R2 files and the events table`. Task 5 writes them as integration tests over one visit, with ADR 0002's check that the UserID is absent from logs and URLs. The card's manual steps say "staging", which was dropped on 2026-11-04; they become `BASE`.
20. The measurements of the Verify section run against the deployed Worker after the merge, so they go into a follow-up PR `docs: stage 6 measurements`, merged like a stage PR (stage 5 decision 18).
21. The stage 3 notes defer "catalog_config_error logging at /go and entry" to stage 6. The stage 6 text does not list it, so this plan leaves it out, and stage 7 lists it among the known limitations in the README.

## Global Constraints

- Everything committed is in English, except `docs/requirements/open-questions.md`. No secrets, tokens, account ids or real emails in a committed file. Tests use `@example.com` addresses only.
- The email never reaches an event, a Queue message, an R2 file, a data point, a URL, a log line or an error response. A log line is one JSON object with ids, counts, numbers and error class names; it never prints a row, a body, an error message or a token.
- Every Queue send goes through `sendEvent()` or `emitInBackground()`. Raw SQL in `src/db/` only, and that includes the Analytics Engine SQL. Times are Unix milliseconds in UTC.
- Each new file under `src/` opens with a comment of two or three lines naming the component, the ADR or design section and the requirement ids.
- Test names start with the requirement id, then any R-/Q- id. Filter with `pnpm test -t "X"`, never `pnpm test -- -t "X"`. A test never asserts a global row count or an empty bucket: it reads its own partner, its own keys or a time window it controls.
- No test, script or card follows a redirect.
- Shell scripts run on the bash 3.2 of macOS and on CI's bash 5.
- No new dependency.
- Nothing in a task needs the deployed Worker, `.dev.vars.remote` or a Cloudflare token. Those steps are in the Verify section, which the controller runs after the merge.
- Work happens in the worktree `.claude/worktrees/part2-stage-6` on branch `part2-stage-6`, made from `main` after the stage 5 PR merges. Each task commits there.

## Known setup traps

From stages 0 to 5, still true: `compatibility_date` stays `2026-11-03`; test-only bindings by augmenting `Cloudflare.Env` in `tests/env.d.ts`; `wrangler types` needs `--strict-vars=false`; secrets are declared by hand in `src/secrets.d.ts`, in both the namespace and the global `Env`; `call()` waits for `waitUntil` work; integration files run one after another; `clearBucket()` runs in `beforeEach` where a file uses R2; `worker.scheduled(createScheduledController({ cron }), env, createExecutionContext())` drives a cron.

New for this stage:
- `env.METRICS.writeDataPoint` is a no-op in the test runtime. Never spy on `env.METRICS`; pass `recordingDataset().dataset` as `METRICS` in the env override.
- Before Task 2, check `typeof env.EVENTS_DLQ.metrics === "function"` and that `await env.EVENTS_DLQ.metrics()` gives a `backlogCount` in the test runtime. If not, stop and report `NEEDS_CONTEXT`.
- Hono runs `onError` at the layer where the handler threw, so the outer middleware sees `c.res.status` 500 after `await next()`. The first Task 1 test checks this; if the middleware sees 200 or nothing, stop and report `NEEDS_CONTEXT`.
- D1 returns `meta.size_after` locally too (miniflare's D1 worker computes it).
- `wrangler types --strict-vars=false --env-file /dev/null` types the object var `ALERT_THRESHOLDS` as an object of numbers, and the CI deploy's `--var GIT_SHA:... --var TEST_ROUTES:on` adds to the config vars without removing it. Run `pnpm types` and check the generated `Env` after the `wrangler.jsonc` change.
- The SQL API returns JSON `{ meta, data, rows }`; 64-bit integers can come back as strings. Read every number with `Number()`. `quantileExactWeighted(q)(column, weight)` is the weighted quantile of the Analytics Engine SQL reference; no test calls the real API.
- `wrangler tail --format json` prints each `console.log` call inside `logs[].message[]` as a string with escaped quotes. Grep for the alert id, not for `"id":"..."`.
- The local dev ticker calls only the loader cron. Run the alert cron locally with `curl -s "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"` against `pnpm dev --test-scheduled`.
- The facts migrations reach the tests through `readD1Migrations` in `vitest.config.ts`, so a new file under `migrations/facts/` needs no config change. Locally it needs `pnpm migrate:local`; CI applies it remotely before the deploy.

## Review Focus

- A data point never carries a raw path, a query, a body, a cookie or an email; the endpoint label is from the fixed list. Task 1 tests it with `?email=` in the URL.
- A throwing `METRICS` binding or a failing alert source never fails a request, and never stops the other alerts. Tasks 1 and 2 test it.
- A handler that throws is recorded with status 500, and a D1 overload is tagged without its message being logged. Tasks 1 and 3 test it.
- The probe writes nothing and sets no cookie, with or without a cookie in the request. Task 1 tests it.
- The alert state window: a run that throws before writing the state looks at the same window again; the second run after a new `rejected/` file or `quarantine` row does not fire again. Task 2 tests it.
- `freshness_lag` stays silent on an idle system and fires when files wait (decision 11). Task 2 tests both.
- The SQL token never appears in a log line or an error message. Task 4 tests it.
- A remote email scan that reads nothing fails instead of passing. Task 5 tests it.

---

### Task 1: request data points, the loader freshness point and `GET /__probe`

**Files:**
- Create: `src/ops/metrics.ts`, `src/routes/probe.ts`, `tests/fixtures/metrics.ts`, `tests/unit/metrics.test.ts`, `tests/integration/metrics.test.ts`, `tests/integration/probe.test.ts`
- Modify: `src/app.ts` (the middleware first, `errorTag` in `onError`, the probe route, `errorTag?: "d1_overload"` in `Variables`), `src/index.ts` (the loader branch writes the loader point), `docs/design/metrics-and-operations.md` ("Latency target" step 1 gets the table of decision 2 and the endpoint list of decision 3), `docs/testing/acceptance-checks.md` (NFR-6 "Automated" names the Task 1 cases)

**Interfaces:**
- Produces, `src/ops/metrics.ts` (header: metrics-and-operations.md "Latency target (NFR-6)", ADR 0006 "Freshness"; serves NFR-3, NFR-6, R-12, R-18):
  - `SELECTION_ENDPOINTS = ["GET /p/:prelander", "POST /api/complete", "GET /go"] as const`
  - `endpointOf(method: string, path: string): string`: decision 3
  - `isD1Overload(err: unknown): boolean`: decision 5
  - `requestPoint(input: { endpoint: string; durationMs: number; status: number; country: string; colo: string; errorTag: "" | "d1_overload" }): AnalyticsEngineDataPoint`
  - `loaderPoint(input: { status: string; freshnessMs: number | null; files: number; rows: number }): AnalyticsEngineDataPoint`
  - `pipelinePoint(input: { pendingFiles: number; pendingOldestAgeMs: number | null; queueBacklog: number | null; queueBacklogBytes: number | null; queueOldestAgeMs: number | null; dlqBacklog: number | null }): AnalyticsEngineDataPoint`
  - `d1SizePoint(database: "facts" | "events", bytes: number): AnalyticsEngineDataPoint`
  - `writePoint(dataset: AnalyticsEngineDataset, point: AnalyticsEngineDataPoint): void`: catches and logs `{"msg":"metrics_write_failed","name":<class>}`
  - `requestMetrics(): MiddlewareHandler<AppEnv>`: one `requestPoint` per request after `await next()`, from `c.res.status` and `c.get("errorTag") ?? ""`
  - `recordLoaderRun(env: Pick<Env, "METRICS" | "EVENTS">, run: LoaderRun, now: number): Promise<void>`: `newestEventAt()`, then one `loaderPoint`
- Produces, `src/routes/probe.ts` (header: metrics-and-operations.md "Latency target" step 4; serves NFR-6): `PROBE_USER_ID = "00000000-0000-4000-8000-000000000000"`; `probeRoute(): Hono<AppEnv>`, mounted at `/__probe` with no identity middleware (decision 6).
- Produces, `src/app.ts`: `app.use("*", requestMetrics())` before every other middleware; `onError` sets `errorTag` when `isD1Overload(err)`, then logs and answers as today.
- Produces, `src/index.ts`: after `runLoader` on the loader cron, `await recordLoaderRun(env, run, now)` with the same `now`.
- Produces, `tests/fixtures/metrics.ts`: `recordingDataset(): { dataset: AnalyticsEngineDataset; points: AnalyticsEngineDataPoint[] }`; `throwingDataset(): AnalyticsEngineDataset`; `overloadedFacts(): D1Database` (`batch` and `prepare` reject or throw `new Error("D1 DB is overloaded. Requests queued for too long.")`); `failingFacts(): D1Database` (the same with `new Error("D1_ERROR: no such table")`).

- [ ] **Step 1: Write the failing tests.**

  `tests/unit/metrics.test.ts`:
  - `NFR-6 endpoint labels are fixed patterns, never the raw path`: `GET /p/demo` gives `GET /p/:prelander`; `POST /postback/v1/partnerA` gives `POST /postback/v1/:partner`; `/go` and `/go/` give `GET /go`; `/__test/state` gives `GET /__test/*`; `/p/demo/extra` and `/wp-login.php` give `GET other`; the path `/p/x` (the middleware passes `c.req.path`, which has no query) gives `GET /p/:prelander`; method `BREW` gives `OTHER other`.
  - `NFR-6 R-18 a request point has the endpoint as index, duration and status as doubles, country and colo as blobs`: `requestPoint({ endpoint: "GET /go", durationMs: 42, status: 302, country: "DE", colo: "FRA", errorTag: "" })` equals `{ indexes: ["GET /go"], blobs: ["request", "DE", "FRA", ""], doubles: [42, 302] }`.
  - `NFR-3 the loader point carries freshness, files and rows`: freshness `null` gives `-1` as `doubles[0]`.
  - `MVP-5 a size point names the database and its bytes`, and `NFR-5 the pipeline point writes -1 for an unknown reading`.
  - `NFR-6 D1 overload errors are recognised by their message`: both D1 overload messages give `true`; `D1_ERROR: no such table`, a string and `undefined` give `false`.

  `tests/integration/metrics.test.ts` (each request through `call()` with `{ METRICS: rec.dataset }`):
  - `NFR-6 every request writes one data point`: `/healthz`, `/p/demo`, a `POST /api/events` with a valid step event, `/api/report`, `/__probe`, `/nope`: one point per request, `indexes[0]` the label, `doubles[1]` the status, `doubles[0]` a number at least 0.
  - `NFR-6 a handler that throws is recorded with status 500`: `/go?prelander=demo` with a new cookie and `FACTS: failingFacts()`: `500`, the point has `doubles[1]` 500 and `blobs[3]` `""`.
  - `NFR-6 a D1 overload that reaches the error handler is tagged on its point`: the same with `overloadedFacts()`: `blobs[3]` `d1_overload`; the `unhandled` log line has no `overloaded` in it.
  - `NFR-6 a broken Analytics Engine binding never fails the request`: `METRICS: throwingDataset()`: `/healthz` answers `200`; the log has `metrics_write_failed`.
  - `R-12 a data point never carries the request path, query or body`: `/p/demo?email=user1%40example.com` and a `POST /api/complete` for `user1@example.com`: `JSON.stringify(rec.points)` contains neither `user1@example.com`, `user1%40example.com` nor `demo`.
  - `NFR-3 each loader run writes one freshness point`: `worker.scheduled` with `LOADER_CRON` and `{ ...env, METRICS: rec.dataset }`: one point with `indexes[0]` `loader`, `blobs[1]` `done`, `doubles[0]` a number; after `pauseLoader()` the run's point has `blobs[1]` `paused` (`resumeLoader()` in `finally`).

  `tests/integration/probe.test.ts`:
  - `NFR-6 probe answers 200 with the D1 time`: `200`, `cache-control` `no-store`, body `{ ok: true, d1_ms: <number at least 0> }`.
  - `NFR-6 probe writes nothing and sets no cookie`: with `captureQueue()` and a recorder, once without a cookie and once with `newCookie()`: no `set-cookie` header, `sent` is empty, `users` has no row for `PROBE_USER_ID` or the cookie's id, `filesWith("pending/", PROBE_USER_ID)` is empty, and the recorder holds exactly one point per call, `GET /__probe`.
  - `NFR-6 probe answers 500 when D1 fails`: `FACTS: failingFacts()` gives `500 {"error":"internal"}`.
- [ ] **Step 2: Run `pnpm test -t "NFR-6|NFR-3 the loader point|NFR-3 each loader|MVP-5 a size|NFR-5 the pipeline|R-12 a data point"`.** Expected: the new tests FAIL, `src/ops/metrics.ts` and `src/routes/probe.ts` cannot be resolved.
- [ ] **Step 3: Write the two modules, the `app.ts` and `index.ts` changes, the fixture and the two doc edits.**
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm lint:docs`.** Expected: all pass, exit 0.
- [ ] **Step 5: Commit** `feat: a data point per request and loader run, GET /__probe`.

### Task 2: the alert cron with the direct checks

**Files:**
- Create: `src/ops/alerts.ts`, `src/db/ops.ts`, `tests/unit/alerts.test.ts`, `tests/integration/alerts.test.ts`, `tests/fixtures/alerts.ts`
- Modify: `src/index.ts` (the alert branch), `src/events/files.ts` (`ALERT_STATE_KEY`), `wrangler.jsonc` (`"crons": ["* * * * *", "*/5 * * * *"]` with the comment naming the alert evaluator; `ALERT_THRESHOLDS` in `vars` with the decision 8 values and a comment pointing at nfr.md; the `EVENTS_DLQ` producer with the decision 13 comment), `scripts/lib/wrangler-config.ts` (`WranglerConfig` types `vars`, `queues.producers` and `analytics_engine_datasets`), `tests/unit/wrangler-config.test.ts`, `tests/integration/schema.test.ts` (`EVENTS_DLQ` joins the binding list), `docs/design/metrics-and-operations.md` (the "Alerts" delivery paragraph per decisions 9, 10, 13 and 14; the signal cells of `freshness_lag` and `dlq_not_empty`; the R3 note in the `rejected_new_file` action cell), `docs/design/data-model.md` ("R2 layout" gets `control/alert-state.json`, written by the alert run)

**Interfaces:**
- Consumes: `readHealth`, `PipelineHealth` (`src/events/health.ts`); `listKeys`, `REJECTED_PREFIX` (`src/events/files.ts`); `pipelinePoint`, `d1SizePoint`, `writePoint` (Task 1).
- Produces, `src/db/ops.ts` (header: metrics-and-operations.md "Alerts"; serves PB-4, Q-11, MVP-5): `countQuarantineBetween(db: D1Database, after: number, upTo: number): Promise<number>` (`received_at > after AND received_at <= upTo`); `databaseSize(db: D1Database): Promise<number>` (`meta.size_after` of `SELECT 1`).
- Produces, `src/events/files.ts`: `ALERT_STATE_KEY = "control/alert-state.json"`.
- Produces, `src/ops/alerts.ts` (header: metrics-and-operations.md "Alerts", ADR 0005 and ADR 0006 "Watch"; serves NFR-3, NFR-5, NFR-6, MVP-5, PB-4, Q-11):
  - `ALERT_CRON = "*/5 * * * *"`
  - `type AlertId = "freshness_lag" | "pending_oldest_file" | "rejected_new_file" | "quarantine_new_row" | "dlq_not_empty" | "postbacks_without_conversions" | "d1_facts_size" | "d1_events_size" | "selection_p95" | "worker_5xx_rate" | "d1_overload_errors"`
  - `type AlertThresholds` with the nine keys of decision 8; `parseThresholds(raw: unknown): AlertThresholds | null`
  - `type AlertState = { checked_at: number; sizes_checked_at: number }`; `SIZE_CHECK_EVERY_MS = 86_400_000`; `LOOK_BACK_MS = 300_000`
  - `type AlertReadings = { health: PipelineHealth | null; queueBacklog: number | null; dlqBacklog: number | null; rejectedNew: number | null; quarantineNew: number | null; sizes: { facts: number; events: number } | null }`; `null` means unknown or not due, and an unknown reading never fires. Tasks 3 and 4 add fields.
  - `type AlertFiring = { id: AlertId; value: number; threshold: number; endpoint?: string; partner_id?: string }`
  - `evaluateAlerts(readings: AlertReadings, t: AlertThresholds): AlertFiring[]`: pure; the rules of decisions 11 to 14.
  - `type AlertEnv = Pick<Env, "EVENTS_BUCKET" | "EVENTS" | "FACTS" | "EVENTS_QUEUE" | "EVENTS_DLQ" | "METRICS" | "ALERT_THRESHOLDS">`
  - `runAlerts(env: AlertEnv, now: number): Promise<{ firing: AlertFiring[]; unavailable: string[] }>`: thresholds; state; every source read in parallel, each failure logged once as `{"msg":"alert_source_unavailable","source":<name>,"alerts":[<ids>],"name":<class>}` with sources `pipeline_health`, `rejected`, `quarantine`, `events_queue`, `dlq`, `d1_size`; evaluate; one `alert` line per firing (decision 9); the pipeline point, and the size points when read; the state put last; then `{"msg":"alert_run","firing":<n>,"unavailable":[<sources>]}`.
- Produces, `src/index.ts`: `controller.cron === ALERT_CRON` awaits `runAlerts(env, Date.now())` inside the decision 7 `try`/`catch`.
- Produces, `tests/fixtures/alerts.ts`: `alertLines(spy): Record<string, unknown>[]` (the parsed lines with `msg` `alert`); `logLines(spy, msg: string)`; `queueWithBacklog(count: number): Queue` and `queueWithoutMetrics(): Queue` (`metrics` rejects); `putAlertState(state: AlertState)`; `testThresholds(overrides?: Partial<AlertThresholds>): AlertThresholds` (decision 8 values).

- [ ] **Step 1: Write the failing tests.**

  `tests/unit/wrangler-config.test.ts`:
  - `NFR-6 the alert cron runs every 5 minutes beside the loader`: `ALERT_CRON` is `*/5 * * * *`; `triggers.crons` equals `["* * * * *", "*/5 * * * *"]`.
  - `NFR-6 alert thresholds in wrangler.jsonc match nfr.md`: `vars.ALERT_THRESHOLDS` equals the decision 8 object, and `parseThresholds` accepts it.
  - `NFR-5 the dead letter queue is bound for its backlog only`: a producer `EVENTS_DLQ` on `events-dlq`; still no consumer of `events-dlq`.

  `tests/unit/alerts.test.ts`, one case per threshold, each with a reading just above and one at the threshold:
  - `NFR-3 freshness_lag fires above 15 minutes when files or messages wait`: `freshness_ms` 900001 with `pending_files` 1 fires with value 900001 and threshold 900000; 900000 does not; 900001 with `pending_files` 0 and `queueBacklog` 0 does not; with `queueBacklog` `null` it fires.
  - `NFR-5 pending_oldest_file fires above one hour`: 3600001 fires, 3600000 does not.
  - `NFR-5 rejected_new_file fires on any new file`: 1 fires with threshold 0; 0 does not.
  - `PB-4 Q-11 quarantine_new_row fires on any new row`, `NFR-5 dlq_not_empty fires on any message`: the same shape.
  - `MVP-5 d1_facts_size and d1_events_size fire above 7 GB`: 7000000001 fires for each; 7000000000 does not; `sizes` `null` gives neither.
  - `NFR-6 parseThresholds rejects a missing, negative or non-number value`: each gives `null`.

  `tests/integration/alerts.test.ts` (`clearBucket()` in `beforeEach`, `console.log` spied; the run gets `{ ...env, METRICS: rec.dataset, EVENTS_QUEUE: queueWithBacklog(0), EVENTS_DLQ: queueWithBacklog(0) }` unless the case says otherwise):
  - `NFR-6 the dead letter queue binding answers metrics in the test runtime`: `(await env.EVENTS_DLQ.metrics()).backlogCount` is a number.
  - `NFR-3 freshness_lag fires when the newest event is old and files wait`: one stored event at `Date.now()` loaded with `loadNow()`, then `putPending` of one row; `runAlerts` at `Date.now() + 16 * 60_000`: a `freshness_lag` line with `value` above 900000.
  - `NFR-3 freshness_lag stays silent when nothing waits`: no pending file, backlog 0, the same `now`: no `freshness_lag` line.
  - `NFR-5 pending_oldest_file fires when the oldest pending file is older than an hour`: `putPending`, then `runAlerts` at `Date.now() + 61 * 60_000`: the line, `value` at least 3660000.
  - `NFR-5 rejected_new_file fires once for a file written since the last run`: `putAlertState({ checked_at: Date.now() - 1000, sizes_checked_at: Date.now() })`, put `rejected/t-<uuid>.ndjson`, run at `Date.now() + 1000`: the line with `value` 1; a second run at `Date.now() + 2000`: no line.
  - `PB-4 Q-11 quarantine_new_row fires once for a signed postback with an unknown click`: state as above; a signed Lead for `click_id` `unknown-<uuid>` from partnerA whose body carries `partner_user_id` `user1@example.com`: `202 {"status":"quarantined"}`; the run fires with `value` at least 1; a second run does not; no logged line contains `user1@example.com`.
  - `NFR-5 dlq_not_empty fires on messages in the dead letter queue`: `EVENTS_DLQ: queueWithBacklog(2)`: the line with `value` 2 and `threshold` 0.
  - `NFR-5 a failing source logs alert_source_unavailable and the other alerts still run`: `EVENTS_DLQ: queueWithoutMetrics()` and an old pending file (`now` + 61 minutes): one `alert_source_unavailable` line with `source` `dlq` and `alerts` `["dlq_not_empty"]`; the `pending_oldest_file` line is there; `alert_run` lists `["dlq"]`.
  - `MVP-5 the D1 sizes are read once a day and written as data points`: with no state, two `d1_size` points (`facts`, `events`) with bytes above 0; a run 1 hour later has none; a run 25 hours after the first has two again.
  - `MVP-5 d1_events_size fires above its threshold`: `ALERT_THRESHOLDS: testThresholds({ d1_events_size_bytes: 1 })`: the line with `value` the bytes.
  - `NFR-5 the alert run writes one pipeline point`: one point with `indexes[0]` `pipeline` and six doubles.
  - `NFR-6 an invalid threshold object stops the run with alert_config_error`: `ALERT_THRESHOLDS: { freshness_lag_ms: "soon" }`: the line, and no `alert` line.
  - `NFR-6 the alert cron runs the evaluator`: `worker.scheduled` with `ALERT_CRON` logs `alert_run`; `NFR-3 the scheduled handler ignores an unknown cron` still passes.
- [ ] **Step 2: Run `pnpm test -t "NFR-3|NFR-5|NFR-6|MVP-5|PB-4"`.** Expected: the new tests FAIL (`src/ops/alerts.ts` cannot be resolved; `triggers.crons` has one entry; no `EVENTS_DLQ`).
- [ ] **Step 3: Write `src/db/ops.ts`, `src/ops/alerts.ts`, the `index.ts` branch, the config changes, `pnpm types`, the fixture and the two doc edits.**
- [ ] **Step 4: Run the alert cron locally.** `pnpm migrate:local && pnpm seed --local`, then `pnpm dev --test-scheduled` in one terminal and `curl -s "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"` in another. Expected: the dev log shows one `alert_run` line whose `unavailable` list is empty (Task 4 adds `analytics_engine_sql` to it later), and `pnpm exec wrangler r2 object get funnels-events/control/alert-state.json --local --pipe` prints `checked_at` and `sizes_checked_at`.
- [ ] **Step 5: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm lint:docs`.** Expected: all pass, exit 0.
- [ ] **Step 6: Commit** `feat: alert cron every 5 minutes with the direct checks`.

### Task 3: the postback counter and `postbacks_without_conversions`

**Files:**
- Create: `migrations/facts/0003_postback_counts.sql`, `src/db/postback-counts.ts`, `tests/integration/postback-counts.test.ts`
- Modify: `src/routes/postback.ts` (the counter in `waitUntil`; `Unavailable` keeps the D1 error as `cause`, and the route sets `errorTag` when `isD1Overload(err.cause)`), `src/ops/alerts.ts` (the `postbacks` reading, its rule, the 24-hour delete), `tests/fixtures/postback.ts` (`deleteTestPartner` also deletes the partner's `postback_counts` rows), `tests/unit/alerts.test.ts`, `docs/design/data-model.md` (a `postback_counts` section under "Tables in the D1 facts database", and the postback row of "Requests and what they touch"), `docs/design/metrics-and-operations.md` (a `postbacks_without_conversions` row in the alerts table), `docs/requirements/nfr.md` (a "Set in stage 4" row: at least 5 postback requests in 15 minutes from one partner and none accepted; source "Part 2 stage 6, part2-mvp-stages.md")

**Interfaces:**
- Produces, `migrations/facts/0003_postback_counts.sql`: `CREATE TABLE postback_counts (minute INTEGER NOT NULL, partner_id TEXT NOT NULL, requests INTEGER NOT NULL, accepted INTEGER NOT NULL, PRIMARY KEY (minute, partner_id)) WITHOUT ROWID;` with a comment naming the alert and decision 15.
- Produces, `src/db/postback-counts.ts` (header: metrics-and-operations.md "Alerts"; serves PB-3, PB-4, Q-11):
  - `recordPostback(db: D1Database, input: { at: number; partnerId: string; accepted: boolean }): Promise<void>`: upsert on `(at - at % 60000, partnerId)` adding 1 request and 1 or 0 accepted
  - `postbackCountsSince(db: D1Database, since: number): Promise<{ partner_id: string; requests: number; accepted: number }[]>`: sums per partner for `minute >= since - since % 60000`
  - `deletePostbackCountsBefore(db: D1Database, before: number): Promise<void>`
- Produces, `src/ops/alerts.ts`: `AlertReadings.postbacks: { partner_id: string; requests: number; accepted: number }[] | null`, read with `postbackCountsSince(FACTS, now - t.postbacks_window_ms)` (source `postback_counts`); one `postbacks_without_conversions` firing per partner with `requests >= t.postbacks_min_requests` and `accepted === 0`, `value` the requests, `threshold` the minimum, `partner_id` set; `deletePostbackCountsBefore(FACTS, now - 86_400_000)` after the evaluation.

- [ ] **Step 1: Write the failing tests.**

  `tests/unit/alerts.test.ts`:
  - `PB-3 postbacks_without_conversions fires at 5 requests with none accepted`: `{ requests: 5, accepted: 0 }` fires with `partner_id`; `{ requests: 4, accepted: 0 }` and `{ requests: 9, accepted: 1 }` do not.

  `tests/integration/postback-counts.test.ts` (each case makes its own partner with `insertTestPartner({ id: "pbc-<uuid>", active: true, current: <secret> })` and removes it in `finally`):
  - `PB-3 a postback with a wrong secret counts a request and no acceptance`: one Lead signed with another secret: `401`; `postbackCountsSince(env.FACTS, Date.now() - 60_000)` has the partner with `requests` 1, `accepted` 0.
  - `PB-1 an accepted Lead and its duplicate count as accepted`: partnerA through `userWithClick()`, the same Lead twice: the partnerA sums over the last 15 minutes rise by 2 requests and 2 accepted.
  - `PB-3 an unknown partner is not counted`: `/postback/v1/nobody-<uuid>`: no row for that id.
  - `PB-3 Q-11 postbacks_without_conversions fires after five rejected postbacks of one partner`: five wrong-secret Leads, then `runAlerts(env, Date.now())` with the Task 2 overrides: one `alert` line with `id` `postbacks_without_conversions`, the partner's id, `value` 5, `threshold` 5. A second partner with four gets no line.
  - `PB-4 Q-11 five quarantined postbacks of one partner fire it too`: five Leads signed with the partner's secret for unknown clicks: the line.
  - `PB-3 counts older than a day are deleted by the alert run`: `recordPostback` at `Date.now() - 25 * 3_600_000`; after `runAlerts`, `postbackCountsSince(env.FACTS, Date.now() - 26 * 3_600_000)` has no row for the partner.
  - `NFR-6 a D1 overload in a postback is tagged on its data point`: `FACTS: overloadedFacts()` and a recorder: `503` with `retry-after` 30; the point has `blobs[3]` `d1_overload`; the `postback` log line has `reason` `d1_unavailable` and no `overloaded`.
  - `R-12 postback logs carry no body, signature or transaction id` keeps passing with the counter in place.
- [ ] **Step 2: Run `pnpm test -t "PB-1 an accepted Lead and its|PB-3|PB-4 Q-11 five|NFR-6 a D1 overload in a postback"`.** Expected: the new tests FAIL, `src/db/postback-counts.ts` cannot be resolved.
- [ ] **Step 3: Write the migration, the module, the route and alert changes, the fixture change and the three doc edits.**
- [ ] **Step 4: Apply the migration locally.** `pnpm migrate:local`. Expected: `0003_postback_counts.sql` is applied to `facts`, and `pnpm exec wrangler d1 execute facts --local --command "SELECT COUNT(*) AS n FROM postback_counts"` prints `n` 0.
- [ ] **Step 5: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm lint:docs`.** Expected: all pass, exit 0.
- [ ] **Step 6: Commit** `feat: postback counts per partner and postbacks_without_conversions`.

### Task 4: the Analytics Engine SQL alerts

**Files:**
- Create: `src/db/analytics-engine.ts`, `tests/unit/analytics-sql.test.ts`
- Modify: `src/ops/alerts.ts` (the `sql` reading and its three rules, the `deps` parameter), `src/secrets.d.ts` (`AE_SQL_TOKEN?: string`, `CF_ACCOUNT_ID?: string`, in both declarations), `.dev.vars.example` (commented `AE_SQL_TOKEN=` and `CF_ACCOUNT_ID=` lines saying the SQL alerts log `alert_source_unavailable` without them), `tests/unit/alerts.test.ts`, `tests/unit/wrangler-config.test.ts`, `tests/integration/alerts.test.ts`, `docs/design/metrics-and-operations.md` (the delivery paragraph names the token and decision 16), `docs/requirements/nfr.md` (a row: the alert SQL queries, 864 a day, against the Analytics Engine read limits)

**Interfaces:**
- Produces, `src/db/analytics-engine.ts` (header: metrics-and-operations.md "Latency target" step 2 and "Alerts"; serves NFR-6):
  - `METRICS_DATASET = "funnels_metrics"`
  - `type AnalyticsSql = (sql: string) => Promise<Record<string, unknown>[]>`
  - `class AnalyticsSqlError extends Error` with `readonly status: number`; its message names the status only
  - `analyticsSql(creds: { accountId: string; token: string }, fetcher?: typeof fetch): AnalyticsSql`: `POST https://api.cloudflare.com/client/v4/accounts/<accountId>/analytics_engine/sql`, `Authorization: Bearer <token>`, the SQL as the body; a non-2xx answer throws `AnalyticsSqlError`; returns `data`
  - `SELECTION_P95_SQL`: `index1 AS endpoint`, `quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms`, `SUM(_sample_interval) AS requests`, `blob1 = 'request'`, `index1 IN (<SELECTION_ENDPOINTS>)`, `timestamp > NOW() - INTERVAL '15' MINUTE`, `GROUP BY endpoint`, `FORMAT JSON`
  - `WORKER_5XX_SQL`: `SUM(IF(double2 >= 500, _sample_interval, 0)) AS errors`, `SUM(_sample_interval) AS requests`, `blob1 = 'request'`, `INTERVAL '5' MINUTE`
  - `D1_OVERLOAD_SQL`: `SUM(_sample_interval) AS errors`, `blob1 = 'request' AND blob4 = 'd1_overload'`, `INTERVAL '1' HOUR`
  - `type SqlSignals = { selectionP95: { endpoint: string; p95_ms: number; requests: number }[]; worker5xx: { errors: number; requests: number }; d1Overload: number }`; `readSqlSignals(sql: AnalyticsSql): Promise<SqlSignals>`: the three queries, every number through `Number()`
- Produces, `src/ops/alerts.ts`: `AlertReadings.sql: SqlSignals | null`; `selection_p95` per endpoint above `selection_p95_ms` with `endpoint` set; `worker_5xx_rate` when `requests > 0` and `errors / requests > worker_5xx_rate`; `d1_overload_errors` above `d1_overload_errors_per_hour`. `AlertEnv` adds `AE_SQL_TOKEN?` and `CF_ACCOUNT_ID?`. `runAlerts(env, now, deps?: { sql?: AnalyticsSql | null })`: `deps.sql` replaces the client in tests; without it the client is built from the two secrets, or is `null` when either is missing or empty (decision 16).

- [ ] **Step 1: Write the failing tests.**

  `tests/unit/analytics-sql.test.ts` (a fake `fetch` records its request):
  - `NFR-6 the SQL client posts to the account's Analytics Engine endpoint with the token`: the URL with account `acc-test`, method `POST`, `authorization` `Bearer tok-test`, the body is the SQL given; `{ data: [{ n: 1 }] }` gives `[{ n: 1 }]`.
  - `NFR-6 R-12 a failed SQL call throws the status and never the token`: a `403` gives `AnalyticsSqlError` with `status` 403; `String(err)` and `err.message` do not contain `tok-test`.
  - `NFR-6 the latency queries weight by _sample_interval over their windows`: the three SQL constants contain the fragments listed above, read from `METRICS_DATASET`, and `SELECTION_P95_SQL` names exactly the three `SELECTION_ENDPOINTS`.
  - `NFR-6 numbers that come back as strings are read as numbers`: a fake `AnalyticsSql` answering `"312.5"` and `"40"` gives `p95_ms` 312.5 and `requests` 40.

  `tests/unit/wrangler-config.test.ts`: `NFR-6 the SQL queries read the dataset the Worker binds`: `METRICS_DATASET` equals the `dataset` of binding `METRICS`.

  `tests/unit/alerts.test.ts`:
  - `NFR-6 selection_p95 fires per endpoint above 300 ms`: `GET /go` at 300.1 fires with `endpoint` `GET /go`; 300 does not.
  - `NFR-6 worker_5xx_rate fires above 1% of requests`: 2 of 100 fires with `value` 0.02; 1 of 100 does not; 0 of 0 does not.
  - `NFR-6 d1_overload_errors fires above 10 in an hour`: 11 fires, 10 does not.

  `tests/integration/alerts.test.ts`:
  - `NFR-6 without the token the SQL alerts log one alert_source_unavailable line`: `runAlerts` with the test env (no secrets): exactly one line with `source` `analytics_engine_sql`, `reason` `no_token` and the three ids; `alert_run` lists it; the direct alerts still evaluate.
  - `NFR-6 a failing SQL API logs alert_source_unavailable with the status`: `deps.sql` throws `AnalyticsSqlError(500)`: the line has `status` 500 and no `reason`.
  - `NFR-6 SQL readings above the thresholds fire their alerts`: `deps.sql` answers each constant with rows for `GET /go` at 450 ms, 3 errors of 100 requests and 12 overloads: the three `alert` lines with those values.
  - `R-12 the SQL token never appears in a log line`: with `AE_SQL_TOKEN` `tok-secret-test`, `CF_ACCOUNT_ID` `acc-test` and a `fetch` stub (`vi.stubGlobal`) answering `401`: no logged line contains `tok-secret-test`.
- [ ] **Step 2: Run `pnpm test -t "NFR-6"`.** Expected: the new tests FAIL, `src/db/analytics-engine.ts` cannot be resolved.
- [ ] **Step 3: Write the module, the alert changes, the secret declarations, `.dev.vars.example` and the two doc edits.**
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm lint:docs`.** Expected: all pass, exit 0.
- [ ] **Step 5: Commit** `feat: latency, 5xx and D1 overload alerts through the Analytics Engine SQL API`.

### Task 5: email absent everywhere, the remote email scan and the cards

**Files:**
- Create: `tests/integration/email-absent.test.ts`, `tests/unit/email-scan.test.ts`
- Modify: `scripts/email-scan.sh`, `src/routes/test.ts` (`GET /files`; the header lists it), `tests/integration/test-routes.test.ts` (`/__test/files` joins the 404 tests), `docs/testing/acceptance-checks.md` (DEMO-8: the automated line names the Task 5 cases and `pnpm test:email-scan` with its three modes, the manual steps run against `BASE` with `pnpm test:email-scan --remote`; R-12: manual step 3 uses the remote scan; NFR-3 and NFR-6: the alert and probe cases of Tasks 1 to 4; the conventions name `/__test/files`), `docs/design/data-model.md` ("Personal data": the scan's address is `user1@example.com`, and it covers data points and the remote files)

**Interfaces:**
- Produces, `GET /__test/files?since=<ms>`: `200 { keys: string[]; truncated: boolean }` with `cache-control: no-store`; keys under `pending/`, `loaded/`, `rejected/` whose `uploaded` is at least `since`, in key order, at most 1,000 in total (decision 18); `400 {"error":"invalid_query"}` unless `since` is a non-negative integer; `404` unless `TEST_ROUTES` is `on`.
- Produces, `scripts/email-scan.sh` (header names DEMO-8, R-12, ADR 0002 and the three modes; exit 0 clean, 1 found, 2 usage or nothing to scan):
  - `bash scripts/email-scan.sh <wrangler-log>`: as today.
  - `bash scripts/email-scan.sh --dir <dir>`: every file under `<dir>`; prints `email-scan: clean (<n> files)` or `email-scan: FOUND the address` and the file paths.
  - `bash scripts/email-scan.sh --remote <tail-log> --since <ms>`: needs `BASE` starting with `https://`; copies the tail log into a new `mktemp -d` work directory; reads the keys from `$BASE/__test/files?since=<ms>` (exit 2 on `truncated` true or no keys); fetches each with `pnpm -s exec wrangler r2 object get "$BUCKET/<key>" --remote --pipe`; dumps `SELECT * FROM events WHERE received_at >= <ms>` with `pnpm -s exec wrangler d1 execute events --remote --json`; scans the directory as `--dir` does; prints `email-scan: clean (tail <n> lines, <k> R2 files, <r> events rows)`.
  - `BUCKET="funnels-events"` on a line of its own.

- [ ] **Step 1: Write the failing tests.**

  `tests/integration/email-absent.test.ts`: one visit in `beforeAll` with `console.log`, `console.warn` and `console.error` spied, one `captureQueue()`, one recorder, and every request URL and response kept: `/p/demo` (new cookie from the response), `step_viewed` 1, `step_answered` gender and ethnicity, `step_viewed` 2 and 3, the completion for `user1@example.com`, `/go?prelander=demo&visit=<v>`, the signed partnerA Lead for the click from `Location`, plus a completion with invalid JSON around `user1@example.com` and one `/api/events` event with an `email` payload key holding it; then `deliver()` of every captured body.
  - `DEMO-8 R-12 email absent from captured logs`: no logged argument contains `user1@example.com` or `user1%40example.com`.
  - `DEMO-8 R-12 email absent from every request URL and Location header`: no URL and no `location` header contains either form.
  - `DEMO-8 R-12 email absent from Queue messages, R2 files and the events table`: no captured body, no file in `filesWith("loaded/", <user id>)` (at least one file), no row of `eventsOf(<user id>)` and no recorded data point contains either form.
  - `DEMO-8 R-12 ADR 0002 user id absent from logs and URLs`: no logged argument, URL or `location` header contains the cookie's user id.

  `tests/integration/test-routes.test.ts`:
  - `DEMO-8 test files lists the event files written since a time`: `putPending` of one row: `since=<Date.now() - 60000>` lists its key, `since=<Date.now() + 60000>` does not; `since=abc` and `since=-1` give `400`.

  `tests/unit/email-scan.test.ts` (`spawnSync("bash", ...)` as in `demo-script.test.ts`, temporary directories under `os.tmpdir()`):
  - `DEMO-8 R-12 email scan of a clean directory exits 0`: one file `{"user_id":"u"}`: exit 0, `email-scan: clean (1 files)`.
  - `DEMO-8 R-12 email scan finds the address and its URL-encoded form`: a file with `user1%40example.com`, then one with `user1@example.com`: exit 1 each, the output names the file.
  - `DEMO-8 a remote scan without an https BASE or --since is a usage error`: `--remote x.log --since 1` with `BASE` empty, then with `BASE=http://localhost:8787`, then `--remote x.log` with an https `BASE`: exit 2 each, before any network call.
  - `DEMO-8 the remote scan reads the bucket the Worker binds`: the script's `BUCKET=` line equals `eventsBucketName(readWranglerConfig(<wrangler.jsonc>))`.
- [ ] **Step 2: Run `pnpm test -t "DEMO-8"`.** Expected: the new tests FAIL (`/__test/files` answers `404`; the script does not know `--dir`). The email-absent cases may already pass; that is the point of them, and they stay.
- [ ] **Step 3: Write the route, the script modes and the doc edits.**
- [ ] **Step 4: Run the browser test with the local scan.** `pnpm migrate:local && pnpm seed --local && pnpm test:browser`. Expected: the Playwright test passes and the last line is `email-scan: clean (log 0 lines, 0 state files)`.
- [ ] **Step 5: Run the stage checks.** `pnpm test -t "DEMO-8|R-12"`; `pnpm test -t "NFR-3|NFR-5|NFR-6|MVP-5|PB-"`; `grep -rnE "[A-Za-z0-9._%+-]+@" tests/ scripts/ | grep -v "@example.com" | grep -vE "@(types|cloudflare|playwright)/"`; `grep -rnE -- "curl .*-L( |$)|redirect: ?['\"]follow" tests/ scripts/ docs/testing/`; `for f in src/*/*.ts; do head -3 "$f" | grep -qE "ADR|design" || echo "$f"; done`. Expected: both test runs pass; the three commands print nothing.
- [ ] **Step 6: Run the gate:** `pnpm check`. Expected: exit 0.
- [ ] **Step 7: Commit** `feat: email absent from logs, URLs, files and data points; remote email scan`.

### After the tasks: closing

From stage 4 on the stages run without an approval gate (Arthur, 2026-11-05). The AI merges the PR once CI is green, cleans up, checks the deploy, runs the Verify steps and moves to the next stage.

- [ ] Explain-back questions, in the PR description and the stage notes; they do not block the merge. If the loader stopped, which alert would Arthur see first, and after how long? If a partner's secret were wrong, which alert fires, and why does a quarantined postback count as "not accepted"? Why is the probe's own data point not a write?
- [ ] Docs in the closing commit:
  - `docs/ai/plan-history.md`, appended at the bottom, `## 2026-11-06: operations built with log-line alerts`: alerts are log lines with no throttle or sender; `freshness_lag` needs work waiting; `dlq_not_empty` reads `Queue.metrics()` instead of the GraphQL API; the SQL alerts wait for Arthur's token; the counter table for `postbacks_without_conversions`; `/__test/files` for the remote scan. No stage was added or moved.
  - `docs/plans/part2-mvp-stages.md`: tick the stage 6 boxes and change its Files line to the files this plan created or changed.
  - `docs/state/progress.json` through `pnpm stage:close 6 --verified "<the commands of Task 5 steps 4 to 6, with their counts>" --notes-file <file>`. The notes name the decisions above, the defects the reviews found, what was deferred (decision 21), and say the deployed checks run after the merge and the SQL alerts wait for "Needs Arthur".
- [ ] Open the PR with `gh pr create --body-file`, listing what the stage built, the decisions, the "Needs Arthur" section, the explain-back questions and the verify output in a details block. Wait with `gh pr checks --watch`. Expected: `check` and `e2e` green.
- [ ] Merge and clean up: `gh pr merge --squash --delete-branch`, subject `feat: latency data, alert cron, probe and email scan`. From the main checkout: `git worktree remove .claude/worktrees/part2-stage-6`, `git checkout main && git pull --ff-only`, then `gh run watch "$(gh run list --branch main --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status`. Expected: the run ends green with the migration and deploy jobs.
- [ ] Run the Verify section, then record it (decision 20): a branch `part2-stage-6-measurements` from `main` adds the numbers to the stage notes and the NFR-6 card's result line, and moves `dlq_not_empty` to the design-only list if Verify step 3 says so. Commit `docs: stage 6 measurements`, open the PR, merge it once CI is green, remove the branch.
- [ ] Tell Arthur in one paragraph what is left, with the explain-back questions, the "Needs Arthur" step and decision 21.

## Verify

The controller runs these from the main checkout after the merge deploys, with `.dev.vars.remote` present and wrangler logged in. Nothing here is an implementer task.

1. The local browser run (already run in Task 5, repeated on `main`): `pnpm test:browser`. Expected: passes, `email-scan: clean`.
2. A demo run against `BASE` with a tail capture and the remote scan:

   ```sh
   export BASE=https://funnels-analytics-events.bblog.workers.dev
   export TMP=$(mktemp -d)
   curl -s $BASE/healthz                                   # {"sha":"<git rev-parse HEAD>"}
   since=$(( $(date +%s) * 1000 ))
   pnpm exec wrangler tail funnels-analytics-events --format json > $TMP/tail.log 2>/dev/null &
   tail_pid=$!; sleep 15
   pnpm test:e2e --base $BASE | tee $TMP/demo.log           # ok lines, demo passed against $BASE
   grep -c "user1@example.com" $TMP/tail.log; grep -c "user1%40example.com" $TMP/tail.log
   pnpm test:email-scan --remote $TMP/tail.log --since $since
   ```

   Expected: both `grep -c` print `0`; the scan prints `email-scan: clean (tail <n> lines, <k> R2 files, <r> events rows)` with `n`, `k` and `r` above 0. Keep the tail running for steps 3 and 4.
3. The alert run on Cloudflare: within 5 minutes of the deploy, `grep -o 'alert_run[^}]*' $TMP/tail.log | tail -n 1`. Expected: `"unavailable":["analytics_engine_sql"]` until "Needs Arthur" is done, `[]` after. If `dlq` is in the list, `Queue.metrics()` is not available on Cloudflare and `dlq_not_empty` moves to the design-only list in the measurements PR (decision 13).
4. The quarantine drill:

   ```sh
   pnpm -s postback lead --click "unknown-$(date +%s)" --txn "DRILL-$(date +%s)" --base $BASE   # {"status":"quarantined"}
   start=$(date +%s)
   until grep -q quarantine_new_row $TMP/tail.log || [ $(( $(date +%s) - start )) -ge 360 ]; do sleep 10; done
   echo "seen after $(( $(date +%s) - start )) s"; grep -c quarantine_new_row $TMP/tail.log
   kill $tail_pid
   ```

   Expected: the line appears within 5 minutes (one alert cron tick) and the count is at least 1. Record the seconds.
5. The probe: `for i in 1 2 3 4 5; do curl -s -o /dev/null -w '%{http_code} %{time_total}\n' $BASE/__probe; sleep 2; done`. Expected: five lines starting `200`, each with a time. Record them and where the curl ran from.
6. p95 per endpoint for the hour of the demo, once "Needs Arthur" is done:

   ```sh
   AE_SQL_TOKEN=$(grep '^AE_SQL_TOKEN=' .dev.vars.remote | cut -d= -f2-)
   CF_ACCOUNT_ID=$(grep '^CF_ACCOUNT_ID=' .dev.vars.remote | cut -d= -f2-)
   curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql" \
     -H "Authorization: Bearer $AE_SQL_TOKEN" \
     --data "SELECT index1 AS endpoint, quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms, SUM(_sample_interval) AS requests FROM funnels_metrics WHERE blob1 = 'request' AND timestamp > NOW() - INTERVAL '1' HOUR GROUP BY endpoint ORDER BY endpoint FORMAT JSON" \
     | jq -c '.data[]'
   ```

   Expected: one row per endpoint the demo called. Write down `POST /api/events` against 50 ms, and `GET /p/:prelander`, `POST /api/complete`, `GET /go`, `POST /postback/v1/:partner` against 300 ms. If the token is not there yet, this step moves to the measurements PR.
7. The AN-5 manual card against `BASE`:

   ```sh
   JAR=$TMP/an5.jar
   Y=$(date -u -v-1d +%F 2>/dev/null || date -u -d yesterday +%F); T=$(date -u +%F)
   noon_y=$(( ( $(date -u +%s) / 86400 - 1 ) * 86400000 + 43200000 ))
   before_c=$(curl -s "$BASE/api/report?view=cohort&from=$Y&to=$Y" | jq .purchase)
   before_p=$(curl -s "$BASE/api/report?view=postback&from=$T&to=$T" | jq .purchase)
   click=$(curl -s -c $JAR -b $JAR -X POST $BASE/__test/seed -H 'content-type: application/json' \
     --data "{\"clicks\":[{\"offer_id\":\"003\",\"created_at\":$noon_y}]}" | jq -r '.clicks[0]')
   pnpm -s postback purchase --click "$click" --txn "AN5-$(date +%s)" --payout 40.00 --base $BASE
   curl -s "$BASE/api/report?view=cohort&from=$Y&to=$Y" | jq .purchase; echo "before $before_c"
   curl -s "$BASE/api/report?view=postback&from=$T&to=$T" | jq .purchase; echo "before $before_p"
   ```

   Expected: the postback prints `{"status":"accepted"}`; yesterday's cohort `purchase` and today's postback `purchase` are each one above their `before` value.
8. `pnpm check` on `main`. Expected: exit 0.

## Needs Arthur

The three Analytics Engine alerts (`selection_p95`, `worker_5xx_rate`, `d1_overload_errors`) and Verify step 6 need a read-only API token. Until it exists, every alert run logs one `alert_source_unavailable` line for them and every other alert works.

- Why: the Worker reads its own latency and error data points through the Analytics Engine SQL API, which accepts only an API token. Creating a token is a dashboard action on Arthur's account, and its value must not pass through the AI.
- What:
  1. In the Cloudflare dashboard, My Profile, API Tokens, Create Token, Custom token. Name `funnels-ae-sql-read`; one permission, Account, Account Analytics, Read; Account Resources, Include, the account of the Worker; TTL 90 days, like the deploy token. Copy the value.
  2. From the main checkout: `pnpm exec wrangler secret put AE_SQL_TOKEN` and paste the token; `pnpm exec wrangler secret put CF_ACCOUNT_ID` and paste the account id that `pnpm exec wrangler whoami` prints.
  3. Add `AE_SQL_TOKEN=<token>` and `CF_ACCOUNT_ID=<id>` to `.dev.vars.remote`, which is not committed, for Verify step 6.
- How to verify: `curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/<id>/analytics_engine/sql" -H "Authorization: Bearer <token>" --data "SELECT count() AS n FROM funnels_metrics FORMAT JSON" | jq .data` prints one row with `n` above 0. Then, with `pnpm exec wrangler tail funnels-analytics-events --format json | grep -o 'alert_run[^}]*'` running for up to 5 minutes, the next `alert_run` line shows `"unavailable":[]`.
