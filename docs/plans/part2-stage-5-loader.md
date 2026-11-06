# Part 2 stage 5: R2 files and the loader, implementation plan

This stage is done, and its status lives in `docs/state/progress.json`. The checkboxes below were not kept up to date.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** events travel the path of ADR 0005 and ADR 0006 with D1 as the load target. The consumer writes each Queue batch as one NDJSON file to R2 `pending/`, the producer writes a one-event file there when the Queue refuses, and a loader cron moves the files into the D1 `events` table once a minute. `pnpm sink outage on|off` pauses the loader and `GET /__test/health` shows the buffer.

**Architecture:** `src/events/files.ts` owns the R2 layout: prefixes, key formats, list and delete helpers. `sendEvent()` in `src/events/producer.ts` tries the Queue, then R2, and throws only when both refuse. `src/events/consumer.ts` stops writing D1: it puts one file per batch and acknowledges, or retries each message with the growing delays of ADR 0005. `src/events/loader.ts` is the cron job: it resumes open manifests, lists `pending/` oldest first, reads files in batches, validates and deduplicates rows, inserts through the existing `insertEvents()`, writes `loaded/`, deletes the pending files and closes the manifest. `src/index.ts` runs it from `scheduled` on the loader cron. `src/events/health.ts` reads the numbers `/__test/health` prints. `scripts/sink.ts` puts or deletes `control/loader-paused` through `wrangler r2 object`, locally or with `--remote`.

**Tech Stack:** as stage 4 (TypeScript 5.9, Hono 4, Zod 4, wrangler 4.157, vitest 4 with `@cloudflare/vitest-plugin` 1.5.1, Playwright 1.64.1). R2 through the Workers binding. The `typescript` package, already a dev dependency, parses `wrangler.jsonc` in scripts and unit tests.

**Spec:** [part2-mvp-stages.md](part2-mvp-stages.md), section "Stage 5: R2 files and the loader". Read with it: [ADR 0005](../adr/0005-event-ingestion-and-buffering.md) (whole), [ADR 0006](../adr/0006-bigquery-delivery.md) "Loader" and "Verification"; [data-model.md](../design/data-model.md) "MVP events database", "Quiz completion", "Idempotency and ordering"; [metrics-and-operations.md](../design/metrics-and-operations.md), the failure table and "Scheduled jobs"; the cards NFR-3, NFR-4, NFR-5 and NFR-8 in [acceptance-checks.md](../testing/acceptance-checks.md); R-8 and R-16 in [risks.md](../requirements/risks.md); the NFR-5 rows and the D1 and Workers limits in [nfr.md](../requirements/nfr.md).

## Decisions in this plan

Each one follows a default that the ADRs, the design or an earlier stage plan implies. Number 18 waits for Arthur.

1. The loader cron is `* * * * *`, the MVP value in ADR 0005 and ADR 0006. `scheduled` dispatches on `controller.cron`, so the alert cron of stage 6 adds a branch, not a Worker. Any other cron logs `scheduled_unknown_cron` and does nothing.
2. R2 keys. ADR 0005 and 0006 name the prefixes, not the keys:
   - `pending/<ms>-b-<uuid>.ndjson` for a consumer batch, `pending/<ms>-e-<event_id>.ndjson` for a producer fallback file. `<ms>` is the write time in Unix milliseconds padded to 13 digits, so key order is write order: the loader takes the oldest files first.
   - `batches/<batch_id>.json`, the manifest: `{ batch_id, files, attempt, created_at }`. `batch_id` is the first 32 hex characters of SHA-256 over the sorted file keys joined by `\n` (ADR 0006 step 3).
   - `loaded/<batch_id>.ndjson`, the rows inserted. `rejected/<batch_id>.ndjson`, the rows of a batch that failed five loads. `rejected/<batch_id>-invalid.ndjson`, the raw lines that failed validation.
   - `control/loader-paused`, the pause flag. `control/last-load.json`, `{ at, files, rows }` of the last run that loaded a batch.
3. The consumer writes every message body as it came and acknowledges the batch. Validation moves to the loader, which sends a bad row to `rejected/` and loads the rest (ADR 0006 step 4). Today a malformed message is retried alone until the dead letter queue; with files that costs 10 retries and a dead letter slot for one bad row. The two stage 2 tests on malformed messages change to match.
4. A failed R2 write retries each message with `message.retry({ delaySeconds: retryDelaySeconds(message.attempts) })`: 60, 120, 240, 480, 960 and 1920 seconds, then 3600. Ten retries add up to 18,180 seconds, the 303 minutes of nfr.md. `max_retries: 10` and `dead_letter_queue: "events-dlq"` are already in `wrangler.jsonc`, and nothing consumes `events-dlq`. Per message, not `retryAll`, because a batch can mix fresh messages with retried ones.
5. The R2 fallback lives inside `sendEvent()`, so every sender gets it. `POST /api/events` and the postback route answer `503` with `Retry-After: 30` only when the Queue and R2 both refuse. Entry, completion and `/go` keep sending in the background (the stage 2 plan: the page never waits for the Queue, NFR-4) and log when both refuse. data-model.md "Quiz completion" and the failure table in metrics-and-operations.md say the completion answers `503` in that case; Task 1 corrects both to the code.
6. Load limits for the MVP: at most 9,000 files per run (ADR 0006), batches of at most 900 rows (100 insert statements of 9 rows), at most 8 batches per run. That is at most 7,200 rows and 800 D1 queries per run, inside the 1,000 queries per Worker invocation in nfr.md. With D1 as the target the row cap binds before the file cap, and the MVP drains 7,200 events a minute, above the 30 events/s nfr.md gives the production loader. The 50 MB batch of ADR 0006 is a BigQuery upload size; a 900-row batch is under 4 MB, so no byte cap is coded. A file with more than 900 rows forms a batch of its own. Files are read 6 at a time, the simultaneous open connections a Worker invocation gets.
7. A failed insert counts as an attempt only when `SELECT 1` on the events database still answers after it. If it does not, D1 is unreachable: the manifest keeps its attempt number and the run stops. ADR 0006 counts only jobs that BigQuery ran and finished with an error, so an outage never sends data to `rejected/`. After the fifth counted failure the batch's rows go to `rejected/<batch_id>.ndjson`, its pending files are deleted and the manifest is removed.
8. Closing a manifest deletes it. A run first resumes every manifest left in `batches/`; a file a manifest names that is gone from `pending/` is skipped, because the crashed run deleted it after its insert. Inserts are `ON CONFLICT (event_id) DO NOTHING`, so a resumed or overlapping run stores each event once.
9. The loader checks `control/loader-paused` with `head` at the start of each run and skips the run while it exists. `pnpm sink outage on|off [--remote]` puts or deletes it with `wrangler r2 object put|delete`, the way `scripts/offer.ts` passes `--local` or `--remote`. The bucket name comes from `wrangler.jsonc`, so the script and the Worker cannot drift apart.
10. `GET /__test/health` sits behind `TEST_ROUTES` like the other test routes. It counts `pending/` up to 10,000 keys and says `pending_truncated` beyond that. The last load time comes from `control/last-load.json`, one small write per loading run; listing `loaded/` would grow with 30 days of files.
11. `POST /__test/reset` leaves R2 alone. The drill runs the demo, which resets at its start, many times while the loader is paused, and the buffered files are what the drill measures. In a normal run `scripts/demo.sh` waits for `pending_files` 0 before the reset, so no earlier file lands in D1 after it.
12. `scripts/demo.sh` reads `loader_paused` from `/__test/health` before the reset. While paused it expects every funnel cell (visits, started, steps, completed) to stay 0 and tags those checks `(loader paused)`. Every HTTP answer and every facts cell (`lead`, `purchase`, `went_to_offer`, `transitions`, the DEMO-5 diff) is checked as in a normal run. "Demo outputs unchanged" (NFR-4) is then a line-by-line comparison of the `ok` lines.
13. Waits. An event reaches D1 up to 30 seconds (Queue batch) plus one cron minute plus the run after it is sent. `wait_report` and `expect_report` default to 150 seconds instead of 90; the Playwright event wait goes from 45 to 120 seconds, with a test timeout of 150 seconds. All of them poll, so they cost time only when events are late. `wrangler dev` does not run crons, so `start_dev_server` passes `--test-scheduled` and a background loop calls `/__scheduled?cron=*+*+*+*+*` every 10 seconds. The deployed demo goes from about 1 to 2 minutes to about 2 to 3 minutes.
14. Tests. `deliver()` runs the consumer and then the loader, so the stage 2 to 4 tests that read the events table go through the real path; `deliver(bodies, { load: false })` stops at R2. The ADR 0006 case "20,000 one-event files are loaded over three runs" runs with injected limits (12 files, 5 per run), and a test pins `LOADER_LIMITS.maxFilesPerRun` at 9000. The stage text's `R-16 events written while the loader is stopped are loaded once after it restarts` is named `NFR-5 R-16 ...`, because a test name starts with the requirement id. The NFR-3, NFR-4 and NFR-5 cards get the real case names.
15. The drill count. In D1, `event_id` is the primary key, so `COUNT(*)` equals `COUNT(DISTINCT event_id)` by construction. The check that matters is that the count equals the distinct events sent: 12 per demo run (9 in DEMO-2, 3 in DEMO-4) plus 2 for the Lead and the Purchase, whose EventIDs derive from the fixed transaction ids `DEMO-L1` and `DEMO-P1` and repeat in every run. N runs give 12N + 2 rows from 16N messages.
16. The R2 lifecycle rule has no field in `wrangler.jsonc`. It is applied once to the account with `wrangler r2 bucket lifecycle add` in the closing steps, as rules `loaded-30d` and `rejected-30d`. Nothing deletes `pending/` or `batches/` automatically (ADR 0006).
17. No D1 migration: the `events` table and its index do not change.
18. Open for Arthur: the drill runs against the deployed Worker after the merge, so its numbers cannot be in the stage PR. Until he answers, the closing steps record them, and fill the Outcome of ADR 0005 and ADR 0006, in a small follow-up PR `docs: stage 5 drill results`, merged like a stage PR.

## Global Constraints

- Everything committed is in English, except `docs/requirements/open-questions.md`. No secrets, tokens, account ids or real emails in a committed file. Tests use `@example.com` addresses only.
- The email never reaches an event, a Queue message, an R2 file, a URL, a log line or an error response. A log line is one JSON object with counts, types, keys and batch ids; it never prints a row, a message body or an error message (error class names only, as the stage 2 consumer does).
- Every Queue send goes through `sendEvent()` or `emitInBackground()` in `src/events/producer.ts`. Raw SQL in `src/db/` only. Times are Unix milliseconds in UTC.
- Each new file under `src/` opens with a comment of two or three lines naming the component, the ADR and the requirement ids.
- Test names start with the requirement id, then any R-/Q- id. Filter with `pnpm test -t "X"`, never `pnpm test -- -t "X"`. A test never asserts a global row count or an empty bucket: it checks its own keys and its own user's rows.
- No test, script or card follows a redirect: no `curl -L`, no `redirect: "follow"`.
- Shell scripts run on the bash 3.2 of macOS and on CI's bash 5. `scripts/acceptance.sh` is also sourced from zsh.
- No new dependency. Scripts run on Node 24 with types stripped, so `scripts/lib/*.ts` uses no enums, namespaces or parameter properties.
- The limits assume Workers Paid (nfr.md): 1,000 D1 queries and 10,000 subrequests per invocation. On Free the D1 cap is 50 and the loader would fail.
- Work happens in the worktree `.claude/worktrees/part2-stage-5` on branch `part2-stage-5`. Each task commits there.

## Known setup traps

From stages 0 to 4, still true: `compatibility_date` stays `2026-11-03`; test-only bindings by augmenting `Cloudflare.Env` in `tests/env.d.ts`; `wrangler types` needs `--strict-vars=false`; the plugin's `retryAll()` drops its argument and reports per-message retries as `retryMessages`; `call()` waits for `waitUntil` work; integration test files run one after another (`fileParallelism: false`); `pnpm postback` is called as `pnpm -s postback`.

New for this stage:
- Check whether the plugin isolates R2 storage per test. Write the tests so they pass either way: a test that pauses the loader removes the flag in `finally`, and tests that depend on order write their files with old timestamps (`at` from 1000) so they sort first.
- Check that `retryMessages[].delaySeconds` carries the delay given to `message.retry()`. If the plugin drops it, as it does for `retryAll`, spy on each message's `retry` instead.
- `bucket.list()` returns at most 1,000 objects per page, in key order, with `truncated` and `cursor`; `uploaded` is a `Date`. `bucket.delete()` takes up to 1,000 keys. `bucket.get()` of a missing key returns `null`.
- `wrangler dev` runs no cron. With `--test-scheduled` it answers `GET /__scheduled?cron=*+*+*+*+*` by running `scheduled` with cron `* * * * *`. The help text of wrangler 4.157 names `/__scheduled`.
- `pnpm exec wrangler r2 object put funnels-events/control/loader-paused --local --pipe` writes to the same `.wrangler/state` a running `wrangler dev` reads. Check that a running dev server sees the flag within one tick. If it does not, stop and report `NEEDS_CONTEXT`.
- Check that `wrangler r2 object delete` of a missing key exits 0, so `pnpm sink outage off` is safe to run twice.
- `ts.parseConfigFileTextToJson(fileName, text)` from `typescript` reads JSONC with comments and trailing commas; it returns `{ config, error }`.
- `wrangler d1 execute events --remote --json --command "..."` prints `[{ "results": [...], ... }]`, as `scripts/offer.ts` reads it.
- `worker.scheduled(createScheduledController({ cron: "* * * * *" }), env, createExecutionContext())` drives the cron in a test; `createScheduledController` comes from `cloudflare:test`.
- `tests/unit/demo-script.test.ts` expects `FAIL preflight: expected .dev.vars.remote` before anything reaches the network, so the health read in `scripts/demo.sh` goes after that check.

## Review Focus

- A loader run that stops between the D1 insert and the delete of its pending files, or two runs that overlap because one ran past a minute: every event is stored once, and the next run resumes the manifest. Task 2 tests both.
- D1 unreachable for many runs in a row: files stay in `pending/`, the attempt number does not rise, nothing goes to `rejected/`. Task 2 tests it.
- A file with a line that is not JSON, an event with no `event_id`, a `received_at` that is a string, or a payload nested 33 levels: those lines go to `rejected/`, the rest of the batch loads, and nothing blocks the next file. Task 2 tests it.
- The Queue refusing a send at peak (`Storage Limit Exceeded`): the browser still gets `202` and the event waits in R2; with R2 down too, `/api/events` and postbacks answer `503` with `Retry-After`, while entry and completion still answer. Task 1 tests it.
- A demo started while files from an earlier run are still pending, or while the loader is paused: the normal run waits for `pending_files` 0 before its reset, and the paused run expects the funnel cells at 0 instead of timing out. Task 5 handles it.

---

### Task 1: the R2 layout and the producer's R2 fallback

**Files:**
- Create: `src/events/files.ts`, `tests/fixtures/files.ts`, `tests/integration/producer.test.ts`
- Modify: `src/events/producer.ts`; `src/routes/events.ts`, `src/routes/postback.ts`, `src/routes/prelander.ts`, `src/routes/complete.ts`, `src/routes/transition.ts` (pass `c.env` instead of `c.env.EVENTS_QUEUE`); `tests/integration/events-route.test.ts` (the `503` test now fails both sinks), `tests/integration/postback.test.ts` (the PB-5 retry test fails both sinks), `tests/integration/visit-events.test.ts` (the NFR-4 test also finds the events in R2); `docs/design/data-model.md` (the "Quiz completion" paragraph on `503` follows decision 5; a new section "R2 layout" after "MVP events database" with the keys of decision 2, the lifecycle rule of decision 16 and the limits of decision 6); `docs/design/metrics-and-operations.md` (the "Queue and R2 together" row: `/api/events` and postbacks answer `503`, entry and completion answer and lose their server events); `docs/testing/acceptance-checks.md` (the "Event ingestion" row: a refused Queue send is written to R2 `pending/` and still answers `202`, `503` with `Retry-After: 30` only when R2 refuses too; the "Postback" row: `503` when D1 fails, or the Queue and R2 both fail)

**Interfaces:**
- Produces, `src/events/files.ts` (header: ADR 0005 "Path of an event", ADR 0006 "Loader"; serves NFR-4, NFR-5, R-16):
  - `PENDING_PREFIX = "pending/"`, `BATCHES_PREFIX = "batches/"`, `LOADED_PREFIX = "loaded/"`, `REJECTED_PREFIX = "rejected/"`, `PAUSE_KEY = "control/loader-paused"`, `LAST_LOAD_KEY = "control/last-load.json"`
  - `pendingKey(kind: "batch" | "event", at: number, id: string): string`: decision 2
  - `toNdjson(rows: readonly unknown[]): string`: one `JSON.stringify` per line, each ending in `\n`
  - `NDJSON_PUT: R2PutOptions = { httpMetadata: { contentType: "application/x-ndjson" } }`
  - `listKeys(bucket: R2Bucket, prefix: string, max: number): Promise<{ keys: { key: string; uploaded: number }[]; truncated: boolean }>`: pages of 1,000 in key order until `max`
  - `deleteKeys(bucket: R2Bucket, keys: readonly string[]): Promise<void>`: chunks of 1,000
- Produces, `src/events/producer.ts`:
  - `type EventSinks = Pick<Env, "EVENTS_QUEUE" | "EVENTS_BUCKET">`
  - `class EventsUnavailable extends Error`
  - `sendEvent(sinks: EventSinks, event: StoredEvent): Promise<"queue" | "r2">`: sanitize as today; on a Queue rejection log `{"msg":"queue_send_failed","type":<type>}` and put `pendingKey("event", event.received_at, event.event_id)` with one line; on success log `{"msg":"event_written_to_r2","type":<type>}`; if the put fails too, log `{"msg":"r2_fallback_failed","type":<type>,"name":<error class>}` and throw `EventsUnavailable`.
  - `emitInBackground(ctx: Pick<ExecutionContext, "waitUntil">, sinks: EventSinks, events: readonly StoredEvent[]): void`: as today, catching `EventsUnavailable`.
- Produces, `tests/fixtures/files.ts`: `failingBucket(): R2Bucket` (every method rejects with `new Error("r2 down")`); `keysUnder(prefix: string): Promise<string[]>`; `linesOf(key: string): Promise<string[]>` (`[]` for a missing key); `filesWith(prefix: string, needle: string): Promise<string[]>` (keys whose text contains `needle`).

- [ ] **Step 1: Write the failing tests** in `tests/integration/producer.test.ts`, each with its own `newCookie()`:
  - `NFR-4 an event the Queue refuses is written to R2 pending/ and answers 202`: `postEvent(browserEvent(), cookie, { EVENTS_QUEUE: failingQueue() })` gives `202`; `filesWith("pending/", eventId)` gives one key matching `^pending/\d{13}-e-<event_id>\.ndjson$`; its one line parses to the event with `user_id` equal to the cookie's id and a numeric `received_at`.
  - `NFR-5 buffer at capacity behaves as ADR 0005 says: a send refused with Storage Limit Exceeded goes to R2`: a queue whose `send` rejects with `new Error("Storage Limit Exceeded")`; `sendEvent({ EVENTS_QUEUE: queue, EVENTS_BUCKET: env.EVENTS_BUCKET }, storedEvent())` resolves to `"r2"`.
  - `NFR-4 Queue and R2 both down answer 503 with Retry-After`: `failingQueue()` and `failingBucket()` give `503`, `retry-after` `30`, `{"error":"unavailable"}`; the logs contain `queue_send_failed` and `r2_fallback_failed` and not `r2 down`.
  - `NFR-4 entry and completion still answer when the Queue and R2 both refuse`: `/p/demo` gives `200`, the completion gives offer `003`.
  - `PB-5 a postback whose Queue send fails is written to R2 and answers 202`: `userWithClick()`, then the Lead with `failingQueue()` gives `202 {"status":"accepted"}`, and `filesWith("pending/", <derived lead event id>)` gives one key.
  - `R-12 an event written to R2 carries no email`: entry and completion with `failingQueue()` and `user1@example.com`; every file in `filesWith("pending/", <user id>)` contains no `@`.
  - Change, in the existing files: the events route `503` test and the PB-5 retry test pass `EVENTS_BUCKET: failingBucket()` next to `failingQueue()`; `NFR-4 entry and completion answer while the Queue refuses` also finds `prelander_viewed`, `quiz_completed` and `offer_selected` for the user in `pending/` files.
- [ ] **Step 2: Run `pnpm test -t "NFR-4|NFR-5 buffer|PB-5|R-12 an event"`.** Expected: the new tests FAIL (`src/events/files.ts` cannot be resolved; the refused send answers `503`).
- [ ] **Step 3: Write `src/events/files.ts`, the producer change and the call sites; edit the three documents as listed.**
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm lint:docs`.** Expected: all pass, exit 0.
- [ ] **Step 5: Commit** `feat: events the Queue refuses wait in R2 pending/`.

### Task 2: the loader

**Files:**
- Create: `src/events/loader.ts`, `tests/integration/loader.test.ts`
- Modify: `src/db/events.ts` (`pingEvents`, `newestEventAt`), `tests/fixtures/files.ts`

**Interfaces:**
- Consumes: `storedEventSchema`, `StoredEvent` (`src/events/envelope.ts`); `insertEvents` (`src/db/events.ts`); everything in `src/events/files.ts` (Task 1).
- Produces, `src/db/events.ts`: `pingEvents(db: D1Database): Promise<boolean>` (`SELECT 1`; `false` on any error); `newestEventAt(db: D1Database): Promise<number | null>` (`SELECT MAX(received_at) AS newest_at FROM events`).
- Produces, `src/events/loader.ts` (header: ADR 0005 "MVP: D1 as the stand-in for BigQuery", ADR 0006 "Loader"; serves NFR-3, NFR-5, R-8, R-16):
  - `LOADER_CRON = "* * * * *"`
  - `type LoaderLimits = { maxFilesPerRun: number; maxRowsPerBatch: number; maxBatchesPerRun: number; maxAttempts: number }`; `LOADER_LIMITS: LoaderLimits = { maxFilesPerRun: 9000, maxRowsPerBatch: 900, maxBatchesPerRun: 8, maxAttempts: 5 }`
  - `type LoaderEnv = { EVENTS_BUCKET: R2Bucket; EVENTS: D1Database }`
  - `type BatchManifest = { batch_id: string; files: string[]; attempt: number; created_at: number }`
  - `batchId(keys: readonly string[]): Promise<string>`: decision 2
  - `type LoaderRun = { status: "paused" | "done" | "d1_unreachable" | "batch_failed"; batchIds: string[]; files: number; rows: number; duplicates: number; invalid: number; rejected: number }`; `rows` counts rows sent to the insert, `rejected` counts batches moved to `rejected/`.
  - `runLoader(env: LoaderEnv, now: number, limits?: LoaderLimits): Promise<LoaderRun>`, in this order: the pause check (decision 9); every open manifest, oldest key first (decision 8); then `listKeys(PENDING_PREFIX, maxFilesPerRun)` read 6 at a time and grouped into batches by rows (decision 6). Per batch: parse each non-empty line with `JSON.parse` and `storedEventSchema.safeParse`; keep the first row per `event_id`; put the manifest; `insertEvents`; put `loaded/<id>.ndjson`, and `rejected/<id>-invalid.ndjson` if any line failed; `deleteKeys`; delete the manifest. A failed insert follows decision 7. After a run that loaded a batch, put `LAST_LOAD_KEY` as `{ at: now, files, rows }`. Log lines: `{"msg":"loader_paused"}`; `{"msg":"loader_run","status","batches","files","rows","duplicates","invalid","rejected"}`; `{"msg":"loader_batch_failed","batch_id","attempt","name"}`; `{"msg":"loader_d1_unreachable","batch_id"}`; `{"msg":"loader_batch_rejected","batch_id","files"}`.
- Produces, `tests/fixtures/files.ts`: `putPending(content: readonly unknown[] | string, at?: number): Promise<string>` (rows as NDJSON or a raw string, key `pendingKey("batch", at ?? Date.now(), crypto.randomUUID())`); `pauseLoader()`, `resumeLoader()`; `loadNow(limits?: Partial<LoaderLimits>, events?: D1Database): Promise<LoaderRun>` (`runLoader` with `env.EVENTS_BUCKET`, `events ?? env.EVENTS`, `{ ...LOADER_LIMITS, ...limits }`); `insertFailingEvents(): D1Database` (`prepare` passes through to `env.EVENTS`, `batch` rejects with `new Error("SQLITE_CONSTRAINT")`); `unreachableEvents(): D1Database` (`batch` rejects; `prepare()` returns a stub whose `bind()` returns itself and whose `first`, `run` and `all` reject).

- [ ] **Step 1: Write the failing tests** in `tests/integration/loader.test.ts`. Each test makes its own user id and reads its rows with `eventsOf()`; "a file" is `putPending([...])` with `storedEvent({ user_id })` rows.
  - `NFR-5 R-8 the loader drops repeated event ids inside a batch`: one file with event A three times and B: after `loadNow()`, 2 rows; `loaded/<batchIds[0]>.ndjson` has 2 lines; `duplicates` is at least 2.
  - `NFR-5 R-8 an event repeated in a later file is stored once`: a file with A, `loadNow()`, a second file with A, `loadNow()`: 1 row.
  - `NFR-5 an invalid row goes to rejected/ and the rest of the batch loads`: one raw file with a valid event, `not json`, `{"event_id":"x"}`, an event whose `received_at` is `"yesterday"`, and an event with `deepPayload(33)`: 1 row; `rejected/<batchIds[0]>-invalid.ndjson` has the 4 bad lines; the pending key is gone.
  - `NFR-5 a run takes at most 9,000 files`: `LOADER_LIMITS.maxFilesPerRun` is `9000`; 12 one-event files at `at` 1000 to 1011, then `loadNow({ maxFilesPerRun: 5 })` three times: `files` 5, 5, 2; after the first run 7 of the 12 keys remain; at the end 12 rows, each once.
  - `NFR-5 a run stops after its batch limit`: `LOADER_LIMITS` has `maxRowsPerBatch` 900 and `maxBatchesPerRun` 8; four files of 2 rows at `at` 2000 to 2003 with `{ maxRowsPerBatch: 3, maxBatchesPerRun: 2 }`: the first run has `batches` 2 (`batchIds` length 2), `files` 2, `rows` 4; the second run loads the other two files.
  - `NFR-5 a batch failing five loads goes to rejected/`: a file of 2 rows at `at` 3000; `loadNow({}, insertFailingEvents())` four times: each `status` `batch_failed`, the manifest's `attempt` is 2, 3, 4, 5 after each run, the key is still pending; the fifth run: `rejected` 1, `rejected/<id>.ndjson` has 2 lines, the pending key and the manifest are gone; a normal `loadNow()` then gives the user 0 rows.
  - `NFR-5 an unreachable events database does not count as a load attempt`: a file at `at` 4000; ten runs with `unreachableEvents()`: each `status` `d1_unreachable`, the manifest's `attempt` stays 1, `keysUnder("rejected/" + id)` is empty; a normal `loadNow()` loads both rows and removes the manifest.
  - `NFR-5 a run resumes an unfinished batch first and stores it once`: a file with 2 rows, its rows inserted with `insertEvents`, and `batches/<batchId([key])>.json` written with attempt 1, as if a run stopped after the insert: `loadNow()` gives 2 rows, removes the key and the manifest, writes `loaded/<id>.ndjson`.
  - `NFR-5 a manifest naming a deleted file is closed without error`: a manifest for one present key and one missing key: the run's `status` is `done`, the present file's rows are loaded, the manifest is gone.
  - `NFR-5 two overlapping runs store each event once`: a file with 3 rows, `Promise.all([loadNow(), loadNow()])`: 3 rows.
  - `NFR-4 a paused loader skips the run and leaves the files`: `pauseLoader()`, a file, `loadNow()` gives `status` `paused`, `files` 0, the key is still pending, the user has 0 rows; `resumeLoader()` in `finally`.
  - `NFR-3 a loading run records the last load time`: after a run that loads a file, `control/last-load.json` parses to `{ at, files, rows }` with `at` the `now` passed in.
  - `R-12 loader logs carry counts and batch ids, never row content`: with `console.log` spied, a run over a file whose payload holds `"value":"asia"`: every line parses as JSON, none contains `asia` or the user id.
- [ ] **Step 2: Run `pnpm test -t "NFR-5|NFR-4 a paused|NFR-3 a loading|R-12 loader"`.** Expected: the new tests FAIL, `src/events/loader.ts` cannot be resolved.
- [ ] **Step 3: Write `src/events/loader.ts`, the two `src/db/events.ts` functions and the fixtures.**
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`.** Expected: all pass, exit 0.
- [ ] **Step 5: Commit** `feat: loader moves R2 pending/ files into the events table`.

### Task 3: the consumer writes files and the cron runs the loader

**Files:**
- Create: `tests/integration/pipeline.test.ts`, `tests/unit/wrangler-config.test.ts`, `scripts/lib/wrangler-config.ts`
- Modify: `src/events/consumer.ts`, `src/index.ts`, `wrangler.jsonc` (`"triggers": { "crons": ["* * * * *"] }` with the comment `// ADR 0005, ADR 0006: the loader, every minute in the MVP`; the bucket comment names the lifecycle rule of decision 16), `tests/fixtures/events.ts` (`deliver`), `tests/integration/consumer.test.ts`

**Interfaces:**
- Consumes: `pendingKey`, `toNdjson`, `NDJSON_PUT` (Task 1); `runLoader`, `LOADER_CRON` (Task 2); `failingBucket`, `filesWith`, `keysUnder`, `pauseLoader`, `resumeLoader`, `loadNow` (Tasks 1 and 2).
- Produces, `src/events/consumer.ts`: `retryDelaySeconds(attempts: number): number` (decision 4; `attempts` is `message.attempts`, 1 on the first delivery); `consumeEvents(batch: MessageBatch<unknown>, bucket: R2Bucket, now: number): Promise<void>`: one put of `pendingKey("batch", now, crypto.randomUUID())` with `toNdjson` of every body, then `message.ack()` for each; on a failed put, log `{"msg":"consumer_write_failed","count":<n>,"name":<error class>}` and retry each message with its delay; on success log `{"msg":"consumer_batch","written":<n>}`. The header comment says the D1 write moved to the loader.
- Produces, `src/index.ts`: `queue(batch, env)` calls `consumeEvents(batch, env.EVENTS_BUCKET, Date.now())`; `scheduled(controller, env)` awaits `runLoader(env, Date.now())` when `controller.cron === LOADER_CRON` (decision 1).
- Produces, `tests/fixtures/events.ts`: `deliver(bodies: readonly unknown[], options?: { load?: boolean }): Promise<QueueResult>`: the batch through `worker.queue`, then `loadNow()` unless `load` is `false`. The `db` parameter is removed; the stage 2 tests that used it now call `consumeEvents` with `failingBucket()`.
- Produces, `scripts/lib/wrangler-config.ts`: `readWranglerConfig(text: string): WranglerConfig` through `ts.parseConfigFileTextToJson`, throwing on a parse error, with `WranglerConfig` typing the fields used here (`triggers.crons`, `queues.consumers[]`, `r2_buckets[]`); `eventsBucketName(config: WranglerConfig): string` (the `bucket_name` of binding `EVENTS_BUCKET`).

- [ ] **Step 1: Write the failing tests.**

  `tests/unit/wrangler-config.test.ts` (reads `wrangler.jsonc` with `node:fs`):
  - `NFR-3 the loader cron runs every minute`: `LOADER_CRON` is `* * * * *` and `triggers.crons` contains it.
  - `NFR-5 consumer write failure goes to the dead letter queue after 10 retries`: the consumer of `events` has `max_retries` 10 and `dead_letter_queue` `events-dlq`; no consumer reads `events-dlq`; `retryDelaySeconds` for attempts 1 to 10 gives `[60, 120, 240, 480, 960, 1920, 3600, 3600, 3600, 3600]`, which sums to 18180.

  `tests/integration/consumer.test.ts`, keeping the stage 2 tests that go through `deliver` (TEST-3, ID-1, BIZ-2, both ID-4, the NFR-8 out-of-order test, `NFR-5 the Worker's queue handler stores the batch`), and replacing the four D1-specific ones:
  - `NFR-5 the consumer writes one NDJSON file per batch to pending/ and acknowledges`: `deliver` of three events with `{ load: false }`: `explicitAcks` `["m0","m1","m2"]`; `filesWith("pending/", <first event id>)` gives one key matching `^pending/\d{13}-b-[0-9a-f-]{36}\.ndjson$` whose three lines parse to the three events in order; the user has 0 rows until `loadNow()`.
  - `NFR-5 consumer write failure retries each message with the growing delay`: a batch of ten messages with attempts 1 to 10 through `consumeEvents(batch, failingBucket(), Date.now())`: each message is retried with the delays above; no acks.
  - `NFR-8 an R2 failure logs the error class name and never its message`: the line is `{"msg":"consumer_write_failed","count":1,"name":"Error"}`; no line contains `r2 down`.
  - `NFR-8 a malformed message is written and acknowledged, and the loader rejects it alone`: `[valid, { foo: 1 }, valid]`: all three acknowledged, 2 rows, one `rejected/` file with the bad line. The deeply nested message test becomes the same case with `deepPayload(1001)`.

  `tests/integration/pipeline.test.ts`:
  - `NFR-5 R-16 events written while the loader is stopped are loaded once after it restarts`: `pauseLoader()`; three events through `deliver` (its loader run is skipped): 0 rows, the file is pending; `resumeLoader()`; `loadNow()`: 3 rows; a second `loadNow()`: still 3; the pending key is gone and a `loaded/` file holds the three event ids.
  - `NFR-5 R-8 drained rows have no duplicate event ids`: while paused, the same two events through `deliver` twice (a redelivery) and one of them a third time: after the resume and one run, 2 rows with 2 distinct ids.
  - `NFR-3 accepted event is counted in the report within the freshness window`: read `started` for `prelander=demo` and today; one `step_viewed` 1 from a new cookie through `postEvent` with `captureQueue()`; `deliver(sent, { load: false })`; `started` unchanged; `worker.scheduled(createScheduledController({ cron: LOADER_CRON }), env, createExecutionContext())`; `started` is the first value plus 1.
  - `NFR-3 the scheduled handler ignores an unknown cron`: a pending file and `cron: "0 0 * * *"`: the key is still pending, the log has `scheduled_unknown_cron`.
  - `NFR-4 P-8 sink outage leaves entry, complete, transition and postback working`: `pauseLoader()`; with one `captureQueue()`: `/p/demo` `200`, `step_viewed` 1 `202`, completion gives `003`, `/go?prelander=demo&visit=<v>` `302` with a click id, the signed Lead `202 {"status":"accepted"}`; `deliver` of every captured body: the user has 0 rows; `resumeLoader()`, `loadNow()`: the user has the 6 events. `resumeLoader()` in `finally`.
- [ ] **Step 2: Run `pnpm test -t "NFR-3|NFR-4 P-8|NFR-5|NFR-8"`.** Expected: the new tests FAIL (`consumeEvents` still takes a `D1Database`; `scripts/lib/wrangler-config.ts` cannot be resolved; no `triggers` in `wrangler.jsonc`).
- [ ] **Step 3: Write the consumer, the two handlers, the cron, `deliver` and the config reader.**
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`.** Expected: all pass, exit 0, the stage 1 to 4 tests included.
- [ ] **Step 5: Commit** `feat: consumer writes R2 files, the loader runs every minute`.

### Task 4: `GET /__test/health` and `pnpm sink`

**Files:**
- Create: `src/events/health.ts`, `scripts/sink.ts`, `scripts/lib/sink.ts`, `tests/integration/health.test.ts`, `tests/unit/sink.test.ts`
- Modify: `src/routes/test.ts` (`GET /health`), `package.json` (`"sink": "node scripts/sink.ts"`), `tests/integration/test-routes.test.ts` (the 404 tests also check `/__test/health`)

**Interfaces:**
- Consumes: `listKeys`, `PENDING_PREFIX`, `BATCHES_PREFIX`, `PAUSE_KEY`, `LAST_LOAD_KEY` (Task 1); `newestEventAt` (Task 2); `readWranglerConfig`, `eventsBucketName` (Task 3).
- Produces, `src/events/health.ts` (header: ADR 0005 "Buffer limits", metrics-and-operations.md "Alerts"; serves NFR-3, NFR-4, NFR-5):
  - `type PipelineHealth = { as_of: number; loader_paused: boolean; pending_files: number; pending_truncated: boolean; pending_oldest_age_ms: number | null; open_batches: number; last_load_at: number | null; events_newest_at: number | null; freshness_ms: number | null }`
  - `readHealth(env: Pick<Env, "EVENTS_BUCKET" | "EVENTS">, now: number): Promise<PipelineHealth>`: pending counted up to 10,000 keys; the oldest age is `now` minus the smallest `uploaded`; `freshness_ms` is `now - events_newest_at`.
- Produces, `GET /__test/health`: `200` JSON of `readHealth(c.env, Date.now())` with `cache-control: no-store`; `404` unless `TEST_ROUTES` is `on`.
- Produces, `scripts/lib/sink.ts`: `parseSinkArgs(argv: readonly string[]): { action: "on" | "off"; target: "local" | "remote" } | null` (accepts `outage on|off` with an optional `--local` or `--remote`); `sinkWranglerArgs(action: "on" | "off", target: "local" | "remote", bucket: string): string[]`: on gives `["exec", "wrangler", "r2", "object", "put", "<bucket>/control/loader-paused", "--<target>", "--pipe"]`, off gives `["exec", "wrangler", "r2", "object", "delete", "<bucket>/control/loader-paused", "--<target>"]`.
- Produces, `scripts/sink.ts`: usage `pnpm sink outage on|off [--remote]`, header comment in the style of `scripts/offer.ts` (ADR 0005, ADR 0006; serves NFR-4, NFR-5, R-16; local by default). It reads the bucket from `wrangler.jsonc`, runs `pnpm` with `sinkWranglerArgs` through `spawnSync` (stdin for `on` is `paused by pnpm sink at <ISO time>`), and prints `loader paused (<target>): <bucket>/control/loader-paused` or `loader resumed (<target>)`. A bad argument prints the usage and exits 1; a wrangler failure prints `wrangler r2 object <put|delete> failed (exit <n>)` and exits 1.

- [ ] **Step 1: Write the failing tests.**

  `tests/unit/sink.test.ts`:
  - `NFR-4 pnpm sink outage on puts the pause key`: `parseSinkArgs(["outage", "on"])` is `{ action: "on", target: "local" }`, with `--remote` the target is `remote`; `sinkWranglerArgs("on", "remote", "funnels-events")` equals the put list above.
  - `NFR-4 pnpm sink outage off deletes the pause key`: the delete list for `off` and `local`.
  - `NFR-4 pnpm sink rejects anything else`: `[]`, `["outage"]`, `["outage", "maybe"]`, `["pause", "on"]`, `["outage", "on", "--prod"]`, `["outage", "on", "--local", "--remote"]` each give `null`.
  - `NFR-4 pnpm sink pauses the bucket the Worker binds`: `eventsBucketName(readWranglerConfig(<wrangler.jsonc>))` is `funnels-events`, and the key in `sinkWranglerArgs` ends with `PAUSE_KEY` from `src/events/files.ts`.

  `tests/integration/health.test.ts`:
  - `NFR-5 health shows pending files and the age of the oldest`: a file put at `Date.now()`: `pending_files` at least 1, `pending_oldest_age_ms` a number at least 0, `pending_truncated` `false`.
  - `NFR-3 health shows the last load time and freshness`: an event with `received_at` `t0 - 5000` in a file, `loadNow()`: `last_load_at` at least `t0`; `events_newest_at` at least `t0 - 5000`; `freshness_ms` a number at least 0.
  - `NFR-4 health shows the loader paused while the flag exists`: `pauseLoader()` gives `loader_paused` `true`; after `resumeLoader()` it is `false`.
  - `R-12 health sets cache-control no-store`, and the `/__test/health` path joins the three 404 tests of `test-routes.test.ts`.
- [ ] **Step 2: Run `pnpm test -t "NFR-3 health|NFR-4|NFR-5 health|R-12"`.** Expected: the new tests FAIL (`/__test/health` answers `404`; `scripts/lib/sink.ts` cannot be resolved).
- [ ] **Step 3: Write the health module, the route, the sink library and script, and the `package.json` line.**
- [ ] **Step 4: Run the script locally.** `pnpm dev` in one terminal after `pnpm migrate:local && pnpm seed --local`. Then `pnpm sink outage on`, `curl -s localhost:8787/__test/health | jq .loader_paused`, `pnpm sink outage off`, the same `curl`, then `pnpm sink outage off` again. Expected: `loader paused (local): funnels-events/control/loader-paused`, `true`, `loader resumed (local)`, `false`, and the second `off` exits 0.
- [ ] **Step 5: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`.** Expected: all pass, exit 0.
- [ ] **Step 6: Commit** `feat: pipeline health route and pnpm sink outage on|off`.

### Task 5: the demo, the browser test and the docs with the loader in the path

**Files:**
- Modify: `scripts/lib/dev-server.sh`, `scripts/acceptance.sh`, `scripts/demo.sh`, `tests/e2e/quiz.spec.ts`, `docs/testing/acceptance-checks.md`

**Interfaces:**
- Consumes: `GET /__test/health` and `pnpm sink` (Task 4); the cron path (Task 3).
- Produces, `scripts/lib/dev-server.sh`: `start_dev_server` runs `wrangler dev --port 8787 --test-scheduled` and, once `/healthz` answers, a background loop that calls `curl -s -o /dev/null "http://localhost:8787/__scheduled?cron=*+*+*+*+*"` every 10 seconds, its pid in `LOADER_TICK_PID`; `stop_dev_server` stops the loop first.
- Produces, `scripts/acceptance.sh`: `health` (`curl -s "$BASE/__test/health" | jq -S .`); `wait_health <jq filter> <expected> [seconds]`, polling every 3 seconds like `wait_report`, default 150; `wait_report` default 150.
- Produces, `scripts/demo.sh`:
  - after the `.dev.vars.remote` check and before the reset, `loader_paused` from `/__test/health`; anything but `true` or `false` is `FAIL health: expected true or false, got <x>`.
  - not paused: `wait_health .pending_files 0`, else `FAIL preflight: expected pending_files 0, got <n>`.
  - paused: prints `loader paused: funnel cells are expected to stay 0`; the DEMO-2 report check expects `0,0,0,0,0` and DEMO-4 expects `0`, read once without waiting, each named `<step> (loader paused)`; the final check expects `0,0,0,0,0,0,1,2,1,1`. Every other check is unchanged.
  - `expect_report` defaults to 150 seconds. The header comment describes both modes.
- Produces, `tests/e2e/quiz.spec.ts`: `test.setTimeout(150_000)`; the event wait is 120 seconds, and its comment names the Queue batch and the loader minute.
- Produces, `docs/testing/acceptance-checks.md`:
  - conventions: `health` and `wait_health` in the helper list, `wait_report` at 150 seconds; the sentence on timing names the 30-second Queue batch and the loader minute; the "Simulated sink outage" row names `control/loader-paused`, `--remote`, and what the demo expects while paused; the "Pipeline health" row lists the `PipelineHealth` fields; the "Test state" row says reset leaves R2 alone.
  - NFR-3: the automated cases become `NFR-3 accepted event is counted in the report within the freshness window` and `NFR-3 the loader cron runs every minute`; step 4 reads `freshness_ms` and `last_load_at`.
  - NFR-4: the automated cases add the producer cases of Task 1; manual step 2 is `pnpm test:e2e --base $BASE` while paused; the expected result says the HTTP answers and facts cells match a normal run, and the funnel cells stay 0 until the loader runs.
  - NFR-5: the automated cases become the Task 2 and Task 3 names, `NFR-5 buffer at capacity ...` among them, and no longer mention a small capacity in the test config.

- [ ] **Step 1: Run the demo against the old waits to see the failure.** After Tasks 1 to 4, `pnpm migrate:local && pnpm seed --local && pnpm test:e2e`. Expected: `FAIL DEMO-2 report`, because `wrangler dev` never runs the loader.
- [ ] **Step 2: Write the shell changes, the Playwright wait and the card edits.**
- [ ] **Step 3: Run the end-to-end checks locally.** `export TMP=$(mktemp -d)`, then `pnpm test:e2e | tee $TMP/normal.log`. Expected: an `ok` line per check, `demo passed against http://localhost:8787`, exit 0. Then `pnpm test:browser`. Expected: passes, the email scan clean.
- [ ] **Step 4: Run the paused demo locally.** In one terminal `pnpm dev --test-scheduled` (no ticker runs here, and the paused run needs none). In another: `pnpm sink outage on`, `pnpm test:e2e --base http://localhost:8787 | tee $TMP/paused.log`, `curl -s localhost:8787/__test/health | jq -c '{loader_paused,pending_files}'`, `pnpm sink outage off`, then `curl -s "localhost:8787/__scheduled?cron=*+*+*+*+*"` once and read the health again. Then `diff <(grep '^ok' $TMP/normal.log) <(grep '^ok' $TMP/paused.log | sed 's/ (loader paused)$//')`. Expected: the paused run passes; health shows `loader_paused` `true` and `pending_files` at least 1, then `loader_paused` `false` and `pending_files` 0; the diff prints nothing.
- [ ] **Step 5: Run the stage checks.** `pnpm test -t "NFR-3|NFR-4|NFR-5|NFR-8|R-12"`; `pnpm test -t "TEST-3|ID-1|ID-4|BIZ-2|AN-|DEMO-"`; `grep -rnE -- "curl .*-L( |$)|redirect: ?['\"]follow" tests/ scripts/ docs/testing/`; `for f in src/*/*.ts; do head -3 "$f" | grep -qE "ADR|design" || echo "$f"; done`. Expected: both test runs pass; the two commands print nothing.
- [ ] **Step 6: Run the gate:** `pnpm check`. Expected: exit 0.
- [ ] **Step 7: Commit** `feat: demo and browser test wait for the loader`.

### After the tasks: closing

From stage 4 on the stages run without an approval gate (Arthur, 2026-11-05). The AI merges the PR once CI is green, cleans up, checks the deploy, runs the drill and moves to the next stage.

- [ ] Apply the R2 lifecycle rule, once, against the account. The AI runs it from the worktree with the logged-in wrangler; the CI token is not used.

  ```sh
  pnpm exec wrangler r2 bucket lifecycle list funnels-events
  pnpm exec wrangler r2 bucket lifecycle add funnels-events loaded-30d loaded/ --expire-days 30 -y
  pnpm exec wrangler r2 bucket lifecycle add funnels-events rejected-30d rejected/ --expire-days 30 -y
  pnpm exec wrangler r2 bucket lifecycle list funnels-events
  ```

  Expected: the last list shows `loaded-30d` on `loaded/` and `rejected-30d` on `rejected/`, both 30 days, and any rule the first list showed is still there. The output goes into the PR's verify block.
- [ ] Explain-back questions, collected for Arthur in the PR description and in the stage notes; they do not block the merge. Where does one event wait while the loader is paused, and where while R2 is down? Why does a D1 error count as a load attempt only when `SELECT 1` still answers? Why does a run take at most 7,200 rows, when ADR 0006 says 9,000 files?
- [ ] Docs in the closing commit:
  - `docs/ai/plan-history.md`, appended at the bottom, `## 2026-11-06: the loader replaces the consumer's D1 write`: the consumer writes files and no longer validates; the D1 row cap of decision 6; failed inserts counted only while D1 answers; completion keeps not waiting for the event sinks, and data-model.md and metrics-and-operations.md now say so; reset leaves R2; the demo's paused mode and the longer waits. No stage was added or moved.
  - `docs/plans/part2-mvp-stages.md`: tick the stage 5 boxes and change its Files line to the files this plan created or changed. In "What to show at the review", the stage 5 row's "How" becomes `curl $BASE/__test/health`, `pnpm sink outage on --remote`, and the drill numbers in ADR 0005's Outcome.
  - `docs/state/progress.json` through `pnpm stage:close 5 --verified "<the commands of Task 5 steps 3 to 6 and the lifecycle list, with their counts>" --notes-file <file>`. The notes name the decisions above, the defects the reviews found and what was deferred, and say the deployed checks and the drill run right after the merge deploys.
- [ ] Open the PR with `gh pr create --body-file`, listing what the stage built, the decisions, the explain-back questions and the verify output in a details block. Wait with `gh pr checks --watch`. Expected: `check` and `e2e` green; the `e2e` log shows `demo passed against http://localhost:8787`.
- [ ] Merge and clean up: `gh pr merge --squash --delete-branch`, subject `feat: R2 event files and the loader`. From the main checkout: `git worktree remove .claude/worktrees/part2-stage-5`, `git checkout main && git pull --ff-only`, then `gh run watch "$(gh run list --branch main --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status`. Expected: the run ends green with the deploy job.
- [ ] Check the deployed Worker, from the main checkout with `.dev.vars.remote` present:

  ```sh
  export BASE=https://funnels-analytics-events.bblog.workers.dev
  export TMP=$(mktemp -d)
  curl -s $BASE/healthz                                      # {"sha":"<git rev-parse HEAD>"}
  curl -s $BASE/__test/health | jq -c .                      # loader_paused false, pending_files 0
  pnpm test:e2e --base $BASE | tee $TMP/normal.log           # ok lines, demo passed against $BASE, about 2 to 3 minutes
  for i in $(seq 1 24); do curl -s $BASE/__test/health | jq -c '{pending_files, pending_oldest_age_ms, last_load_at, freshness_ms}'; sleep 5; done
  pnpm exec wrangler d1 execute events --remote --json \
    --command "SELECT COUNT(*) AS n, COUNT(DISTINCT event_id) AS d FROM events" | jq -c '.[0].results[0]'   # {"n":14,"d":14}
  ```

  Expected: the samples show `pending_files` at least 1 while the demo's last events wait for the cron, then 0 with `last_load_at` after the demo ended. If no sample catches a file, the drill below shows the buffer. The count is 14: 12 events of the run and the Lead and Purchase (decision 15). If a check fails, the fix goes in a new branch and PR before the drill.
- [ ] The loader-paused drill (NFR-4, NFR-5, R-16), from the same shell. Wait 2 minutes after the demo above and see `pending_files` 0, so no event is still in the Queue. Expected cost: about 40 demo runs, 650 Queue messages and 50 R2 writes, inside the Paid plan's included amounts.

  ```sh
  pnpm -s sink outage on --remote
  curl -s $BASE/__test/health | jq -c . | tee $TMP/drill-start.json      # loader_paused true, pending_files 0
  start=$(date +%s); runs=0
  while [ $(( $(date +%s) - start )) -lt 600 ]; do
    if pnpm -s test:e2e --base $BASE > "$TMP/drill-$runs.log" 2>&1; then
      runs=$((runs + 1))
      curl -s $BASE/__test/health | jq -c '{pending_files, pending_oldest_age_ms}'
    else
      echo "run $runs failed"; tail -n 20 "$TMP/drill-$runs.log"; break
    fi
  done
  echo "runs $runs"
  curl -s $BASE/__test/health | jq -c . | tee $TMP/drill-end.json
  diff <(grep '^ok' $TMP/normal.log) <(grep '^ok' $TMP/drill-0.log | sed 's/ (loader paused)$//')   # nothing
  pnpm -s sink outage off --remote
  off=$(date +%s)
  until [ "$(curl -s $BASE/__test/health | jq .pending_files)" = 0 ] || [ $(( $(date +%s) - off )) -ge 600 ]; do sleep 10; done
  echo "drained in $(( $(date +%s) - off )) s"
  pnpm exec wrangler d1 execute events --remote --json \
    --command "SELECT COUNT(*) AS n, COUNT(DISTINCT event_id) AS d FROM events" | jq -c '.[0].results[0]'
  echo "expected $(( 12 * runs + 2 ))"
  ```

  Expected: every run passes; `drill-end.json` shows `loader_paused` `true`, `pending_files` higher than at the start (about one file per 30-second Queue batch) and `pending_oldest_age_ms` near 600,000; the diff prints nothing; pending drains within about 2 minutes; `n` and `d` are equal and match the expected line. Record the runs, pending files and oldest age at start and end, the minutes to drain and both counts. Then `curl -s $BASE/__test/health | jq .loader_paused` prints `false`.
- [ ] Record the drill (decision 18, until Arthur answers): a branch `part2-stage-5-drill` from `main` fills the Outcome of ADR 0005 (the date, what was built, the drill numbers, the redrive script still design-only) and of ADR 0006 (the loader built with D1 as the target, limits of decision 6, BigQuery load jobs design-only). Commit `docs: stage 5 drill results`, open the PR, merge it once CI is green, remove the branch.
- [ ] Tell Arthur in one paragraph what is left, with the explain-back questions and decision 18.
