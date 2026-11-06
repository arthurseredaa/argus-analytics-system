# 0005. Ingest events through a Queue into files in R2

- Status: proposed
- Date: 2026-11-02
- Relates to: NFR-2, NFR-3, NFR-4, NFR-5, MVP-4, MVP-5, AN-6, A-1, A-3, R-3, R-8, R-15, R-16, R-17, P-1, P-7, P-8

## Context

Every visit sends about nine events (A-1): 18M a month, 6.9 a second on average and 200 a second at the 5-minute peak (`nfr.md`). They feed analytics only; the facts the rules read go to D1 synchronously (ADR 0003, P-1). The spec asks that a BigQuery outage does not block the quiz (NFR-4), that we define guarantees, buffer limits and behaviour during a long outage (NFR-5), and that analytics are fresh within 15 minutes (NFR-3).

In the MVP there is no BigQuery, and the report runs on Cloudflare storage (MVP-4). The report counts users who started the quiz, which is a `step_viewed` event, so the MVP needs events in a store it can query (AN-6).

This ADR covers the path from the browser to files in R2 and the MVP stand-in for BigQuery. Loading into BigQuery is ADR 0006.

## Constraints

From the Queues limits page, checked 2026-11-02: messages up to 128 KB; consumer batches up to 100 messages with a wait of up to 60 seconds; up to 100 retries; retention configurable up to 14 days on Paid; 25 GB of backlog per queue, after which `send()` fails with "Storage Limit Exceeded"; 5,000 messages a second per queue.

- One D1 database is single-threaded and holds 10 GB; the facts database must not be slowed down by event writes (ADR 0003).
- Cron triggers run at most once a minute.
- An event is assumed to be about 1 KB, the same assumption as the BigQuery row minimum in `nfr.md`.
- The lean-service principle: every component needs a requirement behind it.

## Options considered

1. The Worker writes each event to D1 during the request, and a cron job ships batches to BigQuery. Where it breaks: every event request waits for a write to a database in one region, which adds a network round trip for distant users; the events share a 10 GB limit and, if in the facts database, its single writer; when the cron cannot ship, D1 is the only buffer and it fills.
2. The Worker sends events to a Queue; a consumer writes batches as files to R2. Where it breaks: more of our own code (consumer, retries, dead letter queue, redrive script); while the consumer or R2 is down, the Queue retries for hours, not days, and after that the messages wait in the dead letter queue (at most 14 days or 25 GB) until a person sends them back.
3. The Worker sends events to Pipelines (now Basin Pipelines, generally available), which writes files to R2 itself: every 300 seconds by default, at least every 10 seconds, with exactly-once delivery to R2 per its documentation. No consumer to write. Where it breaks: the documentation does not say what happens to events while Pipelines or R2 is unavailable, so NFR-5 cannot be answered with numbers; it writes its own time-partitioned paths, so the `pending/` and `loaded/` layout becomes a cursor we keep elsewhere; it cannot write to D1, so the MVP report would need a second path.
4. A Durable Object per shard buffers events in its SQLite storage and flushes files to R2. Where it breaks: we would write and operate by hand what Queues and Pipelines already provide: batching, retries, backlog limits, metrics.

For the MVP report:

1. The report reads the R2 files directly and counts in the Worker. Where it breaks: every report request reads every file (R-17), and the loading step that production depends on is never exercised.
2. The consumer also writes every batch to a D1 table. Where it breaks: the MVP path differs from production in the consumer, which is the part we most want to test as it will run.
3. The cron job that loads BigQuery in production loads the same files into a D1 table in the MVP. Where it breaks: the table is a stand-in, not BigQuery, so BigQuery-specific behaviour (load job quotas, schema handling) is not tested until ADR 0006 is implemented.

## Decision

Option 2 for ingestion, and option 3 for the MVP report.

### Path of an event

1. The browser sends exactly one event per request to `POST /api/events`, at every product step, with its EventID created in the browser (ADR 0002). Unsent events are kept in the browser's storage and resent one by one with the same EventIDs.
2. The Worker checks the envelope (below), takes `user_id` from the cookie, adds the server receive time, and sends the event to the Queue as one message with content type `json`, so the redrive script below can read it. It answers `202`.
3. If the Queue rejects the message (backlog full or unavailable), the Worker writes the event as a one-event file straight to R2 `pending/`. If that fails too, it answers `503` with `Retry-After`, and the browser keeps the event and tries later. A long Queue outage therefore leaves many small files; the loader limits how many it takes per run (ADR 0006).
4. The consumer receives up to 100 messages, waiting at most 30 seconds, and writes them as one newline-delimited JSON file to R2 `pending/`. Then it acknowledges the batch. If the write fails, the batch is retried with a growing delay set through `retry({ delaySeconds })`: 1, 2, 4, 8, 16 and 32 minutes, then 60 minutes for each later retry. After 10 retries, about 5 hours, the messages go to the dead letter queue and an alert fires. An R2 or consumer failure shorter than about 5 hours recovers with no one involved.
5. The loader (cron) takes files from `pending/`, loads them, and moves them to `loaded/` (ADR 0006).

One event per request is Arthur's decision. The browser sends at every product step, so an event reaches the server as soon as it happens and is not lost when the tab closes before a batch would have gone out, and the client has no batching logic to get wrong. The price is about four times the Queue and request cost of batching in the browser (`nfr.md`, cost table). The Worker cannot batch on its own: its memory lasts one request, and the next request may run in another instance. Partners already send one postback per request (ADR 0007).

### Dead letter queue

The dead letter queue has no consumer attached, so nothing drains it into an R2 that is still failing and no retry limit deletes its messages. It keeps them for 14 days, with its own 25 GB backlog. When the cause is fixed, an operator runs a redrive script that reads the dead letter queue through the HTTP pull API and sends the messages back to the main queue, where the consumer writes them as usual; their EventIDs are unchanged, so nothing is counted twice. Pull consumers cannot decode the `v8` content type, which is why step 2 sends `json`. Messages not redriven within 14 days are deleted.

The consumer does not remove duplicates. A file can hold the same event twice, from a browser resend or a Queue redelivery, and the load target removes them by EventID (R-3, R-8).

### Event envelope

Every event carries the same fields: `event_id`, `schema_version`, `type`, `client_time`, `received_at` (set by the Worker), `user_id` (set by the Worker from the cookie), `visit_id`, `seq` (position in the visit), `prelander_id`, `payload`. The Worker rejects an event without a well-formed `event_id` or with a body over the size limit. An event with a `schema_version` the Worker or the loader does not know is kept as it is and passed on, never dropped, so a new client release cannot lose data before the server catches up.

### MVP: D1 as the stand-in for BigQuery

- In the MVP the loader runs every minute and inserts the events from `pending/` into the `events` table of a separate D1 database, with `event_id` as the primary key and `INSERT ... ON CONFLICT (event_id) DO NOTHING`, in chunks that fit D1's limit of 100 bound parameters per query. Then it moves the files to `loaded/`.
- The database is separate from the facts database so its writes do not queue in front of offer selection (ADR 0003). It is marked as MVP-only in the code and the README.
- The report reads funnel steps from this table and Leads and Purchases from the postbacks in the facts database, so a test postback shows up at once and a funnel event within about a minute.
- In production the loader runs every 5 minutes and loads into BigQuery instead; the D1 events database is removed. Only the load target changes.

### Buffer limits

| What is down | What holds the events | At 6.9 events/s | At 200 events/s, sustained |
|---|---|---|---|
| BigQuery or the loader | files in R2 `pending/` | no limit except storage cost and Q-16 | no limit except storage cost and Q-16 |
| Consumer or R2 | the Queue with automatic retries for about 5 hours, then the dead letter queue: 14 days or 25 GB, whichever comes first, redriven by hand | 14 days, about 8.4M events | about 35 hours, about 25M events |
| Queue | Worker writes one file per event straight to R2 `pending/` | as long as R2 is up; the loader drains about 30 events/s (`nfr.md`) | as long as R2 is up; the backlog drains after the outage |
| Queue and R2 | the browser, then lost | until the browser's own limit | until the browser's own limit |

The spec's peak, 60,000 events in 5 minutes, is 0.2% of the Queue backlog. Events are lost only when the Queue and R2 are both unavailable for longer than a browser keeps unsent events, and those losses are counted when the browser reports them.

## Consequences

- Easier: the quiz never waits for BigQuery or for the loader; the event request does one Queue send.
- Easier: the files in R2 are the outage buffer and the backfill source at the same time.
- Easier: the MVP runs the whole production path except the last hop.
- Harder: three moving parts to monitor (Queue, consumer, loader), and a redrive script to run by hand within 14 days when the dead letter queue fills.
- Harder: one event per request costs about four times as much as batching in the browser (`nfr.md`), and a Queue outage leaves one file per event for the loader.
- Watch: Queue backlog in bytes and the age of its oldest message, messages in the dead letter queue (alert on any), the age of the oldest file in `pending/` (alert at 1 hour, ADR 0006), and the count of events written straight to R2 (each one means the Queue refused a message).
- Later: when the report lives in BigQuery and the D1 events database is gone, Pipelines can replace the consumer if its failure behaviour is documented by then.

## Verification

- `NFR-4 quiz works while the Queue is unavailable`: with the Queue binding failing, answers and selection still work and events land in R2 `pending/` through the fallback.
- `R-16 events written while the loader is stopped are loaded once after it restarts` (P-8): stop the loader, run the demo scenario, check the files in `pending/`, start the loader, compare the counts with the events sent.
- `R-3 R-8 a resent batch is stored once in events`: the same events sent twice give one row per EventID.
- `consumer write failure is retried with growing delays and goes to the dead letter queue after 10 retries`.
- `redriven dead letter messages are loaded once`: fail R2 writes until messages reach the dead letter queue, restore R2, run the redrive script, compare the loaded events with those sent.
- `a request with more than one event is rejected`.
- `unknown schema_version is stored and not dropped`.
- Load test (P-7): 200 events/s for 5 minutes against staging, then 2x and 5x; no `5xx` from `/api/events`, and the backlog drains within 5 minutes after the load ends.
- The MVP report counts match a fixed demo script (AN-6) after one loader run.

## References

- Queues limits, checked 2026-11-02: https://developers.cloudflare.com/queues/platform/limits/ (`delaySeconds` up to 24 hours, up to 100 retries).
- Queues batching and retries, dead letter queues and pull consumers, checked 2026-11-02: https://developers.cloudflare.com/queues/configuration/batching-retries/, https://developers.cloudflare.com/queues/configuration/dead-letter-queues/, https://developers.cloudflare.com/queues/configuration/pull-consumers/
- Pipelines overview and R2 sink, checked 2026-11-02: https://developers.cloudflare.com/pipelines/ and https://developers.cloudflare.com/pipelines/sinks/available-sinks/r2/
- `docs/requirements/nfr.md`: load figures, platform limits, cost table.
- `docs/requirements/research-bigquery-ingestion.md`.
- ADR 0002 (EventID), ADR 0003 (facts in D1), ADR 0006 (loading into BigQuery).

## Outcome

2026-11-06, Part 2 stage 5. The path is built as decided, with D1 as the MVP stand-in for BigQuery. The Queue consumer in `src/events/consumer.ts` writes each batch as one NDJSON file to R2 `pending/` and acknowledges it. A failed write retries after 1, 2, 4, 8, 16 and 32 minutes, then hourly, and after 10 retries the batch goes to `events-dlq`. When the Queue refuses an event, `src/events/producer.ts` writes a one-event file to `pending/`. `/api/events` and postbacks answer `503` only when the Queue and R2 both fail. Quiz completion and `/go` send their events in the background and never answer `503`. The dead letter queue redrive script is still design-only.

The loader-paused drill ran against the deployed Worker on 2026-11-06, from 00:46 UTC:

| Measure | Result |
|---|---|
| Demo runs in 10 minutes with the loader paused | 125, every one passed |
| `pending/` files at the start and at the end | 0 and 20, about one per 30-second Queue batch |
| Oldest pending file at the end | 568 s |
| Demo answers while paused | the same `ok` lines as a normal run, funnel cells 0 |
| Time to drain `pending/` after the loader resumed | 61 s |
| Rows in `events`, total and distinct `event_id` | 1,502 and 1,502, equal to 12 × 125 + 2 |

The cron trigger took about 10 minutes after the deploy before its first run on Cloudflare. A demo run in that window fails its report checks while the events wait in `pending/`.
