# Non-functional numbers

Every number about load, freshness, latency, retention or cost lives here with its source. Other documents link to this file instead of repeating the figure. Derived figures show the arithmetic.

## Given by the spec

| ID | Figure | Value | Source |
|---|---|---|---|
| NFR-1 | Users per month | 1,000,000 | spec, via `requirements.md` NFR-1 |
| NFR-1 | Visits per user per month | 2 | spec, NFR-1 |
| NFR-1 | Events per visit | 6 (A-1 lists them) | spec, NFR-1 |
| NFR-1 | Events per month | 12,000,000 = 1,000,000 × 2 × 6 | spec, NFR-1 |
| NFR-2 | Peak rate | 200 events/s | spec, NFR-2 |
| NFR-2 | Peak duration | 5 minutes | spec, NFR-2 |
| NFR-3 | Analytics freshness, normal operation | up to 15 minutes | spec, NFR-3 |

## Derived

| ID | Figure | Value | Arithmetic | Source |
|---|---|---|---|---|
| A-1 | Events per visit in our catalog | 9: the spec's 6 plus a `step_viewed` for each of the 3 quiz steps | 6 + 3 | `open-questions.md` A-1 |
| A-1 | Design load, events per month | 18,000,000 | 1,000,000 × 2 × 9 | `open-questions.md` A-1 |
| A-3 | Average event rate | about 6.9 events/s (4.6 at the spec's 12M) | 18,000,000 / 30 days / 86,400 s = 6.94 | `open-questions.md` A-3 |
| A-3 | Events in one peak | about 60,000 | 200 × 300 s | `open-questions.md` A-3 |
| A-3 | Peak over average | about 29× | 200 / 6.94 | derived here |
| NFR-5 | Buffer while BigQuery or the loader is down | files in R2 `pending/`, no limit except storage cost and Q-16 | R2 Standard $0.015/GB-month | ADR 0005 |
| NFR-5 | Automatic recovery while the consumer or R2 is down | about 5 hours of retries in the Queue | 1 + 2 + 4 + 8 + 16 + 32 + 4 × 60 = 303 minutes over 10 retries | ADR 0005 |
| NFR-5 | Buffer in the dead letter queue after that, at 6.9 events/s | 14 days, about 8.4M events (retention binds first), redriven by hand | 6.9 × 86,400 × 14 = 8.35M; at 1 KB, 8.4 GB of the 25 GB backlog | ADR 0005 |
| NFR-5 | Same, at 200 events/s sustained | about 35 hours (backlog binds first) | 25 GB / 1 KB = 25M events; 25M / 200 = 125,000 s | ADR 0005 |
| NFR-5 | Loader drain of one-event files after a Queue outage | about 30 events/s, above the 6.9 average | 9,000 files per run / 300 s | ADR 0006 |
| NFR-5 | Spec peak against the Queue backlog | 0.2% | 60,000 / 25M | ADR 0005 |
| A-4 | Freshness for rule facts (Leads, offer status) | seconds, not minutes | the Lead return rule runs on the live path | `open-questions.md` A-4 |

## Set in stage 4

Set on 2026-11-03 in stage 4 of `docs/plans/part1-design-document.md`. The definitions, the measurement method and the alerts that use these figures are in `docs/design/metrics-and-operations.md`. Platform figures come from the limits table below.

| ID | Figure | Value | Arithmetic or method | Source |
|---|---|---|---|---|
| NFR-2 | Body limit of `POST /api/events` | 4 KB (4,096 bytes); larger bodies get `413` | one event is about 1 KB (ADR 0005), four times headroom | Part 2 stage 2, 2026-11-05 |
| NFR-6 | p95 latency of `POST /api/events`, server side | at most 50 ms over a rolling 15-minute window | validation and one Queue send, no D1 | Arthur's decision, 2026-11-03 |
| NFR-6 | p95 latency of `GET /p/{prelander}`, `POST /api/complete`, `GET /go`, server side | at most 300 ms over a rolling 15-minute window | one D1 batch to a database in one region | Arthur's decision, 2026-11-03; geography from Q-2, NFR-7 |
| NFR-6 | p95 latency of `POST /postback/v1/{partner}`, server side | at most 300 ms over a rolling 15-minute window | signature check, click lookup, one insert | Arthur's decision, 2026-11-03 |
| NFR-6 | Round trip from a US user to a D1 database in the EU | about 100 to 150 ms | estimate, not measured; the probe measures it | Arthur's estimate, 2026-11-03 |
| NFR-6 | Synthetic probe, end to end | p95 at most 500 ms; every 5 minutes from one EU and one US location; alert after two consecutive failures | `GET /__probe`: the entry D1 batch for a UserID without rows, no events | Arthur's decision, 2026-11-03 |
| NFR-6 | Allowed difference between k6 and the dashboard for the same window | 20% | | Arthur's decision, 2026-11-03 |
| NFR-6 | Latency data points in Analytics Engine | about 18M a month, one per request; $0 today, $2.00 a month if billing starts | 18M − 10M included = 8M × $0.25 | platform limits, Analytics Engine |
| NFR-6 | Probe traffic | about 580 Worker requests a day, no events | 2 locations × 288 runs | derived here |
| NFR-3 | Freshness in production, normal operation | up to 30 s consumer wait, plus up to 5 minutes to the next loader run, plus the load job; alert above 15 minutes | | ADR 0005, ADR 0006 |
| NFR-3 | Freshness in the MVP | about a minute | up to 30 s consumer wait plus a loader run every minute | ADR 0005 |
| MVP-5 | MVP events database at the design load, 560 bytes a row | 10 GB (Paid) full in about a month; 500 MB (Free) in under two days | 18M × 560 B = about 10 GB a month; 600,000 × 560 B = about 336 MB a day | "What these numbers mean for the design" below |
| MVP-5 | Same, at 1 KB a row | 10 GB in about 17 days; 500 MB in under a day | 600,000 × 1 KB = 600 MB a day; 10 GB / 600 MB = 16.7 | A-1, 1 KB per event as in ADR 0005 |
| MVP-5 | MVP events database at the Free ceiling of about 3,300 events a day | 500 MB lasts about 5 to 9 months | 3,300 × 1 KB = 3.3 MB a day, 150 days; 3,300 × 560 B = 1.85 MB a day, 270 days | derived here |
| MVP-5 | Size alert on both D1 databases (`d1_events_size`, `d1_facts_size`) | 7 GB on Paid, 350 MB on Free | 70% of 10 GB and of 500 MB | ADR 0003 migration trigger |
| NFR-6 | Selection p95 alert (`selection_p95`) | above 300 ms over 15 minutes | same as the target | ADR 0003 migration trigger two |
| NFR-6 | D1 overload alert (`d1_overload_errors`) | more than 10 in an hour | a starting value | ADR 0003 migration trigger three; Arthur's decision, 2026-11-03 |
| NFR-6 | Worker error alert (`worker_5xx_rate`) | above 1% of requests over 5 minutes | | Arthur's decision, 2026-11-03 |
| NFR-6 | Alert SQL queries against the Analytics Engine read limits | 864 queries a day, within the 10,000 a day of the Free plan | 3 queries × 12 runs an hour × 24 hours | Part 2 stage 6, decision 16 |
| PB-3 | Alert `postbacks_without_conversions` | at least 5 postback requests in 15 minutes from one partner and none accepted | the request count is kept per partner and minute in `postback_counts` | Part 2 stage 6, part2-mvp-stages.md |
| DES-6 | Observed EPU window and threshold | trailing 30 days by click date; observed EPU replaces the constant when the window has at least 500 users (a starting value) | | Arthur's decision, 2026-11-03 |
| NFR-1 | R2 operations at the design load | about 215,000 Class A and 180,000 Class B a month, within the free 1M and 10M: $0 | 18M / 100 events per file = 180,000 writes; 8,640 loader runs × about 4 lists and writes = about 35,000; each file read once | platform limits, R2 |
| NFR-1 | R2 storage at the design load | about 18 GB-month, $0.12 a month | `loaded/` kept 30 days × 0.6 GB a day at 1 KB per event; (18 − 10 free) × $0.015 | platform limits, R2; ADR 0006 |
| NFR-1 | BigQuery storage at the design load | about 18 GiB more each month; $0.18 in month 1, about $4.74 in month 12 | (18 − 10 free) × $0.023; (216 − 10) × $0.023 | BigQuery limits below |
| NFR-1 | Monthly total at the design load | $28.90 in month 1 ($30.90 if Analytics Engine is billed); about $33.50 in month 12 ($35.50) | $28.60 below + R2 $0.12 + BigQuery $0.18; BigQuery storage adds about $0.41 a month | derived here |

## Measured in Part 2 stage 9

Measured on 2026-11-06 against the deployed Worker (main 16d26e9) with k6 v2.3.0 from the author's laptop in Poland. Every request was served by the WAW colo. Server-side figures come from the Analytics Engine SQL API, weighted by `_sample_interval`. The run and the method are in the NFR-2 and NFR-6 cards of `docs/testing/acceptance-checks.md`.

| ID | Figure | Measured | Target | Verdict |
|---|---|---|---|---|
| NFR-2 | Spec peak, 200 events/s for 5 minutes | 59,990 requests, all `202`, 0 failed, 0 `429` | under 1% failed | met |
| NFR-2 | Stored against accepted | 59,990 rows for 1,000 users, equal to the `202` count | equal | met |
| NFR-2 | Drain after the peak | queue and `pending/` empty 241 s after k6 stopped | | measured |
| NFR-6 | Analytics Engine count against k6 | 59,990 and 59,990 | within 20% | met |
| NFR-6 | p95 of `POST /api/events`, server side, at peak | 74 ms (p50 61 ms; 72 to 75 ms per minute) | at most 50 ms | not met, R-24 |
| NFR-6 | p95 of `POST /api/events`, k6 from the laptop | 97.7 ms (p50 81.7 ms) | not a target | measured |
| NFR-6 | Facts read, `GET /__probe`, server side, 601 requests at 10/s | p50 24 ms, p95 31 ms, p99 36 ms | 300 ms for the selection endpoints | met |
| R-15 | D1 overload errors during the peak | 0 | 0 | met |

The 74 ms is the Queue send. Cloudflare gives about 60 ms as the median latency of a Queue write, which returns after the message is persisted ([How we built Cloudflare Queues](https://blog.cloudflare.com/how-we-built-cloudflare-queues/), 2024-10-24), and publishes no p95. The 50 ms target assumed a faster send and stays as it was set; the miss is recorded, not hidden by a new number.

## Still to be set

These are required by the spec but have no number yet. The stage of `docs/plans/part1-design-document.md` that sets each one is named.

| ID | Figure | Set in |
|---|---|---|
| Q-16 | Retention of email and raw events | company answer |
| Q-17 | Acceptable monthly spend | company answer |

## Platform limits and prices

Checked on 2026-11-01. Prices are in USD. "Paid" is the Workers Paid plan at $5/month plus usage; its included amounts are per month, Free limits are per day unless stated. The same Free and Paid figures also appear on the Workers plans page of the Cloudflare dashboard, which was read on the same date; it gives Paid overage prices but not the included amounts. BigQuery ingestion options are compared in `research-bigquery-ingestion.md`; the numbers they rely on are here.

### Cloudflare

| Service | Limit or price | Free | Paid | Source |
|---|---|---|---|---|
| Workers | Requests | 100,000/day | 10M included, then $0.30/M | https://developers.cloudflare.com/workers/platform/pricing/ |
| Workers | CPU time | 10 ms per request | 30M CPU ms included, then $0.02/M CPU ms; up to 5 min per request (default 30 s) | https://developers.cloudflare.com/workers/platform/pricing/ |
| Workers | Subrequests per request | 50 | 10,000 by default, configurable up to 10M (checked 2026-11-02) | https://developers.cloudflare.com/workers/platform/limits/ |
| Workers | Memory per isolate; cron triggers per account; variable or secret size | 128 MB; 5; 5 KB | 128 MB; 250; 5 KB | https://developers.cloudflare.com/workers/platform/limits/ |
| Workers | Static asset requests | free, unlimited | free, unlimited | https://developers.cloudflare.com/workers/platform/pricing/ |
| D1 | Rows read | 5M/day | 25 billion included, then $0.001/M | https://developers.cloudflare.com/d1/platform/pricing/ |
| D1 | Rows written | 100,000/day | 50M included, then $1.00/M | https://developers.cloudflare.com/d1/platform/pricing/ |
| D1 | Storage | 5 GB total | 5 GB included, then $0.75/GB-month | https://developers.cloudflare.com/d1/platform/pricing/ |
| D1 | Max size of one database | 500 MB | 10 GB | https://developers.cloudflare.com/d1/platform/limits/ |
| D1 | Queries per Worker invocation; bound parameters per query | 50; 100 | 1,000; 100 | https://developers.cloudflare.com/d1/platform/limits/ |
| D1 | Throughput | one database is single-threaded: at 1 ms per query at most 1,000 queries/s, at 100 ms at most 10; `batch()` recommended | same | https://developers.cloudflare.com/d1/platform/limits/ |
| D1 | Time Travel (point-in-time restore) | 7 days | 30 days | https://developers.cloudflare.com/d1/platform/limits/ |
| Durable Objects | Requests | 100,000/day | 1M included, then $0.15/M | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| Durable Objects | Duration | 13,000 GB-s/day | 400,000 GB-s included, then $12.50/M GB-s | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| Durable Objects | SQLite rows read / written | 5M / 100,000 per day | 25 billion / 50M included, then $0.001/M / $1.00/M | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| Durable Objects | SQLite stored data | 5 GB total per account | 5 GB-month included, then $0.20/GB-month; 10 GB per object | https://developers.cloudflare.com/durable-objects/platform/pricing/, https://developers.cloudflare.com/durable-objects/platform/limits/ |
| Durable Objects | Throughput of one object | soft limit 1,000 requests/s, then "overloaded" errors | same | https://developers.cloudflare.com/durable-objects/platform/limits/ |
| Durable Objects | Free-plan availability | SQLite-backed objects only | all | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| KV | Reads | 100,000/day | 10M included, then $0.50/M | https://developers.cloudflare.com/kv/platform/pricing/ |
| KV | Writes, deletes, lists (each) | 1,000/day | 1M included, then $5.00/M | https://developers.cloudflare.com/kv/platform/pricing/ |
| KV | Stored data | 1 GB | 1 GB included, then $0.50/GB-month | https://developers.cloudflare.com/kv/platform/pricing/ |
| KV | Writes to the same key | 1 per second | 1 per second | https://developers.cloudflare.com/kv/platform/limits/ |
| KV | Visibility of a write in other locations | up to 60 seconds or more | same | https://developers.cloudflare.com/kv/concepts/how-kv-works/ |
| Queues | Operations (one per 64 KB written, read or deleted; a delivered message is usually 3) | 10,000/day | 1M included, then $0.40/M | https://developers.cloudflare.com/queues/platform/pricing/ |
| Queues | Message retention | 24 hours, fixed | 4 days default, up to 14 days | https://developers.cloudflare.com/queues/platform/pricing/ |
| Queues | Throughput per queue | 5,000 messages/s | 5,000 messages/s | https://developers.cloudflare.com/queues/platform/limits/ |
| Queues | Message size; consumer batch; `sendBatch` per call | 128 KB; up to 100 messages, wait up to 60 s; 100 messages or 256 KB | same | https://developers.cloudflare.com/queues/platform/limits/ |
| Queues | Retries; consumer concurrency | up to 100; up to 250 | same | https://developers.cloudflare.com/queues/platform/limits/ |
| Queues | Backlog per queue; behaviour when full | 25 GB; `send()` fails with "Storage Limit Exceeded" (checked 2026-11-02) | same | https://developers.cloudflare.com/queues/platform/limits/ |
| R2 (Standard) | Storage | 10 GB-month/month | $0.015/GB-month | https://developers.cloudflare.com/r2/pricing/ |
| R2 (Standard) | Class A operations (writes, lists) | 1M/month | $4.50/M | https://developers.cloudflare.com/r2/pricing/ |
| R2 (Standard) | Class B operations (reads) | 10M/month | $0.36/M | https://developers.cloudflare.com/r2/pricing/ |
| R2 | Egress; deletes | free; free | free; free | https://developers.cloudflare.com/r2/pricing/ |
| Analytics Engine | Data points written | 100,000/day | 10M included, then $0.25/M | https://developers.cloudflare.com/analytics/analytics-engine/pricing/ |
| Analytics Engine | Read queries | 10,000/day | 1M included, then $1.00/M | https://developers.cloudflare.com/analytics/analytics-engine/pricing/ |
| Analytics Engine | Billing status | not billed at the moment, per the pricing page | same | https://developers.cloudflare.com/analytics/analytics-engine/pricing/ |
| Analytics Engine | Retention; data points per Worker invocation; fields per data point | 3 months; 250; 20 blobs, 20 doubles, 1 index | same | https://developers.cloudflare.com/analytics/analytics-engine/limits/ |
| Pipelines | Price | the pricing page lists Workers Paid only | ingress free; SQL transforms 50 GB included, then $0.04/GB; sink to R2 50 GB included, then $0.03/GB JSON or $0.06/GB Parquet | https://developers.cloudflare.com/pipelines/platform/pricing/ |
| Pipelines | Limits | | 20 streams, 20 pipelines, 20 sinks per account; 5 MB per ingestion request; 1 GB/s per stream; R2 sink rolls a file every 300 s by default, at least every 10 s; JSON or Parquet; exactly-once delivery to R2 per the docs; renamed Basin Pipelines and generally available (checked 2026-11-02) | https://developers.cloudflare.com/pipelines/platform/limits/, https://developers.cloudflare.com/pipelines/sinks/available-sinks/r2/ |

### BigQuery

The pricing page shows its default region (Iowa, us-central1). Prices in the EU multi-region were not checked; they matter once Q-2 and Q-18 are answered.

| Item | Value | Source |
|---|---|---|
| Storage Write API (gRPC) | $0.025/GiB, first 2 TiB per month free | https://cloud.google.com/bigquery/pricing |
| Storage Write API (REST), also called streaming inserts | $0.01 per 200 MiB, each row billed at a 1 KB minimum | https://cloud.google.com/bigquery/pricing |
| Batch load | free when using the shared slot pool | https://cloud.google.com/bigquery/pricing |
| Active logical storage | $0.000031507/GiB-hour (about $0.023/GiB-month at 730 hours), first 10 GiB free | https://cloud.google.com/bigquery/pricing |
| On-demand queries | $6.25/TiB scanned, first 1 TiB per month free | https://cloud.google.com/bigquery/pricing |
| Load jobs | 1,500 per table per day, failed jobs included; 100,000 per project per day | https://docs.cloud.google.com/bigquery/quotas |
| Streaming (REST) throughput | 1 GB/s per project in the us and eu multi-regions, 300 MB/s elsewhere | https://docs.cloud.google.com/bigquery/quotas |
| Streaming (REST) rows per request | up to 50,000, 500 recommended | https://docs.cloud.google.com/bigquery/quotas |
| Storage Write API (gRPC) request size | 20 MB per AppendRows request | https://docs.cloud.google.com/bigquery/quotas |

### What these numbers mean for the design

The design load is 18,000,000 / 30 = 600,000 events a day (A-1: 9 events per visit; the spec's 6 give 400,000), so the Free plan does not carry it. Workers allow 100,000 requests a day, D1 and Durable Objects 100,000 rows written a day, Queues 10,000 operations a day (about 3,300 messages), Analytics Engine 100,000 data points a day. The design assumes Workers Paid; the budget is Q-17.

Limits that can break the design at this load:

- One D1 database is single-threaded. At 200 events/s each event's write has to average under 5 ms including overhead, or events have to be written in batches.
- One D1 database holds at most 10 GB. 10 GB / 18M events = about 560 bytes per event per month, so raw events kept in D1 fill one database within months unless they are moved out or the database is split. This bounds MVP-5.
- A single Durable Object takes about 1,000 requests/s. One object per user is far below that; one global object would be the bottleneck at 200 events/s only with heavy per-event work.
- KV writes become visible elsewhere after up to 60 seconds. A-4 needs Leads and offer status visible to selection within seconds, so KV does not fit rule facts.
- Queues keep messages for at most 14 days on Paid and 24 hours on Free. That is the ceiling for the buffer in NFR-5 if Queues is the buffer; with retries and a dead letter queue (ADR 0005), it is the ceiling for the dead letter queue.
- BigQuery allows 1,500 load jobs per table per day, one every 58 seconds at most. A load every 5 minutes is 288 jobs.

Rough monthly cost on Paid, BigQuery excluded. The 18M columns are the design load; the 12M columns are the spec's figure, kept for comparison. The browser sends one event per request (ADR 0005), so the design cost is the "18M, no batching" column, $28.60; the batched columns show what batching in the browser would save.

| Item | 12M, no batching | 12M, 10 events per request and per message | 18M, no batching | 18M, 10 events per request and per message |
|---|---|---|---|---|
| Workers Paid base | $5.00 | $5.00 | $5.00 | $5.00 |
| Workers requests | 12M − 10M included = 2M × $0.30 = $0.60 | 1.2M, within included: $0 | 18M − 10M = 8M × $0.30 = $2.40 | 1.8M, within included: $0 |
| Queues | 12M × 3 = 36M − 1M included = 35M × $0.40 = $14.00 | 3.6M − 1M = 2.6M × $0.40 = $1.04 | 18M × 3 = 54M − 1M = 53M × $0.40 = $21.20 | 5.4M − 1M = 4.4M × $0.40 = $1.76 |
| D1 rows written | 12M, within 50M included: $0 | $0 | 18M, within 50M included: $0 | $0 |
| Total | $19.60 | $6.04 | $28.60 | $6.76 |

"No batching" means one request, one message and one row per event. Unbatched at 18M, the 30M included CPU ms cover an average of 1.7 ms per request (30M / 18M). Routing every event through a Durable Object as well would add 18M − 1M = 17M × $0.15 = $2.55. BigQuery ingestion at 18M costs at most about $0.90 a month (REST streaming at the 1 KB row minimum, 18 GB); the gRPC API and batch loads stay within their free tiers.

### Size of the rule facts in D1

ADR 0003 keeps the facts the rules need (users, current answers, clicks, postbacks, the offer catalog) in one D1 database and keeps raw events out of it. One database holds at most 10 GB. Estimate made on 2026-11-02:

- About 1 KB per user for the user row, current answers, clicks and indexes. This is an assumption; the MVP measures the real figure with the database size divided by the user count.
- 1,000,000 users a month (NFR-1). If every user is new and nothing is deleted, that is about 1 GB a month and the database is full in about 10 months.
- Since stage 3 the `users` row is created only at quiz completion (`docs/design/data-model.md`), so 1,000,000 users a month is an upper bound; the share of users who complete the quiz is not known yet. The cleanup and the 7 GB trigger below are unchanged.
- Cleanup: a user with no Lead who has not returned for 90 days is deleted from D1. Their events stay in R2 and BigQuery. The rules lose nothing: a returning user without a Lead sees an empty quiz anyway (Q-1, ADR 0004).
- Users with a Lead are kept: 5% to 20% of users (A-7), so 50,000 to 200,000 a month, which is 0.05 to 0.2 GB a month.

| | Lead rate 5% | Lead rate 20% |
|---|---|---|
| Users without a Lead, last 90 days | about 3 GB | about 3 GB |
| Lead users added per month | about 0.05 GB | about 0.2 GB |
| Size after 12 months | about 3.6 GB | about 5.4 GB |
| Size after 24 months | about 4.2 GB | about 7.8 GB |
| Months until the 7 GB migration trigger (70% of 10 GB) | (7 − 3) / 0.05 = about 80 | (7 − 3) / 0.2 = about 20 |

The 90-day window counts all users as new, so it is an upper bound. Conclusion: with the cleanup, one D1 database carries the rule facts for at least about 20 months at the spec's load, and for years at a low Lead rate. The 7 GB trigger and the migration path to Postgres are in ADR 0003. If traffic grows several times over, the trigger comes sooner by the same factor.
