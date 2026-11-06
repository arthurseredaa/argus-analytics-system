# Plan history

The initial plan and every significant change to it, newest at the bottom.

## 2026-10-29: initial plan

The work is split into stages, and each one ends with a verification step and the user's approval:

1. Set up the repo for AI-assisted work: agent instructions, ADR template, this log, the humanizer skill for English prose.
2. Break the spec down into requirements, open questions, proposals, risks and research notes in `docs/requirements/`.
3. Write the Part 1 design and send it to the company for discussion.
4. Write technical plans: dev environment, CI/CD, Cloudflare setup, cost limits, pre-commit checks (TypeScript, oxfmt, oxlint), unit tests in CI, Claude Code hooks, deployment, test and production environments, database, scaling and load verification.
5. Implement the MVP in the scope agreed after the design review.

## 2026-10-29: Part 1 first, implementation gated on agreement

Only Part 1 is worked on now. The design deliverable (document, diagram, implementation plan with checks, minimal end-to-end slice, notes on the Purchase-based offer exclusion and EPU from real data) is sent to the company first. Scope and payment for Part 2 are agreed after that, and some of it may not need implementing. The technical plans from step 4 become part of the design's implementation plan; nothing is set up until the scope is agreed.

## 2026-10-30: Part 1 split into eight stages

Stage 3 of the initial plan ("write the Part 1 design") is now its own staged plan, `docs/plans/part1-design-document.md`: research note, two rounds of ADRs, data model, metrics and operations, the design document with diagram, the MVP plan with the end-to-end slice, and a review rehearsal before sending. Reason: one stage of 8 to 10 hours cannot be reviewed or explained back in one sitting, and the reviewer has to see each decision with its alternatives. The plan also adds a design principle the technical reviewer asked for: the system has to keep running with little maintenance and change easily, so every stage names its versioning and extension points.

## 2026-11-01: stage 0 cut from a research note to a limits table

Stage 0 no longer produces `research-cloudflare.md` with a section per service. The limits and prices that bound the design go into a table in `docs/requirements/nfr.md` with sources, and only BigQuery ingestion from outside Google Cloud gets a short note of its own. Estimate down from 1.5 to 1 hour. Reason: the company asked for a design document, and a per-service note would be an intermediate file that the ADR options tables repeat anyway. Most prices were already collected from the account's Workers plans page and the pricing docs on 2026-11-01. The plan was over budget (about 11 hours against 8 to 10), and stage 0 was already named as the one to shorten.

## 2026-11-02: acceptance checks written before the design

Added `docs/testing/acceptance-checks.md`: one card per functional and non-functional requirement, with the automated tests that must exist, manual steps and the expected result, to run as each requirement is implemented. Arthur asked for concrete steps to run after each requirement is implemented. Endpoints and tools in it are provisional and named against the ADR that will fix them; when ADRs 0002 to 0007 are accepted, the conventions table is updated first. Stage 6 of `docs/plans/part1-design-document.md` maps its TEST and DEMO rows to these cards instead of writing the checks again. No stage was added or moved. While writing it, QZ-2 in `requirements.md` was corrected to the spec's codes `asia`, `europe`, `latam`.

## 2026-11-02: Postgres option and a migration path in ADR 0003

Stage 1 of `docs/plans/part1-design-document.md` now lists an external Postgres as a fourth option for the operational store, and ADR 0003 gets a migration section: which D1 numbers trigger a move, to Postgres or to Durable Objects, and the steps. Stage 4 ties its MVP-5 alert thresholds to those triggers. Arthur asked for it while working through the stage 0 limits: he asked why a plain Postgres would not do, and wanted the reason for setting it aside and the plan for outgrowing D1 written down.

## 2026-11-02: step views added to the event catalog

A visit now produces 9 events instead of 6: a `step_viewed` event for each quiz step joins the list in A-1 (`docs/requirements/open-questions.md`). Arthur asked for it: going back to a step and changing an answer is a product signal, and answer events alone do not show a return that left the answer unchanged or the time spent on a step. Q-13 already defined "started the quiz" as step 1 shown, which needed a view event. The design is now sized for 18M events a month against the spec's 12M; `nfr.md` carries both figures and the cost table for each. Stage 3 catalogs nine visit events and stage 4 prices the design load. The acceptance checks for ID-4 and NFR-1 expect nine events.

## 2026-11-02: one event per request, and gaps closed in ADRs 0005 and 0006

Arthur's explain-back for stage 2 was a drawing of the event and postback paths. Checking it against ADRs 0005 and 0006 found three gaps, and his questions settled one open choice.

- The browser sends exactly one event per request, at every product step (Arthur's decision). The design cost is now the unbatched column in `nfr.md`, $28.60 a month at 18M events instead of $6.76. Reason: no event waits in the browser for a batch, and the client has no batching logic.
- ADR 0005 said the Queue holds events for 14 days while R2 is down, but after 10 retries the messages would move to the dead letter queue within minutes. Retries now back off from 1 minute to 1 hour (about 5 hours in total), and a redrive script sends dead letter messages back within its 14 days.
- ADR 0006 had no retention for `rejected/` and no limit on load job attempts, so one bad batch could have used up the daily 1,500 jobs. Now `rejected/` keeps files for 30 days, a batch goes there after five failed jobs, BigQuery outages do not count as attempts, and the loader checks envelope types before loading.
- One-event files after a Queue outage are many; the loader takes at most 9,000 files a run, which drains about 30 events/s.

Stage 4 prices the design at the unbatched figure. No stage was added or moved.

## 2026-11-03: answers and email written at quiz completion

Stage 3 (data model) of `docs/plans/part1-design-document.md` changed when answers and the email reach D1. Arthur made the call in the session.

- Answers and email arrive in one request. At quiz completion the browser sends `POST /api/complete` with `{"answers":{...},"email":"..."}`, and the Worker answers with the offer (`offer_id`, `name`, `url`, `reason`, `catalog_version`). This replaces `POST /api/select`. Per-step events are analytics only and never write D1. The latest accepted answer is the completion request the server received last, so answer ordering by `seq` or `client_time` no longer matters for D1. A user who stops before the email step has no rows in D1.
- The email exists only in the `/api/complete` body and in `users.email_enc` and `users.email_hash`. The event envelope (`event_id`, `schema_version`, `type`, `client_time`, `visit_id`, `seq`, `prelander_id`, `payload`, plus `user_id` and `received_at` added by the Worker) has no field for it, so events cannot carry PII by construction. Arthur rejected the alternative, keeping the same `step_answered` event for step 3 and stripping the value in the Worker before the Queue, as a special case that breaks silently. The session is drafted as `docs/ai/examples/07-email-own-endpoint.md`.
- The `users` row is created at completion. Entry (`GET /p/{prelander}`) writes nothing to D1 for a new user. A Lead return at entry creates a new click row and answers 302.
- Q-29 was added to `docs/requirements/open-questions.md`: does a Lead from prelander P1 apply on P2 of the same domain (default yes). Q-1 keeps its default, an empty quiz on return, and the prefill trade-off is recorded there.
- Table names in the data model differ from the wording in the ADRs: `conversions` (postbacks), `quarantine`, `catalog_history` (catalog versions), `users`, `user_answers`, `clicks`, `offers` with primary key `(version, id)`, and `partners`. `docs/design/data-model.md` carries the mapping.
- `prelander_id` stays in the event body, trusted from the client. A signed visit token was considered and deferred.
- The D1 size estimate in `nfr.md` will be revisited in stage 4, because only users who complete the quiz are stored.

ADR 0003 is not superseded. The table and the upsert are the same. Only the moment of the write and the ordering key, which the ADR left to the data model, are fixed here. `docs/testing/acceptance-checks.md` was updated to the new flow (conventions table, shell helpers, the cards that used `/api/select` or per-step storage, and the email scan in DEMO-8 and R-12). No stage was added or moved.

## 2026-11-03: no separate design review, one delivery

The company answered on 2026-10-30 that it does not review a design on its own before the rest of the work: the whole assignment is delivered at once, with a call about the solution offered afterwards if we want one. Both proposed dates were accepted (the design by 2026-11-02, the MVP about a week later). Arthur decided on 2026-11-03 to deliver everything as one scope and not to negotiate further.

What changes:

- Nothing is sent after stage 7. The design, the MVP and the AI work log go to the company together, so stage 7 becomes a self-review and the cover message moves to the end of Part 2.
- The implementation starts right after stage 4. Stages 5 (design document and diagram) and 6 (MVP plan and end-to-end slice) are done in one session, and stage 6 produces the Part 2 plan with its own stages in `docs/plans/`.
- Open questions keep their defaults; the company will see them in the repository, and the defaults are now the decisions the MVP implements. PRC-1 and PRC-2 in `requirements.md` carry the company's answer.
- The Cloudflare account and spend stay as Q-17 assumes: Arthur's own account, the cheapest plan the design needs, spend reported.

Why: the two-step format was our proposal, not the company's requirement, and waiting for a review that will not happen costs the days the MVP needs.

## 2026-11-04: Part 2 plan written, Cloudflare set up early

Stage 6 of `docs/plans/part1-design-document.md` produced `docs/plans/part2-mvp-stages.md`: eleven stages, 0 to 10, with the end-to-end slice in stages 0 to 4. Stage 6 closed with: 19 sections, 51 checkboxes, 67 table rows, 0 em or en dashes, no empty cell in the requirement-to-stage mapping, a Verify step in all 11 stages, every relative link resolving, no email outside `@example.com`; Arthur named the slice and the irreducible core (funnel, selection, postbacks, events straight into D1 with the report read from it) in his own words. What changed around it:

- Part 1 stage 7 stays skipped and its drills run in Part 2 stage 10. Restoring it before the code was considered on 2026-11-04 (a gap found on paper is cheaper than one found in code) and Arthur decided against it: the same drills would be answered again on the code a week later, so they run once, on the finished system. `progress.json` now follows `part2-mvp-stages.md`; the Part 1 stage record up to stage 5, with what each stage verified, is in the `progress.json` of commit b97a87e, and stage 6's closing is the paragraph above.
- The Cloudflare account was prepared before Part 2 started: wrangler is logged in, R2 is enabled, the account is on Workers Free. The upgrade to Workers Paid waits for Part 2 stage 0. The Cloudflare plugin for Claude Code is enabled through `.claude/settings.json` and is part of the AI setup the spec asks for.
- Decisions recorded in the Part 2 plan's decisions table, each with its owner and date: Hono and Zod; the quiz flow as data, one JSON file per prelander; integration tests in the Workers runtime, an HTTP end-to-end run and a manual browser smoke test; one environment, `main` deploys the one Worker; the team workflow in the README is feature branches with a preview deploy per pull request, merged into `main`, no `develop` branch and no release tags; no frontend framework; one Worker for every entry point rather than a monorepo, with the condition under which that changes; a short live task for the review, a fourth quiz question through the JSON config, with a CSV report as the backup.
- Two environments were in the plan for a few hours on 2026-11-04 and were removed the same day: a second D1, Queue and bucket to keep, and hours on what the spec does not ask for.
- design.md section 10 and data-model.md now describe the fourth quiz question as a new step in the prelander's flow config, with no page code change and no migration.

The Part 1 schedule is not updated; it ended on 2026-11-02 and the dates in the Part 2 plan replace it.

## 2026-11-05: email keys removed from event payloads, a one-day limit on the outbox

Stage 2 of `docs/plans/part2-mvp-stages.md` said no content filter was needed on events, because the strict envelope has no field for an email. Writing the stage plan showed a gap: the payload of an unknown event type or an unknown `schema_version` is stored as sent (ADR 0005), so a later client release could put an email into it. Arthur made two calls in the session.

- The producer runs `sanitizePayload()` on every event, browser and server, before the Queue send. It removes every payload key whose name contains `email`, in any case and at any depth, and logs the event type and the number of removed keys. String values are left as they are, so an email inside a string of an unknown type still passes; that is the accepted risk R-23 in `risks.md`. The AI proposed answering `400` for such an event, and then also replacing email-shaped substrings in string values; Arthur chose removing keys only. The session is drafted as `docs/ai/examples/09-email-in-event-payload.md`.
- The browser outbox drops an unsent event older than one day by its `client_time`. The outbox is there for short outages, and an event that arrives days late lands after the report for its day was counted.

The stage 2 text of `part2-mvp-stages.md`, `docs/design/data-model.md` ("Personal data") and the stage 2 plan now say this. No stage was added or moved.

## 2026-11-05: `/go` without an offer id, and a duplicate postback sends its event again

Two changes to the design came out of the stage 3 plan.

- `GET /go` takes no offer id. The design had `/go/{offer}?prelander=`, and the page put the offer id into the link, so a user could change `/go/003` to `/go/004` and get a click on 004. The AI proposed keeping the path and recording that as an accepted risk. Arthur pointed out that at the press D1 already holds everything `select()` needs, so the server can choose the offer itself from the cookie. A Fable review, asked without the AI's recommendation, reached the same design. `/go?prelander=&visit=` now runs `select()` with the current catalog, writes the click and answers `302`; a user with no `users` row gets a `302` to the quiz (Q-30). The event `offer_selected` with moment `redirect` is dropped, because `offer_click` carries the offer, the reason and the catalog version, so a visit stays at 9 events (A-1). design.md, data-model.md, request-flow.md, metrics-and-operations.md, nfr.md, ADR 0003, ADR 0004, offer-selection.md, the stage 3 text and acceptance-checks.md say this now. The session is drafted as `docs/ai/examples/10-go-without-offer-id.md`.
- data-model.md said a duplicate postback sends no event, and ADR 0007 said it sends the event again with the same EventID. The stage follows ADR 0007: when the Queue fails after the D1 write, the partner's retry is a duplicate, and without the resend the event would be lost. The EventID is derived from the dedup key, so the event is stored once.

No stage was added or moved.

## 2026-11-05: stages run without an approval gate from stage 4

Arthur changed how the remaining stages run, to finish them faster and to review the result once at the end. From stage 4 on there is no approval gate and no blocking explain-back per stage. The AI squash-merges each stage PR itself once CI is green, removes the worktree, checks the deployed Worker, then starts the next stage. It stops only when it needs something from Arthur. Sonnet subagents write the code through subagent-driven development, with a review per task and a whole-branch review on Opus per stage. A Fable review checks how accurately stages 4 to 10 were implemented once stage 10 is done. The explain-back questions are collected in each PR description and in the stage notes. `CLAUDE.md`, the `close-stage` skill, `.claude/rules/state.md` and "How the stages run" in `part2-mvp-stages.md` say this now. An auto-mode safety check refused to let a subagent write these changes, because they relax the agent instructions on the word of agent-written text alone. Arthur confirmed them in his own answer, and the main session made the edits.

The stage 4 plan also settled four report questions the design left open, each from a default in `metrics-and-operations.md`. A click whose user was deleted counts as its own user. Only the first Lead of a user and offer pair counts, and later Leads add only their payout (Q-23). A Purchase counts as "without a Lead" (M-15) when no Lead was accepted at or before it. Visitors (M-2) and transitions (M-11) are in the MVP report, because M-28 and the demo numbers need them. The demo script gained three `step_viewed` lines, without which the report would show `started` 0 after a full visit.

No stage was added or moved.

## 2026-11-06: the loader replaces the consumer's D1 write

Stage 5 moved the D1 write out of the Queue consumer, as ADR 0005 and ADR 0006 planned. The consumer now writes each batch as one NDJSON file to R2 `pending/` and acknowledges it. It no longer validates rows. A loader cron runs every minute and moves those files into the D1 `events` table. The stage plan settled these points:

- A loader run takes at most 8 batches of 900 rows, so 7,200 rows, while ADR 0006 says 9,000 files. The cap comes from D1's limit of 1,000 queries per Worker invocation.
- A failed insert counts as a load attempt only while D1 still answers `SELECT 1`, so an outage never sends a batch to `rejected/`. A D1 that answers but refuses writes would still count. This is recorded as a known limit.
- Quiz completion and `/go` keep sending their server events in the background and never answer `503`, as the stage 2 plan settled. `data-model.md` and `metrics-and-operations.md` said otherwise and were corrected.
- `/__test/reset` leaves R2 alone.
- The demo script and the browser test wait up to 150 seconds for the Queue batch and the next loader minute. The demo also has a paused mode for the loader-paused drill.

The drill numbers and the Outcome sections of ADR 0005 and ADR 0006 follow in a separate small PR, because the drill runs against the deployed Worker after this stage merges.

On 2026-11-06 Arthur also kept stages 6 to 9 in scope after the AI proposed cutting them to save the weekly model quota. The time estimates in this plan are human hours, and the agents need less. A Fable review of how accurately the stages were implemented runs after the last stage, then the project explainer.

No stage was added or moved.

## 2026-11-06: stage 6 alerts as log lines, and the Analytics Engine token

The stage 6 plan settled four points where `metrics-and-operations.md` and the stage text disagreed.

- Alerts are one JSON log line per firing alert, written by a cron every 5 minutes, as the stage text and the decisions table say. The design's email or webhook delivery and its once-an-hour throttle stay design-only. The "Alerts" paragraph now says this.
- `freshness_lag` fires only when something is waiting: a file in `pending/`, or a readable Queue backlog above 0. The design's literal rule, the newest row's age alone, would fire every 5 minutes all night on the idle demo. The whole-branch review added that an unreadable backlog does not count as waiting, so a failing `Queue.metrics()` cannot bring that noise back.
- `dlq_not_empty` reads the dead letter queue through `Queue.metrics()` on a producer binding, not through the GraphQL API, so it needs no token.
- The three alerts read through the Analytics Engine SQL API (`selection_p95`, `worker_5xx_rate`, `d1_overload_errors`) need a read-only API token. Arthur created it and set `AE_SQL_TOKEN` and `CF_ACCOUNT_ID` as Worker secrets on 2026-11-06. Without them, each alert run logs one `alert_source_unavailable` line and the other alerts work.

The reviews changed the alert state to one window start per source (`rejected_checked_at`, `quarantine_checked_at`), so a failed read is retried on the next run. Each window now ends 30 seconds before the run. The plan's decisions 10 and 11 note both changes.

On 2026-11-06 Arthur also lifted the quota limit he had set for the night. No stage was added or moved.

## 2026-11-06: stage 9 runs before stage 8

Stage 9, the load test, ran before stage 8. Stage 8 collects the AI work examples, and Arthur picks the final two or three of them, so it waits for him. Stage 9 needed nothing from him. `docs/state/progress.json` set stage 8 back to pending and stage 9 to in progress, and closing stage 9 makes stage 8 next again.

The same night a small PR fixed the browser test. It compared the browser events in the order they reached D1, and on the deployed Worker that order is not fixed. The test now sorts them by `seq` and checks the server events as a set.

The load test missed one target. `POST /api/events` had a server-side p95 of 74 ms at peak against the 50 ms of NFR-6. The AI first offered to raise the target. Arthur asked to find the cause before any fix. The cause is the Queue send, whose median Cloudflare puts at about 60 ms; the facts read from D1 measured 31 ms at p95 the same night. Arthur then chose to keep the target: "давай не змінювати вимоги, а просто записати по факту скільки вийшло, чому так, + посилання". The miss is in nfr.md, the NFR-2 and NFR-6 cards and risk R-24.

The controller run also went against the plan's order. It ran from the stage branch before the merge, because the stage changes no Worker code and the deployed Worker was already main 16d26e9. The results land in the stage PR instead of a follow-up PR.

Stage 8 moved after stage 9. No stage was added.
