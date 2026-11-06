# Risks and likely problems

Things that can break correctness, cost or the delivery itself. "Mitigation" is a starting point for the design, not a decision; decisions go to ADRs.

## Data correctness

| ID | Risk | Effect | Mitigation | How we check |
|---|---|---|---|---|
| R-1 | The identity cookie is lost: cleared cookies, another device, private mode, Safari limits on script-set cookies. | One person counts as several users; the Lead return rule misses them. | Server-set, HttpOnly, first-party cookie. Document the limit. | Test with and without the cookie. |
| R-2 | Prelanders on different domains (Q-3). | Same as R-1, across prelanders. | One registrable domain, or a documented limit. | Covered by Q-3. |
| R-3 | Events are sent twice (client retry, network glitch) or arrive out of order. | Inflated funnel numbers; a wrong "current answer". | Client-generated EventID as an idempotency key. Server receive time plus a per-visit sequence number for ordering. | Integration test that resends the same batch. |
| R-4 | A postback is redelivered by the partner. | Double-counted Lead or Purchase. | Unique key per postback (partner + type + transaction ID; Lead also unique per click). | Test: same postback twice, numbers unchanged. |
| R-5 | A partner sends no transaction ID (Q-6). | A redelivery and a second real purchase look the same. | Require it in the contract. Without it, fall back to a payload hash and document the false-merge risk. | Contract tests. |
| R-6 | A postback arrives before our click record is stored. | The postback cannot be correlated and is lost or misattributed. | Persist the click before sending the redirect. Quarantine unmatched postbacks and retry matching. | Test with an unknown click ID, then the click appears. |
| R-7 | Late postbacks change numbers in past reports. | Yesterday's report differs from today's; looks like a bug. | Cohort reports by click date with an "as of" time; separate view by postback date. | Report test with a late postback. |
| R-8 | At-least-once delivery to BigQuery creates duplicate rows. | Inflated analytics. | Deduplicate by EventID in BigQuery (views or MERGE); prefer an exactly-once write path. | Count distinct EventID against row count. |
| R-9 | An offer is disabled between selection and redirect. | The user lands on a disabled offer. | Re-check status at the redirect and select again if the offer is no longer active. | Test: disable the offer after selection, then hit the redirect. |
| R-10 | Two tabs answer the quiz at the same time. | Conflicting current answers. | Latest accepted answer wins (Q-4); all answers kept. | Test with interleaved events. |

## Security and personal data

| ID | Risk | Effect | Mitigation | How we check |
|---|---|---|---|---|
| R-11 | Forged postbacks. | Fake revenue, wrong redirects for real users. | Signature or per-partner secret; timestamp window against replay; random, non-guessable click IDs. | Tests for missing, wrong and stale signatures. |
| R-12 | Email leaks into URLs or logs (query string, error messages, request logging, Cloudflare logs). | Breaks a spec rule and GDPR. | Email only in POST bodies; no request-body logging; redact in error handling; never in analytics. | Test that searches captured logs for a test email. |
| R-13 | Partners only support GET postbacks with a token in the URL. | Tokens end up in partner and proxy logs. | Not offered: the contract accepts only signed POST requests (ADR 0007). If a real partner can only send GET, a new ADR decides how, with per-partner rotating tokens and an IP allowlist as the starting point. | Covered by Q-6; `PB-3 unsigned postback is rejected and changes nothing`. |
| R-14 | Event spam or bots. | Polluted funnel, higher cost. | Rate limiting per IP and per user; payload size limits. | Load test includes abusive client. |
| R-23 | A client release puts an email into the payload of an event type the Worker does not know. | Personal data in the Queue, R2 and BigQuery, which are expensive to purge (Q-16). | `sanitizePayload()` in the producer removes every payload key whose name contains `email` and logs the count. An email inside a string value, such as a page URL with `?email=`, is not removed: accepted risk (Arthur, 2026-11-05). | `R-23 R-12 an email field in the payload of an unknown type is removed before the Queue`. |

## Scale and cost

| ID | Risk | Effect | Mitigation | How we check |
|---|---|---|---|---|
| R-15 | The chosen Cloudflare database cannot take the peak write rate or hits its size limit. | Lost or slow events. | Research real limits; buffer writes through a queue; keep only rule facts in the hot store. | Load test at 200 events/s for 5 minutes, plus headroom. |
| R-16 | A long BigQuery outage. | Buffer fills, data is lost or freshness breaks. | Durable buffer with a known retention; backfill path; alert on lag. | Fault test: block delivery, check the buffer, restore, check counts. |
| R-17 | Report queries scan the whole event table. | Slow reports, cost per row read. | Pre-aggregated counters or indexed queries. | Measure rows read per report. |
| R-18 | The edge is close to users but the database is in one region. | Latency target missed for distant users. | Keep the hot path to one round trip; cache the catalog at the edge. | Latency measured by region. |
| R-19 | Some services need a paid plan. | Unexpected spend. | Confirm pricing in research; agree budget (Q-17). | Cost table in the design. |
| R-24 | The Queue send takes about 60 ms at the median, so `POST /api/events` cannot meet its 50 ms p95 while it waits for the send (measured 74 ms at peak, Part 2 stage 9). | The NFR-6 target for event intake is missed. The browser waits about 60 ms longer per event; the quiz does not wait for it. | Accepted for the MVP; the target stays at 50 ms. Answering `202` before the send (`waitUntil`) would meet it, but a `202` would no longer mean the event is persisted and the `503` answer would go: that needs an ADR that supersedes ADR 0005. | The `load/peak.js` run and the server-side p95 from Analytics Engine (NFR-2, NFR-6 cards). |

## Delivery

| ID | Risk | Effect | Mitigation |
|---|---|---|---|
| R-20 | First time working with Cloudflare. | Time overrun. | Research stage before the design; small spike deploy in Part 2 first. |
| R-21 | Scope creep before scope and payment are agreed. | Unpaid work. | Stop after Part 1 until the agreement. |
| R-22 | At the review I must change the system live with AI. | Failing in front of the reviewers. | Fast test suite, clear module boundaries, rehearse a small change. |
