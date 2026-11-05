# Part 2 stage 2: events, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every event of a visit reaches the D1 events database exactly once: the five browser events through `POST /api/events`, the three server events from entry and completion, all through the Queue and its consumer.

**Architecture:** `src/events/` holds the event path of ADR 0005. `envelope.ts` checks an incoming event (pure), `sanitize.ts` removes emails from a payload (pure), `producer.ts` is the one place that sends to the Queue, and `consumer.ts` is the Queue handler that writes to the D1 events database through `src/db/events.ts`. The route `POST /api/events` checks, stamps `user_id` and `received_at`, and sends; entry and completion emit server events through the same producer in the background. The quiz page sends one event per request through a small outbox kept in localStorage. In this stage the consumer writes straight to D1; stage 5 replaces that write with R2 files and the loader.

**Tech Stack:** as stage 1 (TypeScript 5.9, Hono 4, Zod 4, wrangler 4.157, vitest 4 with `@cloudflare/vitest-plugin` 1.5.1). Queue tests use `createMessageBatch` and `getQueueResult` from `cloudflare:test`.

**Spec:** [part2-mvp-stages.md](part2-mvp-stages.md), section "Stage 2". Read with it: [ADR 0005](../adr/0005-event-ingestion-and-buffering.md) ("Path of an event", "Event envelope", "MVP: D1 as the stand-in for BigQuery"), [data-model.md](../design/data-model.md) ("What this file settles" points 6 and 7, "Requests and what they touch", "Current answers", "Idempotency and ordering", "Personal data", "Event catalog", "MVP events database"), and the cards QZ-4, QZ-5, ID-1, ID-2, ID-4, BIZ-2, TEST-3, NFR-8 and R-12 in [acceptance-checks.md](../testing/acceptance-checks.md).

## Decisions by Arthur

1. Email inside an event payload (Arthur, 2026-11-05). The envelope has no email field, and the payload of the two browser types the Worker knows is checked against the quiz config. The payload of an unknown type or an unknown `schema_version` is stored as sent (ADR 0005), so a future client release could put an email into it, for example a page URL with `?email=` added by an ad network. Arthur's call: "Додамо на бекенді якийсь sanitizePayload метод, який буде прибирати звідти email поле, та й все." So the producer runs `sanitizePayload()` on every event, browser and server, before the Queue send, and the event is accepted. The function removes every key whose name contains `email`, in any case and at any depth. String values are left as they are (Arthur, 2026-11-05: "давай стрінги не чіпати, поточний рівень захисті від полей email достатній"), so an email inside a string, such as the URL above, still passes; R-23 records that as an accepted risk. Each sanitized event writes one log line with its type and the number of removed keys, never a value. Rejected: also replacing email-shaped substrings inside string values (the AI's proposal, dropped by Arthur as more than needed); answering `400` for such an event (the AI's recommendation; a bug in our own page would fail a test instead of passing quietly), and leaving it to the front end (the guarantee in data-model.md would rest on a convention). Recorded as R-23 in risks.md; data-model.md "Personal data" and the stage 2 text of part2-mvp-stages.md are corrected in this stage.

Settled here, each reversible:
- `client_time` is Unix milliseconds from the browser's `Date.now()`, like every other time in the system. The card helper `answer()` sent an ISO string and is fixed.
- `user_id` and `received_at` in an incoming body are dropped without an error, because the Worker sets them (card ID-2: "user id in the event body is ignored"). Any other unknown envelope field gives `400`.
- The body limit of `POST /api/events` is 4 KB (4,096 bytes), answered with `413`. One event is about 1 KB (ADR 0005), so this leaves four times headroom. It goes into nfr.md.
- An event whose `prelander_id` has no flow config gives `400 unknown_prelander`, as `/api/complete` does. A new prelander needs a deploy for its config anyway.
- Server events are sent with `waitUntil`, so the page and the completion do not wait for the Queue. A failed send is logged and the request still succeeds (NFR-4). `POST /api/events` answers `503` with `Retry-After: 30` when the Queue refuses, and the browser keeps the event. Stage 5 adds the R2 fallback before both.
- `visit_id` stays optional in the `/api/complete` body so stage 1 clients and the card helper keep working. When it is missing, the Worker makes one for the two completion events. The page always sends it.
- The step number in `step_viewed` and `step_answered` is the step's 1-based position in the flow config's `steps` list (1 to 3 for the demo).
- The consumer retries a message it cannot parse on its own, so it ends in the dead letter queue after 10 retries, and acknowledges the rest of the batch. A D1 failure retries the whole batch.
- The outbox script is a JavaScript string in `src/pages/outbox.ts`, unit-tested in Node by evaluating it. The browser-level test of the whole page stays in stage 7.

## Global Constraints

- Everything committed is in English. No secrets, tokens, account ids, real emails or other personal data in any committed file. Tests use `user1@example.com`, `user2@example.com` and other `@example.com` addresses only.
- The email from the quiz never reaches an event, a Queue message, the events table, a log line, an error response or localStorage. (An email that a client itself writes into a string value of an unknown event type is the accepted risk R-23.) The UserID never appears in a URL or a log line. Log lines are one JSON object each and name fields, never values from the request body; an event's `type` may be logged because the envelope schema limits it to `^[a-z][a-z0-9_]{0,63}$`.
- Every Queue send goes through `sendEvent()` in `src/events/producer.ts`, with content type `json` (ADR 0005, needed by the redrive script). No other file calls `EVENTS_QUEUE.send`.
- Test names start with the requirement id, then any R-/Q- id, then plain words. Unit tests go in `tests/unit/`, integration tests in `tests/integration/`, shared helpers in `tests/fixtures/`.
- Each new file under `src/` opens with a comment of two or three lines naming the component, the ADR it implements and the requirement ids it serves. `src/events/consumer.ts` also says that stage 5 replaces its D1 write with R2 files.
- Raw SQL in `src/db/` only. A D1 query binds at most 100 parameters. Times are Unix milliseconds in UTC.
- No new runtime or dev dependency.
- Run wrangler as `pnpm exec wrangler ...`. Filter tests with `pnpm test -t "X"`, never `pnpm test -- -t "X"`, which runs everything (stage 1 notes).
- Work happens on branch `part2-stage-2`. Each task commits there. Nothing is pushed until Arthur approves the stage.

## Known setup traps

From stages 0 and 1, still true: `compatibility_date` stays `2026-11-03`; test-only bindings are declared by augmenting `Cloudflare.Env` in `tests/env.d.ts`; `wrangler types` needs `--strict-vars=false`; V8's `JSON.parse` error message quotes part of the input, so a parse error is never logged; tests never assert global row counts, each makes its own user with a fresh `uid` cookie; two requests in a row can see the same `Date.now()`.

New for this stage:
- With `SELF.fetch`, events go to the real local Queue, and miniflare may deliver them to the consumer about 30 seconds later, during another test. Tests that check events use `call()` from `tests/fixtures/events.ts` with a captured Queue and feed the consumer themselves with `deliver()`. No test asserts a global count of the `events` table.
- `waitUntil` work finishes after the response. `call()` awaits `waitOnExecutionContext(ctx)` before it returns, so the captured Queue holds the server events when the test reads it.
- Check the exact shapes in `node_modules/@cloudflare/vitest-plugin/types/cloudflare-test.d.ts` before writing the fixtures: `createMessageBatch(queueName, messages)` takes `{ id, timestamp, attempts, body }` objects, and `getQueueResult(batch, ctx)` returns `outcome`, `ackAll`, `retryBatch`, `explicitAcks` and `explicitRetries`.
- Zod 4 `z.strictObject` reports unknown keys as one `unrecognized_keys` issue with an empty path. Map it to the field name `<unknown>`; a client-chosen key name never goes into a response or a log.
- oxlint may flag `new Function` in the outbox test. Disable the rule for that one line with a comment that says why.
- `crypto.randomUUID()` in the browser needs a secure context. `http://localhost` and the `workers.dev` URL both count; a LAN IP over plain HTTP does not.

## Review Focus

- The Queue is down while a user takes the quiz: the page and the completion must still answer `200` with the right offer, and the browser must keep its events. Task 4 tests the entry and the completion with a failing Queue; Task 3 tests the `503` with `Retry-After`; Task 5 tests that the outbox keeps the event.
- The browser goes offline between two steps: the event must stay in localStorage and be sent later with the same `event_id`, after a reload too, and stored once. Task 5 (outbox) and Task 2 (one row per `event_id`) test it.
- A hostile event body (a JSON array, 5 KB of payload, a `lead` type, an extra top-level `email`, cut-off JSON around an email) must give `400` or `413`, send nothing and log no email. Task 3 tests each.
- The Queue delivers the same event twice, in one batch or in two batches: one row. Task 2 tests both.
- One malformed message in a batch must not hold back the other events of the batch. Task 2 tests a batch of valid, malformed, valid.

---

### Task 1: the envelope check and `sanitizePayload`

**Files:**
- Create: `src/events/envelope.ts`, `src/events/sanitize.ts`, `tests/fixtures/event-bodies.ts`, `tests/unit/envelope.test.ts`, `tests/unit/sanitize.test.ts`
- Modify: `docs/requirements/risks.md` (row R-23 in "Security and personal data": risk "A client release puts an email into the payload of an event type the Worker does not know"; effect "Personal data in the Queue, R2 and BigQuery, which are expensive to purge (Q-16)"; mitigation "`sanitizePayload()` in the producer removes every payload key whose name contains `email` and logs the count. An email inside a string value, such as a page URL with `?email=`, is not removed: accepted risk (Arthur, 2026-11-05)"; how we check `R-23 R-12 an email field in the payload of an unknown type is removed before the Queue`), `docs/design/data-model.md` ("Personal data": the backstop sentence says the producer removes every payload key whose name contains `email` and logs the removal without the value, instead of rejecting the event, and that an email inside a string value is the accepted risk R-23; decision 1)

**Interfaces:**
- Consumes: `Flow` and `prelanderFlows` from `src/domain/flow.ts` and `src/domain/prelanders.ts` (stage 1).
- Produces, `src/events/envelope.ts`:
  - `BROWSER_TYPES = ["step_viewed", "step_answered"] as const`
  - `SERVER_TYPES = ["prelander_viewed", "quiz_completed", "offer_selected", "offer_click", "lead", "purchase"] as const`, `type ServerType = (typeof SERVER_TYPES)[number]`
  - `type IncomingEvent = { event_id: string; schema_version: number; type: string; client_time: number; visit_id: string; seq: number; prelander_id: string; payload: Record<string, unknown> }`
  - `type StoredEvent = { event_id: string; schema_version: number; type: string; client_time: number | null; received_at: number; user_id: string | null; visit_id: string; seq: number | null; prelander_id: string; payload: Record<string, unknown> }`
  - `storedEventSchema` (Zod, the `StoredEvent` shape; the consumer uses it)
  - `type CheckError = "invalid_body" | "server_only_type" | "unknown_prelander"`
  - `checkIncoming(raw: unknown, flows: ReadonlyMap<string, Flow>): { ok: true; event: IncomingEvent } | { ok: false; error: CheckError; fields: string[] }`
  - `makeServerEvent(input: { type: ServerType; userId: string | null; visitId: string; prelanderId: string; payload: Record<string, unknown>; now: number }): StoredEvent`
- Produces, `src/events/sanitize.ts`:
  - `sanitizePayload(payload: Record<string, unknown>): { payload: Record<string, unknown>; removed: number }`, pure, never changes its input
- Produces, `tests/fixtures/event-bodies.ts` (pure, no `cloudflare:test` import, so unit and integration tests both use it): `browserEvent(overrides?: Record<string, unknown>): Record<string, unknown>`, a `step_answered` for prelander `demo`: `{ event_id: crypto.randomUUID(), schema_version: 1, type: "step_answered", client_time: 1762300000000, visit_id: "v1", seq: 2, prelander_id: "demo", payload: { step: 1, question_key: "gender", value: "women" } }` with `overrides` spread over it

Envelope rules, in this order:
1. `raw` must be a plain object; an array, `null` or a primitive gives `invalid_body` with `fields: []`.
2. Keys `user_id` and `received_at` are dropped.
3. `z.strictObject`: `event_id` a UUID (`z.uuid()`), `schema_version` an integer 1 to 1000, `type` matching `^[a-z][a-z0-9_]{0,63}$`, `client_time` an integer ≥ 0, `visit_id` and `prelander_id` matching `^[A-Za-z0-9_-]{1,64}$`, `seq` an integer 1 to 10,000, `payload` an object. Failures give `invalid_body` with the failing envelope field names, and `<unknown>` for unknown keys.
4. A type in `SERVER_TYPES` gives `server_only_type`.
5. No flow for `prelander_id` gives `unknown_prelander`.
6. Only for `schema_version` 1: `step_viewed` payload is strictly `{ step, prefilled }` with `step` an integer from 1 to the flow's step count and `prefilled` a boolean; `step_answered` payload is strictly `{ step, question_key, value }`, where `question_key` names a choice step of the flow, `step` is that step's position, and `value` is one of its option values. Failures give `invalid_body` with fields such as `payload.value`, and `payload.<unknown>` for unknown keys. Any other type, and any other version, passes with its payload unchecked.

`sanitizePayload` rules: walk objects and arrays at any depth; drop a key when its lower-cased name contains `email`; leave every value, strings included, unchanged. `removed` counts dropped keys.

- [ ] **Step 1: Write the failing tests and `tests/fixtures/event-bodies.ts`.**

  `tests/unit/envelope.test.ts`, against `prelanderFlows`:
  - `ID-1 a valid step_answered passes unchanged`: `{ ok: true, event: <the body> }`.
  - `ID-1 event without event id is rejected`: `{ ok: false, error: "invalid_body", fields: ["event_id"] }`. `ID-1 event id that is not a UUID is rejected`: same, for `"abc"`.
  - `ID-1 a request with more than one event is rejected`: `[browserEvent(), browserEvent()]` gives `invalid_body` with `fields: []`.
  - `ID-2 user id and received_at in the body are dropped`: with both added, `ok` is true and the event has neither key.
  - `R-12 envelope has no email field: an unknown envelope field is rejected`: with `email: "user2@example.com"` added, `fields` equals `["<unknown>"]` and `JSON.stringify(result)` does not contain `user2`.
  - `BIZ-2 a client cannot post a server-only type`: each of the six server types gives `server_only_type`.
  - `QZ-1 unknown prelander is rejected`: `prelander_id: "nope"` gives `unknown_prelander`.
  - `QZ-4 step_answered value must be one of the step's options`: `value: "robots"` gives `fields: ["payload.value"]`; `question_key: "email"` gives `fields` containing `payload.question_key`; `step: 2` with `gender` gives `fields` containing `payload.step`; an extra payload key gives `fields` containing `payload.<unknown>`.
  - `QZ-4 step_viewed step must be within the flow`: `{ step: 4, prefilled: false }` is rejected with `payload.step`; `{ step: 3, prefilled: false }` passes.
  - `ID-4 unknown schema_version is passed without a payload check`: `step_answered` with `schema_version: 2` and payload `{ anything: "x" }` passes.
  - `ID-4 unknown event type is passed`: `type: "share_clicked"`, payload `{ target: "x" }` passes.
  - `R-14 type, visit id and prelander id are length-limited`: a 65-character `type`, a 65-character `visit_id` and `seq: 0` are each rejected.
  - `ID-1 server events get a fresh UUID, version 1, and no client time or seq`: two `makeServerEvent` calls give different UUID `event_id`s, `schema_version: 1`, `client_time: null`, `seq: null`, `received_at` equal to `now`.

  `tests/unit/sanitize.test.ts`:
  - `R-23 R-12 a key named email is removed at any depth`: `{ email: "a", nested: { userEmail: "b" }, list: [{ EMAIL: "c" }], keep: 1 }` gives `{ nested: {}, list: [{}], keep: 1 }` and `removed: 3`.
  - `R-23 string values are left unchanged`: `{ url: "https://x.example/?e=user2@example.com" }` is unchanged with `removed: 0` (decision 1: strings are not touched).
  - `R-23 the demo's step payloads are unchanged`: `{ step: 1, question_key: "gender", value: "women" }` gives an equal object and `removed: 0`.
  - `R-23 sanitizing does not change its input`: the input, deep-frozen, still deep-equals its copy after the call.
- [ ] **Step 2: Run `pnpm test -t "ID-1|ID-2|ID-4|BIZ-2|QZ-4|R-12|R-14|R-23"`.** Expected: FAIL, `src/events/envelope.ts` cannot be resolved.
- [ ] **Step 3: Write `src/events/envelope.ts` and `src/events/sanitize.ts`; add R-23 to risks.md and correct the data-model.md sentence.**
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`.** Expected: all pass, exit 0.
- [ ] **Step 5: Commit** `feat: event envelope check and payload sanitizing`.

### Task 2: events table writes and the Queue consumer

**Files:**
- Create: `src/db/events.ts`, `src/events/consumer.ts`, `tests/fixtures/events.ts` (the consumer half), `tests/unit/events-sql.test.ts`, `tests/integration/consumer.test.ts`
- Modify: `src/index.ts` (the `queue` handler calls `consumeEvents(batch, env.EVENTS)`; the placeholder comment goes)

**Interfaces:**
- Consumes: `StoredEvent`, `storedEventSchema`, `makeServerEvent`, `SERVER_TYPES` (Task 1).
- Produces, `src/db/events.ts`:
  - `type Statement = { sql: string; params: (string | number | null)[] }`
  - `EVENT_COLUMNS`: `event_id, schema_version, type, client_time, received_at, user_id, visit_id, seq, prelander_id, payload` (10 columns), `ROWS_PER_INSERT = 9` (90 bound parameters)
  - `eventInsertStatements(events: readonly StoredEvent[]): Statement[]`, pure: multi-row `INSERT INTO events (...) VALUES (...), ... ON CONFLICT (event_id) DO NOTHING`, `payload` as `JSON.stringify` text; `[]` for no events
  - `insertEvents(db: D1Database, events: readonly StoredEvent[]): Promise<void>`: one `db.batch` of those statements (one transaction); does nothing for an empty list
- Produces, `src/events/consumer.ts`: `consumeEvents(batch: MessageBatch<unknown>, db: D1Database): Promise<void>`. Each body is parsed with `storedEventSchema`. A message that does not parse gets `msg.retry()` and the log line `{"msg":"consumer_invalid_message","id":<message id>}`. The valid ones go to `insertEvents`; on success each gets `msg.ack()`, on failure the handler logs `{"msg":"consumer_write_failed","count":n}` and calls `batch.retryAll()`. A last line logs `{"msg":"consumer_batch","stored":n,"invalid":m}`.
- Produces, `tests/fixtures/events.ts`:
  - `storedEvent(overrides?: Partial<StoredEvent>): StoredEvent`: a valid `step_viewed` with a fresh `event_id`, `user_id` a fresh UUID, `visit_id` `"v1"`, `seq` 1, `received_at` `Date.now()`
  - `deliver(bodies: readonly unknown[], db?: D1Database): Promise<QueueResult>`: builds a batch with `createMessageBatch("events", ...)`, message ids `m0`, `m1`, ...; without `db` it runs the Worker's own handler (`worker.queue(batch, env, ctx)` from `src/index.ts`), with `db` it runs `consumeEvents(batch, db)`; returns `getQueueResult(batch, ctx)`
  - `eventsOf(userId: string): Promise<{ event_id: string; type: string; schema_version: number; visit_id: string; seq: number | null; client_time: number | null; payload: Record<string, unknown> }[]>`: the user's rows from `env.EVENTS`, ordered by `received_at`, `seq`, payload parsed

- [ ] **Step 1: Write the failing tests.** `tests/unit/events-sql.test.ts`:
  - `ID-4 100 events become statements of at most 9 rows and 90 bound parameters`: 12 statements, the last with one row; every `params.length` ≤ 90; 1,000 parameters in total.
  - `ID-1 every insert ignores a repeated event id`: every `sql` contains `ON CONFLICT (event_id) DO NOTHING`.
  - `ID-4 payload is stored as JSON text`: the payload parameter of a row equals `JSON.stringify(payload)`.
  - `ID-4 no events give no statements`.

  `tests/integration/consumer.test.ts` (each test uses its own `user_id`):
  - `TEST-3 R-3 resending the same event stores it once`: one event twice in one batch, then again in a second batch; `eventsOf` gives one row; both results ack every message.
  - `ID-1 every stored event has a unique event id`: three events plus a repeat of the first give three rows with three distinct ids.
  - `BIZ-2 every event type in the catalog is accepted and stored`: `step_viewed` and `step_answered` from `storedEvent`, the six server types from `makeServerEvent` (`lead` and `purchase` with the same `userId` as the rest), delivered in one batch; `eventsOf` gives the eight types.
  - `ID-4 unknown schema_version is stored and not dropped`: `schema_version: 2`, payload `{ anything: { nested: true } }` comes back unchanged.
  - `ID-4 a batch of 100 events is stored`: 100 rows for the user.
  - `NFR-8 R-3 events arriving out of order are all stored and leave D1 unchanged`: `step_answered` with `seq` 2, then with `seq` 1, in two batches; two rows ordered by `seq` when `received_at` is equal; `user_answers` in `env.FACTS` has no row for the user.
  - `NFR-8 a D1 failure retries the whole batch`: `deliver(bodies, failingDb)` where `failingDb.batch` rejects; `retryBatch.retry` is true and `explicitAcks` is empty.
  - `NFR-8 a malformed message is retried alone and the rest are stored`: `[valid, { foo: 1 }, valid]` gives two rows, `explicitRetries` `["m1"]`, `explicitAcks` containing `m0` and `m2`.
  - `NFR-5 the Worker's queue handler stores the batch`: `deliver([event])` without `db` gives the row.
- [ ] **Step 2: Run `pnpm test -t "ID-1|ID-4|TEST-3|BIZ-2|NFR-5|NFR-8"`.** Expected: FAIL, `src/db/events.ts` cannot be resolved.
- [ ] **Step 3: Write `src/db/events.ts`, `src/events/consumer.ts`, the fixtures, and switch the `queue` handler in `src/index.ts`.**
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`.** Expected: all pass, exit 0.
- [ ] **Step 5: Commit** `feat: queue consumer writes events to the events database`.

### Task 3: the producer and `POST /api/events`

**Files:**
- Create: `src/events/producer.ts`, `src/routes/events.ts`, `tests/integration/events-route.test.ts`
- Modify: `src/app.ts` (mount `eventsRoute(flows)` under `/api`), `tests/fixtures/events.ts` (the request half), `docs/requirements/nfr.md` (a row in "Set in stage 4", even though it is set here: ID NFR-2, figure "Body limit of `POST /api/events`", value "4 KB (4,096 bytes); larger bodies get `413`", arithmetic "one event is about 1 KB (ADR 0005), four times headroom", source "Part 2 stage 2, 2026-11-05"), `docs/testing/acceptance-checks.md` (the event ingestion row of the endpoints table: the 4 KB limit and `413`, `400` for unknown envelope fields and server-only types, `user_id` and `received_at` in the body dropped, emails removed from the payload; the `answer()` helper, see below)

**Interfaces:**
- Consumes: `checkIncoming`, `StoredEvent`, `ServerType`, `makeServerEvent`, `browserEvent` (Task 1); `sanitizePayload` (Task 1); `deliver`, `eventsOf` (Task 2); `AppEnv`, `createApp` (stage 1).
- Produces, `src/events/producer.ts`:
  - `sendEvent(queue: Queue, event: StoredEvent): Promise<void>`: `sanitizePayload(event.payload)`; when `removed > 0`, logs `{"msg":"payload_sanitized","type":event.type,"removed":n}`; then `queue.send(cleanEvent, { contentType: "json" })`. Rejects when the Queue rejects.
  - `emitInBackground(ctx: ExecutionContext, queue: Queue, events: readonly StoredEvent[]): void`: `ctx.waitUntil(...)` over `sendEvent` for each event; a failed send logs `{"msg":"queue_send_failed","source":"server","type":event.type}` and never throws.
- Produces, `POST /api/events` in `src/routes/events.ts`, `eventsRoute(flows: ReadonlyMap<string, Flow>): Hono<AppEnv>`. Order:
  1. A `content-length` header over 4,096, or a body text over 4,096 bytes (`new TextEncoder().encode(text).length`), gives `413 {"error":"too_large"}`.
  2. `JSON.parse` in a `try` that logs nothing about the error; failure gives `400 {"error":"invalid_body","fields":[]}`.
  3. `checkIncoming`; failure gives `400 {"error":<error>,"fields":[...]}` and logs `{"msg":"event_rejected","error","fields"}`.
  4. `sendEvent(c.env.EVENTS_QUEUE, { ...event, user_id: c.get("userId"), received_at: Date.now() })`, then `202 {"ok":true}`. If the send rejects: log `{"msg":"queue_send_failed","source":"api_events"}` and answer `503 {"error":"unavailable"}` with `Retry-After: 30`, with a comment that stage 5 writes to R2 `pending/` before giving up.
- Produces, `tests/fixtures/events.ts` (added):
  - `captureQueue(): { queue: Queue; sent: { body: StoredEvent; contentType: string | undefined }[] }`, `failingQueue(): Queue` (every `send` rejects)
  - `call(path: string, init: { method?: string; cookie?: string; body?: string }, envOverride?: Partial<Env>, app?: Hono<AppEnv>): Promise<Response>`: `app.fetch` with `createExecutionContext()` (default app `createApp(prelanderFlows)`), awaiting `waitOnExecutionContext(ctx)` before it returns
  - `postEvent(event: unknown, cookie: string, envOverride?: Partial<Env>): Promise<Response>`: `call("/api/events", ...)`; a string `event` is sent as is
- Produces, the card helper in acceptance-checks.md, replacing the old one:

```sh
answer() { # answer <jar> <question_key> <value> [seq]: one step_answered event, analytics only
  step=$([ "$2" = gender ] && echo 1 || echo 2)
  curl -s -b "$1" -c "$1" -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/events" -H 'content-type: application/json' \
    -d "{\"event_id\":\"$(uuidgen | tr A-Z a-z)\",\"schema_version\":1,\"type\":\"step_answered\",\"client_time\":$(date +%s)000,\"visit_id\":\"v1\",\"seq\":${4:-1},\"prelander_id\":\"demo\",\"payload\":{\"step\":$step,\"question_key\":\"$2\",\"value\":\"$3\"}}"
}
```

  and every use of it: `answer $JAR quiz_step1 women` becomes `answer $JAR gender women`, `quiz_step2 asia` becomes `ethnicity asia`, the NFR-8 step `answer $JAR quiz_step1 women 2` becomes `answer $JAR gender women 2` (and `men 1` likewise), and the QZ-4 manual step 1 likewise. Each `answer` line in the demo script gets the comment `# 202`.

- [ ] **Step 1: Write the failing tests** in `tests/integration/events-route.test.ts`, each with a fresh cookie and `captureQueue()` passed as `EVENTS_QUEUE`; log tests spy on `console.log`, `console.error` and `console.warn`:
  - `TEST-3 R-3 the same body posted twice is accepted twice and stored once`: two `202`s, two sends with the same `event_id`; `deliver` of both bodies gives one row in `eventsOf`.
  - `NFR-5 events go to the Queue as json with the user id and receive time`: `contentType` is `"json"`; the body's `user_id` is the cookie's id and `received_at` is a number within the test's time window.
  - `ID-2 user id in the event body is ignored`: a body `user_id` of another UUID; the sent `user_id` is the cookie's.
  - `ID-1 event without event id is rejected and nothing is sent`: `400`, `sent` empty.
  - `BIZ-2 a client cannot post a server-only type`: `type: "lead"` gives `400 {"error":"server_only_type"...}`, `sent` empty.
  - `R-12 envelope has no email field: an event carrying one never reaches the Queue`: a top-level `email: "user2@example.com"` gives `400`; `sent` is empty; neither the response text nor any captured log argument contains `user2@example`.
  - `R-23 R-12 an email field in the payload of an unknown type is removed before the Queue`: `type: "page_error"`, payload `{ email: "user2@example.com", nested: { contactEmail: "user2@example.com" }, page: 2 }` gives `202`; `JSON.stringify(sent)` does not contain `user2`; the sent payload is `{ nested: {}, page: 2 }`; a log line has `"msg":"payload_sanitized"` and `"removed":2`, and no log contains `user2`.
  - `R-12 a malformed event body with an email is rejected without logging it`: the raw text `{"event_id":"x","payload":{"note":"user2@example.com"` (cut short) gives `400`; no log and no response contains `user2@example`.
  - `R-14 an event body over 4 KB is rejected with 413`: a valid envelope with a payload string of 5,000 characters gives `413`, `sent` empty.
  - `NFR-4 the event answers 503 with Retry-After when the Queue refuses`: with `failingQueue()`, `503`, header `Retry-After` is `30`.
  - `QZ-4 answer events do not change D1`: `step_answered` for `gender` and `ethnicity` give `202`s; `users` and `user_answers` in `env.FACTS` have no row for the cookie's id.
- [ ] **Step 2: Run `pnpm test -t "TEST-3|NFR-4|NFR-5|ID-1|ID-2|BIZ-2|R-12|R-14|R-23|QZ-4"`.** Expected: the new tests FAIL with `404`.
- [ ] **Step 3: Write `src/events/producer.ts` and `src/routes/events.ts`, mount the route, extend the fixtures, and edit nfr.md and acceptance-checks.md as listed under Files.** Then `grep -n "quiz_step" docs/testing/acceptance-checks.md` prints nothing.
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`.** Expected: all pass, exit 0. Then `grep -rn "EVENTS_QUEUE.send\|\.send(" src/` shows the one call in `src/events/producer.ts`.
- [ ] **Step 5: Commit** `feat: event ingestion endpoint through the Queue`.

### Task 4: server events, the visit id and the events in test state

**Files:**
- Create: `tests/integration/visit-events.test.ts`
- Modify: `src/routes/prelander.ts`, `src/routes/complete.ts`, `src/pages/quiz.ts` (markup only: `data-visit` and `data-step-number`; the script changes in Task 5), `src/routes/test.ts`, `src/db/test-state.ts`, `tests/integration/test-routes.test.ts`, existing callers of `renderQuizPage`

**Interfaces:**
- Consumes: `makeServerEvent`, `emitInBackground` (Tasks 1 and 3); `browserEvent` (Task 1); `deliver`, `eventsOf` (Task 2); `call`, `captureQueue`, `failingQueue`, `postEvent` (Task 3).
- Produces, entry: `GET /p/:prelander` makes `visitId = crypto.randomUUID()` on every request, renders it, and emits `prelander_viewed` with payload `{ reason: "quiz" }`, the request's user id, `visit_id` and `prelander_id`. Stage 3 adds `lead_return` and `skip` together with the redirect. An unknown prelander emits nothing.
- Produces, completion: after a successful selection, `POST /api/complete` emits `quiz_completed` with payload `{ answers: <the validated answers> }` and `offer_selected` with payload `{ offer_id: <id or null>, reason, moment: "completion", catalog_version }`. `visit_id` is the body's, or a fresh UUID when it is missing; `prelander_id` is the body's. A `400` or `500` emits nothing.
- Produces, `src/pages/quiz.ts`: `renderQuizPage(flow: Flow, prelanderId: string, visitId: string): string`; `<main>` carries `data-visit="<visitId>"`, each step section carries `data-step-number="<1-based position in flow.steps>"`.
- Produces, `src/db/test-state.ts`: `readTestEvents(events: D1Database, userId: string): Promise<{ events: { event_id: string; type: string; visit_id: string; seq: number | null; schema_version: number; payload: unknown }[]; total: number }>`, the user's events ordered by `received_at`, `seq`, and the total row count of the table. `GET /__test/state` adds `me.events` and `counts.events`.

- [ ] **Step 1: Write the failing tests** in `tests/integration/visit-events.test.ts`, with `captureQueue()` unless the case says otherwise. `visitIdOf(html)` reads `data-visit`.
  - `ID-1 entry emits prelander_viewed with the page's visit id`: `GET /p/demo` gives one sent event: `type` `prelander_viewed`, payload `{ reason: "quiz" }`, `visit_id` equal to the page's, `user_id` equal to the cookie's, `client_time` and `seq` null, `prelander_id` `demo`.
  - `QZ-4 Q-26 each page load gets a new visit id`: two loads with one cookie give two different UUIDs.
  - `QZ-4 offer_selected carries reason and catalog version`: completion with `visit_id` from the page gives `quiz_completed` with payload `{ answers: { gender: "women", ethnicity: "asia" } }` and `offer_selected` with payload `{ offer_id: "003", reason: "best_epu", moment: "completion", catalog_version: <number> }`, both with the page's `visit_id`; `JSON.stringify(sent)` contains no `@`.
  - `QZ-4 a completion without a visit id gets one from the Worker`: both events carry the same UUID `visit_id`.
  - `ID-4 quiz run stores properties and the visit events`: entry; five browser events through `postEvent` with the page's `visit_id` and `seq` 1 to 5 (`step_viewed` 1, `step_answered` gender women, `step_viewed` 2, `step_answered` ethnicity asia, `step_viewed` 3); completion; `deliver` of every captured body. `eventsOf` gives 8 rows: `prelander_viewed` 1, `step_viewed` 3, `step_answered` 2, `quiz_completed` 1, `offer_selected` 1; one `visit_id` for all; 8 distinct `event_id`s. The `users` row exists. No row contains `user1@example.com`.
  - `NFR-4 entry and completion answer while the Queue refuses`: with `failingQueue()`, `GET /p/demo` gives `200`, completion gives `200` with `offer_id` `003`, and a log line has `"msg":"queue_send_failed"`.
  - `NFR-8 R-3 the completion received last decides the stored answers`: completion as women+asia, then a later `step_answered` for `gender` `men` gives `202`; `user_answers` still holds `gender` = `"\"women\""`.
  - `QZ-5 reload before completion starts from step 1`: a `step_answered` for `gender`, then `GET /p/demo` with the same cookie; the `gender` section has no `hidden` attribute, the `ethnicity` section has one.

  `tests/integration/test-routes.test.ts`:
  - `ID-4 test state lists the caller's events`: after `deliver` of two events for the cookie's user, `me.events` has two entries in `seq` order, and `counts.events` is a number ≥ 2.
  - The existing `R-12 test state never shows the email or its ciphertext` also passes with the events in the state.
- [ ] **Step 2: Run `pnpm test -t "ID-1|ID-4|QZ-4|QZ-5|NFR-4|NFR-8"`.** Expected: the new tests FAIL (no events sent, no `data-visit`).
- [ ] **Step 3: Change the entry, completion, page markup and test routes as listed.**
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`.** Expected: all pass, exit 0, the stage 1 tests included.
- [ ] **Step 5: Commit** `feat: server events at entry and completion`.

### Task 5: the browser sender

**Files:**
- Create: `src/pages/outbox.ts`, `tests/unit/outbox.test.ts`
- Modify: `src/pages/quiz.ts` (the script), `tests/integration/prelander.test.ts`

**Interfaces:**
- Consumes: the page markup of Task 4 (`data-visit`, `data-step-number`); `POST /api/events` (Task 3).
- Produces, `src/pages/outbox.ts`: `OUTBOX_SCRIPT: string`, plain browser JavaScript (no build, no modules, no arrow-function-only features beyond what the existing page script uses) that defines `function createOutbox(opts)`:
  - `opts`: `{ storage: { getItem(k), setItem(k, v) } | null, send: (event) => Promise<number>, key: string, cap: number }`. `send` resolves to the HTTP status and rejects on a network error.
  - Returns `{ enqueue(event), flush(), pending() }`. `enqueue` appends, keeps at most `cap` events by dropping the oldest, saves, and calls `flush`. `flush` sends the first pending event if nothing is in flight; on a status from 200 to 499 other than 408 and 429 it removes that event, saves, and goes on to the next; on 408, 429, 5xx or a rejection it keeps the event and stops. `pending()` returns a copy of the list.
  - Storage is read once at creation and written after every change; a throwing or missing storage makes the outbox work in memory without errors.
- Produces, the page script in `src/pages/quiz.ts`: embeds `OUTBOX_SCRIPT` and creates one outbox with key `funnel_outbox_v1`, cap 100, and `send` as `fetch("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event), keepalive: true }).then(r => r.status)`. `track(type, payload)` builds the envelope (`event_id: crypto.randomUUID()`, `schema_version: 1`, `client_time: Date.now()`, the page's `visit_id` and `prelander_id`, `seq` counting from 1 per page load) and enqueues it. On load: `flush()` (events left by an earlier load go first), then `step_viewed` for the first step. On a choice: `step_answered` with `{ step, question_key, value }`, then `step_viewed` for the next step when there is one. On the `online` event: `flush()`. The completion body adds `visit_id`. The email step sends no event, and the email input's value is never passed to `track`.

- [ ] **Step 1: Write the failing tests.** `tests/unit/outbox.test.ts` gets `createOutbox` with `new Function(OUTBOX_SCRIPT + "; return createOutbox;")()`, a storage backed by a `Map`, and a `send` mock whose answers each test controls:
  - `ID-1 events are sent one per request, in order, one at a time`: three `enqueue`s while the first send is unresolved; `send` has one call; after resolving each with 202, the calls are a, b, c.
  - `TEST-3 R-3 an event that failed to send is resent with the same event id`: the first send rejects; after `flush()` the second call gets the same object with the same `event_id`.
  - `NFR-4 a 503 or 429 keeps the event, a 202 or 400 removes it`.
  - `R-3 events left in storage are sent after a reload`: an outbox whose send rejects leaves one event in storage; a new outbox over the same storage sends it on `flush()`.
  - `R-14 the outbox keeps at most 100 events, dropping the oldest`: with every send rejected, 101 `enqueue`s leave 100, the first of them the second event.
  - `R-12 the outbox works when storage throws`: `getItem` and `setItem` throw; `enqueue` still sends.

  `tests/integration/prelander.test.ts`:
  - `QZ-4 the page sends step events to /api/events with its visit id`: the HTML contains `data-visit="<UUID>"`, `/api/events`, `createOutbox`, `funnel_outbox_v1`, and `data-step-number="1"`, `"2"` and `"3"`.
  - `QZ-7 a fourth step added to the flow config renders and is validated without a code change` still passes, with `data-step-number="4"` on the fourth step.
- [ ] **Step 2: Run `pnpm test -t "ID-1|TEST-3|NFR-4|R-3|R-14|R-12|QZ-4|QZ-7"`.** Expected: the outbox tests FAIL, `src/pages/outbox.ts` cannot be resolved.
- [ ] **Step 3: Write `src/pages/outbox.ts` and the page script.**
- [ ] **Step 4: Run the gate:** `pnpm typecheck && pnpm lint && pnpm fmt:check && pnpm test`. Expected: exit 0, all pass.
- [ ] **Step 5: Check the page against `wrangler dev`.** With `.dev.vars` and the local seed from stage 1, `pnpm migrate:local` and `pnpm dev`, open `http://localhost:8787/p/demo`, answer women, asia and `user1@example.com`. Expected: the network tab shows five `POST /api/events` answered `202` and one `POST /api/complete`; no request body of `/api/events` contains `user1`; `localStorage.funnel_outbox_v1` is `[]` at the end. Then DevTools offline, reload, answer women, go back online, answer asia. Expected: the event sent while offline goes out after reconnecting with the `event_id` it had in localStorage. After about 30 seconds, `curl -s -b <the browser's uid cookie> http://localhost:8787/__test/state | jq '.me.events | length'` prints the number of events sent from that browser (8 for the first run).
- [ ] **Step 6: Run the stage checks.** `pnpm test -t "TEST-3|ID-1|ID-2|ID-4|BIZ-2|QZ-4|QZ-5|NFR-4|NFR-5|NFR-8|R-12|R-23"`; `grep -rni "current_step" migrations/ src/` (QZ-5); `grep -rnE "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}" src tests config scripts | grep -v "@example\.com"`; `for f in src/*/*.ts; do head -3 "$f" | grep -q "ADR" || echo "$f"; done`. Expected: the test run passes; the three commands print nothing.
- [ ] **Step 7: Commit** `feat: quiz page sends events through a local outbox`.

### After the tasks: Arthur's part and closing

- [ ] Explain back. Arthur follows one `step_answered` from the click in the browser to its row: outbox and localStorage, `POST /api/events`, `checkIncoming`, `sendEvent` with `sanitizePayload`, the Queue, `consumeEvents`, `insertEvents`, the row. Then he says what happens when the same event is sent twice (two `202`s, two messages, one row through `ON CONFLICT (event_id) DO NOTHING`), and what happens when the Queue is down (the page and the completion still work; the browser keeps the event and resends it). The AI points at every difference from the code.
- [ ] Docs in the closing commit: in part2-mvp-stages.md, stage 2 "Content", the sentence "(the schema is strict, so an email has no field to travel in and no content filter is needed)" becomes "(the schema is strict, so an email has no field of its own, and `sanitizePayload()` in the producer removes every payload key whose name contains `email`, decision 1 of the stage 2 plan)"; a `docs/ai/plan-history.md` entry for decision 1; the stage 2 row of "What to show at the review" checked against what was built.
- [ ] Approval. Squash-merge `part2-stage-2` into `main` as `feat: event ingestion through the Queue`, with `docs/state/progress.json` (stage 2 done, stage 3 next, decision 1 and the settled points in `notes`), and push.
- [ ] After CI deploys, against `BASE` (the workers.dev URL), with the helpers from acceptance-checks.md: `curl -s $BASE/healthz` prints the merge commit's sha. `curl -s -X POST $BASE/__test/reset`, then `curl -s -c $JAR -b $JAR -o /dev/null $BASE/p/demo`, then the body `answer()` sends for `gender women`, saved once to `$TMP/e.json` so its `event_id` stays the same, posted twice with `curl -s -b $JAR -o /dev/null -w '%{http_code}\n' -X POST $BASE/api/events -H 'content-type: application/json' -d @$TMP/e.json`. Expected: `202` twice; after 35 seconds `state $JAR | jq '.me.events | length'` prints 2 (the entry's `prelander_viewed` and the one event, stored once). Then one browser visit through completion on `$BASE/p/demo`, and after 35 seconds `curl -s -b <the browser's uid cookie> $BASE/__test/state | jq '[.me.events[].type] | group_by(.) | map({(.[0]): length}) | add'` prints `prelander_viewed` 1, `step_viewed` 3, `step_answered` 2, `quiz_completed` 1, `offer_selected` 1: 8 events (the ninth, `offer_click`, comes in stage 3). Paste the outputs into the stage notes.
