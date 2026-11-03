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
