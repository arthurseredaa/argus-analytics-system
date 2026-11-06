# Metrics and operations

This file defines the funnel metrics and the two report views, sets the latency and freshness targets, lists the alerts, prices the design, states the storage limits of the MVP, and describes two future extensions. It covers AN-1 to AN-8, NFR-3, NFR-5, NFR-6, NFR-7, MVP-4, MVP-5, DES-5 and DES-6. Tables, columns and event types are the ones in [data-model.md](data-model.md). The reasoning behind each store and pipeline step is in the ADRs listed under References.

Numbers about load, latency, freshness, cost and storage live in [nfr.md](../requirements/nfr.md), each with its source. This file links to the rows there; where it shows a figure, the same figure is in `nfr.md`.

## What this file settles

Arthur made these three decisions on 2026-11-03.

1. Funnel metrics count distinct users. A cohort is a prelander and a UTC day (Q-14). A user with two visits in a day counts once in every step, and visits are a separate metric. "Started the quiz" is a `step_viewed` event for step 1 (Q-13). A visit that opens with a Lead return or a rule 3 skip is a visit but not a start (Q-21).
2. Late postbacks are shown in two report views over the same data (P-6, Q-12, R-7): a cohort view keyed by the click date, which changes as postbacks arrive, and a postback view keyed by the time we accepted the postback, which does not change once a period has ended. The MVP has no attribution window.
3. Latency is a server-side p95 per endpoint over a rolling 15-minute window, measured in the Worker and written to Workers Analytics Engine, with a synthetic probe from the EU and the US as the end-to-end check (NFR-6).

## Metric definitions

Every metric has an id. Each query in the report module names the id it implements (AN-8), and the tests in `docs/testing/acceptance-checks.md` refer to the same ids.

Rules that apply to every row:

- Counts run on deduplicated data: the `events` view in BigQuery, which keeps one row per EventID ([ADR 0006](../adr/0006-bigquery-delivery.md)), the MVP `events` table, where `event_id` is the primary key, or the D1 facts. Nothing counts rows of `events_raw`.
- A cohort is (`prelander_id`, UTC day). Funnel steps take the UTC date of the event's `received_at`. Clicks, Leads and Purchases take the UTC date of the click's `created_at` in the cohort view and of `conversions.accepted_at` in the postback view (see "Two report views").
- A period longer than a day (a week, a month) counts distinct users over the whole period. A week is therefore not the sum of its days.
- Funnel steps belong to the prelander of the visit. A Lead or a Purchase belongs to the prelander and the offer of the click it references (Q-22). A Purchase belongs to the click the partner sends back, which can be a Lead return click (Q-21).
- The offer breakdown applies only from the click onward. Earlier steps have no offer.
- A visit that crosses midnight UTC puts its steps on one day and its click on the next. Rates are ratios of two counts in the same cell, not a join per user, so such a user can sit in the numerator of one day and the denominator of another. At daily volumes the effect is small, and it keeps one simple key for every metric.

### Counts

| ID | Metric | What is counted | Denominator | Grain | Repeat visits | Source |
|---|---|---|---|---|---|---|
| M-1 | Visits | distinct `visit_id` of `prelander_viewed`, any `reason` | none, a count | prelander, day | every visit counts (Q-26) | `prelander_viewed` |
| M-2 | Visitors | distinct `user_id` with a `prelander_viewed` | none, a count | prelander, day | once per user per cohort | `prelander_viewed` |
| M-3 | Started the quiz (reached step 1) | distinct `user_id` with `step_viewed` where `step` = 1 | none, a count | prelander, day | once per user per cohort; Lead return and skip visits emit no `step_viewed` and do not count (Q-13, Q-21) | `step_viewed` |
| M-4 | Reached step 2 | distinct `user_id` with `step_viewed` where `step` = 2 | none, a count | prelander, day | once per user per cohort | `step_viewed` |
| M-5 | Reached step 3 | distinct `user_id` with `step_viewed` where `step` = 3 | none, a count | prelander, day | once per user per cohort | `step_viewed` |
| M-6 | Answered step 1 | distinct `user_id` with `step_answered` where `step` = 1 | none, a count | prelander, day | once per user per cohort, however many times the answer changed | `step_answered` |
| M-7 | Answered step 2 | distinct `user_id` with `step_answered` where `step` = 2 | none, a count | prelander, day | as M-6 | `step_answered` |
| M-8 | Completed the quiz | distinct `user_id` with `quiz_completed` | none, a count | prelander, day | once per user per cohort; a retried completion emits a second event and still counts once | `quiz_completed` |
| M-9 | No offer shown | distinct `user_id` with `offer_selected` where `reason` = `no_offer` | none, a count | prelander, day | once per user per cohort | `offer_selected` |
| M-10 | Went to an offer | distinct `user_id` with a click whose `reason` is not `lead_return` | none, a count | prelander, offer, day | once per user per offer per cohort; a Lead return click is a repeat transition and does not add a user to the offer (Q-21); a click whose user was deleted counts as its own user, as in M-13 | `offer_click`; `clicks` in the MVP |
| M-11 | Transitions | distinct `click_id`, every reason | none, a count | prelander, offer, day | every click counts, Lead returns and double clicks included | `offer_click`; `clicks` in the MVP |
| M-12 | Lead returns | distinct `visit_id` of `prelander_viewed` where `reason` = `lead_return` | none, a count | prelander, day | every visit counts | `prelander_viewed` |
| M-13 | Leads | distinct (`user_id`, `offer_id`) with an accepted Lead. The first accepted Lead of the pair carries the count, with its click's prelander and date | none, a count | prelander, offer, day | one per user per offer, ever (Q-23); a second Lead for the pair is stored and not counted. A Lead whose click lost its user to a deletion request counts once per click | `conversions` joined with `clicks`; `lead` events |
| M-14 | Purchases | every accepted Purchase, distinct (`partner_id`, `transaction_id`) | none, a count | prelander, offer, day | every Purchase counts, a second real Purchase included (PB-5) | `conversions` joined with `clicks`; `purchase` events |
| M-15 | Purchases without a Lead | M-14 rows with no Lead for the same user and offer | none, a count | prelander, offer, day | a flag; these Purchases stay in M-14 (Q-8); no Lead accepted at or before the Purchase, so a Lead that arrives later does not clear the flag. A deletion request changes this: the user's clicks then count one per click, so a Purchase whose Lead sat on another click of the user can flip to "without a Lead" | `conversions` joined with `clicks` |
| M-16 | Payout received | sum of `payout` of accepted Leads and Purchases, per `currency` | none, a sum | prelander, offer, day | each accepted postback adds its payout, including a second Lead for the same pair, because the partner paid for it | `conversions`; `lead` and `purchase` events |

### Answers

D1 keeps only the current answer per user and question, while BigQuery has every `step_answered` event. Counting `step_answered` events for the answer distribution would count an answer the user later changed. The distribution therefore uses the final answer per user, and answer changes have metrics of their own.

| ID | Metric | What is counted | Denominator | Grain | Repeat visits | Source |
|---|---|---|---|---|---|---|
| M-17 | Answer distribution | distinct `user_id` per (`question_key`, final value); the final value is in the `answers` of the user's latest `quiz_completed` by `received_at` | M-8 for the share of each value | prelander, day | the latest completion wins (Q-4) | `quiz_completed.payload.answers`; `user_answers` in D1 |
| M-18 | Users who changed an answer | distinct `user_id` with more than one `step_answered` for the same step | none, a count | prelander, day, step | once per user per step | `step_answered` |
| M-19 | Answer transitions | count of consecutive pairs (A, B), A different from B, in one user's `step_answered` events for one question, ordered by `received_at`, then `seq` | none, a count | prelander, day, question, (A, B) | every change counts | `step_answered` |

### Rates

| ID | Rate | Numerator | Denominator | Grain | Note |
|---|---|---|---|---|---|
| M-20 | Step 1 to step 2 | M-4 | M-3 | prelander, day | |
| M-21 | Step 2 to step 3 | M-5 | M-4 | prelander, day | |
| M-22 | Step 3 to completion | M-8 | M-5 | prelander, day | |
| M-23 | Drop-off at step N | reached N minus reached N+1: M-3 minus M-4, M-4 minus M-5, M-5 minus M-8 | reached step N (M-3, M-4, M-5) for the share; the difference itself is shown as a count | prelander, day | no timeout; a user who has not reached the next step in the cohort has dropped off (Q-26) |
| M-24 | Start to offer | M-10 counted across offers (distinct users) | M-3 | prelander, day | |
| M-25 | Offer to Lead | M-13 | M-10 | prelander, offer, day | in the cohort view this grows with late postbacks |
| M-26 | Lead to Purchase | (user, offer) pairs of M-13 with at least one Purchase on that offer | M-13 | prelander, offer, day | Purchases without a Lead are in M-15, not here |
| M-27 | Start to Lead | distinct users with at least one Lead (M-13 counted by user) | M-3 | prelander, day | |
| M-28 | Visits per user | M-1 | M-2 | prelander, day | |
| M-29 | Answer change rate | M-18 | M-6 for step 1, M-7 for step 2 | prelander, day, step | |

### What the MVP report shows

The MVP report (AN-6, MVP-4) shows M-1 to M-5, M-8, M-10, M-11, M-13 and M-14, the drop-offs M-23, and the rates M-20 to M-22 and M-24 to M-28 computed from them. M-2 is there because it is the denominator of M-28, and M-11 because the AN-1 fixture and the demo numbers expect transitions. The postback view adds M-15 and M-16. Funnel steps come from the MVP `events` table; clicks, Leads and Purchases come from the facts database, so a test postback shows up at once ([ADR 0005](../adr/0005-event-ingestion-and-buffering.md)). The AN-1 fixture gives started 3, reached step 2 2, reached step 3 2: "step N" in that card is "reached step N".

M-6, M-7, M-9, M-12, M-17 to M-19 and M-29 are BigQuery queries over the `events` view and are not in the MVP report.

## Two report views

A postback can arrive hours or days after the click (R-7). One report cannot both stay stable for past days and put every Lead on the day of its click, so the report has two views over the same data (P-6, Q-12). The report endpoint takes `view=cohort` or `view=postback` (AN-5).

### Cohort view (`view=cohort`)

- Keyed by cohort day. For funnel steps it is the UTC date of the event's `received_at`; for M-10, M-11 and M-13 to M-15 it is the UTC date of `clicks.created_at`, and the prelander and offer come from the click.
- Sort key columns: `cohort_day`, `prelander_id`, `offer_id`.
- The page prints an "as of" time: the time the query ran, next to the current freshness of the events ([ADR 0006](../adr/0006-bigquery-delivery.md), Freshness).
- A past day grows while late postbacks for its clicks keep arriving. There is no attribution window in the MVP (Q-12): a Lead accepted a month after the click still lands on the click's day.

### Postback view (`view=postback`)

- Keyed by `accepted_day`, the UTC date of `conversions.accepted_at`, our own receive time.
- Sort key columns: `accepted_day`, `prelander_id`, `offer_id`.
- Shows M-13 (on the day the pair's first Lead was accepted), M-14, M-15 and M-16: what came in during the period.
- A period's numbers do not change once it has ended, because `accepted_at` is written once by us and later postbacks land on later days. The one exception is a deletion request: it sets `clicks.user_id` to null on the user's clicks, and each such click then counts as its own user (M-13). A second Lead of the pair that was stored and not counted then counts, and a Purchase can become "without a Lead" (M-15), on days that have already ended.

### Worked example

100 users click an offer on 3 Nov (M-10 = 100, none of them a Lead return). The partner sends 5 Leads, accepted on 4 Nov, and 3 more, accepted on 5 Nov. All 8 are for 3 Nov clicks.

Cohort view, row for 3 Nov, read at three moments:

| As of | Leads (M-13) | Offer to Lead (M-25) |
|---|---|---|
| 4 Nov 00:00 UTC | 0 | 0% |
| 5 Nov 00:00 UTC | 5 | 5% |
| 6 Nov 00:00 UTC | 8 | 8% |

Postback view, any time after 5 Nov:

| Accepted day | Leads (M-13) |
|---|---|
| 3 Nov | 0 |
| 4 Nov | 5 |
| 5 Nov | 3 |

Both views count the same 8 Leads. They place them on different days.

### Which view to read

A marketer comparing funnels reads the cohort view: it answers which prelander and which offer turn clicks into Leads, because every Lead sits on the day of the click that earned it. A finance person reads the postback view: it answers what came in during a period, and a closed period does not change, except when a deletion request removes a user (M-13, M-15). Yesterday's numbers in the cohort view can change today because the partner reports a registration when it happens on their side, which can be days after our click; the "as of" time on the page says how complete the row is.

## Latency target (NFR-6)

Geography assumption, stated with the target: traffic comes mostly from the EU and the US, and D1 sits in the EU (Q-2, NFR-7). A user in the US reaching a D1 database in the EU pays about 100 to 150 ms of round trip, an estimate that the probe below measures.

Targets, server side, p95 per endpoint over a rolling 15-minute window ([nfr.md, Set in stage 4](../requirements/nfr.md#set-in-stage-4)):

| Endpoint | p95 target | What the request does |
|---|---|---|
| `POST /api/events` | 50 ms | validates the event and sends it to the Queue; no D1 |
| `GET /p/{prelander}`, `POST /api/complete`, `GET /go` | 300 ms | one D1 batch to a database in one region, then `select()` |
| `POST /postback/v1/{partner}` | 300 ms | signature check, click lookup and one insert in D1 |

How it is measured:

1. The Worker records, for every request, the time from receipt to response as one data point in Workers Analytics Engine: index = endpoint, doubles = duration in ms and HTTP status, blobs = country and Cloudflare location from `request.cf`, so p95 can be split by region (R-18). Analytics Engine includes 10M data points a month on Paid, is not billed at the moment, and keeps data for 3 months ([nfr.md, Cloudflare](../requirements/nfr.md#cloudflare)). `blob1` is the kind of point, so every query filters on one column:

   | Kind | `index1` | blobs | doubles |
   |---|---|---|---|
   | request | endpoint label | `request`, country, colo, error tag (`d1_overload` or empty) | duration ms, HTTP status |
   | loader | `loader` | `loader`, run status | freshness ms (`-1` when the table is empty), files, rows |
   | pipeline | `pipeline` | `pipeline` | pending files, oldest pending age ms, Queue backlog count, Queue backlog bytes, oldest Queue message age ms, dead letter backlog count (`-1` for any unknown) |
   | d1_size | `d1_size` | `d1_size`, `facts` or `events` | bytes |

   The endpoint label comes from a fixed list and never from the raw path, so a crafted URL such as `/p/x?email=...` cannot reach Analytics Engine (R-12): `GET /healthz`, `<M> /p/:prelander`, `<M> /api/events`, `<M> /api/complete`, `<M> /api/report`, `<M> /go`, `<M> /postback/v1/:partner`, `<M> /report`, `<M> /__probe`, `<M> /__test/*`, else `<M> other`. `<M>` is the method when it is one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS, else `OTHER`. The duration is the clock after the handler minus the clock before it, so it leaves out `waitUntil` work; in Workers the clock moves only across I/O, so a route that only computes reads near 0. A request whose handler threw is recorded with status 500, and a D1 overload error is tagged `d1_overload` on its point without its message being logged.
2. The dashboard queries p50, p95 and p99 per endpoint through the Analytics Engine SQL API, weighting by `_sample_interval` because Analytics Engine samples at high write rates. The Cloudflare Workers metrics (wall time, CPU time, errors) are the cross-check.
3. A synthetic probe calls `GET /__probe` every 5 minutes from one EU and one US location. Target: end-to-end p95 at most 500 ms; two consecutive failures raise `probe_failed`. The default assumption is an external uptime service, Checkly, because it runs checks from chosen locations; its free-tier limits are checked and written to `nfr.md` before it is set up. A cron Worker could run the probe instead, but it runs inside Cloudflare and does not see the public network path a user takes.
4. `GET /__probe` runs the same D1 batch as entry for a fixed UserID that has no rows, then `select()`, and answers `200` with the D1 time in the body. The reads return nothing but still pay the round trip to the database, which is what the probe measures. It sets no cookie, emits no events and writes nothing, so it needs no seeded user, no cleanup exception and no filter in the metrics. The Queue is not probed: `/api/events` carries real traffic every second, and its latency comes from step 1, while a stopped pipeline shows up in `freshness_lag`.
5. The k6 load tests in acceptance checks NFR-2 and NFR-6 (P-7) are the one-off verification. Where k6 ran from is recorded with the result, and k6 and the dashboard may differ by at most 20% for the same window.

The 50 ms target for `/api/events` and the postback target have no alert of their own: the page does not wait for the answer to an event request before it shows the next step, partners retry postbacks, and both figures are read in the monthly check. The selection target has an alert, because it is also a migration trigger in [ADR 0003](../adr/0003-operational-store.md#migration).

## Reliability and alerts

### Freshness and buffers

| Item | Value | Source |
|---|---|---|
| Freshness target, normal operation | 15 minutes (NFR-3): consumer wait up to 30 s, plus up to 5 minutes until the next loader run, plus the load job | [nfr.md, Given by the spec](../requirements/nfr.md#given-by-the-spec), [ADR 0006](../adr/0006-bigquery-delivery.md) |
| Freshness in the MVP | about a minute: consumer wait up to 30 s, loader every minute | [nfr.md, Set in stage 4](../requirements/nfr.md#set-in-stage-4), [ADR 0005](../adr/0005-event-ingestion-and-buffering.md) |
| Freshness metric | age of the newest row in `events_raw` (MVP: in the D1 `events` table), measured by the loader after every run and written to Analytics Engine | [ADR 0006](../adr/0006-bigquery-delivery.md) |
| Consumer or R2 down | Queue retries for about 5 hours, then the dead letter queue: 14 days or 25 GB. At 6.9 events/s that is 14 days and about 8.4M events; at 200 events/s sustained, about 35 hours | [nfr.md, Derived](../requirements/nfr.md#derived), [ADR 0005](../adr/0005-event-ingestion-and-buffering.md) |
| BigQuery or the loader down | files wait in R2 `pending/`, with no limit except storage cost and Q-16 | [nfr.md, Derived](../requirements/nfr.md#derived) |
| Queue down | the Worker writes one file per event to R2 `pending/`; the loader drains about 30 events/s | [nfr.md, Derived](../requirements/nfr.md#derived) |

What a reviewer sees during each outage:

| What is down | Quiz and selection | Report | Alerts | After recovery |
|---|---|---|---|---|
| BigQuery or the loader | keep working (NFR-4) | freshness grows; no new rows | `freshness_lag` after 15 minutes, `pending_oldest_file` after 1 hour | the loader takes the backlog, 9,000 files a run; counts equal the distinct EventIDs sent |
| Consumer or R2 | keep working | freshness grows | `freshness_lag`; `dlq_not_empty` after about 5 hours | retries recover a short outage with no one involved; after 5 hours an operator runs the redrive script within 14 days |
| Queue | keep working; events go to R2 one file each | freshness stays close to normal | none of the delivery alerts while the loader keeps up | the loader drains the one-event files; counts equal the distinct EventIDs |
| Queue and R2 together | `/api/events` and postbacks answer `503`; entry and completion answer normally and lose their server events | no new data | `worker_5xx_rate`, `probe_failed` | browser events come in as browsers resend them and Leads as partners retry; the server events of entry and completion sent in that window are lost ([ADR 0005](../adr/0005-event-ingestion-and-buffering.md)) |
| D1 facts database | entry, completion, `/go` and postbacks fail | funnel steps still arrive; Leads and Purchases stop | `worker_5xx_rate`, `probe_failed`, possibly `d1_overload_errors` | partners retry postbacks; the unique key stops double counting (PB-5) |

### Alerts

| Alert | Signal | Threshold | What it means | Action |
|---|---|---|---|---|
| `freshness_lag` | age of the newest row in `events_raw` (MVP: D1 `events`), counted only while files wait in `pending/` or messages wait in the Queue | above 15 minutes | analytics are behind NFR-3 | look at `pending_oldest_file` and `dlq_not_empty` to find the stopped stage; read the loader logs |
| `pending_oldest_file` | age of the oldest object in R2 `pending/` | above 1 hour | loads into BigQuery have stopped | check BigQuery reachability, the service account and the last load job; nothing is lost while files wait |
| `dlq_not_empty` | backlog count of the dead letter queue, read with `Queue.metrics()` on a producer binding | any | the consumer could not write to R2 for about 5 hours | fix the cause, then run the redrive script; messages are deleted after 14 days |
| `rejected_new_file` | new object in R2 `rejected/` | any | rows failed validation, or a batch failed five load jobs | fix the loader or the row, then move the file back to `pending/`; 30 days before the lifecycle rule deletes it. Check the file's event ids against D1 first: two overlapping loader runs can write rows that D1 already holds to `rejected/` |
| `quarantine_new_row` | new row in `quarantine` | any | a signed postback named an unknown click (Q-11) | check the partner integration, the cleanup window or a forgery; resend if the click exists |
| `postbacks_without_conversions` | per partner, requests in `postback_counts` over 15 minutes and how many were accepted | at least 5 requests and none accepted | a partner posts, but nothing is accepted: a wrong secret, a changed contract or a broken click lookup (PB-3, PB-4, Q-11) | check the partner's secret and the last `postback` log lines for the reason; ask the partner what changed |
| `d1_facts_size` | size of the facts database | above 7 GB | migration trigger one ([ADR 0003](../adr/0003-operational-store.md#migration)) | start the migration plan in ADR 0003 |
| `d1_events_size` | size of the MVP events database | above 7 GB on Paid, 350 MB on Free | the MVP stand-in for BigQuery is near its limit (MVP-5) | point the loader at BigQuery (see "MVP storage limits") |
| `selection_p95` | p95 of `GET /p/{prelander}`, `POST /api/complete`, `GET /go` | above 300 ms over 15 minutes | migration trigger two | split p95 by region and by D1 query time; if D1 is the cause, follow ADR 0003 |
| `d1_overload_errors` | D1 errors that report overload, counted by the Worker | more than 10 in an hour (a starting value) | migration trigger three | check write load on the facts database; follow ADR 0003 if it repeats |
| `worker_5xx_rate` | share of `5xx` responses among all requests | above 1% over 5 minutes | a broken deploy or a failing dependency | read the Worker logs; roll back the last deploy if it is the cause |
| `probe_failed` | synthetic probe from the EU or the US | two consecutive failures (wrong status or no answer) | the public path is broken for real users | check the Cloudflare status page, DNS and the last deploy |
| `load_jobs_day` | BigQuery load jobs for the table today | above 1,000 of the 1,500 daily quota | failed batches are using up the quota | find the failing batch in the manifests; fix it before the quota runs out |

Thresholds are listed in [nfr.md, Set in stage 4](../requirements/nfr.md#set-in-stage-4).

Delivery: the alert run is a second cron, `*/5 * * * *`, in the same Worker as the loader. It reads the pipeline state (pending files and the age of the newest row), lists `rejected/` in R2, counts new `quarantine` rows, reads the backlog of the events queue and of the dead letter queue with `Queue.metrics()`, and once a day reads both D1 sizes (the figure `wrangler d1 info` prints, `meta.size_after` of a `SELECT 1`) and writes them to Analytics Engine. The dead letter queue is bound as `EVENTS_DLQ` for this read only; nothing sends to it or consumes it. A firing alert is one log line per run, `{"msg":"alert","id","value","threshold"}`, with `endpoint` or `partner_id` where the alert has one. A level alert such as `freshness_lag` repeats every 5 minutes while it holds. The MVP sends no email or webhook and does not throttle. The sender, which would email or call a webhook at most once an hour per alert, is design-only, and so are the Cloudflare Notifications for signals that Cloudflare raises itself (which types exist for Workers, Queues and D1 is checked when it is built). "New" means after the previous run: the run keeps `checked_at` and `sizes_checked_at` in the small R2 object `control/alert-state.json` and writes it last, so a run that fails looks at the same window again. A source that cannot be read logs `alert_source_unavailable` with its name and the alerts it covers, and the other alerts still run. In the MVP the reader is the one operator, Arthur, through the Worker logs; later a shared channel.

## Cost at the design load

18M events a month (A-1), one event per request ([ADR 0005](../adr/0005-event-ingestion-and-buffering.md)), on the services the ADRs chose. The first four rows are the existing $28.60 from [nfr.md](../requirements/nfr.md#what-these-numbers-mean-for-the-design); the rest are new and are also listed in [nfr.md, Set in stage 4](../requirements/nfr.md#set-in-stage-4).

| Item | Arithmetic | Per month | Limits row |
|---|---|---|---|
| Workers Paid base | | $5.00 | [Workers](../requirements/nfr.md#cloudflare) |
| Workers requests | 18M − 10M included = 8M × $0.30/M; an upper bound, since the four server-emitted events of a visit are not requests and the real count is closer to 16M | $2.40 | [Workers](../requirements/nfr.md#cloudflare) |
| Queues | 18M × 3 operations = 54M − 1M included = 53M × $0.40/M | $21.20 | [Queues](../requirements/nfr.md#cloudflare) |
| D1 rows written | 18M, within 50M included | $0 | [D1](../requirements/nfr.md#cloudflare) |
| D1 storage | facts database under the 5 GB included for at least the first year ([nfr.md](../requirements/nfr.md#size-of-the-rule-facts-in-d1)); no events database in production | $0 | [D1](../requirements/nfr.md#cloudflare) |
| R2 operations | consumer writes 18M / 100 events per file = about 180,000 files (Class A), plus about 35,000 loader lists, manifest writes and `loaded/` writes (8,640 runs × about 4); the loader reads each file once, about 180,000 Class B; deletes are free | $0, within 1M Class A and 10M Class B | [R2](../requirements/nfr.md#cloudflare) |
| R2 storage | `loaded/` keeps 30 days: about 18 GB at 1 KB per event, so about 18 GB-month; 18 − 10 free = 8 × $0.015 | $0.12 | [R2](../requirements/nfr.md#cloudflare) |
| Analytics Engine | one latency data point per request, about 18M; 10M included | $0 today; 8M × $0.25/M = $2.00 if billing starts | [Analytics Engine](../requirements/nfr.md#cloudflare) |
| BigQuery loads | batch load jobs on the shared slot pool | $0 | [BigQuery](../requirements/nfr.md#bigquery) |
| BigQuery storage | about 18 GiB more each month at 1 KB per event; month 1: 18 − 10 free = 8 × $0.023 (billed on the end-of-month size, which overstates it); month 12: 216 − 10 = 206 × $0.023 | $0.18 in month 1, about $4.74 in month 12 | [BigQuery](../requirements/nfr.md#bigquery) |
| BigQuery queries | a daily report reads one partition per day; within the free 1 TiB | $0 | [BigQuery](../requirements/nfr.md#bigquery) |
| Durable Objects, KV | not used | $0 | |

Total: $28.90 in month 1, or $30.90 if Analytics Engine billing starts, so about $31. BigQuery storage adds about $0.41 a month for every month of history kept: about $33.50 in month 12, or $35.50 with Analytics Engine billed. BigQuery prices were read for the US default region; EU prices are not checked ([nfr.md, BigQuery](../requirements/nfr.md#bigquery)). The budget is Q-17.

### Free-plan ceiling for the MVP

On the Free plan, per day: Workers 100,000 requests, Queues 10,000 operations, D1 100,000 rows written, Analytics Engine 100,000 data points ([nfr.md, Cloudflare](../requirements/nfr.md#cloudflare)). Queues binds first: at 3 operations per message, about 3,300 events a day. A Free account carries the demo and about 3,000 events a day. Two more Free limits matter: Queue messages, and so the dead letter queue, are kept 24 hours instead of 14 days, and D1 Time Travel covers 7 days instead of 30. The synthetic probe costs about 580 Worker requests a day (two locations, 288 runs) and no events. The design assumes Workers Paid at $5 a month (Q-17).

## MVP storage limits (MVP-5)

In the MVP every event goes into the `events` table of a separate D1 database ([ADR 0005](../adr/0005-event-ingestion-and-buffering.md), [data-model.md](data-model.md#mvp-events-database)). Figures are in [nfr.md, Set in stage 4](../requirements/nfr.md#set-in-stage-4):

- At about 560 bytes a row (10 GB / 18M, [nfr.md](../requirements/nfr.md#what-these-numbers-mean-for-the-design)), the design load fills the 10 GB maximum of one D1 database on Paid in about a month, and the 500 MB Free limit in under two days. At 1 KB a row, the figure used for the Queue and BigQuery, it is about 17 days and under one day.
- At the Free ceiling of about 3,300 events a day, 500 MB lasts about 5 to 9 months (1 KB and 560 bytes a row). A demo run is tens of events, so for the review the limit is years away.

How we notice: the alert cron reads the size of both D1 databases once a day (the figure `wrangler d1 info` and the D1 dashboard show) and writes it to Analytics Engine. `d1_events_size` fires at 7 GB on Paid and 350 MB on Free, 70% of the limit, the same rule as the facts trigger in [ADR 0003](../adr/0003-operational-store.md#migration). `d1_facts_size` watches the facts database at 7 GB. The growth per day on the dashboard gives the date the limit would be reached.

What moves to BigQuery: raw events. The production loader is the same code with a different load target (ADR 0005, ADR 0006). The R2 `loaded/` files of the last 30 days are moved back to `pending/` and load again; the `events` view hides anything loaded twice. Older history exists only in the D1 table, so it is exported once as newline-delimited JSON into `pending/` and loaded like any other file. Then the events database is removed.

What stays in D1, because the rules read it within seconds (A-4): `users`, `user_answers`, `clicks`, `conversions`, `offers`, `catalog_history` and `partners`. Leads and offer status are read by every entry and every completion, so they cannot wait for a 15-minute pipeline. Their size, the cleanup that bounds it and the migration path are in [ADR 0003](../adr/0003-operational-store.md#migration) and [nfr.md, Size of the rule facts in D1](../requirements/nfr.md#size-of-the-rule-facts-in-d1).

## Extensions

The two extensions in DES-5 and DES-6 are designed but not built. Each ends with the files it would touch.

### Offer exclusion after Purchase (DES-5)

Q-20's default: after a Purchase on offer X, X is removed from the user's candidates, and the Lead rule no longer applies to X.

The flag: a column `offers.exclude_after_purchase INTEGER NOT NULL DEFAULT 0 CHECK (exclude_after_purchase IN (0, 1))`. It lives on the catalog row, per catalog version, so marketing turns it on for one offer with the catalog script and no deploy, and every `offer_selected` event's `catalog_version` shows whether the flag applied (P-3). A single global switch would be smaller: one config value and no migration. Per offer is the better fit because the right answer differs by offer. A dating service with a one-time purchase may want the user gone, while one that sells repeat credits wants them back, and a global switch would also apply to the universal offer.

The rule step: step 1 of `select()` ([ADR 0004](../adr/0004-offer-selection-semantics.md)), which is empty today, marks every offer for which the user has an accepted Purchase and whose flag is 1 in the current catalog version as inactive for this user. From there the existing steps do the work: rule 1 skips the offer's Leads because the offer is not active, rule 3 skips the quiz when the answers are sufficient, and rule 2 never matches it. So for this user an excluded offer behaves exactly like a disabled offer, and no step after the first one learns a new case. The facts already include Purchases: the query that reads the user's conversions at entry, at completion and at `/go` changes from `v.type = 'lead'` to both types:

```sql
SELECT c.offer_id, v.type, v.accepted_at
FROM conversions v
JOIN clicks c ON c.click_id = v.click_id
WHERE c.user_id = ?1 AND v.type IN ('lead', 'purchase');
```

`GET /go` runs `select()` on every press, so an excluded offer is inactive there too and the press goes to the next result (R-9).

Interaction with rule 1: an excluded offer also loses its Lead redirect. A user with a Lead and a Purchase on 001, no other Lead, and 001 flagged, is handled like a user whose Lead is for a disabled offer (OFF-9): at entry with sufficient answers, rule 3 skips the quiz and rule 2 gives 003 for women + asia; with insufficient answers, the quiz. With a Lead on 004 as well, 004 wins by rule 1. The alternative, removing the Lead and showing the quiz again at entry, would introduce a second kind of unusable Lead with its own behaviour, so it was not taken.

Rows to add to the decision table in `offer-selection.md` when this is built, as the tests:

| Answers | Lead | Purchase | Flag | Moment | Expected | Reason |
|---|---|---|---|---|---|---|
| women + asia | 001 | 001 | 001 on | entry | 003, quiz skipped | best_epu; 001 inactive for this user, rule 3 (Q-20, OFF-9) |
| women only | 001 | 001 | 001 on | entry | quiz | insufficient answers, rule 3 |
| women + asia | 004 then 001 | 001 | 001 on | entry | 004, quiz skipped | lead_return; without the flag 001, the most recent Lead, would win |
| women + asia | none | 003 | 003 on | completion | 001 | best_epu, 003 excluded (Purchase without a Lead, Q-8) |
| women + asia | 001 | 001 | off | entry | 001, quiz skipped | lead_return, unchanged |

Files and migrations touched:

- `migrations/000N_offers_exclude_after_purchase.sql`: the new column.
- Catalog script: an option to set or clear the flag for an offer in a new version.
- `select()` step 1 and its decision table tests.
- The facts query used at entry, completion and `/go`: Leads and Purchases.
- The `/go` handler: no change, because it calls `select()`.
- Event schema: no change. `offer_selected.reason` keeps its values; a new reason is not needed.
- Metrics: none.

### EPU from real data (DES-6)

EPU is revenue per unique user sent to the offer (OFF-2, glossary). Today it is a constant in the catalog.

The field: `conversions.payout` and `currency` from the postback contract ([ADR 0007](../adr/0007-postback-contract-and-auth.md)). A column `payout_minor INTEGER` is added next to the `REAL` one, as the data model foresees: the postback endpoint parses the decimal string into minor units of the currency, so sums are exact. Existing USD rows are backfilled from `payout` once. A rate table to USD is kept in the Worker's config, next to the question catalog, with each currency's minor-unit exponent and a fixed rate. The MVP partner sends USD; other currencies use the configured rate, revisited when a real partner appears.

The query, per offer over a trailing 30-day window by click date. The window ends some days before today, by the typical delay between a click and its postback, so recent clicks whose postbacks have not arrived yet do not drag the figure down. The lag is a config value, set from the measured delay between `clicks.created_at` and `conversions.accepted_at` once real postbacks exist.

```sql
-- ?1 = window_start, ?2 = window_end, Unix ms, UTC
WITH window_clicks AS (
  SELECT click_id, offer_id,
         COALESCE(user_id, 'click:' || click_id) AS user_key
  FROM clicks
  WHERE created_at >= ?1 AND created_at < ?2
),
offer_users AS (
  SELECT offer_id, COUNT(DISTINCT user_key) AS users
  FROM window_clicks
  GROUP BY offer_id
),
offer_revenue AS (
  SELECT w.offer_id, v.currency, SUM(v.payout_minor) AS revenue_minor
  FROM window_clicks w
  JOIN conversions v ON v.click_id = w.click_id
  WHERE v.payout_minor IS NOT NULL
  GROUP BY w.offer_id, v.currency
)
SELECT u.offer_id, u.users, r.currency, COALESCE(r.revenue_minor, 0) AS revenue_minor
FROM offer_users u
LEFT JOIN offer_revenue r ON r.offer_id = u.offer_id;
```

The job converts each `revenue_minor` to USD minor units with the configured rate and sums them per offer into `revenue_minor_usd`. EPU = `revenue_minor_usd` / 100 / `users`. Payouts of Leads and Purchases both count, because both are money received. The same query runs in BigQuery over the `offer_click`, `lead` and `purchase` events if the facts database has moved.

Recomputed daily by a cron job into a new table in the facts database:

```sql
CREATE TABLE offer_epu_observed (
  offer_id          TEXT NOT NULL,
  window_start      INTEGER NOT NULL,
  window_end        INTEGER NOT NULL,
  users             INTEGER NOT NULL,
  revenue_minor_usd INTEGER NOT NULL,
  epu               REAL NOT NULL,
  computed_at       INTEGER NOT NULL,
  PRIMARY KEY (offer_id, window_end)
);
```

Replacing the constant: selection keeps reading EPU from the catalog, which is versioned and explains every past redirect (P-3). The observed figure never flows into `select()` directly: rule 2, step 5 of `select()`, keeps reading `offers.epu` from the current catalog version, as it does today. Once a week, a catalog script option writes a new catalog version in which `epu` is replaced by the latest observed value for every offer whose window has at least 500 users (a starting value); below that the constant stays. In the first months an operator confirms the change after reading the script's diff; later the step runs on its own. Each catalog row records where its EPU came from in a new column `offers.epu_source`, `constant` or `observed`, so a past selection can be traced to the kind of number it used.

Pitfalls:

- Late postbacks move a window's revenue after it is computed. The window is by click date and ends behind today by the postback lag, so the figure for a window settles before it is used.
- Lead return clicks add revenue (a Purchase can reference them, Q-21) but no unique users, because the user is counted once per offer in the window.
- The 90-day cleanup never touches clicks inside a 30-day window. Clicks of a user removed by a deletion request count once each, through the `click:` key.
- A disabled offer keeps its last observed EPU in the catalog; if it is enabled again, the old figure applies until a new window has 500 users.
- An offer that loses on EPU to another match gets no new users from that match (001 against 003 for women + asia), so its observed figure stops updating. Choosing by the highest EPU has this limit, and this extension does not change it.

Files and migrations touched:

- `migrations/000N_epu_observed.sql`: `conversions.payout_minor`, `offers.epu_source TEXT NOT NULL DEFAULT 'constant'`, and the `offer_epu_observed` table.
- The postback handler: parse `payout` into `payout_minor`.
- Worker config: currency rates and exponents.
- A daily cron job and its trigger in the Wrangler config.
- Catalog script: an option to write a version with observed EPU, with a printed diff.
- The report page: a row per offer with the catalog EPU, the observed EPU and its window.
- Tests with a fixture of clicks and payouts, including a Lead return click, a late postback and two currencies.
- `select()`: no change.

## Operating with little attention

### Scheduled work

| Job | Schedule | What it does | Source |
|---|---|---|---|
| Loader | every 5 minutes (every minute in the MVP) | loads `pending/` into BigQuery (MVP: D1 `events`), records freshness | [ADR 0005](../adr/0005-event-ingestion-and-buffering.md), [ADR 0006](../adr/0006-bigquery-delivery.md) |
| Cleanup | daily | deletes users with no Lead and no Purchase inactive for 90 days | [ADR 0003](../adr/0003-operational-store.md), [data-model.md](data-model.md#cleanup-and-deletion) |
| Alert evaluator | every 5 minutes; D1 sizes once a day | evaluates the alerts above and sends them | this file |
| Synthetic probe | every 5 minutes, EU and US | external checker calls `GET /__probe` | this file |
| EPU job (future) | daily, with a weekly catalog step | fills `offer_epu_observed` | this file, DES-6 |
| R2 lifecycle rules | continuous | delete `loaded/` and `rejected/` objects after 30 days | [ADR 0006](../adr/0006-bigquery-delivery.md) |
| D1 Time Travel | continuous | the backup: point-in-time restore for 30 days on Paid, 7 on Free | [nfr.md, Cloudflare](../requirements/nfr.md#cloudflare) |

The MVP uses three cron triggers (loader, cleanup, alert evaluator), within the five a Free account allows; the EPU job would be the fourth.

### Who gets the alerts

Every alert goes to one email address or webhook. In the MVP that is Arthur, the only operator. When more people run the system, it becomes a shared channel, and the alert evaluator needs no change beyond the address.

### Monthly check

Once a month:

1. Open the dashboard: freshness over the month, p95 per endpoint against the targets, both D1 sizes and their growth.
2. Confirm the dead letter queue is empty, and read the counts of `rejected/` files and `quarantine` rows.
3. Compare the month's Cloudflare and Google invoices with the cost table and with the budget once Q-17 is answered.
4. Confirm the Dependabot pull requests of the month are merged.
5. Read the Cloudflare deprecation and change notices for Workers, D1, Queues, R2 and Analytics Engine.

### Dependency updates

Dependabot opens one grouped pull request a week for npm dependencies and one for GitHub Actions. CI runs the full test suite, decision table included, and a green run is the gate for merging. `wrangler` and the Worker's compatibility date are bumped by hand once a quarter, with a staging deploy and the demo script before production.

### A month with nothing to do

The dashboard shows every alert green for the whole month, the dead letter queue at 0, no new files in `rejected/`, no new rows in `quarantine`, both D1 databases below 7 GB, p95 under the targets for every endpoint, and the bill within the budget. The only work left is merging the Dependabot pull requests whose CI is green.

## References

- ADRs: [0002 identity](../adr/0002-user-identity.md), [0003 operational store](../adr/0003-operational-store.md), [0004 offer selection](../adr/0004-offer-selection-semantics.md), [0005 event ingestion](../adr/0005-event-ingestion-and-buffering.md), [0006 BigQuery delivery](../adr/0006-bigquery-delivery.md), [0007 postbacks](../adr/0007-postback-contract-and-auth.md).
- [data-model.md](data-model.md): tables, event catalog, MVP events database, change management.
- [nfr.md](../requirements/nfr.md): load figures, platform limits, cost, the figures set in stage 4.
- [requirements.md](../requirements/requirements.md): AN-1 to AN-8, NFR-1 to NFR-8, MVP-4, MVP-5, OFF-2, PB-5, DES-5, DES-6.
- [open-questions.md](../requirements/open-questions.md): Q-2, Q-4, Q-8, Q-11, Q-12, Q-13, Q-14, Q-16, Q-17, Q-20, Q-21, Q-22, Q-23, Q-26, A-1, A-3, A-4, A-7.
- [proposals.md](../requirements/proposals.md): P-3, P-6, P-7, P-8.
- [risks.md](../requirements/risks.md): R-7, R-8, R-9, R-15 to R-19.
- [glossary.md](../requirements/glossary.md): visit, click, Lead, Purchase, started the quiz, cohort report, universal offer, EPU.
- [offer-selection.md](../requirements/offer-selection.md): catalog and decision table.
- [acceptance-checks.md](../testing/acceptance-checks.md): AN-1 to AN-8, NFR-2, NFR-3, NFR-5, NFR-6, NFR-7.
