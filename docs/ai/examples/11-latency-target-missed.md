# Example 11: a latency target missed under load

- Date: 2026-11-06
- Stage: Part 2 stage 9, load test

## Task given to the AI

Run the stage 9 load test against the deployed Worker: `load/peak.js` at 200 `POST /api/events` a second for 5 minutes. Then count the stored rows, read the server-side p95 from the Analytics Engine SQL API and record the numbers against NFR-2 and NFR-6.

## What the AI proposed

The run passed on errors and storage. There were 59,990 requests, all `202`, and 59,990 rows stored. The server-side p95 was 74 ms (p50 61 ms) against the 50 ms target of NFR-6. The AI guessed that the time went into the Queue send and offered three options right away. It recommended raising the target to 100 ms. The other two were to keep 50 ms and mark it not met, or to answer `202` before the send.

## Decision

Arthur rejected choosing before the cause was known (Ukrainian in the session): "Треба спершу розібратися в причині, а потім фіксити" ("First find the cause, then fix").

The AI then gathered evidence before proposing anything:

- It read the handler. On the timed path, `POST /api/events` awaits two I/O operations: the body read and `EVENTS_QUEUE.send()`. On Workers, `Date.now()` advances only across I/O, so validation is not in the 61 ms.
- It split the run in Analytics Engine by minute and by colo. Every request was served by WAW. The p50 was 60 to 62 ms in every minute, so the time does not grow with load. A D1 read from the same colo has a p50 of 22 ms.
- It found Cloudflare's published figure: the median latency of a Queue write is about 60 ms, and the write returns only after the message is persisted ([How we built Cloudflare Queues](https://blog.cloudflare.com/how-we-built-cloudflare-queues/)).

Arthur asked whether reading the facts from D1 stays under 50 ms. The AI measured it with 601 requests to `GET /__probe`: p95 31 ms.

Arthur first suggested a target of 70 ms. The AI pointed out that the measured p95 of 74 ms would still miss it. Arthur asked why not 61 ms. The AI explained that 61 ms is the median and the target is a p95. Then Arthur saw that Cloudflare publishes only the median, and decided: "давай не змінювати вимоги, а просто записати по факту скільки вийшло, чому так, + посилання" ("let's not change the requirement, just record what came out, why, and the link").

The target stays at 50 ms. The miss is recorded with its cause and the link. Risk R-24 names the one fix and its price: answering before the send, which needs an ADR that supersedes ADR 0005.

## Verification

- Analytics Engine for the run window: 59,990 requests in WAW, p50 61 ms, p95 74 ms, minimum 34 ms, 0 `5xx`, 0 `d1_overload`.
- `GET /__probe`, 601 requests at 10 a second: p50 24 ms, p95 31 ms, p99 36 ms.
- The numbers are in `docs/requirements/nfr.md` "Measured in Part 2 stage 9", in the NFR-2 and NFR-6 results of `docs/testing/acceptance-checks.md`, and in R-24 of `docs/requirements/risks.md`. They were merged in PR #13 (main 4ce08a6).
- Not checked: the body read and the send timed apart.
