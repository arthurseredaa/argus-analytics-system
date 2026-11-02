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
| A-4 | Freshness for rule facts (Leads, offer status) | seconds, not minutes | the Lead return rule runs on the live path | `open-questions.md` A-4 |

## Still to be set

These are required by the spec but have no number yet. The stage of `docs/plans/part1-design-document.md` that sets each one is named.

| ID | Figure | Set in |
|---|---|---|
| NFR-5 | Buffer capacity and hours of survival at 6.9 and at 200 events/s during a BigQuery outage | stage 2, ADR 0005 |
| NFR-6 | Target p95 latency for the selection endpoint and for event ingestion, with the measurement method | stage 4 |
| MVP-5 | Storage size at which the chosen store approaches its limit, and the metric that signals it | stage 4 |
| Q-16 | Retention of email and raw events | company answer |
| Q-17 | Acceptable monthly spend | company answer |

## Platform limits and prices

Checked on 2026-11-01. Prices are in USD. "Paid" is the Workers Paid plan at $5/month plus usage; its included amounts are per month, Free limits are per day unless stated. The same Free and Paid figures also appear on the Workers plans page of the Cloudflare dashboard, which was read on the same date; it gives Paid overage prices but not the included amounts. BigQuery ingestion options are compared in `research-bigquery-ingestion.md`; the numbers they rely on are here.

### Cloudflare

| Service | Limit or price | Free | Paid | Source |
|---|---|---|---|---|
| Workers | Requests | 100,000/day | 10M included, then $0.30/M | https://developers.cloudflare.com/workers/platform/pricing/ |
| Workers | CPU time | 10 ms per request | 30M CPU ms included, then $0.02/M CPU ms; up to 5 min per request (default 30 s) | https://developers.cloudflare.com/workers/platform/pricing/ |
| Workers | Subrequests per request | 50 | 10,000 | https://developers.cloudflare.com/workers/platform/limits/ |
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
| R2 (Standard) | Storage | 10 GB-month/month | $0.015/GB-month | https://developers.cloudflare.com/r2/pricing/ |
| R2 (Standard) | Class A operations (writes, lists) | 1M/month | $4.50/M | https://developers.cloudflare.com/r2/pricing/ |
| R2 (Standard) | Class B operations (reads) | 10M/month | $0.36/M | https://developers.cloudflare.com/r2/pricing/ |
| R2 | Egress; deletes | free; free | free; free | https://developers.cloudflare.com/r2/pricing/ |
| Analytics Engine | Data points written | 100,000/day | 10M included, then $0.25/M | https://developers.cloudflare.com/analytics/analytics-engine/pricing/ |
| Analytics Engine | Read queries | 10,000/day | 1M included, then $1.00/M | https://developers.cloudflare.com/analytics/analytics-engine/pricing/ |
| Analytics Engine | Billing status | not billed at the moment, per the pricing page | same | https://developers.cloudflare.com/analytics/analytics-engine/pricing/ |
| Analytics Engine | Retention; data points per Worker invocation; fields per data point | 3 months; 250; 20 blobs, 20 doubles, 1 index | same | https://developers.cloudflare.com/analytics/analytics-engine/limits/ |
| Pipelines | Price | the pricing page lists Workers Paid only | ingress free; SQL transforms 50 GB included, then $0.04/GB; sink to R2 50 GB included, then $0.03/GB JSON or $0.06/GB Parquet | https://developers.cloudflare.com/pipelines/platform/pricing/ |
| Pipelines | Limits | | 20 streams, 20 pipelines, 20 sinks per account; 5 MB per ingestion request; 1 GB/s per stream; delivery interval to R2 not stated | https://developers.cloudflare.com/pipelines/platform/limits/ |

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
- Queues keep messages for at most 14 days on Paid and 24 hours on Free. That is the ceiling for the buffer in NFR-5 if Queues is the buffer.
- BigQuery allows 1,500 load jobs per table per day, one every 58 seconds at most. A load every 5 minutes is 288 jobs.

Rough monthly cost on Paid, BigQuery excluded. The 18M columns are the design load; the 12M columns are the spec's figure, kept for comparison.

| Item | 12M, no batching | 12M, 10 events per request and per message | 18M, no batching | 18M, 10 events per request and per message |
|---|---|---|---|---|
| Workers Paid base | $5.00 | $5.00 | $5.00 | $5.00 |
| Workers requests | 12M − 10M included = 2M × $0.30 = $0.60 | 1.2M, within included: $0 | 18M − 10M = 8M × $0.30 = $2.40 | 1.8M, within included: $0 |
| Queues | 12M × 3 = 36M − 1M included = 35M × $0.40 = $14.00 | 3.6M − 1M = 2.6M × $0.40 = $1.04 | 18M × 3 = 54M − 1M = 53M × $0.40 = $21.20 | 5.4M − 1M = 4.4M × $0.40 = $1.76 |
| D1 rows written | 12M, within 50M included: $0 | $0 | 18M, within 50M included: $0 | $0 |
| Total | $19.60 | $6.04 | $28.60 | $6.76 |

"No batching" means one request, one message and one row per event. Unbatched at 18M, the 30M included CPU ms cover an average of 1.7 ms per request (30M / 18M). Routing every event through a Durable Object as well would add 18M − 1M = 17M × $0.15 = $2.55. BigQuery ingestion at 18M costs at most about $0.90 a month (REST streaming at the 1 KB row minimum, 18 GB); the gRPC API and batch loads stay within their free tiers.
