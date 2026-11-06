# Part 2 stage 9: load test, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the spec peak (NFR-2, P-7) is measured on the deployed Worker, and the p95 of `POST /api/events` under that load is compared with the 50 ms of NFR-6. The stored event count equals the count of `202` answers.

**Architecture:** one k6 script, `load/peak.js`, sends `POST /api/events` and nothing else. No Worker code changes. The results go into nfr.md and the NFR-2 and NFR-6 cards, the cost line into the README.

**Tech Stack:** k6 v2.3.0, installed on the laptop, not a package dependency. Analytics Engine SQL API, `wrangler d1 execute`.

**Spec:** [part2-mvp-stages.md](part2-mvp-stages.md), section "Stage 9 (optional): load test". Read with it: the cards NFR-2 and NFR-6 in [acceptance-checks.md](../testing/acceptance-checks.md), the p95 targets in [nfr.md](../requirements/nfr.md#set-in-stage-4), the migration triggers in [ADR 0003](../adr/0003-operational-store.md).

## Decisions in this plan

1. Identity. `POST /api/events` runs behind the identity middleware (`src/routes/identity.ts`). A `uid` cookie that is a lowercase UUID v4 makes the request a returning user; anything else gets a new random id. No other header is needed except `content-type: application/json`. k6 sends the cookie with `replace: true`, so the VU cookie jar cannot put back the uid of the previous user.
2. A valid event (`src/events/envelope.ts`): a strict object with `event_id` (UUID), `schema_version` 1, `type`, `client_time`, `visit_id`, `seq` (1 to 10,000), `prelander_id` `demo` and `payload`. The body is at most 4,096 bytes; one event is about 250. Server-only types are refused, so the script sends `step_answered` for step 1 (`gender`) or step 2 (`ethnicity`) with an allowed value. That is the longest check path of a browser event. The report funnel reads only `prelander_viewed`, `step_viewed` and `quiz_completed`, so the run leaves `/report` as it was.
3. Many synthetic users. A pool of `USERS` (default 1,000) made in `setup()`, each with its own uid and `visit_id` `load-<RUN>-<index>`. Iteration n uses user n mod `USERS` with `seq` floor(n / `USERS`) + 1. One identity per VU would give only the 50 or so VUs the executor keeps. At the full run each user sends 60 events.
4. Load. `constant-arrival-rate`, 200 iterations a second for 5 minutes, 60,000 requests, 50 VUs preallocated and up to 400. `RATE`, `DURATION`, `USERS` and `RUN` are env overrides. Thresholds: `http_req_failed` under 1%, which counts every status from 400 up, `429` included; `dropped_iterations` under 1% of the plan, so a laptop that cannot hold the rate fails the run. The p95 is reported and is not a threshold: k6 measures the round trip from the laptop, while NFR-6 is server side. The server-side p95 comes from the Analytics Engine SQL query in step 6 of the controller run.
5. Counters in the summary: `events_accepted` (`202`), `events_throttled` (`429`), `events_cf_1015` (a `429` whose body names error 1015), `events_unavailable` (`503`, the Queue and R2 both refused) and `events_rejected` (`400` or `413`, a script bug).
6. Stored equals accepted. The `RUN` tag lets one query count the rows of this run alone: `COUNT(*)` and `COUNT(DISTINCT user_id)` over `visit_id LIKE 'load-<RUN>-%'`. The total row count before and after is a cross-check. The NFR-2 card says to reset first and read `/__test/state`; both are dropped, because the reset wipes the demo store and `/__test/state` counts only the caller's own events. A request that timed out in k6 (`timeout` 10 s) can still have been stored, so the stored count can exceed `202` by the number of timeouts.
7. Draining. The loader takes at most 8 batches of 900 rows, 7,200 rows a minute, while the run brings 12,000 a minute. About 24,000 rows still wait when k6 stops, so the drain takes about 4 more minutes, about 9 from the start. The count is read after `/__test/health` shows `pending_files` 0 and `open_batches` 0 at least 2 minutes after k6 stopped (the consumer waits up to 30 s for a batch), and read again a minute later to see that it no longer grows.
8. Cloudflare limits from one laptop. The Workers limits page says "There is no general limit on requests per second", and Workers Paid has no request limit (https://developers.cloudflare.com/workers/platform/limits/). There is no published per-IP limit for `workers.dev`. Community threads report an anti-abuse rule that answers `429` with error 1015 when many requests come from a few IPs, mostly at thousands of requests a second or for subrequests. 200 a second from one IP is 12,000 a minute, so the run must detect it: `events_throttled` and `events_cf_1015` above 0, `http_req_failed` over 1%, and an Analytics Engine count below k6's, because a blocked request never reaches the Worker and writes no data point. If it happens, the run stops there, the numbers are recorded as they are, and running from more IPs waits for Arthur.
9. The dashboard check becomes an Analytics Engine SQL query: `SUM(_sample_interval)` for `index1 = 'POST /api/events'` between the start and end of the run. The controller can run it with the read-only token, and it is the same data the dashboard shows. It must be within 20% of k6's `http_reqs` (NFR-6 row "Allowed difference").
10. Cost, for the README "Spend to date": 60,000 Worker requests and about 180,000 Queue operations (3 per message) fall inside the Workers Paid included amounts (10M requests, 1M operations). Past them it would be about $0.02 of requests ($0.30/M) and $0.07 of Queue ($0.40/M), from the nfr.md price table. The 2x and 5x runs of P-7 run only if Arthur agrees on the day.
11. Nothing runs against the deployed Worker before the merge. The implementer runs the script against a local `wrangler dev` only, at a low rate.
12. No `pnpm load:peak` script: k6 is not a package dependency, and the card already names the `k6 run` command. `pnpm lint` now includes `load/`; oxfmt checks it through `pnpm fmt:check`; tsc does not see `.js` files.

## Global Constraints

- English. No em or en dashes (`pnpm lint:docs`). No account ids or tokens in a committed file; the SQL token and account id come from `.dev.vars.remote`.
- Never `--no-verify`. The controller pushes.

---

### Task 1: the script

**Files:** Create `load/peak.js`. Modify `package.json` (the `lint` paths).

- [x] **Step 1:** write `load/peak.js` with a header comment naming NFR-2, NFR-6, P-7 and this plan.
- [x] **Step 2:** local run. `pnpm migrate:local && pnpm seed --local`, then `pnpm exec wrangler dev --port 8787 --test-scheduled` in the background, then `k6 run -e RUN=local1 -e RATE=20 -e DURATION=20s -e USERS=50 --summary-export $TMP/peak.json load/peak.js`. Tick the loader with `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"` and count the run's rows with `wrangler d1 execute events --local`. Expected: 400 requests, 0% failed, 400 rows stored for 50 distinct users. Stop the dev server by its PID.
- [x] **Step 3:** `pnpm check`. Commit `test: load test at 200 events/s`.

## Controller run (after the merge, against the deployed Worker)

- [x] 1. Announce the run and its cost (decision 10) to Arthur, then set up:

  ```sh
  export BASE=https://funnels-analytics-events.bblog.workers.dev TMP=$(mktemp -d) RUN=$(date +%s)
  curl -s $BASE/healthz                                                   # the sha of main
  curl -s $BASE/__test/health | jq -c '{loader_paused,pending_files,open_batches}'   # false, 0, 0
  pnpm exec wrangler d1 execute events --remote --json --command "SELECT COUNT(*) AS n FROM events" 2>/dev/null | jq '.[0].results[0].n'   # BEFORE
  ```

- [x] 2. The run, about 5 minutes:

  ```sh
  START=$(date -u +%s); k6 run -e BASE=$BASE -e RUN=$RUN --summary-export $TMP/peak.json load/peak.js | tee $TMP/peak.txt; END=$(date -u +%s)
  jq '.metrics | {reqs: .http_reqs.count, accepted: .events_accepted.count, failed: .http_req_failed.value, p95_ms: .http_req_duration["p(95)"], throttled: (.events_throttled.count // 0), cf_1015: (.events_cf_1015.count // 0), dropped: .dropped_iterations.count}' $TMP/peak.json
  ```

  Expected: about 60,000 requests, `failed` under 0.01, `throttled` 0. If `throttled` is above 0, follow decision 8.
- [x] 3. Drain (decision 7): wait 2 minutes, then poll until both are 0, about 5 minutes:

  ```sh
  until curl -s $BASE/__test/health | jq -e '.pending_files == 0 and .open_batches == 0' >/dev/null; do sleep 30; done
  ```

- [x] 4. Count, then count again a minute later. `n` equals `accepted` (plus timeouts, decision 6), `users` is 1000, AFTER minus BEFORE is at least `n`:

  ```sh
  pnpm exec wrangler d1 execute events --remote --json --command "SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS users FROM events WHERE visit_id LIKE 'load-$RUN-%'" 2>/dev/null | jq -c '.[0].results[0]'
  pnpm exec wrangler d1 execute events --remote --json --command "SELECT COUNT(*) AS n FROM events" 2>/dev/null | jq '.[0].results[0].n'   # AFTER
  ```

- [x] 5. Analytics Engine, a few minutes after the run so the points have arrived:

  ```sh
  AE_SQL_TOKEN=$(grep '^AE_SQL_TOKEN=' .dev.vars.remote | cut -d= -f2-); CF_ACCOUNT_ID=$(grep '^CF_ACCOUNT_ID=' .dev.vars.remote | cut -d= -f2-)
  curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql" -H "Authorization: Bearer $AE_SQL_TOKEN" \
    --data "SELECT SUM(_sample_interval) AS requests, quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms, SUM(IF(double2 >= 500, _sample_interval, 0)) AS errors_5xx, SUM(IF(blob4 = 'd1_overload', _sample_interval, 0)) AS d1_overload FROM funnels_metrics WHERE blob1 = 'request' AND index1 = 'POST /api/events' AND timestamp >= toDateTime($START) AND timestamp <= toDateTime($END) FORMAT JSON" | jq -c '.data[]'
  ```

  Expected: `requests` within 20% of k6's `reqs`, server-side `p95_ms` against 50 ms, `errors_5xx` and `d1_overload` 0.
- [x] 6. Record: a result line in the NFR-2 and NFR-6 cards and the measured numbers in nfr.md (k6 p95, server p95, error rate, both counts, where k6 ran from); the cost line in the README "Spend to date"; the card steps changed in decision 6.
- [ ] 7. Explain-back: Arthur reads the summary and names the number that would make him leave D1. The run does not touch the facts database, because `POST /api/events` only validates and sends to the Queue (ADR 0005). The ADR 0003 triggers are the facts size above 7 GB, the selection p95 above 300 ms and more than 10 D1 overload errors an hour, so `d1_overload` in step 5 is the only number here that speaks to them.
