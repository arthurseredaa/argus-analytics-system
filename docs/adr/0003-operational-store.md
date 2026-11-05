# 0003. Keep the facts the rules need in one D1 database

- Status: proposed
- Date: 2026-11-02
- Relates to: P-1, P-3, A-4, A-7, Q-1, Q-4, Q-8, Q-9, Q-11, Q-16, Q-25, R-9, R-10, OFF-9, MVP-4, MVP-5, MVP-6, NFR-1, NFR-2

## Context

Offer selection reads a small set of facts on every decision: the user's current answers to steps 1 and 2, the user's Leads, and which offers are active with what EPU. A postback has to find its click, and through it the user and the offer. These facts must be visible to selection within seconds of being written (A-4), and selection must not depend on BigQuery (NFR-4). P-1 keeps them apart from the event log that feeds analytics; the event path is ADR 0005.

The spec names the infrastructure (Cloudflare, BigQuery, GitHub), says extra external services need a justification, and asks for the MVP to run on "the chosen Cloudflare storage", with its limits explained: how we notice the limit approaching, what happens to accumulated history, and how the facts the rules need, such as Leads, are kept (MVP-4, MVP-5). Migration and production scaling are design only (MVP-6).

This ADR also settles three things that live in the same store: how answers are stored, how the offer catalog is versioned (P-3), and where offer status is re-read (review focus item 3).

## Constraints

- One D1 database is single-threaded and holds at most 10 GB (`nfr.md`, platform limits).
- KV makes a write visible elsewhere after up to 60 seconds and allows one write per second to a key.
- One Durable Object takes about 1,000 requests a second.
- Size of the facts, from `nfr.md` ("Size of the rule facts in D1"): about 1 KB per user (an assumption the MVP measures), 1,000,000 users a month, 5% to 20% of them with a Lead (A-7).
- Retention of personal data is open (Q-16).

## Options considered

The demo scenario used to compare them: (1) a new user answers the quiz, gets an offer and clicks it; (2) the partner sends a Lead for that click; (3) the user comes back and is redirected to the Lead offer before the page renders.

1. D1 for the facts only. Users, current answers, clicks, postbacks and the offer catalog live in one D1 database; raw events go past it (ADR 0005). Demo: (1) writes answers and a click and reads the catalog, (2) finds the click by click ID and writes the postback under a unique key, (3) reads the user's Leads joined with the current catalog. All in one database with SQL, unique keys and transactions. Where it breaks: the database fills. Without cleanup, about 1 GB a month gives about 10 months to the 10 GB limit. With the cleanup below, the 7 GB trigger is at least about 20 months away at a 20% Lead rate and about 80 months at 5%.
2. D1 for facts and raw events together. Same as option 1 with every event also written to D1. Where it breaks: at the 200 events/s peak the event writes queue up in front of the selection queries on the single writer, so step (3) waits behind analytics. Raw events at about 560 bytes of headroom per event per month fill the database within months (`nfr.md`).
3. A Durable Object per user for facts, D1 for the rest. Each user's answers and Leads live in that user's object. Where it breaks: a postback carries a click ID, not a UserID, so step (2) still needs a global click-to-user table in D1; offer status is shared by all users and also lives in D1; a report across users cannot be read from thousands of objects. The result is two stores to keep consistent, for a benefit we do not need: strict ordering per user, which "latest answer wins" (Q-4) already handles.
4. KV for facts. Where it breaks: step (3) can miss a Lead written seconds earlier because of the 60-second visibility delay (A-4); KV has no unique constraints, so a redelivered postback cannot be rejected by the store; step (2) cannot look up a click by click ID without a second key kept in sync by hand.
5. External Postgres (Neon, Supabase or similar) reached from the Worker. Demo steps work the same as option 1, and Postgres handles concurrent writes and has no 10 GB database limit. Where it breaks: it is one more provider to pay for, secure and monitor, which the spec asks us to justify, and every selection makes a network round trip from the Cloudflare location to the region of the database. Nothing at the spec's load needs it before the D1 trigger, so it is the migration target instead of the starting point.

## Decision

Option 1: one D1 database holds the facts the rules need, and raw events stay out of it. It meets the freshness and consistency needs with no extra service, and its limit is known, measured and tied to a planned migration, which is what MVP-5 asks for.

### Answers

- Table `user_answers(user_id, question_key, value, answered_at)` with primary key `(user_id, question_key)`. It holds the latest accepted answer to each question, one row per question. The history of changes is in the answer events (ADR 0005, BigQuery), so D1 does not keep it twice.
- `value` is JSON text with `CHECK (json_valid(value))`, so a future question can take a number, a string, an array or an object. The Worker checks that the value is allowed for that question before writing.
- A new question is a new `question_key` and needs no schema migration.
- The write overwrites only with a newer answer: `INSERT ... ON CONFLICT (user_id, question_key) DO UPDATE SET ... WHERE excluded.answered_at > user_answers.answered_at`. An answer that arrives out of order cannot replace a newer one (R-10, Q-4). `answered_at` stands for the ordering key that the data model defines (server receive time plus the per-visit sequence from R-3).

### Offer catalog

- `catalog_versions(version, created_at, changed_by, note)` and `offers(version, offer_id, name, ethnicity, genders, epu, url, active, kind)`. Every version is a full copy of the catalog, all offers included. The current version is the highest number.
- Any change, including turning an offer off or changing an EPU, creates a new version in one D1 batch, which runs as a transaction, so selection never reads half of a version.
- The spec's catalog is seeded as version 1. Changes are made by a script (Q-9), with no deploy, because the catalog is data. EPU computed from real data later becomes a new version the same way.
- The `offer_selected` event records the catalog version it used (P-3). Any past redirect is explained by that version number.

### Where offer status is read

Status is read from the current catalog version at three points: at entry, for the Lead return (rule 1 and rule 3); at quiz completion, for selection; and at the press on the offer button (`GET /go`), which runs selection again for the cookie's user. So an offer turned off after selection is never sent to: the press goes to the new result (R-9, OFF-9).

### Cleanup

A daily job deletes a user, with their answers and clicks, when the user has no Lead and no Purchase (Q-8) and their last visit and last click are older than 90 days. Users with a Lead or a Purchase are kept. Their events stay in R2 and BigQuery. A returning user without a Lead sees an empty quiz anyway (ADR 0004); if the company asks for a prefilled quiz (Q-1), a user returning after the window gets it empty. A postback that arrives later for a deleted click is handled as an unknown click: stored in quarantine and not counted (Q-11). The 90 days are a default until Q-16 is answered.

### Migration

Triggers, each with an alert in the metrics document:

- database size above 7 GB, 70% of the limit;
- p95 duration of the selection queries above the NFR-6 threshold set in stage 4;
- D1 overload errors on more than a few requests in an hour.

Targets, in the order we would consider them:

1. Several D1 databases, users split by a hash of the UserID. The click ID carries the shard number so a postback finds its database. This stays inside Cloudflare; the limit on the number of databases per account is to be checked before this target is chosen.
2. Postgres outside Cloudflare, reached through a connection pooler. The tables move almost one to one, because the model is plain SQL.

Steps for either target: create the schema from the same numbered migrations; copy the data; write to both stores for a period while reads stay on D1; compare row counts and a sample of rows; move reads; stop writing to D1. All database access goes through one module in the code, so the switch touches that module and its tests.

## Consequences

- Easier: one place for every fact the rules read, with unique keys for idempotency and transactions for catalog changes, available in the MVP with no external service.
- Easier: adding a quiz question, an offer or a catalog change is a data change.
- Harder: the store has a hard size limit, so the cleanup job and the size alert are required parts of the design, not extras.
- Harder: if the quiz is ever prefilled (Q-1), a user who returns after 90 days without a Lead gets it empty.
- Watch: database size and its growth per month against the table in `nfr.md`, the real bytes per user once the MVP runs, and the real Lead rate against A-7. Either number moving changes the time to the trigger.

## Verification

- `Q-4 R-10 older answer arriving later does not replace the newer one`: two answer writes in reverse order leave the newer value.
- `user_answers rejects a value that is not valid JSON` and `an answer to an unknown question is rejected`.
- `P-3 offer_selected records the catalog version`.
- `catalog change creates a new full version in one transaction`: after the script runs, the new version has every offer, and selection reads it.
- `R-9 offer disabled after selection is not used at redirect` and `OFF-9 lead for a disabled offer gives no redirect`.
- `cleanup deletes inactive users without a lead and keeps lead users`, with seeded users on both sides of the 90-day line.
- Size metric: `PRAGMA page_count` times `page_size`, or the size reported by the D1 API, recorded daily; alert at 7 GB. Bytes per user is that size divided by the user count, compared with the 1 KB assumption in `nfr.md`.

## References

- `docs/requirements/nfr.md`: platform limits, "Size of the rule facts in D1".
- `docs/requirements/offer-selection.md`: algorithm and decision table.
- `docs/requirements/open-questions.md`: Q-1, Q-4, Q-8, Q-9, Q-11, Q-16, A-4, A-7.
- `docs/requirements/proposals.md`: P-1, P-3.
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- KV consistency: https://developers.cloudflare.com/kv/concepts/how-kv-works/
- Durable Objects limits: https://developers.cloudflare.com/durable-objects/platform/limits/

## Outcome

