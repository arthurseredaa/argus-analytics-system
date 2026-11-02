# BigQuery ingestion from a Cloudflare Worker

Checked on 2026-11-01. Prices and quotas are in `nfr.md`, section "Platform limits and prices"; this note compares the ways to get events into BigQuery from outside Google Cloud and ends with a starting recommendation for ADR 0006 in stage 2.

The constraints from the spec: analytics fresh within 15 minutes (NFR-3), no lost or double-counted events during a BigQuery outage (NFR-4, NFR-5, R-8, R-16), and email never in BigQuery in plain text (Q-16).

## Authentication from a Worker

Google's client libraries do not run in Workers, so the Worker authenticates as a service account by hand:

1. Build a JWT with `iss` set to the service account, the BigQuery scope, `aud` set to `https://oauth2.googleapis.com/token`, and `exp` at most one hour after `iat`.
2. Sign it with RS256 using the service account's private key. RS256 is the only algorithm Google's token endpoint accepts. The Worker signs with Web Crypto.
3. POST it to `https://oauth2.googleapis.com/token` and get an access token, valid for `expires_in` seconds (3600 in Google's example). Reuse the token until it expires.

Some Google APIs accept a self-signed JWT directly as the bearer token, which skips step 3. That works only for APIs with a service definition in Google's googleapis repository; whether it works for BigQuery was not checked.

The private key is a Worker secret. Secrets are limited to 5 KB each, so the key has to fit; to check when the key is created. Google's documentation recommends client libraries over hand-rolled JWT signing because mistakes are a security risk, so the signing code needs its own tests.

Source: https://developers.google.com/identity/protocols/oauth2/service-account

## Option 1: Storage Write API (REST), `tabledata.insertAll`

The Worker POSTs JSON rows to `https://bigquery.googleapis.com/bigquery/v2/projects/{projectId}/datasets/{datasetId}/tables/{tableId}/insertAll`.

- Works with plain `fetch` from a Worker.
- Rows are queryable within seconds, well inside the 15-minute target.
- Deduplication by `insertId` is best effort, and Google's reference page says it is not recommended for stronger semantics. Duplicates have to be removed in BigQuery by EventID (R-8).
- Cost at the design load of 18M events a month is about $0.90 (`nfr.md`).
- Up to 50,000 rows per request, 500 recommended.

Source: https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/tabledata/insertAll

## Option 2: Storage Write API (gRPC)

Rows are sent as protocol buffers over a bidirectional gRPC connection.

- A committed-type stream with client-supplied offsets gives exactly-once writes. The default stream is at-least-once.
- First 2 TiB a month free, so free at this volume.
- Whether a Worker can hold a bidirectional gRPC stream to Google was not checked. If it cannot, this option needs a small service inside Google Cloud (Cloud Run, for example) between the Worker and BigQuery. That is one more service to deploy, monitor and pay for, against the lean-service principle in the plan.

Source: https://docs.cloud.google.com/bigquery/docs/write-api

## Option 3: batch load jobs

Events are buffered as files (in R2, or written to R2 by Pipelines), and a cron-triggered Worker starts a load job every few minutes. The load job is a POST to `https://bigquery.googleapis.com/upload/bigquery/v2/projects/{projectId}/jobs` with the job configuration and the file data as two multipart parts.

- Free with the shared slot pool.
- 1,500 load jobs per table per day, failed ones included. A load every 5 minutes is 288 a day, which meets the 15-minute target with room for retries.
- A file is loaded whole or not at all, so the buffer gives a clear unit for retry and backfill after an outage (R-16).
- The maximum upload size for the upload endpoint was not found on the reference page.
- Whether a repeated job ID is rejected, which would make a retried load idempotent, was not checked.

Source: https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/jobs/insert, https://docs.cloud.google.com/bigquery/quotas

## Starting recommendation for stage 2

Batch load jobs from files buffered in R2, on a cron trigger. They are free, fit the 15-minute target, use only `fetch` from a Worker, and the buffered files double as the outage buffer and the backfill source. REST streaming is the fallback if freshness has to drop below a minute or the upload endpoint turns out not to fit. gRPC is left out unless a Worker can hold the stream without a helper service.

To check in stage 2 before ADR 0006 is accepted:

- the upload size limit of the load job upload endpoint: checked 2026-11-02, no maximum in the API description and a resumable protocol exists; the Worker's 128 MB memory is the real limit (ADR 0006);
- whether a repeated job ID makes a load idempotent: checked 2026-11-02, yes, a job ID that exists gives `duplicate`, HTTP 409 (ADR 0006);
- EU multi-region prices (Q-2, Q-18);
- whether BigQuery accepts a self-signed JWT;
- whether a Worker can hold a bidirectional gRPC stream.
