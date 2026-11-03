# Requirements

Every statement in `requirements.pdf` mapped to an ID. "Part" is 1 (design) or 2 (MVP). "Verify" says how we will show the requirement is met. Interpretations that are not spelled out in the spec are marked "(assumption, see Q-n)" and listed in [open-questions.md](open-questions.md).

Related files: [offer-selection.md](offer-selection.md) (rules and decision table), [open-questions.md](open-questions.md), [risks.md](risks.md), [proposals.md](proposals.md).

## Process

| ID | Requirement | Part | Verify |
|---|---|---|---|
| PRC-1 | The design is done first and discussed with the company. Implementation scope is agreed after that discussion. Changed by the company's answer of 2026-10-30: no separate design review, the whole assignment is delivered at once, a call afterwards is optional (`docs/ai/plan-history.md`, 2026-11-03). | 1 | Design is in the repository before the code; the open questions are delivered with their defaults. |
| PRC-2 | Access to a test Cloudflare environment, possible costs and the final scope are agreed before implementation. Per the same answer, no agreement step exists; the MVP runs on Arthur's own account (Q-17) and the scope is the spec as broken down here. | 1 | Q-17 default stated in the design; spend reported in the README. |
| PRC-3 | Production access and extra external environments are not needed for the MVP. | 2 | No production access requested. |
| PRC-4 | Ambiguous expectations are recorded before implementation. | 1 | `open-questions.md` answered or assumed before coding. |

## Business context

| ID | Requirement | Part | Verify |
|---|---|---|---|
| BIZ-1 | Users arrive on landing pages, take a quiz and go to partner offers. Landing page = prelander (assumption A-6). | 1, 2 | Funnel model in the design covers all three. |
| BIZ-2 | Collect visitor events for funnel analytics. | 1, 2 | Event catalog in the design; events stored in MVP. |
| BIZ-3 | User properties and event history are used to choose an offer, or to skip the prelander for a user already registered with the partner. Skipping the prelander and skipping the quiz are the same thing (A-6). | 1, 2 | Offer selection reads them on the server. |
| BIZ-4 | Existing infrastructure: Cloudflare, BigQuery, GitHub. Components, storage and data model are ours to propose. | 1 | Architecture section. |
| BIZ-5 | Extra external services are allowed only with a justification. | 1 | One ADR per external service, or none used. |

## Quiz

| ID | Requirement | Part | Verify |
|---|---|---|---|
| QZ-1 | Step 1: who the user is looking for, women or men. This is the desired partner's gender, not the user's. | 1, 2 | UI + stored answer. |
| QZ-2 | Step 2: desired partner ethnicity, one of `asia`, `europe`, `latam` (the codes the spec uses in the catalog and its worked examples). The question wording depends on the step 1 answer. | 1, 2 | UI test for both wordings. |
| QZ-3 | Step 3: email. It does not affect the offer, does not confirm identity and does not confirm a partner registration. | 1, 2 | Selection gives the same result for different emails; an email never creates a Lead. |
| QZ-4 | Propose the set of events, how they link to offer transitions, and how the current (actual) answers are determined. | 1 | Event catalog + "current answers" rule in the design. |
| QZ-5 | The current quiz step does not need to be stored separately. | 1 | Not stored, or derived from events. |
| QZ-6 | One quiz is enough for the MVP. | 2 | Scope section. |
| QZ-7 | MVP: one simple page with the three steps. | 2 | Demo page; UI test for the step 2 wording. |

## Users and identity

| ID | Requirement | Part | Verify |
|---|---|---|---|
| ID-1 | A user has a UserID and properties. Each event has an EventID. | 1, 2 | Data model. |
| ID-2 | The system distinguishes users and recognises the same user on a return visit. The method is ours to propose and explain. | 1, 2 | Test: second visit with the same identifier resolves to the same UserID. |
| ID-3 | An entered email on its own does not confirm identity. | 1, 2 | Test: entering an earlier user's email in a new browser does not give the earlier user's Lead redirect. |
| ID-4 | MVP: store user properties and events. | 2 | Integration test reads both back after a quiz run. |

## Offer catalog and selection

Full rules, edge cases and the expected-result table are in [offer-selection.md](offer-selection.md).

| ID | Requirement | Part | Verify |
|---|---|---|---|
| OFF-1 | Use the given synthetic catalog of 7 offers. All offers start active. | 2 | Seed data matches the spec table. |
| OFF-2 | EPU is a given constant in USD per unique user sent to the offer. It is not computed in the MVP. | 1, 2 | EPU stored as config. |
| OFF-3 | Rule 1: a user with a Lead for an active offer skips the quiz and goes to that offer. This beats EPU. | 1, 2 | Unit + integration test. |
| OFF-4 | The base scenario has one such Lead. The design proposes what happens with several. | 1 | Design section + ADR. |
| OFF-5 | Rule 2: otherwise pick, among active specialised offers that match both ethnicity and partner gender, the highest EPU. Ties go to the lowest ID. | 1, 2 | Unit tests. |
| OFF-6 | If no active specialised offer matches (including missing configuration), use universal offer 007 if it is active, regardless of preferences. | 1, 2 | Unit tests. |
| OFF-7 | 007 does not compete on EPU when specialised matches exist. | 1, 2 | Unit test where 007 would win on EPU if it competed (needs a modified catalog). |
| OFF-8 | If 007 is disabled and nothing else matches, show «Немає доступного офера» ("No offer available"). | 1, 2 | Unit + UI test. |
| OFF-9 | Rule 3: a Lead for a disabled offer gives no redirect right. Apply normal selection; if the answers are not enough, show the quiz. | 1, 2 | Unit + integration test. |
| OFF-10 | Selection runs on the server. The demo shows the chosen offer's name and target URL. | 2 | Integration test + demo page. |
| OFF-11 | The HTTP redirect is verified by a test that does not open the external site. `.example` domains are fictional. | 2 | Test asserts status code and `Location` header. |
| OFF-12 | The spec's worked examples hold: women + asia gives 003, women + europe 004, women + latam 007, men + latam 006, men + latam with 006 disabled or missing 007, and a user with a Lead for active 001 returns to 001 although 003 has a higher EPU. | 1, 2 | Decision table rows 1, 3, 5, 6, 7, 8, 16 as unit tests. |

## Postbacks

| ID | Requirement | Part | Verify |
|---|---|---|---|
| PB-1 | Partners send Lead (registration) and Purchase. | 1, 2 | Endpoint accepts both types. |
| PB-2 | Propose the postback contract. | 1 | Contract section in the design. |
| PB-3 | Propose an authenticity check. | 1, 2 | Test: unsigned or badly signed postback is rejected and changes nothing. |
| PB-4 | Correlate a postback with the transition (click), the user and the offer. | 1, 2 | Test: Lead lands on the right user and offer. |
| PB-5 | Protect against double counting. A redelivered postback and a second real purchase are different cases. | 1, 2 | Tests: same postback twice counts once; two purchases count twice. |
| PB-6 | Entering an email in the quiz is not a partner Lead. | 1, 2 | Test. |
| PB-7 | MVP: an endpoint for Lead and Purchase and a way to send test requests to it. A real partner and a separate simulator server are not needed. | 2 | Script or curl commands in README. |
| PB-8 | Malformed and unauthorised postbacks must not change data. | 2 | Tests compare state before and after. |

## Analytics and reporting

| ID | Requirement | Part | Verify |
|---|---|---|---|
| AN-1 | Analyse funnel start, step completion, drop-offs, offer transitions, confirmed Lead and Purchase. | 1, 2 | Metric definitions in the design; report in MVP. |
| AN-2 | Break down by prelander, offer and period. | 1 | Dimensions in the data model. |
| AN-3 | Define conversion denominators. | 1 | Metric definitions table. |
| AN-4 | Define how repeat visits are counted. | 1 | Metric definitions table. |
| AN-5 | Define the effect of late postbacks on reports. | 1 | Design section + test in MVP. |
| AN-6 | MVP report: users who started the quiz, passed each step, went to an offer, got Lead or Purchase. | 2 | Report page/table. |
| AN-7 | The report counts events recorded by the system. No hard-coded numbers. | 2 | Test: seed events, assert report numbers. |
| AN-8 | The report uses the metric definitions from the design. | 2 | Report queries link to the definitions. |

## Load, reliability, latency

| ID | Requirement | Part | Verify |
|---|---|---|---|
| NFR-1 | Planned load: 1M users/month × 2 visits × 6 events = 12M events/month (about 4.6 events/s on average). | 1 | Capacity and cost section. |
| NFR-2 | Peak: 200 events/s for 5 minutes (about 60,000 events). | 1 | Load test plan; optional load test run. |
| NFR-3 | Analytics freshness in normal operation: up to 15 minutes. | 1 | Pipeline design + freshness metric. |
| NFR-4 | BigQuery being down must not block the quiz right away. | 1 | Design: quiz path does not depend on BigQuery. |
| NFR-5 | Define guarantees, buffering limits and behaviour during a long outage. | 1 | Design section with numbers. |
| NFR-6 | Propose a target API latency and how to measure it. | 1 | SLO + measurement method. |
| NFR-7 | Geography is an assumption to agree on. | 1 | Listed in open questions. |
| NFR-8 | Delayed messages and failures behave as defined in the design, and we show how that was verified. | 2 | Tests for late postback and outage behaviour. |

## Design deliverable

| ID | Requirement | Part | Verify |
|---|---|---|---|
| DES-1 | Short document and a diagram. | 1 | Files exist. |
| DES-2 | Sections: questions and assumptions; architecture and alternatives; data model; user identification; retries, concurrent changes and event order; postback and personal data security; delivery to BigQuery; metrics, monitoring, costs and limits. | 1 | Checklist against this row before sending. |
| DES-3 | Implementation plan with checks. | 1 | Plan file. |
| DES-4 | A proposed minimal end-to-end slice. | 1 | Section in the plan. |
| DES-5 | How to add offer exclusion after Purchase later. Not implemented. | 1 | Design section. |
| DES-6 | How to compute EPU from real data later. Not implemented. | 1 | Design section. |

## MVP scope limits

| ID | Requirement | Part | Verify |
|---|---|---|---|
| MVP-1 | A small working version deployed to Cloudflare, covering the path from a user's answer to an event, an offer choice and a report result. | 2 | Demo link. |
| MVP-2 | Cloudflare services and code structure follow our design. | 2 | Matches the architecture section. |
| MVP-3 | Not needed: full admin panel, rules builder, mailings, automatic EPU recalculation. | 2 | Not built. |
| MVP-4 | A real BigQuery connection is not needed. Analytics are shown on the chosen Cloudflare storage. | 2 | Report reads Cloudflare storage. |
| MVP-5 | Explain the limits of that choice and point to the roadmap: how to notice approaching limits, what to do with accumulated history, how to keep facts the rules need (such as Lead). | 1, 2 | Design section. |
| MVP-6 | Migration and production scaling are not implemented. | 2 | Listed as design-only. |

## Demo scenario

| ID | Requirement | Part | Verify |
|---|---|---|---|
| DEMO-1 | Short instructions the reviewers can follow to repeat the scenario. | 2 | README section, dry run by us. |
| DEMO-2 | A new user takes the quiz and gets the correct offer. | 2 | Step in the instructions. |
| DEMO-3 | Reviewers send a test Lead for that user's transition. | 2 | Step in the instructions. |
| DEMO-4 | The same user returns and gets the offer without the quiz. | 2 | Step in the instructions. |
| DEMO-5 | Reviewers send a Purchase and see the report change. | 2 | Step in the instructions. |
| DEMO-6 | Repeating the same postback does not double the numbers. | 2 | Step in the instructions. |
| DEMO-7 | Test data and expected results are included. | 2 | Table in README. |
| DEMO-8 | Synthetic emails only, no mailings, no real personal data. Email never goes into URLs or technical logs. | 2 | Test or log check; code review. |
| DEMO-9 | No real transitions to partners. The instructions explain how the transition is reproduced. | 2 | README section. |

## Automated tests

| ID | Requirement | Part | Verify |
|---|---|---|---|
| TEST-1 | Offer selection, highest EPU, fallback to 007. | 2 | Unit tests. |
| TEST-2 | Returning user with a Lead, including when the earlier offer is disabled. | 2 | Unit + integration tests. |
| TEST-3 | Redelivered events and postbacks are not counted twice; two different purchases are counted separately. | 2 | Integration tests. |
| TEST-4 | Malformed and unauthorised postbacks do not change data. | 2 | Integration tests. |
| TEST-5 | The report matches expected results on test data. | 2 | Integration test. |

## What to hand over

| ID | Requirement | Part | Verify |
|---|---|---|---|
| DLV-1 | Link to the working demo on Cloudflare. | 2 | Link in README. |
| DLV-2 | GitHub repository with code, design and implementation plan. | 1, 2 | Repo link. |
| DLV-3 | README: how to run the project and tests, send a test postback, repeat the demo. | 2 | Dry run from a clean clone. |
| DLV-4 | Automated tests and CI, check results, known limitations. | 2 | CI badge or run link. |
| DLV-5 | A clear split of what is implemented, what is simulated and what exists only in the design. | 2 | README section. |

## AI work evidence

| ID | Requirement | Part | Verify |
|---|---|---|---|
| AI-1 | Keep the agent instructions, the initial plan and significant plan changes. | 1, 2 | `CLAUDE.md`, `docs/ai/plan-history.md`. |
| AI-2 | Two or three real examples: task given to AI, what it proposed, the decision, how it was verified. | 1, 2 | `docs/ai/examples/`. |
| AI-3 | No secrets or personal data. Full chat archives are not needed. Any tool is fine. | 1, 2 | Review before sending. |
| AI-4 | At the review: explain the implementation and make one small time-boxed change with AI, with checks. Evaluated on a working result, data correctness and understanding of the system. | 2 | Rehearse: know every module; fast test suite. |
