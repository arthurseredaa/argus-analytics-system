# Part 2 stage 3: redirect, postbacks and the Lead return, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a press on the offer button becomes a stored click and a `302` to the partner with the `click_id`; a returning user with a Lead goes straight to the offer; a signed postback lands on the right click, user and offer exactly once, and a rejected one changes nothing.

**Architecture:** the transition has one shared helper, `startTransition()` in `src/routes/transition.ts`, used by `GET /go` and by the entry redirect: it writes the click to D1, emits `offer_click` and answers `302`. `GET /go` takes no offer id; it reads the user's facts by the cookie, runs `select(facts, catalog, "redirect")` and sends the user to the result (decision 1). `POST /postback/v1/:partner` checks the partner, the HMAC signature over the raw body and the timestamp, then the fields and the click, and writes `conversions` or `quarantine` synchronously (ADR 0007); its `lead` or `purchase` event is sent with an EventID derived from the dedup key and awaited. Two scripts let a reviewer sign a postback (`pnpm postback`) and change an offer (`pnpm offer`), and `POST /__test/seed` builds users with Leads for the cards.

**Tech Stack:** as stage 2 (TypeScript 5.9, Hono 4, Zod 4, wrangler 4.157, vitest 4 with `@cloudflare/vitest-plugin` 1.5.1). WebCrypto HMAC (`crypto.subtle.sign`, `crypto.subtle.verify`) in the Worker and in Node 24.

**Spec:** [part2-mvp-stages.md](part2-mvp-stages.md), section "Stage 3", as changed by decision 1. Read with it: [ADR 0007](../adr/0007-postback-contract-and-auth.md), whole; [ADR 0004](../adr/0004-offer-selection-semantics.md), "Shape of the selection code"; [design.md](../design/design.md#where-offer-status-is-checked-again), "Where offer status is checked again"; [data-model.md](../design/data-model.md), "Requests and what they touch", `partners`, `clicks`, `conversions`, `quarantine`, "Idempotency and ordering", "Types", "The nine events of a visit", "Trace of the demo"; the cards OFF-3, OFF-4, OFF-9, OFF-11, ID-3, PB-1 to PB-8, A-4, NFR-1, TEST-2, TEST-3, TEST-4, DEMO-3, DEMO-4, DEMO-6 in [acceptance-checks.md](../testing/acceptance-checks.md); the decision table in [offer-selection.md](../requirements/offer-selection.md).

## Decisions by Arthur

1. The transition takes no offer id (Arthur, 2026-11-05). The design had `GET /go/{offer}?prelander=&visit=`: if the offer in the path is active, the click is written for it. Writing this plan showed a gap: the server does not remember which offer it showed (the selection lives only in the `offer_selected` event, which the rules never read), and the page builds the link itself (`src/pages/quiz.ts`), so a user who edits the path to any active offer gets a click on it, recorded as `best_epu`. The AI proposed to accept that as a risk. Arthur's point: at the moment of the press D1 already holds everything selection needs, so the server can select by the cookie's user and nothing in the URL can be changed. A Fable review, given the options without the AI's recommendation, reached the same answer. So `GET /go?prelander=&visit=` reads the facts, runs `select()` with moment `redirect`, writes the click for the result and answers `302`. The click is made when the user presses the button, never when the offer is shown, so "went to an offer" (M-10) counts presses, and reloads of the result page add nothing. Re-checking a disabled offer (R-9) needs no branch of its own. The cost: if an operator changes the catalog between showing offer X and the press, the user goes to the new result, as R-9 already accepted for a disabled offer. `/go` emits `offer_click` only; `offer_selected` with moment `redirect` is dropped, because `offer_click` carries `offer_id`, `catalog_version` and `reason`, and a visit stays at nine events (A-1). Analytics finds "shown X, went to Y" by comparing `offer_selected` (completion) with `offer_click` within one `visit_id`. Rejected: keeping the offer in the path and recording an accepted risk (the AI's first proposal); an `/offer` page that returns the offer and a `click_id` on display (Arthur's first idea, dropped because every display and reload would make a click); a signed selection token or a stored selection (one more secret or a second source of truth beside `select()`).
2. `/go` from a user with no `users` row (Arthur, 2026-11-05): a new cookie, a user who skipped the quiz, a link opened in another browser. Default: `302` to `/p/{prelander}`, no click. Recorded as Q-30. It needs no branch: such a user has no answers and no Leads, so `select()` answers `quiz`.
3. Who can send a postback to the deployed demo (Arthur, 2026-11-05). `pnpm postback` signs with the test partner's secret, and the secrets of the deployed Worker exist only in Arthur's `.dev.vars.remote`. So a reviewer runs the whole scenario locally, with their own `.dev.vars` and seed (PB-7 checks this "from a fresh clone"), and the run against the deployed Worker is Arthur's. Arthur: "це окей що рецензент не зможе все зробити, в нього ж немає мого середовища". Rejected: a demo partner whose secret is published in the README (a secret in a committed file) and a `POST /__test/postback` route that signs on the server (anyone with the demo URL could forge postbacks). The README in stage 7 says this.

Settled here, each reversible:
- `click_id` is 32 lowercase hex characters from 16 bytes of `crypto.getRandomValues` (128 random bits; a UUID v4 has only 122). The partner gets it as the query parameter `click_id` on the offer URL (Q-6 default), set with `URL.searchParams`, so `https://asia-connect.example` becomes `https://asia-connect.example/?click_id=<id>`.
- `GET /go` needs `prelander`, a known prelander id, else `404` like `/p`. A missing or malformed `visit` is replaced by a Worker UUID, as `/api/complete` does. `HEAD /go` answers `405` and writes nothing (stage 2 found HEAD counted as an entry). Every `302` carries `cache-control: no-store`.
- The click's `reason` is the selection reason: `lead_return`, `best_epu` or `fallback_universal`.
- Entry, rule 1 and rule 3: when `select(..., "entry")` answers `redirect`, entry calls `startTransition()` with the page's new `visit_id`, and emits `prelander_viewed` with reason `lead_return` (selection reason `lead_return`) or `skip` (any other), plus `offer_selected` with moment `entry`: three events. When it answers `no_offer` (decision table row 21), entry renders the no-offer page with `prelander_viewed` (`skip`) and `offer_selected` (`no_offer`).
- The postback body limit is 16 KB (16,384 bytes) and gives `400 {"error":"too_large"}`, as ADR 0007 says (`/api/events` uses `413`; ADR 0007's table says `400`, and PB-8 expects `400` or `401`).
- Order in the postback route, each failure ending the request: path partner id against `^[A-Za-z0-9_-]{1,64}$`, else `401`; body size; partner row (unknown or `active = 0` gives `401`); signature and timestamp (`401`); `content-type` `application/json` (`400`); JSON and fields (`400`); click lookup (unknown gives quarantine and `202`); the click's offer belongs to the path partner (`400 click_partner_mismatch`); conversion insert; event send. Content type comes after the signature because PB-8 sends malformed requests with a valid signature and expects `400`.
- One `401` body for every authentication failure, `{"error":"unauthorized"}`; the log line names the reason (`unknown_partner`, `missing`, `malformed`, `stale`, `mismatch`).
- The HMAC key is the UTF-8 bytes of the partner secret string, as stored. The header is `t=<digits>,v1=<64 hex>`; more than one `v1` is allowed and any match passes. The timestamp window is 300 seconds either way.
- Body fields (ADR 0007): `type` `lead` or `purchase`; `click_id` matching `^[A-Za-z0-9_-]{1,128}$` (not our own format, so a foreign id reaches quarantine); `transaction_id` 1 to 128 printable ASCII characters (`^[\x21-\x7e]{1,128}$`); `occurred_at` an ISO 8601 UTC time (`z.iso.datetime()`), stored as Unix milliseconds; optional `payout` matching `^\d{1,10}(\.\d{1,4})?$` (so a negative payout is `400`), optional `currency` matching `^[A-Z]{3}$`, optional `partner_user_id` of 1 to 128 characters. Unknown fields are dropped (PB-2).
- A duplicate sends the event again (doc conflict resolved here). ADR 0007 says a postback whose event could not be queued answers `503`, and the partner's retry, now a duplicate, sends the event with the same EventID. data-model.md said duplicates emit nothing, which loses the event after a `503`. ADR 0007 wins: every accepted or duplicate postback awaits `sendEvent()` with the derived EventID, and a Queue failure answers `503` with `Retry-After: 30`; the events table keeps one row by `event_id`. data-model.md is corrected in Task 4. Quarantined postbacks emit nothing.
- The derived EventID: SHA-256 of `partner_id + "\n" + type + "\n" + transaction_id`, the first 16 bytes formatted as a UUID with version nibble `8` and variant bits `10`, which `z.uuid()` accepts.
- `D1` failures inside the postback route answer `503 {"error":"unavailable"}` with `Retry-After: 30`. In `/go` and entry they reach `app.onError` (`500`), as today.
- Postback responses: `202 {"status":"accepted"}`, `200 {"status":"duplicate"}`, `202 {"status":"quarantined"}`.
- `POST /__test/seed` acts on the caller's user (the identity middleware sets the cookie for a new caller). Body `{ answers?: Record<string, string>, leads?: { offer_id: string; accepted_at?: number }[], clicks?: { offer_id: string; created_at?: number }[] }`. It creates the `users` row (email `seed@example.com`, encrypted and hashed like a completion), the answers, one click per Lead and a `lead` conversion for it (`transaction_id` `seed-<uuid>`, partner from the offer), and the plain clicks. Leads without `accepted_at` get `now + index`, so the array order is the Lead order (rows 22 and 23). An offer id missing from the current catalog gives `400`. Answers `{"ok":true,"clicks":[<lead clicks>, <plain clicks>]}`.
- `pnpm offer` reads the current version with `wrangler d1 execute --json --command`, checks the offer id exists in it, then writes version `v + 1` through `wrangler d1 execute --file`: a `catalog_history` row (`changed_by` `offer-script`, note such as `set-status 003 inactive`) and a copy of every offer of version `v` with the one change. Default `--local`; `--remote` for the deployed demo. A concurrent second run fails on the `catalog_history.version` primary key.
- `pnpm postback` takes `lead|purchase --click <id> --txn <id> [--partner partnerA] [--payout 25.00] [--currency USD] [--base <url>]`. The base is `--base`, then `$BASE`, then `http://localhost:8787`. The secret is `PARTNER_SECRET_<PARTNER in upper case>` from `.dev.vars` when the base host is `localhost` or `127.0.0.1`, else from `.dev.vars.remote`. It prints `<status> <body>` and never follows a redirect.
- The test state gains `me.clicks` (`click_id`, `offer_id`, `reason`, `created_at`), `me.conversions` (`type`, `offer_id`, `transaction_id`) through the user's clicks, and `counts.quarantine`.

## Global Constraints

- Everything committed is in English, except `docs/requirements/open-questions.md` (Ukrainian rows). No secrets, tokens, account ids, real emails or other personal data in any committed file. Tests use `@example.com` addresses and the fixed secrets in `tests/fixtures/facts.ts` only.
- The email never reaches an event, a Queue message, a URL, a log line, an error response or localStorage. The UserID never appears in a URL or a log line. Postback log lines never carry the body, the signature, the secret or the `transaction_id`; they may name a partner id only after it was found in `partners`.
- Every Queue send goes through `sendEvent()` or `emitInBackground()` in `src/events/producer.ts`.
- Raw SQL in `src/db/` only. Times are Unix milliseconds in UTC.
- Each new file under `src/` opens with a comment of two or three lines naming the component, the ADR and the requirement ids.
- Test names start with the requirement id, then any R-/Q- id. Tests never assert a global row count; each makes its own user, click and `transaction_id`. Filter with `pnpm test -t "X"`, never `pnpm test -- -t "X"`.
- No test, script or card follows a redirect: no `curl -L`, no `redirect: "follow"`. `scripts/postback.ts` passes `redirect: "manual"`.
- Scripts are erasable TypeScript run by Node 24 (no enums, no parameter properties); `src/domain/signature.ts` is imported by a script and follows the same rule.
- No new runtime or dev dependency.
- Work happens in the worktree `.claude/worktrees/part2-stage-3` on branch `part2-stage-3`. Each task commits there. Nothing is pushed until Arthur approves the stage.

## Known setup traps

From stages 0 to 2, still true: `compatibility_date` stays `2026-11-03`; test-only bindings by augmenting `Cloudflare.Env` in `tests/env.d.ts`; `wrangler types` needs `--strict-vars=false`; a JSON parse error is never logged (V8 quotes the input); two requests in a row can see the same `Date.now()`; tests that check events use `call()` with `captureQueue()` and feed the consumer with `deliver()`; `TEST_ROUTES` is `on` in `vitest.config.ts`.

New for this stage:
- D1 enforces foreign keys. A click needs its `users` row (or `user_id` null) and its `(catalog_version, offer_id)` in `offers`; a conversion needs its partner and click. Test fixtures create them in that order.
- Hono runs a GET handler for HEAD. `/go` checks the method first.
- `app.fetch` never follows a `302`, so tests read `Location` directly.
- `call()` sends only `content-type` and `cookie`. Task 4 adds a `headers` field to its `init` for `X-Signature` and other content types.
- `crypto.subtle.verify("HMAC", ...)` compares in constant time; comparing hex strings with `===` does not. Decode `v1` to bytes first; a value that is not 64 hex characters is `malformed`.
- Check whether `wrangler d1 execute --file` runs the file as one transaction before relying on it in `pnpm offer`; if it does not, say so in the script's header comment (one operator in the MVP, and the version key still blocks a parallel run).

## Review Focus

- A double press on the offer button, or a reload of `/go`: two clicks, two `302`s, no error (data-model.md: clicks are not deduplicated; M-10 counts distinct users). Task 3 tests it.
- A partner whose HTTP library re-serialises the JSON (other whitespace or key order) after signing: the signature is over the raw bytes, so this must give `401`, and the same bytes must pass. Task 1 tests both.
- The Queue is down when a Lead arrives: the D1 row is written, the answer is `503`; the partner's retry is a duplicate, answered `200`, and the event reaches the events table once. Task 4 tests the whole retry.
- A Lead for a click whose user was deleted (`user_id` null): accepted, counted, event with `user_id` null, no error. Task 4 tests it.
- A link-preview bot or uptime checker sending `HEAD /go` or `GET /go` with a bad prelander: no click and no event. Task 3 tests both.

---

### Task 1: click ids, signatures and derived EventIDs

**Files:**
- Create: `src/domain/clicks.ts`, `src/domain/signature.ts`, `tests/unit/clicks.test.ts`, `tests/unit/signature.test.ts`
- Modify: `src/events/envelope.ts` (`makeServerEvent` takes an optional `eventId`; `derivedEventId`), `tests/unit/envelope.test.ts`

**Interfaces:**
- Produces, `src/domain/clicks.ts`: `newClickId(): string` (32 lowercase hex characters); `partnerUrl(offerUrl: string, clickId: string): string`.
- Produces, `src/domain/signature.ts`:
  - `SIGNATURE_WINDOW_S = 300`
  - `parseSignatureHeader(header: string | undefined): { t: number; v1: string[] } | null`
  - `signPayload(secret: string, t: number, body: string): Promise<string>`: hex HMAC-SHA256 of `` `${t}.${body}` ``
  - `type SignatureCheck = "ok" | "missing" | "malformed" | "stale" | "mismatch"`
  - `verifySignature(input: { header: string | undefined; body: string; secrets: readonly string[]; nowMs: number }): Promise<SignatureCheck>`: `missing` for no header, `malformed` for a header that does not parse or a `v1` that is not 64 hex characters, `stale` when `|now - t| > 300 s`, `ok` when any `v1` verifies under any secret.
- Produces, `src/events/envelope.ts`: `derivedEventId(parts: readonly string[]): Promise<string>`; `makeServerEvent(input & { eventId?: string })` uses `eventId` when given.

- [ ] **Step 1: Write the failing tests.**

  `tests/unit/clicks.test.ts`:
  - `PB-4 P-2 click id has 128 random bits`: matches `^[0-9a-f]{32}$`; 1,000 calls give 1,000 distinct values.
  - `OFF-11 partner url carries the click id`: `partnerUrl("https://asia-connect.example", "abc")` is `https://asia-connect.example/?click_id=abc`; a URL with `?a=1` keeps `a=1`.

  `tests/unit/signature.test.ts`, with secret `test-partner-a-secret`, `t = 1762300000`, `nowMs = t * 1000`:
  - `PB-3 a signature over the raw body verifies`: `signPayload` then `verifySignature` gives `ok`.
  - `PB-3 R-11 no header gives missing`; `PB-3 R-11 a header without t or v1 gives malformed`; `PB-3 R-11 v1 that is not 64 hex gives malformed`.
  - `PB-3 R-11 a wrong secret gives mismatch`.
  - `PB-3 R-11 a re-serialised body gives mismatch`: signed over `{"type":"lead"}`, checked against `{ "type": "lead" }`.
  - `PB-3 R-11 stale timestamp gives stale`: `t` 301 seconds before `nowMs`, and 301 seconds after; 299 seconds passes.
  - `PB-3 rotation: the current and the previous secret both verify`: `secrets: [current, previous]`, a signature with either gives `ok`.
  - `PB-3 any of several v1 values may match`: `t=...,v1=<wrong>,v1=<right>` gives `ok`.

  `tests/unit/envelope.test.ts`:
  - `PB-5 the postback EventID is derived from partner, type and transaction id`: the same parts give the same id twice; another `transaction_id` gives another; the id passes `z.uuid()` and its 15th character is `8`.
  - `ID-1 makeServerEvent keeps a given event id`.
- [ ] **Step 2: Run `pnpm test -t "PB-4|OFF-11|PB-3|PB-5|ID-1"`.** Expected: FAIL, `src/domain/clicks.ts` cannot be resolved.
- [ ] **Step 3: Write `src/domain/clicks.ts`, `src/domain/signature.ts` and the envelope changes.**
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`.** Expected: all pass, exit 0.
- [ ] **Step 5: Commit** `feat: click ids, postback signatures and derived event ids`.

### Task 2: catalog changes, the offer script and the test seed

**Files:**
- Create: `src/db/catalog-change.ts`, `scripts/offer.ts`, `tests/unit/catalog-change.test.ts`, `tests/integration/catalog-change.test.ts`, `tests/fixtures/catalog.ts`
- Modify: `src/db/test-state.ts`, `src/routes/test.ts`, `tests/integration/test-routes.test.ts`, `package.json` (scripts `offer` and `postback`; the second points at the file Task 5 writes), `docs/testing/acceptance-checks.md` (the "Test state" row of the endpoints table: the seed body above)

**Interfaces:**
- Consumes: `Statement`, `renderSql` from `src/db/seed.ts`; `readFacts` from `src/db/facts.ts`; `encrypt`, `emailHash` and key imports from `src/domain/crypto.ts`; `newClickId` (Task 1).
- Produces, `src/db/catalog-change.ts`:
  - `type CatalogChange = { kind: "status"; offerId: string; active: boolean } | { kind: "epu"; offerId: string; epu: number }`
  - `catalogChangeStatements(current: number, change: CatalogChange, now: number): Statement[]`: two statements, the history row for `current + 1` and `INSERT INTO offers ... SELECT ... FROM offers WHERE version = current` with the changed column through `CASE WHEN id = ? THEN ? ELSE <column> END`.
- Produces, `tests/fixtures/catalog.ts`: `changeCatalog(change: CatalogChange): Promise<number>` reads the current version from `env.FACTS`, runs the statements in one `db.batch`, returns the new version.
- Produces, `src/db/test-state.ts`: `seedTestUser(db: D1Database, input: { userId: string; emailEnc: string; emailHash: string; answers: Record<string, string>; leads: { offerId: string; acceptedAt: number }[]; clicks: { offerId: string; createdAt: number }[]; now: number }): Promise<string[]>` (one `db.batch`; returns the click ids in order); `readTestState` adds the user's clicks and conversions and `counts.quarantine`.
- Produces, `POST /__test/seed` in `src/routes/test.ts`, Zod body as in the settled point above.
- Produces, `scripts/offer.ts`: `pnpm offer set-status <id> active|inactive [--remote]`, `pnpm offer set-epu <id> <value> [--remote]`; prints `catalog version <n>: <note>`; exits 1 with a usage line for unknown commands, an id that is not in the current version, or an EPU that is not a positive number.

- [ ] **Step 1: Write the failing tests.**

  `tests/unit/catalog-change.test.ts`:
  - `Q-9 a status change writes version n+1 with one offer changed`: two statements; the first inserts version 2; the parameters carry `003` and `0`.
  - `Q-9 an EPU change touches only the epu column`.

  `tests/integration/catalog-change.test.ts`:
  - `A-4 Q-9 disabled offer is not selected once the change has taken effect`: `changeCatalog({ kind: "status", offerId: "003", active: false })`, then completion as women + asia gives `001`; restore 003 at the end (`changeCatalog` back to active).
  - `Q-9 the new version keeps every other offer unchanged`: seven offers in the new version; six equal to the old ones.

  `tests/integration/test-routes.test.ts`:
  - `OFF-3 seed creates a user with answers and a Lead`: `POST /__test/seed` with `{ answers: { gender: "women", ethnicity: "asia" }, leads: [{ offer_id: "001" }] }` from a new caller gives `200`, one click id and a cookie; `GET /__test/state` with that cookie shows the answers, one click on `001` and one `lead` conversion.
  - `OFF-4 seeded Leads keep their array order`: Leads `001`, `004` give `accepted_at` of 004 greater than of 001.
  - `R-12 seeded user's email is not in the state`: the state text contains no `@`.
  - `PB-3 seed answers 404 when test routes are off`.
- [ ] **Step 2: Run `pnpm test -t "Q-9|A-4|OFF-3|OFF-4|R-12|PB-3"`.** Expected: the new tests FAIL.
- [ ] **Step 3: Write the statements, the fixture, the seed route and state, and `scripts/offer.ts`.** Then run `pnpm migrate:local && pnpm seed --local && pnpm offer set-status 003 inactive && pnpm offer set-status 003 active`. Expected: `catalog version 2: set-status 003 inactive`, then version 3.
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`.** Expected: all pass, exit 0.
- [ ] **Step 5: Commit** `feat: catalog change script and test seed route`.

### Task 3: the transition at /go and the entry redirect

**Files:**
- Create: `src/db/clicks.ts`, `src/routes/transition.ts`, `src/routes/go.ts`, `src/pages/no-offer.ts`, `tests/integration/go.test.ts`, `tests/integration/entry-redirect.test.ts`
- Modify: `src/routes/prelander.ts` (the redirect branch), `src/pages/quiz.ts` (the offer link), `src/app.ts` (identity on `/go`, mount), `tests/integration/prelander.test.ts`, `docs/requirements/open-questions.md` (Q-30), and decision 1 in the docs: `docs/design/data-model.md` (the `/go` row of "Requests and what they touch"; the first bullet of `clicks`; `offer_selected` moments `entry` and `completion` only in "Types"; the re-selection sentence under "The nine events of a visit"; row 4 of "Trace of the demo"), `docs/design/design.md` ("Where offer status is checked again": `/go` runs selection on every press, so any catalog change since the page was shown applies), `docs/adr/0004-offer-selection-semantics.md` (the `/go/{offer}` sentence; the ADR is still `proposed`), `docs/requirements/offer-selection.md` (the "Offer disabled between selection and redirect" row), `docs/plans/part2-mvp-stages.md` (stage 3 "Content", the `/go` bullet), `docs/testing/acceptance-checks.md` (the "Transition" row; OFF-11 and ID-3 manual steps and the demo script use `$BASE/go?prelander=demo`)

**Interfaces:**
- Consumes: `newClickId`, `partnerUrl` (Task 1); `readFacts`; `select`; `makeServerEvent`, `emitInBackground`; `isValidVisitId`; `seedTestUser` through `POST /__test/seed` and `changeCatalog` (Task 2); `call`, `captureQueue`, `deliver`, `eventsOf` from `tests/fixtures/events.ts`.
- Produces, `src/db/clicks.ts`: `type Click = { clickId: string; userId: string | null; offerId: string; catalogVersion: number; prelanderId: string; visitId: string; reason: "lead_return" | "best_epu" | "fallback_universal"; createdAt: number }`; `insertClick(db: D1Database, click: Click): Promise<void>`.
- Produces, `src/routes/transition.ts`: `startTransition(c: Context<AppEnv>, input: { offer: Offer; reason: Click["reason"]; catalogVersion: number; prelanderId: string; visitId: string; extraEvents?: StoredEvent[] }): Promise<Response>`: `insertClick` awaited, then `emitInBackground` with `extraEvents` and `offer_click` (payload `{ click_id, offer_id, catalog_version, reason }`), then `302` to `partnerUrl` with `cache-control: no-store`.
- Produces, `GET /go?prelander=&visit=` in `src/routes/go.ts`, `goRoute(flows: ReadonlyMap<string, Flow>): Hono<AppEnv>`: `HEAD` gives `405`; unknown `prelander` gives `404`; `readFacts`, then `select(..., "redirect")`: `redirect` calls `startTransition`; `quiz` answers `302` to `/p/<prelander>`; `no_offer` renders the no-offer page with `200` and logs `{"msg":"go_no_offer"}`.
- Produces, `src/pages/no-offer.ts`: `renderNoOfferPage(): string` with the text `No offer available`.
- Produces, the page link: `"/go?prelander=" + encodeURIComponent(prelander) + "&visit=" + encodeURIComponent(visit)`.
- Produces, Q-30 in "Питання про поведінку": «Користувач без рядка в `users` (новий cookie, пропущений квіз, посилання відкрите в іншому браузері) натискає перехід на offer. Що показати?» Default: «302 на `/p/{prelander}`, click не записується: без відповідей і Lead `select()` повертає квіз». Why it matters: «Click без користувача не дає Lead-повернення, а click на offer, вибраний не для цього користувача, псує метрику переходів». Status `open`.

- [ ] **Step 1: Write the failing tests.** Each test makes its own user through completion or `POST /__test/seed`, with `captureQueue()`.

  `tests/integration/go.test.ts`:
  - `OFF-11 transition answers 302 with Location and click id`: completion women + asia, then `GET /go?prelander=demo&visit=<page visit>` gives `302`, `Location` matching `^https://asia-connect\.example/\?click_id=[0-9a-f]{32}$`, `cache-control` `no-store`.
  - `OFF-11 click row exists before the 302`: the click id from `Location` is in `me.clicks` with `offer_id` `003`, `reason` `best_epu`, `visit_id` the page's.
  - `OFF-11 R-9 offer disabled after selection is re-selected at /go`: completion gives 003; `changeCatalog` disables 003; `/go` sends to `https://asia-women.example/?click_id=...` (001); restore 003.
  - `OFF-11 the URL cannot choose the offer`: `GET /go/004?prelander=demo` gives `404`; `GET /go?prelander=demo&offer=004` still goes to 003.
  - `Q-30 a user without a users row is sent to the quiz`: a new cookie gives `302` to `/p/demo`; no click for that user.
  - `OFF-8 no offer at /go shows the message`: women + latam, then 007 disabled, `/go` gives `200` with `No offer available` and no click; restore 007.
  - `OFF-11 a double press makes two clicks`: two `/go` calls give two different click ids, both stored.
  - `OFF-11 HEAD and an unknown prelander write nothing`: `HEAD /go?prelander=demo` gives `405`; `GET /go?prelander=nope` gives `404`; no click, nothing in the captured Queue.
  - `QZ-4 a malformed visit is replaced`: `visit=bad id!` gives a click whose `visit_id` is a UUID.
  - `NFR-1 one full visit produces nine events`: entry, the five browser events through `postEvent`, completion, `/go`; `deliver` of every captured body; `eventsOf` gives 9 rows, the last `offer_click` with the click id from `Location`.

  `tests/integration/entry-redirect.test.ts`, users from `POST /__test/seed`, entry with `GET /p/demo`:
  - `OFF-3 row 16 a Lead for active 001 skips the quiz and beats EPU`: `302` to `https://asia-women.example/?click_id=<new id>`; a second click for the user with `reason` `lead_return`; the captured Queue holds `prelander_viewed` (`lead_return`), `offer_selected` (`001`, `lead_return`, `entry`) and `offer_click`.
  - `OFF-3 row 17 a Lead without answers skips the quiz`; `OFF-3 row 27 a Lead beats answers for another offer` (men + europe, Lead 001).
  - `OFF-9 row 18 a Lead for disabled 001 with full answers goes to 003`: `302` to asia-connect, `prelander_viewed` reason `skip`, click reason `best_epu`.
  - `OFF-9 row 19 a Lead for disabled 001 without full answers shows the quiz`: `200`, no new click.
  - `OFF-9 row 20` (007) and `OFF-9 row 21` (`200` with `No offer available`, `prelander_viewed` `skip`, `offer_selected` `no_offer`).
  - `OFF-4 row 22 the most recent Lead wins` and `OFF-4 row 23 the next Lead when the newest offer is disabled`.
  - `OFF-9 row 28 a Lead for a removed offer`: not reachable through `pnpm offer`; this row stays covered by the `select()` unit test, and the test file says so in a comment.
  - `ID-3 earlier user's email in a new browser gives no lead return`: user A seeded with a Lead on 003; user B, a new cookie, completes women + europe with the same email `user1@example.com`; B gets `004`; B's entry gives `200` with the quiz; A and B have different user ids.

  Every test that disables an offer restores it.
- [ ] **Step 2: Run `pnpm test -t "OFF-3|OFF-4|OFF-8|OFF-9|OFF-11|Q-30|QZ-4|NFR-1|ID-3"`.** Expected: the new tests FAIL with `404` for `/go` and `200` for the entries.
- [ ] **Step 3: Write the click insert, `startTransition`, the route, the no-offer page and the entry branch; change the link; write the docs edits listed under Files.** Then `grep -rnE "/go/\{offer\}|/go/0[0-9]{2}|moment \`?redirect" docs src tests scripts` prints only `docs/plans/part2-stage-3-redirect-postbacks.md` and `docs/ai/plan-history.md`.
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm lint:docs`.** Expected: all pass, exit 0, the stage 1 and 2 tests included.
- [ ] **Step 5: Commit** `feat: transition at /go and the Lead return at entry`.

### Task 4: the postback endpoint

**Files:**
- Create: `src/db/conversions.ts`, `src/routes/postback.ts`, `tests/fixtures/postback.ts`, `tests/integration/postback.test.ts`
- Modify: `src/db/clicks.ts` (`findClickForPostback`), `src/app.ts` (mount, no identity middleware on `/postback`), `tests/fixtures/events.ts` (`call` takes `headers`), `docs/design/data-model.md` ("Types": a duplicate postback sends its event again with the same EventID; a quarantined one sends nothing; row 6 of "Trace of the demo" emits `lead` again with the same EventID), `docs/testing/acceptance-checks.md` (the "Postback" row of the endpoints table: the answers of ADR 0007 and the 16 KB limit)

**Interfaces:**
- Consumes: `verifySignature`, `derivedEventId` (Task 1); `decrypt`, `importAesKey`, `ConfigError`; `sendEvent`, `makeServerEvent`; `insertClick`, `seedTestUser` (Tasks 2 and 3); `TEST_PARTNER_SECRETS`.
- Produces, `src/db/clicks.ts`: `findClickForPostback(db: D1Database, clickId: string): Promise<{ clickId: string; userId: string | null; offerId: string; catalogVersion: number; prelanderId: string; visitId: string; offerPartnerId: string } | null>` (clicks joined with `offers` on `(catalog_version, offer_id)`).
- Produces, `src/db/conversions.ts`:
  - `readPartner(db: D1Database, id: string): Promise<{ active: boolean; secretCurrentEnc: string; secretPreviousEnc: string | null } | null>`
  - `insertConversion(db: D1Database, row: { partnerId: string; type: "lead" | "purchase"; transactionId: string; clickId: string; occurredAt: number; acceptedAt: number; payout: number | null; currency: string | null; partnerUserId: string | null }): Promise<{ inserted: boolean }>`: `ON CONFLICT (partner_id, type, transaction_id) DO NOTHING RETURNING id`
  - `insertQuarantine(db: D1Database, row: { partnerId: string; type: string | null; transactionId: string | null; clickId: string | null; body: string; reason: "unknown_click"; receivedAt: number }): Promise<void>`
- Produces, `POST /postback/v1/:partner` in `src/routes/postback.ts`, `postbackRoute(): Hono<AppEnv>`, in the order of the settled point above. The event: type `lead` or `purchase`, `eventId` from `derivedEventId([partner, type, transaction_id])`, `user_id`, `visit_id` and `prelander_id` from the click, payload `{ click_id, offer_id, partner_id, transaction_id, occurred_at, payout, currency }`. One log line per request: `{"msg":"postback","partner":<id or null>,"outcome":"accepted"|"duplicate"|"quarantined"|"rejected","reason"?:<string>}`.
- Produces, `tests/fixtures/postback.ts`:
  - `postback(partner: string, body: unknown, opts?: { secret?: string; t?: number; header?: string | null; contentType?: string; raw?: string }, envOverride?: Partial<Env>): Promise<Response>`: signs with the partner's test secret and the current time unless told otherwise
  - `leadBody(clickId: string, overrides?: Record<string, unknown>): Record<string, unknown>` with a fresh `transaction_id`
  - `userWithClick(offerAnswers?: { gender: string; ethnicity: string }): Promise<{ cookie: string; clickId: string }>` through completion and `/go` (women + asia, offer 003, partnerA, by default)
  - `conversionsOf(clickId: string)`, `quarantineOf(transactionId: string)`

- [ ] **Step 1: Write the failing tests** in `tests/integration/postback.test.ts`. "Changes nothing" means `conversionsOf(click)` and `quarantineOf(txn)` are equal before and after, and the captured Queue is empty.
  - `PB-1 signed lead is accepted`: `202 {"status":"accepted"}`, one conversion on the click; one `lead` event with the click's `user_id`, `visit_id`, `prelander_id` and the derived `event_id`.
  - `PB-1 signed purchase is accepted`; `PB-1 unknown type is rejected` (`type: "refund"`, `400`, changes nothing).
  - `PB-2 a missing required field is rejected`, one case per field of `type`, `click_id`, `transaction_id`, `occurred_at`; `PB-2 optional payout and currency accepted` (`25.00`, `USD`, stored as 25 and `USD`); `PB-2 unknown extra field ignored`; `PB-2 version is in the path` (`/postback/v2/partnerA` gives `404`).
  - `PB-3 R-11 no signature gives 401`, `PB-3 R-11 wrong signature gives 401`, `PB-3 R-11 stale timestamp gives 401` (6 minutes old), `PB-3 R-11 signature from another partner gives 401` (partnerB's secret on `/postback/v1/partnerA`), `PB-3 R-11 unknown partner gives 401`, `PB-3 an inactive partner gives 401`; each changes nothing and answers `{"error":"unauthorized"}`.
  - `PB-3 rotation: signatures with the current and the previous secret are both accepted`: a partner `partnerR` inserted by the test with both secrets encrypted; a postback with an unknown click signed with either gives `202 quarantined`.
  - `PB-4 lead lands on the click's user and offer`: two users with clicks on 003 and 004; a Lead on A's click gives a conversion on A's click and none on B's.
  - `PB-4 Q-11 unknown click is quarantined with 202`: `202 {"status":"quarantined"}`, one quarantine row with reason `unknown_click`, no conversion, no event.
  - `PB-4 R-6 quarantined postback matches once the click exists`: quarantine first; `insertClick` with that id; the same postback again gives `202 accepted`.
  - `PB-4 Q-24 offer mismatch is rejected`: a click on 004 (partnerB) with a Lead to `/postback/v1/partnerA` signed by partnerA gives `400 {"error":"click_partner_mismatch"}`, changes nothing.
  - `PB-4 Q-24 lead on a disabled offer is counted without a redirect right`: click on 003, `changeCatalog` disables 003, Lead gives `202`; the user's entry does not redirect to 003; restore 003.
  - `PB-4 a lead for a click without a user is accepted`: a click inserted with `user_id` null; `202`, event `user_id` null.
  - `PB-5 R-4 same postback twice counts once`: the same signed request twice gives `202`, then `200 {"status":"duplicate"}`; one conversion; two Queue messages with the same `event_id`; `deliver` of both stores one row.
  - `PB-5 two purchases with different transaction ids count twice`: two conversions.
  - `PB-5 Q-23 second lead for the same user and offer is stored`: a second Lead with a new `transaction_id` gives `202` and a second row; counting it once is the report's rule (stage 4).
  - `PB-5 R-5 missing transaction id is handled as the design says`: `400`, changes nothing.
  - `PB-5 the postback event retried after a queue failure reaches analytics once`: with `failingQueue()` a Lead gives `503` with `Retry-After: 30` and one conversion; the retry with a working Queue gives `200 duplicate` and one event; `deliver` stores it once.
  - `PB-6 a quiz email is not a Lead`: after completion, `me.conversions` is empty and entry shows the quiz.
  - `PB-8 malformed postback changes nothing`, signed correctly, one case each: invalid JSON, `content-type: text/plain`, a body of 16,385 bytes (`400 too_large`), unknown type, negative payout (`-1.00`), `occurred_at` without a time zone.
  - `PB-8 D1 unavailable gives 503`: `FACTS` replaced by a database whose `prepare` throws; `503`.
  - `R-12 postback logs carry no body, signature or transaction id`: across a valid, a duplicate and a rejected request, no captured log argument contains the `transaction_id`, the `v1` value or `click_id`.
  - `TEST-3 R-4 a redelivered Lead and a second real Purchase`: Lead `T1` twice and Purchase `P1`, `P2` give conversions lead 1, purchase 2.
- [ ] **Step 2: Run `pnpm test -t "PB-|TEST-3|R-12"`.** Expected: the new tests FAIL with `404`.
- [ ] **Step 3: Write the DB functions, the route and the fixtures, extend `call`, edit data-model.md and acceptance-checks.md as listed.**
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm lint:docs`.** Expected: all pass, exit 0.
- [ ] **Step 5: Commit** `feat: signed postback endpoint with dedup and quarantine`.

### Task 5: the postback script and the demo path

**Files:**
- Create: `scripts/lib/postback-request.ts`, `scripts/postback.ts`, `tests/integration/demo.test.ts`
- Modify: `docs/testing/acceptance-checks.md` (PB-1 and PB-7 expect `202`; the demo script: `# 202` on the DEMO-3 Lead and the first DEMO-5 Purchase, `# 200 duplicate` on DEMO-6; the `go` line already changed in Task 3)

**Interfaces:**
- Consumes: `signPayload` (Task 1); the endpoint (Task 4); `call`, `captureQueue`, `userWithClick`.
- Produces, `scripts/lib/postback-request.ts`: `buildPostbackRequest(input: { base: string; partner: string; type: "lead" | "purchase"; clickId: string; transactionId: string; secret: string; nowMs: number; payout?: string; currency?: string }): Promise<{ url: string; init: RequestInit }>`: body with `occurred_at` from `nowMs`, header `X-Signature`, `content-type: application/json`, `redirect: "manual"`.
- Produces, `scripts/postback.ts` as in the settled point; exits 1 with a usage line for a missing `--click` or `--txn`, an unknown type, or a missing secret variable.

- [ ] **Step 1: Write the failing tests** in `tests/integration/demo.test.ts`, one user from an empty cookie, each block in order:
  - `PB-7 helper produces a signature the endpoint accepts`: `buildPostbackRequest` with base `https://example.com` and partnerA's test secret, sent with `app.fetch`, gives `202`.
  - `DEMO-3 a test Lead for that user's transition`: entry, completion women + asia, `/go`; the Lead through `buildPostbackRequest` gives `202`; `me.conversions` holds one Lead on 003.
  - `DEMO-4 the same user returns without the quiz`: entry gives `302 https://asia-connect.example/?click_id=<id>` with an id different from the first click.
  - `A-4 Lead is used by the very next entry`: the entry right after the Lead returns `302` on the first try.
  - `DEMO-6 repeating a postback does not double the numbers`: the Purchase `DEMO-P1` gives `202`, again gives `200` with `duplicate`, the Lead again gives `200`; `me.conversions` holds one Lead and one Purchase.
- [ ] **Step 2: Run `pnpm test -t "PB-7|DEMO-|A-4"`.** Expected: FAIL, `scripts/lib/postback-request.ts` cannot be resolved.
- [ ] **Step 3: Write the request builder and the script; edit acceptance-checks.md.** Then, against `wrangler dev` with the local seed: `curl -s -X POST localhost:8787/__test/reset`, complete the quiz with curl, take the click from `/go`, `pnpm postback lead --click <id> --txn L1`. Expected: `202 {"status":"accepted"}`; the same command again prints `200 {"status":"duplicate"}`.
- [ ] **Step 4: Run the stage checks.** `pnpm test -t "OFF-3|OFF-4|OFF-9|ID-3"`, `pnpm test -t "PB-5|TEST-3"`, `pnpm test -t "PB-3|PB-8"`, `pnpm test -t "A-4|NFR-1|DEMO-3|DEMO-4|DEMO-6"`; `grep -rnE -- "curl .*-L( |$)|redirect: ?['\"]follow" tests/ scripts/ docs/testing/`; `grep -rnE "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}" src tests config scripts | grep -v "@example\.com"`; `for f in src/*/*.ts; do head -3 "$f" | grep -q "ADR" || echo "$f"; done`. Expected: the four test runs pass; the three commands print nothing.
- [ ] **Step 5: Run the gate:** `pnpm check`. Expected: exit 0.
- [ ] **Step 6: Commit** `feat: signed postback script and the demo path`.

### After the tasks: Arthur's part and closing

- [ ] Explain back. Arthur walks a redelivered Lead and a second real Purchase through `POST /postback/v1/partnerA`: the signature over `t.body`, the click lookup, the partner check, `INSERT ... ON CONFLICT (partner_id, type, transaction_id) DO NOTHING RETURNING id`, and names the key that tells them apart (the same `transaction_id` is a redelivery, a new one is a second Purchase). Then he says what `/go` does with a user whose offer was disabled after the page showed it. The AI points at every difference from the code.
- [ ] Docs in the closing commit: a `docs/ai/plan-history.md` entry for decision 1 (`/go` without an offer id, `offer_selected` with moment `redirect` dropped) and the duplicate-event correction; the ADR 0007 "Outcome" with the date and what was built; a draft in `docs/ai/examples/` for decision 1 (the AI proposed an accepted risk, Arthur proposed selection by the cookie, a Fable review agreed, the tests above check it), for Arthur to pick or drop.
- [ ] Approval. Squash-merge `part2-stage-3` into `main` as `feat: redirect, signed postbacks and the Lead return`, with `docs/state/progress.json` (stage 3 done, stage 4 next, decisions and settled points in `notes`), and push.
- [ ] After CI deploys, against `BASE` (the workers.dev URL), with the helpers from acceptance-checks.md: `curl -s $BASE/healthz` prints the merge commit's sha. Then the demo script from DEMO-2 to DEMO-4 and DEMO-6, without the report lines (stage 4). Expected: DEMO-3 prints `202`; DEMO-4 prints `302 https://asia-connect.example/?click_id=<new id>`; the repeated Lead prints `200` with `duplicate`; `state $JAR | jq '.me.conversions | map(select(.type == "lead")) | length'` prints `1`. Paste the outputs into the stage notes.
