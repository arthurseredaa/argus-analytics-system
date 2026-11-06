# 0006. Load event files from R2 into BigQuery with load jobs every 5 minutes

- Status: proposed
- Date: 2026-11-02
- Relates to: NFR-3, NFR-4, NFR-5, R-8, R-16, R-17, Q-2, Q-16, Q-18, P-8, MVP-4

## Context

ADR 0005 puts every event into newline-delimited JSON files in R2 `pending/`. This ADR decides how those files reach BigQuery: analytics fresh within 15 minutes (NFR-3), nothing lost or counted twice during and after an outage (NFR-5, R-8, R-16), and a table that keeps working when events gain new fields. The options were compared in `research-bigquery-ingestion.md`; two points left open there were checked on 2026-11-02 (see Constraints).

In the MVP there is no BigQuery (MVP-4); the same loader writes to a D1 stand-in (ADR 0005).

## Constraints

- Load jobs: 1,500 per table per day, failed jobs included; 100,000 per project per day; up to 15 TB and 10 million files per job; a newline-delimited JSON row up to 100 MB (quotas page, checked 2026-11-02).
- Creating a job whose ID already exists fails with the `duplicate` error, HTTP 409: "This error returns when trying to create a job, dataset, or table that already exists" (error messages page, checked 2026-11-02). A retry with the same job ID cannot load the data twice.
- The `jobs.insert` upload has no maximum size in the API description and offers a resumable protocol for large uploads (discovery document, checked 2026-11-02).
- BigQuery does not enforce primary keys or unique constraints: "Key constraints aren't enforced in BigQuery", and queries over a table that violates a declared key "might return incorrect results" (checked 2026-11-02).
- A Worker has 128 MB of memory, so the loader cannot hold an arbitrarily large upload.
- Google's client libraries do not run in Workers; the Worker signs a JWT with a service account key and exchanges it for an access token (`research-bigquery-ingestion.md`). A Worker secret is at most 5 KB.
- Dataset location follows Q-2 (default EU); EU prices are not checked yet (Q-18).

## Options considered

How the data gets in:

1. Load jobs from the files in R2, started by a cron Worker. Free with the shared slot pool; a file set loads whole or not at all; the files double as the outage buffer and the backfill source. Where it breaks: freshness is minutes, not seconds; every retry counts against the 1,500 jobs per table per day; the loader holds the upload in memory.
2. REST streaming (`tabledata.insertAll`) from the consumer. Rows are queryable in seconds, about $0.90 a month at 18M events. Where it breaks: deduplication by `insertId` is best effort and Google does not recommend relying on it; a request can be accepted in part, so retries need per-row bookkeeping; during an outage the rows have to wait somewhere else, and there is no file to reload from after a bad transform.
3. Storage Write API over gRPC with committed streams and offsets. The only exactly-once write path. Where it breaks: whether a Worker can hold a bidirectional gRPC stream is unverified, so it probably needs a service in Google Cloud between the Worker and BigQuery, one more component to run; it still needs a buffer upstream and gives no reload source.

How duplicates are removed (R-8), for those that reach the raw table:

1. A view over the raw table that keeps one row per EventID. Fresh at every query. Where it breaks: every query pays for the deduplication over the date range it reads; at 18 GB a month that is inside the free terabyte of queries, but it grows with the volume.
2. A scheduled MERGE from the raw table into a clean table. Cheaper reads. Where it breaks: freshness becomes the schedule; an hourly MERGE breaks the 15-minute target, and a frequent one costs more than the view at our volume.

How new fields reach the table:

1. Envelope fields as columns, `payload` as one column of type `JSON`. A new payload field needs no table change; a new envelope field is added by the load job with `ALLOW_FIELD_ADDITION`. Where it breaks: queries read payload fields through `JSON_VALUE(payload, '$.field')`.
2. Every field as its own column. Plain queries. Where it breaks: every new field of any event is a schema change, and with `maxBadRecords = 0` one unknown field fails the whole load.

## Decision

Load jobs, a deduplicating view, and `payload` as a JSON column.

### Loader

The loader is a cron Worker that runs every 5 minutes in production (every minute in the MVP, where its target is D1, ADR 0005).

1. List the files in `pending/`. If a manifest from an earlier run is unfinished, resume it first (step 6).
2. Group the files into a batch of at most 50 MB, to stay well inside the Worker's memory. A larger backlog becomes several batches in the same run. One run takes at most 9,000 files, to stay inside the 10,000 subrequests a Worker invocation gets by default: each file costs one read, and the clean-up in step 6 costs one write per batch and one delete call per 1,000 files. A Queue outage leaves one file per event (ADR 0005), so this cap sets the drain rate in `nfr.md`; a larger backlog takes several runs.
3. Write a manifest to R2 `batches/{batch_id}.json` with the file names and attempt number 1. The batch ID is derived from the sorted file names, so the same files always give the same ID.
4. Read the files, and drop repeated EventIDs inside the batch: the first occurrence of each EventID is kept. Redeliveries from the Queue and quick resends from the browser arrive close in time and land in the same batch, so most duplicates stop here, before BigQuery. Rows that fail validation go to R2 `rejected/` with an alert instead of failing the batch: not JSON, no well-formed `event_id`, or an envelope field whose type does not match its column, such as a `received_at` that is not a timestamp. Checking the envelope types here matters because with `maxBadRecords = 0` one such row would make BigQuery reject the whole batch.
5. Start a load job with job ID `load_{batch_id}_{attempt}`: `NEWLINE_DELIMITED_JSON`, `WRITE_APPEND`, the table schema from the code, `ALLOW_FIELD_ADDITION`, `maxBadRecords = 0`, upload through the resumable protocol when the batch is large.
6. Find out how the job ended. If the request timed out or the Worker restarted, ask BigQuery for the job by its ID. A `409` on creation means the job already exists, so the loader asks for its status instead of loading again. Done without errors: write the batch as one file `loaded/{batch_id}.ndjson`, delete its files from `pending/` (up to 1,000 keys per call), and close the manifest. Done with an error: raise the attempt number and start a new job, so a failed job is retried under a new ID and a successful one is never repeated. After the fifth failed job the batch's files go to `rejected/` with an alert and the manifest is closed, so one bad batch cannot use up the daily 1,500 jobs. Only jobs that BigQuery ran and finished with an error count as attempts. When BigQuery cannot be reached or answers with a server error, the batch stays in `pending/` for the next run, so a BigQuery outage never sends data to `rejected/`.

`loaded/` and `rejected/` files are deleted by R2 lifecycle rules after 30 days (bounded by Q-16); for `rejected/` that is the window to act on the alert. To recover rejected data, fix the cause (a loader bug or the row itself) and move the file back to `pending/`; the next run loads it and the view hides anything loaded twice. Nothing in `pending/` is deleted automatically. 288 runs a day leave more than 1,200 jobs of the daily 1,500 for retries and split batches.

### Duplicates, three layers

1. The job ID keeps a batch from being loaded twice.
2. The loader drops repeated EventIDs inside a batch.
3. The view `events` keeps one row per EventID across batches, for duplicates that arrive far apart, such as a browser resend an hour later: `QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY received_at) = 1`.

No key is declared on the raw table, because a declared key that the data violates makes BigQuery return wrong results. Reports and analysts get access to the view, not to `events_raw` (an authorized view), so the deduplication is written once and cannot be skipped. A scheduled MERGE into a clean table replaces the view when the cost of querying it grows past the free tier.

### Table

- `events_raw`, partitioned by the date of `received_at` and clustered by `type`, so a report for one day reads one partition.
- Envelope fields from ADR 0005 as typed columns; `payload` as `JSON`. A new payload field needs nothing; a new envelope field is added as a column, never renamed (the plan's migration rule).
- Email never reaches BigQuery (Q-16, ADR 0002); the envelope has no field for it.

### Freshness

Consumer wait up to 30 seconds, plus up to 5 minutes until the next loader run, plus the load job itself. The age of the newest row in `events_raw` is measured, with an alert when it exceeds 15 minutes; the oldest file in `pending/` has its own alert at 1 hour.

### Access

A service account with permission to run jobs and write to this one dataset. The Worker keeps its client email and private key as two secrets (the key fits in 5 KB), signs a JWT with RS256 through Web Crypto, exchanges it for an access token and reuses the token until it expires. The signing code has its own tests, as Google advises when client libraries are not used.

## Consequences

- Easier: a backfill is moving files from `loaded/` back to `pending/`; the view hides any rows loaded twice.
- Easier: new event fields reach BigQuery with no manual table change.
- Harder: the loader carries state (manifests, attempt numbers) and needs tests for every crash point.
- Harder: payload queries use JSON functions.
- Watch: load jobs per table per day (alert at 1,000), newest row age (alert at 15 minutes), oldest `pending/` file (alert at 1 hour), files in `rejected/` (alert on any), bytes scanned by the view each month against the free terabyte.

## Verification

- `loader retry with the same job id loads the batch once`: simulate a timeout after the job was created; the second run gets 409, reads the job status, and moves the files without a second load.
- `failed load job is retried under a new attempt id`.
- `loader drops repeated event ids inside a batch`: a batch with the same event three times uploads one row.
- `R-8 duplicate across batches appears once in the events view`.
- `invalid row goes to rejected and the rest of the batch loads`, including a row whose `received_at` is not a timestamp.
- `load job failing five times moves the batch to rejected`.
- `BigQuery unavailable does not count as a load attempt`: with BigQuery unreachable for ten runs, the files stay in `pending/` and nothing reaches `rejected/`.
- `a run takes at most 9,000 files`: 20,000 one-event files in `pending/` are loaded over three runs, once each.
- `new payload field reaches BigQuery without a schema change` and `new envelope field is added by the load job`.
- Fault test (P-8): stop the loader, send the demo traffic, check `pending/`, start the loader, compare the view's counts with the events sent.
- Freshness: in staging, the newest row is never older than 15 minutes during normal traffic.

## References

- BigQuery quotas, checked 2026-11-02: https://docs.cloud.google.com/bigquery/quotas
- BigQuery error messages (`duplicate`, 409), checked 2026-11-02: https://docs.cloud.google.com/bigquery/docs/error-messages
- BigQuery primary and foreign keys, checked 2026-11-02: https://docs.cloud.google.com/bigquery/docs/primary-foreign-keys
- `jobs.insert` and the BigQuery API discovery document, checked 2026-11-02: https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/jobs/insert, https://bigquery.googleapis.com/discovery/v1/apis/bigquery/v2/rest
- R2 Workers API (`delete` takes up to 1,000 keys per call) and Workers limits (10,000 subrequests per invocation by default), checked 2026-11-02: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/, https://developers.cloudflare.com/workers/platform/limits/
- `docs/requirements/research-bigquery-ingestion.md`, `docs/requirements/nfr.md`.
- ADR 0005 (files in R2, MVP stand-in).

## Outcome

2026-11-06, Part 2 stage 5. The loader is built in `src/events/loader.ts`, with D1 `events` as its target in place of a BigQuery load job, and runs every minute. A run writes a manifest to `batches/` before the insert, drops repeated EventIDs, sends invalid rows to `rejected/`, inserts with `ON CONFLICT (event_id) DO NOTHING`, writes the batch to `loaded/` and then deletes its `pending/` files. A run takes at most 8 batches of 900 rows, 7,200 rows in all, because a Worker invocation may send D1 at most 1,000 queries. A failed insert counts as an attempt only when D1 still answers `SELECT 1`, and five attempts send the batch to `rejected/`. `control/loader-paused` in R2 pauses the loader. R2 lifecycle rules delete `loaded/` and `rejected/` files after 30 days. BigQuery load jobs remain design-only. The drill numbers are in the Outcome of ADR 0005.
