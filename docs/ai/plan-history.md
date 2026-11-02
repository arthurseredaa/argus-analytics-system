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
