# Part 2: MVP implementation plan

Plan for Part 2: build the MVP on Cloudflare from the Part 1 design and hand everything to the company. It answers DES-3 and DES-4 in [requirements.md](../requirements/requirements.md) and was written in stage 6 of [part1-design-document.md](part1-design-document.md).

Goal: by Monday 2026-11-09, one week after the Part 1 date, the company receives the design, a deployed MVP that runs the demo scenario end to end, tests and CI, a README and the AI work log, in one delivery. The company does not review the design separately ([plan-history.md](../ai/plan-history.md), 2026-11-03), so nobody negotiates the slice. It is named below so the company can see what the minimum was.

Time budget: 16 to 25 hours, from the Part 2 rows of [estimate.md](../estimate.md) (Cloudflare 4 to 6, code 5 to 8, tests and CI 4 to 6, README 2 to 3, review preparation 1 to 2). The stages add up to 24 hours without the optional stage 9. If time runs short, stage 9 is dropped first, then the browser smoke test in stage 7, then stage 6 shrinks to `GET /__probe` and the email scan, then stage 5 becomes design-only and the consumer keeps writing to D1. Stages 7, 8 and 10 can shrink but not disappear, because they are deliverables. Stages 0 to 4 do not shrink.

What the reviewer looks for. Arthur's notes from the interview with the technical reviewer say the assignment is mostly about understanding the architecture, and he wants a system that keeps running with little maintenance and changes without pain. So this plan spends its hours on three things before anything else: code whose folders are the components of the architecture diagram, each pointing at the ADR it implements; a README that explains why each component is there and what to read first; and the explain-back step in every stage, which is how Arthur will be able to defend the code at the review. A test or a feature that does not help him explain the system is the first to go.

## Decisions this plan builds on

| Choice | Value | Decided by |
|---|---|---|
| Router, validation | Hono, Zod | Arthur, 2026-11-03 |
| Language, packages, layout | TypeScript, pnpm, one package at the repository root | Fable |
| Database access | Raw SQL against D1, no ORM: the queries are in [data-model.md](../design/data-model.md), and an ORM would hide them from the reviewer | Fable |
| Tests | vitest with `@cloudflare/vitest-pool-workers`, real D1, Queue and R2 bindings in the Workers runtime | Fable |
| Lint, format | oxlint, oxfmt | [acceptance-checks.md](../testing/acceptance-checks.md) |
| Config | `wrangler.jsonc` | Fable |
| CI | GitHub Actions: typecheck, lint, tests on every push; on `main` also `wrangler d1 migrations apply`, then `wrangler deploy`, with a `CLOUDFLARE_API_TOKEN` repository secret | Fable |
| Environments | One environment: `main` deploys the one Worker and its resources, which serve as the demo. A second environment (staging from a `develop` branch, with its own D1, Queue and bucket) was considered and dropped on 2026-11-04: it doubles the Cloudflare resources to keep and spends time on what the spec does not ask for. The README describes how a team would run it: one feature branch per task, tested on its own preview deploy (`wrangler versions upload` gives a URL per pull request without moving traffic), merged into `main` after review and green CI, and `main` is what runs in production. No `develop` branch, no staging and no release tags: a feature that is not ready stays on its branch or behind a flag, so nothing has to be cherry-picked out of `main` | Arthur, 2026-11-04 |
| Deployment | One Worker for every endpoint, the Queue consumer and the crons: `src/index.ts` exports `fetch`, `queue` and `scheduled`, `wrangler deploy` ships one bundle, and the folders under `src/` are modules of it, not services. Not a monorepo: the consumer or the crons move to their own Worker only when they need their own release cadence or scaling, or another team owns them; then each gets its own `wrangler.jsonc` under `apps/` and CI deploys the Workers whose files changed. The README's deploy section says this | Fable, confirmed by Arthur 2026-11-04 |
| Frontend | No frontend framework: the Worker renders the quiz and report pages as HTML, with a small inline script on the quiz page that sends events and posts the completion. Reasons: the two pages have no shared state, routing or auth; a prelander lives off time to first byte on a mobile in-app browser; a framework adds a build, a second deploy target and hours the budget needs for the event path. A framework comes in with the admin panel, funnel constructor or a reports cabinet, which MVP-3 leaves out; the cheapest step then is a Vite + React build served as static assets by the same Worker. The README's deploy section says this | Arthur, 2026-11-04 |
| Event path in the slice | `POST /api/events` to the Queue, consumer writes straight into the D1 events database. R2 `pending/` and the loader come in stage 5, and the D1 write moves to the loader then (small rework, accepted) | Arthur |
| Operations | Built: Analytics Engine data points (latency, freshness), an alert cron every 5 minutes against the [nfr.md](../requirements/nfr.md) thresholds that writes a log line, `GET /__probe`. Design-only: the external probe from the EU and the US (Checkly), the dead letter queue redrive script (README gives the command it would run) | Arthur |
| Load test | k6 at 200 events/s, an optional last stage, first to drop | Arthur |
| Quiz flow | Data, not code: one JSON file per prelander lists the steps, each with its question key, allowed values, wording (a template that can read an earlier answer) and the next step, which may depend on an answer. The Worker renders a step from it and `POST /api/complete` validates answers against it. The idea comes from a configuration-driven funnel constructor Arthur works with; the types and code here are written from scratch, nothing is copied | Arthur, 2026-11-04 |

Proposed layout. It is kept small so a live change at the review (AI-4, R-22) has one obvious place to go, and it mirrors the components of [design.md](../design/design.md) section 2. Each folder under `src/` opens with a comment of two or three lines naming the component, the ADR it implements and the requirement ids it serves:

```
src/index.ts          Hono app; fetch, queue and scheduled handlers
src/routes/           one file per endpoint
src/domain/           select() (pure), quiz flow (config types, next step, conditions), signature, crypto
config/prelanders/    one quiz flow JSON per prelander (demo.json)
src/db/               SQL strings and D1 batch helpers
src/events/           envelope schema, producer, consumer, loader
src/ops/              Analytics Engine writes, alert evaluator
src/pages/            quiz page, report page
migrations/facts/     numbered SQL, facts database
migrations/events/    numbered SQL, MVP events database
scripts/              seed, offer, postback, sink, demo
tests/unit/           pure functions, no I/O
tests/integration/    routes through the Workers runtime with local D1, Queue and R2
tests/e2e/            the demo scenario against a running Worker; the Playwright smoke test
tests/fixtures/       decision table loader, report fixture, synthetic users
load/                 k6 scripts (stage 9)
```

## How the stages run

The loop from Part 1, adapted for code:

1. Read. The stage names what to read before any code.
2. Decide. Arthur's decisions go through AskUserQuestion with one option recommended. A spec ambiguity found while coding goes into [open-questions.md](../requirements/open-questions.md) with a default before code settles it. From stage 4 on, a choice the docs give a default for is made by the AI and recorded in the stage plan; only a decision with no default in the docs stops the stage.
3. Write tests and code together with the test-driven-development skill: the failing test first. Its name says what is checked in plain words and starts with the requirement id, as acceptance-checks.md requires (`OFF-5 row 1 women+asia gives 003`): the words tell a person what broke, the id lets `pnpm test -t "OFF-5"` run one requirement and ties the test to its card. From stage 4 on, Sonnet subagents write the code through subagent-driven development, each task is reviewed on its own, and the whole branch is reviewed on Opus before the merge.
4. Explain back. Arthur says in Ukrainian what one request does in the new code: route, function, table or binding. The AI points at every difference from the code. Up to stage 3 the stage was not done until they matched; from stage 4 on the questions are collected in the PR description and the stage notes and do not block the merge.
5. Verify. Run the acceptance cards the stage names, then the regression gate, and paste both outputs. Checks against Cloudflare use `BASE` set to the deployed workers.dev URL; curl never gets `-L`.
6. Merge. One squash-merged commit per stage. Up to stage 3 it waited for Arthur's approval; from stage 4 on the AI merges the PR once CI is green, removes the worktree, pulls `main`, waits for the deploy run and checks the deployed Worker, then starts the next stage. A push to `main` deploys, so a stage is closed only when that CI run is green and `GET /healthz` shows the new commit. [progress.json](../state/progress.json) changes in the same commit. `BASE` in a stage's checks is the deployed workers.dev URL, the same one the README gives as the demo link.

From stage 4 on the stages run back to back. Once stage 10 is done, a Fable review checks stages 4 to 10 against their plans.

Every closing commit also updates the table "What to show at the review" at the end of this file, so the review walk-through grows with the code instead of being reconstructed at the end.

### Test levels

Every test case in this plan sits on one of four levels. The level is part of the file path, so the split is visible in the repository and in the CI log.

| Level | Where it runs | What it proves | Cases |
|---|---|---|---|
| Unit | vitest, plain Node, `tests/unit/` | one pure function: `select()`, `nextStep()`, `evaluateCondition()`, the HMAC signature, the report arithmetic | TEST-1, the OFF-12 rows, the flow config tests |
| Integration | vitest with `@cloudflare/vitest-pool-workers`, `tests/integration/`: the test calls `SELF.fetch()` on the real Worker inside the Workers runtime, with local D1, Queue and R2 bindings, then reads the databases | one request end to end inside the Worker: route, validation, SQL, Queue message, response | TEST-2, TEST-3, TEST-4, TEST-5, the PB, ID, QZ, AN and R-12 cards |
| End to end, HTTP | `pnpm test:e2e --base $BASE`, which is `scripts/demo.sh` driving the Worker with curl, against `wrangler dev` or the deployed Worker | the five demo steps in order with the expected answers and report cells (MVP-1, DEMO-2 to DEMO-6) | stage 4 onward, every "against `BASE`" check |
| End to end, browser | Playwright with Chromium, `tests/e2e/quiz.spec.ts`, `pnpm test:browser`, run in CI in job `e2e` against `wrangler dev`; against the deployed Worker as `BASE=$BASE pnpm test:browser` | the page's own JavaScript: a user clicks through the three steps, sees the offer, and `__test/state` holds every visit event with the right `seq` | the quiz happy path; the email scan, which runs only against local `wrangler dev` (with `BASE` set it prints `email-scan skipped`); the `/go?prelander=demo` link in stage 7 |

The first two levels run in CI on every push and make up `pnpm test`. The HTTP level runs in CI against `wrangler dev` from stage 4. The browser level is the check that the curl script cannot give, that the page's JavaScript sends what the design says. The `e2e` job installs Chromium and runs the test against `wrangler dev`, and the deploy job waits for it.

The regression gate is `pnpm check` (typecheck, lint, fmt:check, lint:docs, state:check, test), run by the pre-commit hook and by CI. `pnpm test:browser` runs in CI and before each hand-in, and against local `wrangler dev` it ends with the email scan.

The commit that closes Part 1 stage 6 points `progress.json` at this file, with stage 0 as `next` and Part 1 stage 7 recorded as `skipped` (its drills run here in stage 10, on the finished system). The Part 1 stage record up to stage 5 is in the `progress.json` of commit b97a87e; stage 6's closing is in plan history. Plan history gets an entry for the switch.

The README carries a "Spend to date" line from stage 0. Stages that run drills or load against Cloudflare update it from the billing page.

## The end-to-end slice

Stages 0 to 4 are the slice (DES-4): one prelander with the three-step quiz, `POST /api/complete` with selection, the `/go` redirect with a click row, a signed Lead postback, the Lead return at entry, a Purchase, a repeated postback that changes nothing, and the report in both views, deployed through CI. Events take the short path, Queue to consumer to D1. The slice is done when `pnpm test:e2e --base $BASE` (MVP-1) passes against the deployed Worker in stage 4.

If time runs out, stages 5 to 10 shrink or become design-only. The slice does not.

---

## Stage 0: project setup and first deploy

Estimate: 3 hours.

Goal: R-20. The empty project deploys through CI with every binding the design needs, and both databases have their schema. DLV-1, DLV-2 and DLV-4 start here.

Files: `package.json`, `tsconfig.json`, `vitest.config.ts`, oxlint config, `.gitignore` (adds `.dev.vars`, `.wrangler`), `.dev.vars.example`, `wrangler.jsonc`, `src/index.ts`, `migrations/facts/0001_init.sql`, `migrations/events/0001_init.sql`, `.github/workflows/ci.yml`, `README.md`, `tests/healthz.test.ts`.

Read first: [data-model.md](../design/data-model.md), the tables and "MVP events database"; [ADR 0005](../adr/0005-event-ingestion-and-buffering.md), "Path of an event" and "Dead letter queue"; the Cloudflare rows of [nfr.md](../requirements/nfr.md#platform-limits-and-prices).

Done on 2026-11-03, before this plan: wrangler 4.157 installed; `wrangler login` with Arthur's own account (Q-17); R2 enabled on the account; the Cloudflare skills plugin (`cloudflare@cloudflare`) installed at project scope and declared in `.claude/settings.json`. Not verified yet: whether the account is on Workers Paid.

Content:
- Bindings: D1 `facts`, D1 `events`, Queue `events` (producer, and a consumer with batches of 100, a 30-second wait, 10 retries, dead letter queue `events-dlq`), one R2 bucket, one Analytics Engine dataset.
- Facts migration 0001: the eight tables of data-model.md as written. Events migration 0001: `events` with `event_id` as primary key and the envelope fields as columns.
- `GET /healthz` returns `{"sha": ...}`, set at deploy with `wrangler deploy --var GIT_SHA:$GITHUB_SHA`.
- CI as in the decisions table. Arthur creates the API token with the narrowest scopes deploy and migrations need and adds it to GitHub himself.
- Plan check. Workers Paid costs $5 a month and is what the design assumes: Queues keep messages 14 days on Paid against 24 hours on Free, D1 holds 10 GB against 500 MB, and the design load of 600,000 events a day exceeds the Free daily limits ([nfr.md](../requirements/nfr.md#what-these-numbers-mean-for-the-design)). The demo alone fits on Free.

Steps:
- [ ] Arthur reads the account's plan on the dashboard's plans page. If Free, AskUserQuestion: upgrade now or before stage 5 (recommended: before stage 5, the first stage that relies on retention). Record it in the README spend line.
- [ ] Scaffold, pin hono, zod, typescript, wrangler, vitest, the pool package, oxlint, oxfmt.
- [ ] Create the databases, queues and bucket with wrangler; write the bindings.
- [ ] Write both migrations; `wrangler d1 migrations apply facts --local`, same for `events`.
- [ ] Test `DLV-1 healthz returns the commit sha`, then the route.
- [ ] CI workflow; Arthur adds the secrets.
- [ ] Explain back: Arthur names each binding and the stage that first uses it.
- [ ] Verify: `curl -s $BASE/healthz` prints the sha of `git rev-parse HEAD`; the green CI run link is pasted; `wrangler d1 execute facts --remote --command "SELECT name FROM sqlite_master WHERE type='table'"` lists the eight tables, and on `events` lists `events`; `pnpm typecheck && pnpm lint && pnpm test` pass.
- [ ] Approval, commit `feat: project setup, bindings, schema, CI and first deploy`, push.

---

## Stage 1: identity, selection and the quiz

Estimate: 3 hours.

Goal: a new user takes the quiz on the deployed page and gets the right offer; `select()` passes every decision table row. QZ-1, QZ-2, QZ-3, QZ-7, ID-1 (UserID), ID-2, OFF-1, OFF-2, OFF-5 to OFF-8, OFF-10, OFF-12, TEST-1, DEMO-2. The Lead rows (TEST-2) run here as unit cases, since `select()` takes Leads as input.

Files: `src/domain/select.ts`, `src/domain/flow.ts`, `config/prelanders/demo.json`, `src/domain/crypto.ts`, identity middleware, `src/routes/prelander.ts`, `src/routes/complete.ts`, `src/routes/test.ts`, `src/pages/quiz.ts`, `src/db/facts.ts`, `scripts/seed.ts`, tests for each.

Read first: [ADR 0002](../adr/0002-user-identity.md), the decision; [ADR 0004](../adr/0004-offer-selection-semantics.md), the shape of the selection code; [offer-selection.md](../requirements/offer-selection.md), whole; data-model.md, "Quiz completion" and the tables `users`, `user_answers`, `partners`, `catalog_history`, `offers`.

Content:
- Identity cookie per ADR 0002: random UUID, `HttpOnly`, `Secure`, `SameSite=Lax`, re-set on each page request; a non-UUID value is replaced.
- `select(facts, catalog, moment)`, pure. Its tests read their cases from the decision table in offer-selection.md (P-9), so table and tests cannot drift.
- `pnpm seed --local|--remote`: catalog version 1 with the spec's seven offers, all active, and the test partners of data-model.md with secrets encrypted under the master key.
- Quiz flow config: `config/prelanders/demo.json` with the three steps (gender, ethnicity, email), validated by a Zod schema at startup. `src/domain/flow.ts` has three pure functions: `nextStep(flow, answers)`, `evaluateCondition(condition, value)` with `if`, `some` and `not`, and `wording(step, answers)` for templates such as `{gender}`. A fourth step is a new object in the JSON.
- `GET /p/{prelander}`: facts in one D1 batch, selection at entry, the quiz on one page rendered from the flow config (step 2 worded by the step 1 answer, step 3 the email). The redirect branch has nothing to act on until stage 3.
- `POST /api/complete`: Zod body, answers checked against the prelander's flow config (known keys, allowed values), email format check; one D1 batch upserts `users` and `user_answers` and reads Leads and the catalog; `select()`; answers `{offer_id, name, url, reason, catalog_version}`. A `400` writes nothing. The page shows the offer name and URL with a link to `/go?prelander=&visit=` (OFF-10).
- Worker secrets `MASTER_KEY` (AES-GCM for email and partner secrets) and `EMAIL_HASH_KEY` (HMAC for `email_hash`); local values in `.dev.vars`.
- `GET /__test/state` and `POST /__test/reset`, live only when the variable `TEST_ROUTES` is `on`, `404` otherwise.

Steps:
- [ ] Unit tests per decision table row (`OFF-12 row 1 women+asia gives 003`), then `select()`.
- [ ] The automated cases of the cards QZ-1, QZ-2, QZ-3, ID-2, OFF-1, OFF-2, OFF-10, DEMO-2, and `R-12 malformed completion body with an email is rejected without logging the email`; plus `QZ-2 step 2 wording follows the step 1 answer` and `QZ-7 a fourth step added to the flow config renders and is validated without a code change`; then routes, page, seed.
- [ ] Explain back: Arthur walks decision table rows 5 and 7 through `select()`, and says what changes in the repository when a fourth question is added.
- [ ] Verify: `pnpm test -t "OFF-5|OFF-6|OFF-7|OFF-8|OFF-12"` (TEST-1) passes and rows 1 to 15 and 29 each have a test; `pnpm test -t "QZ-|ID-2|OFF-1|OFF-2|OFF-10|DEMO-2"` passes; against `BASE` the DEMO-2 block of the demo script prints `{"offer_id":"003","reason":"best_epu"}`; the gate passes.
- [ ] Approval, commit `feat: identity, offer selection and the quiz`, push.

---

## Stage 2: events

Estimate: 2 hours.

Goal: each visit event reaches the D1 events database once. ID-1 (EventID), ID-4, BIZ-2, QZ-4, QZ-5, the event half of TEST-3, NFR-8 for event order.

Files: `src/events/envelope.ts`, `src/routes/events.ts`, `src/events/producer.ts`, `src/events/consumer.ts`, `src/db/events.ts`, the sender in `src/pages/quiz.ts`, server events in the entry and completion routes, `tests/events.test.ts`.

Read first: [ADR 0005](../adr/0005-event-ingestion-and-buffering.md), "Path of an event" and "Event envelope"; data-model.md, "Event catalog" and "Personal data"; cards QZ-4, ID-1, ID-4, BIZ-2, TEST-3, NFR-8.

Content:
- `POST /api/events`: Zod envelope, `event_id` a UUID, a body size limit (set here and written to nfr.md). The Worker adds `user_id` from the cookie and `received_at`, rejects server-only types and unknown envelope fields with `400` (the schema is strict, so an email has no field of its own, and `sanitizePayload()` in the producer removes every payload key whose name contains `email`, decision 1 of the stage 2 plan), passes unknown types and `schema_version` values, sends one `json` Queue message, answers `202`.
- Server events (`prelander_viewed`, `quiz_completed`, `offer_selected`) through the same producer with Worker-made EventIDs. Entry generates `visit_id` and writes it into the page.
- Slice consumer: up to 100 messages into D1 `events` with `ON CONFLICT (event_id) DO NOTHING`, in chunks under 100 bound parameters. A comment marks it for replacement in stage 5.
- Browser: one event per request, `step_viewed` for steps 1 to 3, `step_answered` for steps 1 and 2, `seq` per visit, unsent events kept in localStorage and resent with the same `event_id`.

Steps:
- [ ] The automated cases of the cards above, plus `R-12 envelope has no email field: an event carrying one never reaches the Queue` and `ID-4 unknown schema_version is stored and not dropped`; then the code.
- [ ] Explain back: Arthur follows one `step_answered` from the browser to its row, and says what happens when it is sent twice.
- [ ] Verify: `pnpm test -t "TEST-3|ID-1|ID-4|BIZ-2|QZ-4|QZ-5|NFR-8"` passes; against `BASE`, the same body posted twice raises `state $JAR | jq '.me.events | length'` by exactly 1 after the 30-second consumer wait; one browser visit through completion gives 8 events (the ninth, `offer_click`, is checked by NFR-1 in stage 3); the gate passes.
- [ ] Approval, commit `feat: event ingestion through the Queue`, push.

---

## Stage 3: redirect, postbacks and the Lead return

Estimate: 3 hours.

Goal: the transition, the signed postback and the Lead return behave as the ADRs say, and rejected postbacks change nothing. OFF-3, OFF-4, OFF-9, OFF-11, ID-3, PB-1 to PB-8, A-4, R-9, NFR-1, TEST-2, TEST-3, TEST-4, DEMO-3, DEMO-4, DEMO-6.

Files: `src/routes/go.ts`, `src/routes/postback.ts`, `src/domain/signature.ts`, `src/db/clicks.ts`, `src/db/conversions.ts`, the redirect branch of entry, `POST /__test/seed`, `scripts/postback.ts`, `scripts/offer.ts`, tests for each.

Read first: [ADR 0007](../adr/0007-postback-contract-and-auth.md), whole; [design.md](../design/design.md#where-offer-status-is-checked-again), "Where offer status is checked again"; data-model.md, `clicks`, `conversions`, `quarantine`; the PB cards and endpoint conventions.

Content:
- `GET /go?prelander=&visit=` takes no offer ID. It reads the facts and the current catalog and runs `select()` again for the cookie's user, so a catalog change since the page was shown applies (R-9, OFF-9). An offer: write the click, then `302` with `click_id` in `Location`. No offer: show the no-offer message. Quiz needed (no `users` row, Q-30): `302` to `/p/{prelander}`, no click. `click_id` has at least 128 random bits; each click emits `offer_click`, and `/go` emits no `offer_selected`.
- Entry: rule 1 answers `302` with a new click; rule 3 skips the quiz when every Lead is for a disabled offer and the answers are sufficient.
- `POST /postback/v1/{partner}`: `X-Signature: t=<unix seconds>,v1=<hex>`, HMAC-SHA256 over `t.body` with the current or previous secret, constant-time compare, 5-minute window; Zod body; click lookup; partner owns the click's offer; `ON CONFLICT (partner_id, type, transaction_id) DO NOTHING RETURNING id`. Answers per ADR 0007: `202` new, `200` with `duplicate`, `401` unsigned, wrong or stale, `400` malformed or another partner's click, `202` plus a `quarantine` row for an unknown click, `503` with `Retry-After: 30` when D1 or the Queue fails. Accepted and duplicate postbacks send `lead` or `purchase` with the EventID derived from the dedup key.
- `pnpm postback lead|purchase --click <id> --txn <id> [--base <url>]` signs with the test secret from `.dev.vars` and prints status and body (P-10, PB-7).
- `pnpm offer set-status <id> active|inactive` and `pnpm offer set-epu <id> <value>` write a new catalog version through `wrangler d1 execute`, no deploy (Q-9).

Steps:
- [x] The automated cases of the cards above, plus `R-9 offer disabled after selection is re-selected at /go` and `OFF-11 click row exists before the 302`; then the code.
- [x] Fix the demo script comments in acceptance-checks.md that expect `200` for a new postback, where ADR 0007 says `202`, in this commit.
- [x] Explain back: Arthur walks a redelivered Lead and a second real Purchase, naming the key that tells them apart.
- [x] Verify: `pnpm test -t "OFF-3|OFF-4|OFF-9|ID-3"` (TEST-2, rows 16 to 23, 27, 28), `pnpm test -t "PB-5|TEST-3"` (TEST-3), `pnpm test -t "PB-3|PB-8"` (TEST-4) and `pnpm test -t "A-4|NFR-1|DEMO-3|DEMO-4|DEMO-6"` pass; against `BASE`, DEMO-3 prints `202`, DEMO-4 prints `302 https://asia-connect.example/?click_id=<new id>`, the repeated Lead prints `200` with `duplicate` and `state $JAR` shows one Lead; `grep -rnE -- "curl .*-L( |$)|redirect: ?'follow'" tests/ scripts/` prints nothing; the gate passes.
- [x] Approval, commit `feat: redirect, signed postbacks and the Lead return`, push.

---

## Stage 4: report

Estimate: 2.5 hours.

Goal: the report counts what the system recorded, in the cohort and postback views, and the slice runs end to end on Cloudflare. AN-1 to AN-8, TEST-5, DEMO-5, DEMO-7, R-17, MVP-1, MVP-4.

Files: `src/domain/report.ts`, `src/db/report.ts`, `src/routes/report.ts`, `src/pages/report.ts`, `migrations/events/0002_report_indexes.sql`, `migrations/facts/0002_report_indexes.sql`, `scripts/demo.sh` behind `pnpm test:e2e`, `scripts/lib/dev-server.sh`, `tests/fixtures/report.ts`, the report tests in `tests/unit/` and `tests/integration/`, the README "Expected results" section.

Read first: [metrics-and-operations.md](../design/metrics-and-operations.md), "Metric definitions", "What the MVP report shows", "Two report views"; cards AN-1 to AN-8, TEST-5, DEMO-5, MVP-1.

Content:
- `GET /api/report?from=&to=&prelander=&offer=&view=cohort|postback`. Funnel steps from D1 `events` (M-1, M-3, M-4, M-5, M-8); clicks, Leads and Purchases from facts (M-10, M-13, M-14; M-15 and M-16 in the postback view); drop-offs M-23; rates M-20 to M-22 and M-24 to M-28. The Worker merges the two databases by day, prelander and offer. Each query has a comment with its metric id (AN-8). The response has top-level totals (`started`, `lead`, `purchase` and the rest) for the demo script, rows, and an "as of" time.
- `/report` shows the same data with a view switch. No CSV export here: `?format=csv` is kept as the backup live task for the review (stage 10).
- Fixture: the three AN-1 users and, for AN-5, a click dated yesterday with a Purchase today. Expected: started 3, step 1 3, step 2 2, step 3 2, transitions 1, Lead 1, Purchase 1.
- DEMO-7 table: the report after each demo step, ending at started 1, steps 1 to 3 at 1, transitions 2, unique users sent to an offer 1, Lead 1, Purchase 1, as in acceptance-checks.md.

Steps:
- [x] The automated cases of AN-1 to AN-8, R-17 and DEMO-5; then the queries and the page.
- [x] Explain back: Arthur says why yesterday's cohort row can change today and which view finance should read.
- [x] Verify: `pnpm test -t "AN-1|AN-5|AN-7"` (TEST-5) passes against the fixture table; against `BASE`, the report saved with `jq -S .` before and after the DEMO-5 Purchase differs, by `diff`, only in the cells the DEMO-7 table lists; after DEMO-6, `jq '{lead,purchase}'` prints `{"lead":1,"purchase":1}`; `pnpm test:e2e --base $BASE` passes (MVP-1); `grep -rni bigquery src/ wrangler.jsonc` prints nothing (MVP-4); the gate passes.
- [x] Approval, commit `feat: funnel report in cohort and postback views`, push.

The slice is complete here.

---

## Stage 5: R2 files and the loader

Estimate: 2.5 hours.

Goal: the event path matches ADR 0005 and ADR 0006, with D1 as the load target. NFR-3, NFR-4, NFR-5, NFR-8, R-8, R-16.

Files: `src/events/files.ts`, `src/events/consumer.ts`, `src/events/loader.ts`, `src/events/producer.ts`, `src/events/health.ts` behind `GET /__test/health`, `src/db/events.ts`, `src/index.ts` (queue and the loader cron), the producer callers in `src/routes/`, the loader cron in `wrangler.jsonc`, `scripts/sink.ts` and `scripts/lib/sink.ts` behind `pnpm sink outage on|off`, `scripts/lib/wrangler-config.ts`, the loader ticker in `scripts/lib/dev-server.sh`, `scripts/demo.sh` and `scripts/acceptance.sh` waiting for the loader, `tests/fixtures/files.ts`, the producer, loader, pipeline and health tests, the `loaded-30d` and `rejected-30d` R2 lifecycle rules.

Read first: [ADR 0005](../adr/0005-event-ingestion-and-buffering.md), "Path of an event", "Dead letter queue", "MVP: D1 as the stand-in for BigQuery"; [ADR 0006](../adr/0006-bigquery-delivery.md), "Loader"; cards NFR-3, NFR-4, NFR-5.

Content:
- The consumer writes each batch as one NDJSON file to `pending/`, then acknowledges. A failed write retries after 1, 2, 4, 8, 16, 32 minutes, then hourly; after 10 retries the batch goes to `events-dlq`, which has no consumer.
- The producer writes a one-event file to `pending/` when the Queue refuses, and answers `503` with `Retry-After` when both fail.
- The loader cron runs every minute, the MVP value in ADR 0005 and ADR 0006. It lists `pending/`, writes a manifest to `batches/`, takes at most 9,000 files, drops repeated EventIDs, sends invalid rows to `rejected/`, inserts into D1 `events` with `ON CONFLICT (event_id) DO NOTHING`, writes the batch to `loaded/` and deletes its `pending/` files. Five failed attempts send the batch to `rejected/`. The D1 write moves here from the consumer.
- `pnpm sink outage on|off` puts or removes `control/loader-paused` in R2; the loader skips runs while it exists, so the drill needs no table and no deploy (Fable's call).
- `GET /__test/health`: pending count, oldest pending age, last load time, freshness (age of the newest `events` row).
- Lifecycle rule: `loaded/` and `rejected/` deleted after 30 days.

Steps:
- [x] The automated cases of NFR-3, NFR-4, NFR-5, plus the ADR tests with ids in front: `R-16 events written while the loader is stopped are loaded once after it restarts`, `NFR-5 consumer write failure goes to the dead letter queue after 10 retries`, `NFR-5 a run takes at most 9,000 files`; then the code.
- [x] Explain back: Arthur says where one event waits while the loader is paused, and while R2 is down.
- [x] Verify, against `BASE`: after a demo run `__test/health` shows files in `pending/`, and after the next cron run 0 pending and the rows in D1. Drill: `pnpm sink outage on`, keep the demo script running for 10 minutes, record pending count and oldest age at start and end; demo outputs unchanged (NFR-4). `pnpm sink outage off`, record minutes until pending is 0; `SELECT COUNT(*), COUNT(DISTINCT event_id) FROM events` gives two equal numbers matching the events sent. The gate passes.
- [x] Approval, commit `feat: R2 event files and the loader`, push.

---

## Stage 6: operations

Estimate: 2.25 hours.

Goal: latency and freshness are measured, alerts fire on the [nfr.md](../requirements/nfr.md#set-in-stage-4) thresholds, and the email is absent everywhere it must be. NFR-6 (in-Worker measurement), R-12, DEMO-8, AN-5 on Cloudflare.

Files: `src/ops/metrics.ts` (a data point per request and per loader run), `src/ops/alerts.ts` (the alert cron), `src/db/ops.ts`, `src/db/postback-counts.ts` with `migrations/facts/0003_postback_counts.sql`, `src/db/analytics-engine.ts` (the SQL API reads), `src/routes/probe.ts`, `GET /__test/files` in `src/routes/test.ts`, the alert branch in `src/index.ts`, the alert cron, `ALERT_THRESHOLDS` and the `EVENTS_DLQ` binding in `wrangler.jsonc`, `scripts/email-scan.sh` with its remote mode, the metrics, alert, probe, postback count and email-absent tests, the Worker secrets `AE_SQL_TOKEN` and `CF_ACCOUNT_ID`.

Read first: metrics-and-operations.md, "Latency target (NFR-6)" and "Alerts"; data-model.md, "Personal data"; cards DEMO-8, R-12.

Content:
- One Analytics Engine data point per request: endpoint as index; duration and status as doubles; country and Cloudflare location as blobs. The loader adds a freshness point per run.
- Alert cron every 5 minutes, one JSON log line per firing alert (id, value, threshold). Read directly: `freshness_lag`, `pending_oldest_file`, `rejected_new_file`, `quarantine_new_row`, `postbacks_without_conversions` (at least 5 postback requests in the last 15 minutes and none accepted, which is what a wrong partner secret or a broken click lookup looks like; the counter lives in a small D1 table written by the postback route), and once a day `d1_facts_size` and `d1_events_size`. Read through the Analytics Engine SQL API with a read-only token held as a secret: `selection_p95`, `worker_5xx_rate`, `d1_overload_errors`. Whether `dlq_not_empty` can be read the same way is settled in the stage; if not, it joins the design-only list.
- `GET /__probe`: the entry D1 batch for a UserID with no rows, then `select()`, `200` with the D1 time; no cookie, no events.
- `pnpm test:email-scan` already exists: it takes the path of a `wrangler dev` log and searches that log and the local D1 and Queue state for the address and its URL-encoded form. This stage extends it to Queue messages on Cloudflare, R2 files and a `wrangler tail` capture against `BASE`.

Steps:
- [x] The automated cases of DEMO-8 and R-12, plus `NFR-6 every request writes one data point`, `NFR-6 probe writes nothing and sets no cookie`, and one case per alert threshold; then the code.
- [x] Explain back: Arthur names the first alert he would see if the loader stopped, and if a partner's secret were wrong (`postbacks_without_conversions`).
- [x] Verify: `pnpm test:browser` passes against local `wrangler dev`, its email scan clean; with `wrangler tail --format json > $TMP/tail.log` during a demo run against `BASE`, `grep -c` for `user1@example.com` and for `user1%40example.com` both print 0; an Analytics Engine SQL query for that hour gives p95 per endpoint, written down against 50 ms and 300 ms; drill: a signed postback for an unknown click, then `wrangler tail` shows `quarantine_new_row` within 5 minutes; `curl -s -o /dev/null -w '%{http_code} %{time_total}\n' $BASE/__probe` prints `200` and a time, recorded; the AN-5 manual card against `BASE` puts the Purchase on yesterday's cohort row and today's postback row; `pnpm check` passes.
- [x] Approval, commit `feat: latency data, alert cron, probe and email scan`, push.

---

## Stage 7: README and demo

Estimate: 2.75 hours.

Goal: a reviewer can install, run, test and repeat the demo from the README alone, and the quiz page works in a real browser. DEMO-1, DEMO-7, DEMO-9, DLV-1, DLV-3, DLV-4, DLV-5, NFR-8 step 3.

Files: `README.md`, `tests/e2e/quiz.spec.ts` (the `/go?prelander=demo` link, DEMO-9), `tests/unit/signature.test.ts` (a known-answer HMAC vector computed with openssl), the NFR-6 card's result line.

Read first: the DEMO and DLV rows of requirements.md; cards DEMO-1, DEMO-7, DEMO-9, NFR-8.

Content: an "Architecture in the code" section first: the diagram from design.md, a table from each component to its folder and ADR, the request path of the five demo steps through the code, and "what to read first" for a reviewer with 30 minutes; then the demo link (DLV-1); install and `wrangler dev`; tests and the gate; a test postback with `pnpm postback`; repeating the demo locally and on Cloudflare (DLV-3); test data and expected results (DEMO-7); how the transition is reproduced without a partner, as a `302` checked by its `Location` header with `.example` targets (DEMO-9); the implemented, simulated and design-only split from this plan (DLV-5); known limitations, each with the test that shows it (NFR-8); the CI badge (DLV-4); the redrive command; the deploy workflow (a push to `main` deploys), the paragraph on how a team would run it with feature branches, a preview deploy per pull request and flags, and the two paragraphs from the decisions table on one Worker rather than a monorepo and on pages without a frontend framework, each with when that would change; spend to date.

Browser smoke test (Fable's proposal, accepted by Arthur on 2026-11-04): the test already exists in `tests/e2e/quiz.spec.ts` and runs in CI against `wrangler dev`. This stage adds the `/go?prelander=demo` link assertion and the run against the deployed `BASE`. The scenario: a fresh context opens `/p/demo`, answers women and asia, enters `user1@example.com`, sees the offer name for 003 and the `/go?prelander=demo` link, and `GET /__test/state` with the context's cookie lists `prelander_viewed`, `step_viewed` 1 to 3, `step_answered` 1 and 2, `quiz_completed` and `offer_selected`, in arrival order: the browser's five events carry `seq` 1 to 5 and the server's three carry none. The browser never follows `/go` (DEMO-9). Playwright is a dev dependency only; `pnpm test:browser` is not part of `pnpm test`.

Steps:
- [ ] Draft through the humanizer skill; Arthur reads it whole. (Drafted, reviewed by Opus and read cold by Fable; Arthur reads it before the hand-in.)
- [x] Add the `/go?prelander=demo` link assertion to `tests/e2e/quiz.spec.ts` and run it against `BASE`; fix whatever it finds in the page's JavaScript.
- [x] Explain back: Arthur runs the demo from the README, saying what each command proves.
- [x] Verify: `git clone` into `$TMP/fresh` and follow only the README (`pnpm install`, the gate, `wrangler dev` with the demo script, the demo script against `BASE`), output pasted, every step matching the README; the DEMO-7 card finds each README row in the decision table with the same result; `grep -rnE -- "curl .*-L( |$)|redirect: ?'follow'" README.md tests/` prints nothing; the CI badge shows green; `BASE=$BASE pnpm test:browser` passes, its summary pasted; the test asserts that the eight events arrive in order, the browser's five with `seq` 1 to 5 and the server's three with none.
- [x] Approval, commit `docs: README, demo instructions and the implementation split`, push.

---

## Stage 8: AI evidence

Estimate: 1 hour.

Goal: AI-1 to AI-3. Agent instructions, plan history and two or three examples are final; nothing secret or personal is in the repository.

Files: `docs/ai/examples/`, `CLAUDE.md`, [plan-history.md](../ai/plan-history.md), a README section pointing to them.

Read first: plan-history.md, whole; examples 01 to 08 and any added in Part 2.

Content: Arthur picks two or three examples, each with the template's four parts. `CLAUDE.md` is updated to how Part 2 actually ran. acceptance-checks.md has no AI cards, so the checks are listed here.

Steps:
- [x] Arthur picks; the AI tightens the text with the humanizer skill without changing facts.
- [ ] Explain back: for each example, Arthur says in one sentence what he changed in the AI's proposal and why.
- [x] Verify: `grep -rnE "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}" --exclude-dir=node_modules --exclude=pnpm-lock.yaml . | grep -v "@example\.com"` prints nothing; `grep -rnEi "(token|secret|api[_-]?key)[\"' ]*[:=][\"' ]*[A-Za-z0-9_-]{20,}" --exclude-dir=node_modules .` prints nothing; `git ls-files | grep "\.dev\.vars$"` prints nothing; the last plan-history entry covers Part 2 (AI-1); `grep -c "^## "` gives 4 for each chosen example (AI-2).
- [x] Approval, commit `docs: AI work log for the delivery`, push.

---

## Stage 9 (optional): load test

Estimate: 1 hour. The first stage to drop.

Goal: P-7 and NFR-2 measured, and p95 under load compared with NFR-6.

Files: `load/peak.js`, results in nfr.md, a cost line in the README.

Read first: cards NFR-2, NFR-6; the p95 targets in [nfr.md](../requirements/nfr.md#set-in-stage-4).

Content: 200 events/s for 5 minutes against the deployed Worker, one `POST /api/events` per iteration with a new `event_id` for one of many synthetic users: 60,000 requests and about 180,000 Queue operations. On Paid that falls inside the included amounts; past them it is about 2 cents of requests and 7 cents of Queue at the nfr.md prices. The 2x and 5x runs of P-7 only if Arthur agrees on the day.

Steps:
- [x] Announce the run and its cost, then run it.
- [ ] Explain back: Arthur reads the summary and names the number that would make him leave D1 (ADR 0003 migration triggers).
- [x] Verify: `k6 run -e BASE=$BASE --summary-export $TMP/peak.json load/peak.js` gives p95 for `/api/events` against 50 ms and an error rate, both recorded; stored events equal the `202` count once `__test/health` shows an empty buffer; the dashboard request count for the window is within 20% of k6's; the cost line is in the README.
- [x] Approval, commit `test: load test at 200 events/s`, push.

---

## Stage 10: self-review and hand-in

Estimate: 2 hours.

Goal: AI-4 and R-22. Arthur defends and changes the system under time pressure, and the delivery leaves. This is Part 1 stage 7, moved here: Arthur chose on 2026-11-04 to run the design drills once, on the finished system, rather than once on paper and again on code.

Files: fixes found by the drills. The cover message is drafted in conversation in Ukrainian and not committed.

Read first: [design.md](../design/design.md#10-how-the-system-changes), section 10; the open rows of [open-questions.md](../requirements/open-questions.md).

Content:
- Change drill: the six changes of design.md section 10, each answered from memory as "change X in place Y, run Z" with real file names. An answer touching more than one module, or needing a manual production step, is a finding.
- Live task for the review (AI-4), prepared and rehearsed, not improvised. Primary: a fourth quiz question, a new step in `config/prelanders/demo.json` (partner age range) and a row in the test fixture, no code. Backup: `GET /api/report?format=csv`, one route and one test. Either runs the whole path in front of the reviewers: branch, pull request, green CI, merge to `main`, the step visible on the deployed page, `/api/complete` accepting the new answer. Rehearsal: both tasks done once on a throwaway branch with a stopwatch, the CI time written down (target under 3 minutes per deploy), and the branch deleted. Target for the live run: 10 minutes for the primary, 15 for the backup.
- grill-me on the design and the code.
- Infrastructure drill, from Arthur's own notes outside the repository: questions about the Cloudflare pieces (where the Worker runs, where D1 lives and why one region, what happens to the Queue when the consumer stops, the monthly cost at the design load, what a binding is), answered without looking.
- The list "What to show at the review" below, walked through once in order, with the URL or command for each item ready.
- Cover message: what is in the repository, the demo link, open questions with their defaults, the spend. Arthur edits and sends it.

Steps:
- [ ] Change drill. Rehearse both live tasks on throwaway branches and record the times. grill-me; each unanswered question becomes a fix or a line in the message.
- [ ] Verify: the six drill answers written down; for each live task the elapsed time from branch to production `/healthz`, the CI run time and the `pnpm test` output pasted, both throwaway branches deleted and production unchanged; DLV-2: code, design and both plans in the repository, `git status` clean; Arthur has read the cover message.
- [ ] Approval, commit `docs: final self-review fixes`, push. Arthur sends the message.

---

## What to show at the review

The list Arthur walks through at the review, so nothing built is forgotten. Each stage adds its items in its closing commit; stage 10 rehearses the walk. The order is the demo order, then what is behind it.

| Shown | How | Stage |
|---|---|---|
| A new user takes the quiz and gets 003; the quiz is a JSON config | `/p/demo` in a browser, then `config/prelanders/demo.json` | 1 |
| Every step sends one event; the same event twice is stored once | `__test/state` after the visit; resend one event | 2 |
| The Lead postback, the return without the quiz, the repeated postback that changes nothing | `pnpm postback`, `/p/demo` again, `pnpm postback` again | 3 |
| The report in two views and the Purchase moving the numbers | `/report`, then a Purchase postback, then `/report` again | 4 |
| The whole demo as one command, every answer and report cell checked | `pnpm test:e2e --base $BASE` | 4 |
| An offer turned off without a deploy and `/go` re-selecting | `pnpm offer set-status 003 inactive`, then `/go?prelander=demo` | 3 |
| A postback that is unsigned, stale or for another partner's click changes nothing; an unknown click waits in quarantine | `pnpm test -t "PB-3\|PB-4\|PB-8"`, then `counts.quarantine` in `__test/state` | 3 |
| The event path: Queue, files in R2, the loader, and what the loader-paused drill showed | `curl $BASE/__test/health`, `pnpm sink outage on --remote`, the drill numbers in ADR 0005's Outcome | 5 |
| Alerts and latency: the data points, the alert log line for a wrong secret | the Analytics Engine SQL query for p95 per endpoint, `wrangler tail` with `alert_run` and `postbacks_without_conversions`, `curl $BASE/__probe` | 6 |
| The path to production: a push to `main`, tests, migrations, deploy, `/healthz` with the commit | the CI run list | 0 |
| Where the architecture lives in the code | README "What it does", "Implemented, simulated, design-only" and "Architecture in the code", the folder comments | 7 |
| Tests at four levels and the browser smoke run | `pnpm test` output, the Playwright summary | 7 |
| The spec peak: 200 events/s for 5 minutes, every accepted event stored, and the one target it missed with the cause | nfr.md "Measured in Part 2 stage 9", the NFR-2 and NFR-6 results, R-24, `load/peak.js` | 9 |
| The cost: spend to date and the monthly figure at 12M and 18M events | README spend line, nfr.md cost table | 0, 9 |
| How the system changes: the six changes and their places | design.md section 10, answered live | 10 |
| The live task: a fourth quiz question from branch to production in 10 minutes, with AI | branch, PR, CI, merge to `main`, the deployed page; CSV export as the backup | 10 |
| The AI work log: instructions, plan history, examples | `CLAUDE.md`, `docs/ai/` | 8 |

## Requirement to stage mapping

| Requirement | Stage | Check |
|---|---|---|
| TEST-1 | 1 | `pnpm test -t "OFF-5\|OFF-6\|OFF-7\|OFF-8\|OFF-12"` |
| TEST-2 | 1 (unit), 3 (integration) | `pnpm test -t "OFF-3\|OFF-4\|OFF-9\|ID-3"` |
| TEST-3 | 2 (events), 3 (postbacks) | `pnpm test -t "PB-5\|TEST-3"` |
| TEST-4 | 3 | `pnpm test -t "PB-3\|PB-8"` |
| TEST-5 | 4 | `pnpm test -t "AN-1\|AN-5\|AN-7"` |
| DEMO-1 | 7 | fresh-clone dry run from the README |
| DEMO-2 | 1 (HTTP), 7 (browser) | DEMO-2 block against `BASE`; test `DEMO-2`; `pnpm test:browser` |
| DEMO-3 | 3 | DEMO-3 block; test `DEMO-3` |
| DEMO-4 | 3 | DEMO-4 block; test `DEMO-4` |
| DEMO-5 | 4 | report diff around the Purchase |
| DEMO-6 | 3 (answers), 4 (report) | `duplicate`; `{"lead":1,"purchase":1}` |
| DEMO-7 | 4 (table), 7 (README) | DEMO-7 card |
| DEMO-8 | 6 | `pnpm test:email-scan`; `wrangler tail` grep |
| DEMO-9 | 3 (tests), 7 (README) | redirect grep prints nothing |
| DLV-1 | 0 (deploy), 7 (link) | `curl $BASE/healthz` |
| DLV-2 | 0, 10 | code, design and plans in the repository |
| DLV-3 | 7 | fresh-clone dry run |
| DLV-4 | 0 (CI), 7 (badge, limitations) | green CI run |
| DLV-5 | 7 | README section from the lists below |

## Implemented, simulated, design-only

Expected split for DLV-5; the README copies it in stage 7 with whatever changed.

Implemented:
- Endpoints `GET /p/{prelander}`, `POST /api/events`, `POST /api/complete`, `GET /go`, `POST /postback/v1/{partner}`, `GET /api/report`, `/report`, `GET /__probe`, `GET /healthz`.
- The Queue and its consumer, with retries and a dead letter queue.
- The D1 facts and D1 events databases, with migrations applied in CI before each deploy.
- R2 event files and the loader (`pending/`, `loaded/`, `rejected/`).
- HMAC-signed postbacks, quarantine, dedup on `(partner_id, type, transaction_id)` and on `event_id`.
- The report in the cohort and postback views.
- Catalog versions changed by script, no deploy.
- Analytics Engine data points, the alert cron, `GET /__probe`.

Simulated:
- BigQuery, replaced by the D1 events database, with the loader writing there (MVP-4).
- Partner sites, replaced by `.example` URLs and a redirect that tests assert without following.
- Partners, replaced by the `pnpm postback` helper.

Design-only (MVP-6):
- BigQuery load jobs and the deduplicating view ([ADR 0006](../adr/0006-bigquery-delivery.md)).
- The external probe from the EU and the US.
- The dead letter queue redrive script.
- Feature branches tested in isolation on a preview deploy per pull request, merged into `main` after review, with flags for unfinished work: the team workflow, described in the README's deploy section with the wrangler commands it would use.
- Migration to Postgres ([ADR 0003](../adr/0003-operational-store.md)).
- Durable Objects.
- A cookie consent banner (Q-27).
- Ad campaign attribution (Q-28).
- Cross-device identity.

## Schedule

| Day | Stages | Hours |
|---|---|---|
| Wed 2026-11-04 | 0, 1 | 6 |
| Thu 2026-11-05 | 2, 3 | 5 |
| Fri 2026-11-06 | 4, 5 | 5 |
| Sat 2026-11-07 | 6, 7 | 5 |
| Sun 2026-11-08 | 8, 9 (optional) | 1, plus 1 for stage 9 |
| Mon 2026-11-09 | 10, hand-in | 2 |

If Wednesday or Thursday overruns, stage 9 goes first, then stage 6 shrinks and stage 5 becomes design-only, so the slice still finishes on Friday.

## Self-review against the spec

- MVP-1: stages 0 to 4, closed by `pnpm test:e2e --base $BASE`.
- MVP-2: the layout follows design.md section 2; stage 0 creates every binding it names.
- MVP-3: no admin panel, rules builder, mailings or EPU recalculation in any stage.
- MVP-4: stage 4 (BigQuery grep), stage 5 (loader writes D1).
- MVP-5: stage 6 (D1 size alerts); the README links the limits.
- MVP-6: the design-only list.
- DEMO-1 to DEMO-9, TEST-1 to TEST-5, DLV-1 to DLV-5: the mapping table.
- AI-1 to AI-3: stage 8. AI-4: stage 10, with R-22 rehearsed there.
- R-9: stage 3. R-12: stages 1, 2, 6. R-20: stage 0 is the first deploy.
