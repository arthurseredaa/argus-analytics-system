# Part 1: design document plan

Plan for stage 3 of `docs/ai/plan-history.md`: write the Part 1 design and send it to the company. Nothing here produces code. The deliverable is a set of documents the reviewers can read in one sitting, plus the questions we want answered before Part 2.

Goal: by Monday 2026-11-02 the repository holds a design document, a diagram, ADRs for every decision with a real alternative, a data model, an implementation plan for the MVP with checks, and a proposed end-to-end slice (DES-1 to DES-6 in `docs/requirements/requirements.md`).

Spec: `requirements.pdf`, broken down in `docs/requirements/`.

Time budget: 8 to 10 hours of design work per `docs/estimate.md`. Each stage below carries an estimate; the sum is about 10.5 hours. Stage 0 was cut on 2026-11-01; stage 4 is the one to shorten if Sunday evening arrives early.

## How the stages run

Every stage follows the same loop, because the point of Part 1 is that Arthur understands and can defend every choice at the review.

1. Read. The stage names what to read first (a requirements file, a research note, the options table of an ADR). Reading comes before any writing.
2. Decide. Decisions that belong to Arthur are asked with AskUserQuestion, one option recommended, each option with its cost. No decision is settled silently in a document.
3. Write. The AI drafts the file in English, through the humanizer skill. Arthur reads it whole.
4. Explain back. Arthur explains the stage's result in his own words, in Ukrainian, in two or three sentences per decision. The AI points at any place where the explanation and the document differ. A stage is not done until they match.
5. Verify. The stage's checklist is run and its output shown.
6. Approve, commit, push. One commit per stage, after the explicit approval. The stage's status in `docs/state/progress.json` changes in that same commit, per `.claude/rules/state.md`. One stage per session.

Rule for the whole plan: a document that Arthur cannot explain is not finished, however correct it is.

Files the project rules rely on and that stages 1 to 5 write into: `docs/requirements/glossary.md` (new terms go here first), `docs/requirements/nfr.md` (every load, latency, cost number with its source), `docs/adr/README.md` (one index line per ADR), `docs/state/progress.json` (stage status, changed only in the stage's commit). All four exist as of 2026-10-30.

## Global constraints

- Everything committed is in English; conversation is in Ukrainian (`CLAUDE.md`).
- No email, token or personal data in any file. Examples use `@example.com`.
- ADRs start from `docs/adr/0000-template.md`, numbered from 0002 (0001 exists).
- Ambiguities go to `docs/requirements/open-questions.md` first, with a default we design for.
- The repository has no commits and no remote yet. The first commit happens at the end of stage 0 and needs a GitHub remote; creating it is part of stage 0.
- Numbers about Cloudflare and BigQuery limits or prices are written only with a source link and the date they were checked.

## Design principle: the system has to live after the demo

The technical reviewer has said what he values: a project that keeps running with little maintenance and changes easily when the business changes. Every ADR and design section is checked against that, so the principle is written here once and each stage names its part.

What it means in this system, concretely:

- Versioned things. The offer catalog has a version, and every selection event records which version it used, so a redirect from last month can be explained after the catalog changed (P-3). Events carry a schema version. The postback endpoint carries a version in its path so a partner on the old contract keeps working when a new field is added.
- Config is data. Offer status, EPU, partner secrets and quiz wording live in storage or environment, never in code, so enabling an offer or adding a partner is a data change with no deploy.
- Schema changes are migrations. D1 migrations are numbered files in the repository and run in CI before deploy; a column is added, never renamed in place.
- Extension points named in advance. The design lists, for each likely change, what is touched: a fourth quiz question, a new offer, a new partner, a new prelander, a new event type, a change in the selection rules. If any of those needs a change in more than one place besides data, the design says why.
- The two spec extensions (exclusion after Purchase, EPU from real data) are written as proof that the points above hold, with the exact table and rule step they touch.
- A lean service list. A component is in the design because a requirement needs it; every extra service is a thing to monitor and pay for. ADRs say what was left out and why.

The check in stage 7 asks each of the six changes above and expects an answer of the form "change X in place Y, run Z".

## Review focus

Five things the spec implies, which the design must answer explicitly because the reviewers will ask:

1. Rule 3 can be read two ways: does a returning user with full answers but no Lead skip the quiz? Q-1 in open questions. The design states the chosen reading and the question is in the cover message.
2. A postback can arrive before the click row is written, or for a click we never made. R-6, Q-11. The design says what happens to it and that it is not lost.
3. The offer can be disabled between selection and the redirect, or between a Lead and the return visit. R-9, OFF-9. The design says where the status is re-checked.
4. Two tabs, a back button, a retried request: which answer is current and how an EventID stops a double count. Q-4, R-3, R-10.
5. BigQuery is down for hours. The design gives the buffer size, how long it lasts at the average rate in `nfr.md` (6.9 events/s) and at 200 events/s, and what happens when it fills. NFR-4, NFR-5.

Each item is assigned to a stage below.

---

## Stage 0: platform limits and BigQuery ingestion

Estimate: 1 hour.

Goal: the limits and prices that bound the design are written down once, with sources, so the ADRs in stages 1 and 2 can cite them instead of guessing. Comparing services belongs in the options tables of those ADRs, so there is no separate per-service research note. The one topic that gets its own short note is BigQuery ingestion from outside Google Cloud, because it is the least familiar part and has a real choice in it.

Files:
- Modify `docs/requirements/nfr.md`: new section "Platform limits and prices", one table row per limit that matters at 12M events/month or 200 events/s, each with a link and check date
- Create `docs/requirements/research-bigquery-ingestion.md`
- Modify `docs/state/progress.json` at the end of the stage

Read first: `docs/requirements/risks.md` rows R-15 to R-19, `docs/estimate.md` section on Cloudflare costs.

Content of the `nfr.md` table: Free-plan limit, Paid-plan included amount, price above it, for Workers, D1, KV, Durable Objects, Queues, R2, Analytics Engine and Pipelines. Prices from the account's Workers plans page and the R2 and Queues pricing docs were collected on 2026-11-01; the Paid included amounts for D1, KV, Durable Objects and Analytics Engine are not on that page and come from each product's pricing docs. Below the table, one paragraph: which free limits the spec's load already exceeds, and the rough monthly cost on the Paid plan.

Content of the BigQuery note: streaming inserts, Storage Write API and batch load from files, each with cost per GB, the auth method a Worker can use (service account key, JWT signed in the Worker), and the limit that matters. One recommendation for stage 2 to decide on.

Steps:

- [ ] Fill the `nfr.md` table from the collected prices and the pricing docs. Every number gets a source and a date.
- [ ] Draft the BigQuery note with WebFetch against the official docs.
- [ ] Arthur reads both and asks about anything unclear. Answers are folded into the files.
- [ ] Explain back: for each of D1, Durable Objects, Queues, Arthur says in one sentence when he would pick it, and which BigQuery ingestion method he would start with.
- [ ] Create the GitHub repository (private) and add it as `origin`. Ask Arthur for the repository name; do not pick one.
- [ ] Verify: every row of the platform table has a link and a check date (`grep -c "developers.cloudflare.com" docs/requirements/nfr.md` is at least the number of services covered); the BigQuery note has cost and auth for all three methods.
- [ ] Approval, then first commit: everything that exists now (`CLAUDE.md`, `docs/`, `.gitignore`, `requirements.pdf` only if Arthur agrees to commit the spec), message `docs: requirements breakdown and platform limits`. Push.

---

## Stage 1: architecture decisions, hot path

Estimate: 2 hours.

Goal: the three decisions that shape everything else are made and written as ADRs: how we recognise a user, where the facts the rules need are stored, and how offer selection reads them.

Files:
- Create `docs/adr/0002-user-identity.md`
- Create `docs/adr/0003-operational-store.md`
- Create `docs/adr/0004-offer-selection-semantics.md`
- Modify `docs/adr/README.md`: one index line per new ADR (same in stage 2)
- Modify `docs/requirements/open-questions.md` only to record a default that changes

Read first: `docs/requirements/offer-selection.md` whole, open questions Q-1, Q-4, Q-10, Q-19, Q-21, proposals P-1, P-3.

Decisions for Arthur, each asked with AskUserQuestion:

1. Identity (ADR 0002). Options: first-party cookie with a random UserID set by the Worker; browser storage ID sent in the event payload; email as identity. The spec rules out the third, so the ADR records why. Review focus item 4 is partly answered here: an EventID is generated where the event is created, in the browser for browser events and in the Worker for server events.
2. Operational store (ADR 0003). Options: D1 as the single store for both facts and events; Durable Object per user for facts plus D1 for events; KV for facts; an external Postgres (Neon, Supabase or similar) reached from the Worker over the network. The ADR shows the demo scenario written into each option and where each one breaks at 200 events/s. For Postgres it records why it was set aside: one more provider to pay for and monitor, and a network round trip to its region on every request. It also has a migration section: the D1 numbers that trigger a move (write latency, database size against the 10 GB limit), which target we would move to (Postgres, or Durable Objects to split the load), and the steps, so the move is planned before it is needed. Review focus item 3 is answered here: where offer status lives and where it is re-read at redirect time.
3. Selection semantics (ADR 0004). Not a storage choice but a rules choice with alternatives: several active Leads (most recent, highest EPU, lowest ID); the Q-1 reading of rule 3; whether selection runs at entry, at completion, or both. The decision table in `offer-selection.md` is updated if a row changes.

Evolution hooks in this stage: ADR 0003 says how the catalog is versioned (a version column with an effective-from time, or a full copy per version) and that offer status is a data change with no deploy. ADR 0004 names the selection function's inputs so a rule change is one function and its tests, and states how a new rule step (the Purchase exclusion from DES-5) slots in.

Steps:

- [ ] For each ADR, present the options table in conversation first (one line per option: how it works, cost, where it breaks), with a recommendation. Arthur picks.
- [ ] Write the three ADRs from the template. Status `proposed` until the company review; the design document is what the company sees, the ADR holds the reasoning.
- [ ] Explain back: Arthur walks demo steps 1 to 3 (new user, Lead, return) and names which store is read and written at each step.
- [ ] Verify: each ADR has every template section filled; the Context section links at least one requirement ID; the Options section has at least two options with a "where it breaks" sentence; `offer-selection.md` decision table still matches OFF-12 examples (re-read rows 1, 3, 5, 6, 7, 8, 16).
- [ ] Approval, commit `docs: ADRs for identity, operational store, selection semantics`, push.

---

## Stage 2: architecture decisions, events, postbacks, BigQuery

Estimate: 1.5 hours.

Goal: the write path is decided: how events get in, how they survive a BigQuery outage, how they reach BigQuery, and how a postback is authenticated and correlated.

Files:
- Create `docs/adr/0005-event-ingestion-and-buffering.md`
- Create `docs/adr/0006-bigquery-delivery.md`
- Create `docs/adr/0007-postback-contract-and-auth.md`
- Modify `docs/requirements/open-questions.md` if a default changes

Read first: open questions Q-6, Q-11, Q-12, Q-23, Q-24, risks R-3 to R-8, R-11 to R-13, R-16, proposals P-2, P-4, P-5, P-8, the platform limits table in `nfr.md` (Queues, R2), `research-bigquery-ingestion.md`.

Decisions for Arthur:

1. Ingestion and buffer (ADR 0005). Options: Worker writes straight to D1 and a cron job ships batches; Worker puts events on a Queue, a consumer writes D1 and ships; Durable Object buffers per shard. The ADR carries the numbers from review focus item 5: buffer capacity, hours of survival at 6.9 events/s and at 200 events/s, behaviour when full (drop oldest, stop accepting, spill to R2). Answers NFR-4, NFR-5.
2. BigQuery delivery (ADR 0006). Options: Storage Write API from the consumer; batch files to R2 then a load job; streaming inserts. Includes the dedup rule on the BigQuery side (R-8) and the 15-minute freshness path (NFR-3). If the R2 option is chosen, the ADR also fixes the file layout and cleanup: the consumer writes to `pending/`, a successful load moves the file to `loaded/`, and an R2 lifecycle rule deletes files in `loaded/` after N days (default 30, bounded by Q-16). Nothing in `pending/` is deleted automatically. A stuck load is caught by an alert: the oldest file in `pending/` is older than 1 hour.
3. Postback contract and authentication (ADR 0007). Options for auth: HMAC signature over the body with a per-partner secret; per-partner token in a header; IP allowlist only. Contract fields are fixed here: click ID, event type, partner transaction ID, timestamp, optional payout and currency. Dedup key is fixed here (P-4). Unknown click ID handling is fixed here (review focus item 2, Q-11).

Evolution hooks in this stage: ADR 0005 fixes the event envelope with a schema version field and says what the consumer does with a version it does not know (store raw, do not drop). ADR 0006 says how a new event field reaches BigQuery without a manual table change. ADR 0007 puts the contract version in the path (`/postback/v1/...`) and adds a partner as a row with a secret, not as code.

Steps:

- [ ] Options tables in conversation, one per ADR, recommendation marked. Arthur picks.
- [ ] Write the three ADRs.
- [ ] Explain back: Arthur describes the life of one event from the browser to a BigQuery row, naming each hop and what happens if that hop is down. Then the life of one postback, including a redelivered one and a second real purchase.
- [ ] Verify: ADR 0005 states the buffer limit in events and in hours at both rates; ADR 0007 names the dedup key and lists what a malformed, unsigned, stale and unknown-click postback each get as an HTTP response; each ADR links its requirement IDs.
- [ ] Approval, commit `docs: ADRs for ingestion, BigQuery delivery, postbacks`, push.

---

## Stage 3: data model and event catalog

Estimate: 1.5 hours.

Goal: every table, every event type and every key is written down, and the demo scenario can be traced through them on paper.

Files:
- Create `docs/design/data-model.md`

Read first: ADRs 0002 to 0007, requirements QZ-4, QZ-5, ID-1, AN-2, risks R-3, R-10.

Content:

- Event catalog: the nine visit events from assumption A-1 (the spec's six plus `step_viewed` for each quiz step) plus `lead` and `purchase`, each with its payload fields and which prelander, offer and click it links to (P-3 reason codes included).
- Tables (or Durable Object state, per ADR 0003): users, events, clicks, postbacks, offers, offer status. For each: columns, primary key, unique keys that enforce idempotency, which ADR put it there.
- Current answers rule: how the latest accepted answer is derived from events (Q-4, Q-25), with the ordering fields it relies on (review focus item 4).
- Personal data: where the email lives, encrypted or hashed per P-5, and the list of places it must never appear.
- A trace table: the five demo steps as rows, the tables they write as columns, with the key values for a synthetic user.
- Change management: the migration convention (numbered SQL files, additive only, run in CI before deploy), the `schema_version` on events, the catalog version column, and a short "to add X, change Y" list for a new offer, a new partner, a new prelander and a new event type.

Steps:

- [ ] Draft the file.
- [ ] Explain back: Arthur takes decision-table row 16 (Lead on active 001) and says which rows exist before the return visit and which query finds the Lead.
- [ ] Verify: every table has a primary key and every idempotency case in R-3, R-4, Q-23 maps to a named unique key; every event type in the catalog appears in the trace table at least once; the file does not contain `@` outside `@example.com`.
- [ ] Approval, commit `docs: data model and event catalog`, push.

---

## Stage 4: metrics, reliability numbers, extensions

Estimate: 1.5 hours.

Goal: the parts of the design that are numbers and definitions rather than components are written: metric definitions, latency target, monitoring, costs, and the two future extensions.

Files:
- Create `docs/design/metrics-and-operations.md`

Read first: requirements AN-1 to AN-5, NFR-1 to NFR-7, MVP-5, DES-5, DES-6, open questions Q-12 to Q-14, Q-20, Q-26, proposals P-6, P-7.

Decisions for Arthur:

1. Conversion denominators and "started the quiz" (Q-13, Q-26): visits or unique users as the base; step 1 shown or step 1 answered as the start.
2. Late postbacks (Q-12): cohort by click date with an "as of" time, by postback date, or both (P-6).
3. Target API latency (NFR-6): a p95 number for the selection endpoint and for event ingestion, and how it is measured (Worker timing headers, synthetic probes, Cloudflare analytics). The geography assumption from Q-2 is stated next to it.

Content:

- Metric definitions table: name, numerator, denominator, grain (prelander, offer, day), repeat-visit rule. Answer metrics say which answer they count. D1 keeps only the latest answer per question, while BigQuery has every answer event, so counting answer events would overstate an answer that users later changed. The answer distribution counts distinct users by their final answer (the answers recorded in the `offer_selected` event, or the latest answer per user and question by the same ordering rule as D1). Answer changes are a separate metric over all answer events: users with more than one answer to a step, and the A to B transitions.
- Reliability table: freshness target, buffer survival hours (from ADR 0005), alert thresholds, what a reviewer would see during an outage. One of the alerts is the age of the oldest file in `pending/` (ADR 0006), threshold 1 hour: past it, loads into BigQuery have stopped.
- Cost table at the design load in `nfr.md` (18M events/month, A-1) on the chosen services, with the platform limits table in `nfr.md` as the source, and the free-plan ceiling for the MVP.
- MVP storage limits (MVP-5): the number at which D1 or the chosen store gets close to its limit, how we notice (a metric and a threshold), what moves to BigQuery and what stays because the rules need it (Leads, offer status). The alert thresholds match the migration triggers in ADR 0003.
- Extensions, one short section each: offer exclusion after Purchase (which table gains a flag, which rule step reads it, how it interacts with rule 1), and EPU from real data (which postback field, which query, how often it is recomputed, how the catalog constant is replaced). Each one ends with the list of files and migrations it would touch, as evidence for the design principle.
- Operating the system with little attention: what runs on a schedule, what alerts exist and who gets them, what a monthly check looks like, which dependencies get updated and how (Dependabot or equivalent), and what "nothing to do this month" looks like in the dashboard.

Steps:

- [ ] Decisions asked, then draft.
- [ ] Explain back: Arthur explains why yesterday's report can change today and which of the two views a finance person should read.
- [ ] Verify: every metric has a denominator; the latency target has a measurement method; every cost number links to the platform limits table in `nfr.md`; both extensions name a concrete table and a concrete rule step.
- [ ] Approval, commit `docs: metrics, reliability numbers, cost, extensions`, push.

---

## Stage 5: the design document and the diagram

Estimate: 2 hours.

Goal: one document the company reads, short enough for 15 minutes, with the diagram, pointing into the ADRs and the two design files for depth.

Files:
- Create `docs/design/design.md`
- Create `docs/design/architecture.md` (Mermaid) or `docs/design/architecture.svg` (made with the archify skill); decide by what renders on GitHub without extra tooling, which means Mermaid first and an SVG only if the Mermaid one is unreadable
- Modify `docs/requirements/open-questions.md`: mark the questions that go into the cover message

Section order follows DES-2 word for word so the reviewers can tick it off:

1. Questions and assumptions (the five to seven questions we actually need answered, the rest by link)
2. Architecture and alternatives (diagram, one paragraph per component, each alternative in one line with a link to its ADR)
3. Data model (summary, link to `data-model.md`)
4. User identification (ADR 0002 in a paragraph, with what it does not do: no cross-device, no email merge)
5. Retries, concurrent changes, event order (review focus item 4 in a paragraph)
6. Postback security and personal data (ADR 0007, P-5)
7. Delivery to BigQuery and outage behaviour (ADR 0005, 0006, with the survival numbers)
8. Metrics, monitoring, costs and limits (summary, link to `metrics-and-operations.md`)
9. Future extensions (DES-5, DES-6, link)
10. How the system changes: the six likely changes from the design principle, one line each with the place to change and the check to run; versioning of catalog, events and the postback contract; migrations; what is left out and why
11. Implementation plan and end-to-end slice (link to stage 6's file)

Steps:

- [ ] Draft the diagram first, in conversation, and agree on it before the text. Boxes: browser, Worker, operational store, event buffer, consumer, BigQuery, partner, report. Arrows carry the event or request name.
- [ ] Draft `design.md`. Target length under 2,500 words excluding tables.
- [ ] Explain back: Arthur presents the diagram out loud, top to bottom, as he would at the review. Time it; under five minutes.
- [ ] Verify: `wc -w docs/design/design.md` under 2,500 plus tables; each of the eight DES-2 topics is a heading; every ADR 0002 to 0007 is linked at least once; the diagram renders in GitHub's Markdown preview (check after push); no `@` outside `@example.com`; no dash used as a connector (humanizer pass).
- [ ] Approval, commit `docs: Part 1 design document and diagram`, push.

---

## Stage 6: MVP implementation plan and the end-to-end slice

Estimate: 1 hour.

Goal: DES-3 and DES-4. A staged plan for Part 2 with a check per stage, and a slice the company can agree to as the minimum.

Files:
- Create `docs/plans/part2-mvp-stages.md`

Read first: requirements TEST-1 to TEST-5, DEMO-1 to DEMO-9, DLV-1 to DLV-5, AI-4, risks R-20, R-22, estimate.

Content:

- The slice: the smallest set that runs the five demo steps end to end. Expected: quiz page, event endpoint, selection endpoint with redirect, postback endpoint, one report query, deployed. Named explicitly so the company can say yes or cut.
- Stages after the slice, each with goal, files or components, and the check that proves it (a test name from TEST-n, a demo step from DEMO-n, or a measurement). Candidates: project setup and CI; identity and events; selection and redirect; postbacks and dedup; report; late postback and outage behaviour; load test at 200 events/s (P-7, optional, cost noted); README and demo script; AI evidence; rehearsal for the live change at the review (R-22).
- A table mapping every TEST-n and DEMO-n row to the stage that satisfies it.
- A list of what will be implemented, simulated, or design-only (DLV-5), as we expect it before the discussion.

Steps:

- [ ] Draft.
- [ ] Explain back: Arthur names the slice in one sentence and says which stage he would drop first if time runs out.
- [ ] Verify: the mapping table has no empty cell; every stage has a check that is a command, a test or a demo step, not a sentence like "verify it works".
- [ ] Approval, commit `docs: MVP implementation plan and end-to-end slice`, push.

---

## Stage 7: review rehearsal and sending

Estimate: 1 hour.

Goal: the design survives questioning before the company asks, the AI evidence is in place, and the message to the company is ready.

Files:
- Modify `docs/ai/plan-history.md` (entry for any material change made during stages 0 to 6)
- Create one or two files in `docs/ai/examples/` from `_template.md`, drafted from real moments in stages 1 to 5 where Arthur rejected or changed a recommendation
- Cover message: drafted in conversation in Ukrainian, not committed

Steps:

- [ ] Run the grill-me skill against `design.md`. Arthur answers without opening the files. Every question he cannot answer becomes either a fix in the document or an item in the cover message.
- [ ] Evolution drill: for each of the six changes in the design principle (fourth quiz question, new offer, new partner, new prelander, new event type, rule change), Arthur answers "change X in place Y, run Z" from memory. An answer that touches code in more than one module, or needs a manual step in production, is a finding to fix in the design.
- [ ] Final checklist, output shown: DES-1 to DES-6 each point to a file and heading; PRC-4 (every open question has a default); review focus items 1 to 5 each have a heading or ADR; `grep -rn "@" docs | grep -v example.com` returns nothing; `git status` clean after the last commit.
- [ ] Draft the cover message to Alina: what is in the repository, the five to seven questions, the proposed slice, the assumption about geography and the Cloudflare account, a proposed time for the discussion. Arthur edits and sends it himself.
- [ ] Approval, commit `docs: AI work log for Part 1`, push.

Changed 2026-11-03: nothing is sent after this stage. The company does not review the design separately (`docs/ai/plan-history.md`), so the cover message is written at the end of Part 2 and the grill-me and evolution drills run before the hand-in. Stage 6 produces the Part 2 plan, and implementation starts from it.

---

## Schedule

| Day | Stages | Hours |
|---|---|---|
| Thu 2026-10-30 | 0 | 1.5 |
| Fri 2026-10-31 | 1, 2 | 3.5 |
| Sat 2026-11-01 | 3, 4, 5 | 5 |
| Sun 2026-11-02 | 6, 7, send | 2 |

If Saturday overruns, stage 4's cost table and stage 6's load-test stage are the first to shrink to a paragraph each. The ADRs and `design.md` do not shrink.

## Self-review against the spec

- DES-1 document and diagram: stage 5.
- DES-2 eight topics: stage 5 headings, backed by stages 1 to 4.
- DES-3 implementation plan with checks: stage 6.
- DES-4 end-to-end slice: stage 6.
- DES-5, DES-6 extensions: stage 4.
- PRC-1, PRC-2, PRC-4: stage 7 cover message and open questions.
- AI-1, AI-2: stage 7, with `CLAUDE.md` and plan history already in place.
- Review focus 1: stage 1 (ADR 0004) and stage 7 cover message. 2: stage 2 (ADR 0007). 3: stage 1 (ADR 0003). 4: stages 1 and 3. 5: stage 2 (ADR 0005) and stage 4.
