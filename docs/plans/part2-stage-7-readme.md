# Part 2 stage 7: README and demo, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a reviewer can install, run, test and repeat the demo from `README.md` alone, the README explains where each architecture component lives in the code, and the browser test also checks the `/go?prelander=demo` link. DEMO-1, DEMO-7, DEMO-9, DLV-1, DLV-3, DLV-4, DLV-5, NFR-8 step 3.

**Architecture:** no code changes except two tests. Task 1 rewrites `README.md` (the Run, Check, Demo, Expected results, Deploy and Spend sections of stage 6 stay as source material and are reordered). Task 2 adds one assertion to `tests/e2e/quiz.spec.ts`. Task 3 adds a known-answer HMAC vector to `tests/unit/signature.test.ts`.

**Tech Stack:** as stage 6 (Playwright 1.64.1, vitest 4). No new dependency.

**Spec:** [part2-mvp-stages.md](part2-mvp-stages.md), section "Stage 7: README and demo". Read with it: the decisions table at the top of that file (rows "Environments", "Deployment", "Frontend", "Operations"), "Implemented, simulated, design-only" and "What to show at the review" at its end; the cards DEMO-1, DEMO-7, DEMO-9 and NFR-8 in [acceptance-checks.md](../testing/acceptance-checks.md); the current `README.md`; the stage 1 to 5 `notes` in [progress.json](../state/progress.json).

## Decisions in this plan

1. Stage 6 is merged (4b6ca3b). Take its facts from the code: `wrangler.jsonc` (the alert cron `*/5 * * * *`, `ALERT_THRESHOLDS`), `.dev.vars.example` (the optional `AE_SQL_TOKEN` and `CF_ACCOUNT_ID`), `src/routes/probe.ts` and `scripts/email-scan.sh` with its remote mode.
2. Only Arthur can send postbacks or run `pnpm test:e2e` against the deployed Worker, because the partner secrets are in his `.dev.vars.remote` (stage 3 notes). The README says so in the postback and demo sections. A reviewer uses the deployed Worker for the quiz in a browser, `/report`, `GET /healthz` and `pnpm test:browser` with `BASE`; the signed steps run locally with their own `.dev.vars`.
3. The stage text also lists "known limitations, each with the test that shows it". Most deferred items in progress.json have no test. The README lists a test name where one exists and writes "no test; documented here" where none does. It adds no tests for them (scope).
4. `catalog_config_error` is logged at `/complete` only, not at `/go` and entry (stage 6 plan, decision 21). It goes into the known limitations.
5. Spend: the repository holds one figure, "2026-11-04: Workers Paid, $5 a month" (README "Spend to date"). No later figure exists. The README keeps that line and adds `2026-11-06: [spend]`; the controller fills it in from the billing page before the PR merges.
6. The redrive script is design-only. The README gives the command it would run as the two Cloudflare Queues HTTP pull calls named in ADR 0005 (pull from `events-dlq`, then send each body to `events` through the Queues API and ack), with `<account_id>`, `<queue_id>` and `$CF_API_TOKEN` as placeholders. The implementer checks the endpoint paths against the current Cloudflare Queues documentation and says in the text that the script does not exist.
7. The CI badge points at `https://github.com/arthurseredaa/argus-analytics-system/actions/workflows/ci.yml/badge.svg` (from `git remote`, workflow file `ci.yml`, workflow name `ci`). The demo link is `https://funnels-analytics-events.bblog.workers.dev` (from the stage 5 plan); the README shows it as the Worker URL, with no account id.

## Global Constraints

- English. Write the README prose through the `humanizer` skill: plain sentences, no em or en dashes, no filler. `pnpm lint:docs` must pass (dash, email and link rules).
- No account ids, tokens, secrets or real emails. Only `user1@example.com` and other `@example.com` addresses. No `curl -L` and no `redirect: "follow"` anywhere in the README or tests.
- Every number, path and command in the README is copied from the file named in the table below, never from memory. Every command is run once from the worktree and its output matches what the README says.
- Do not edit docs other than `README.md`. If a source file disagrees with another, stop and report `NEEDS_CONTEXT`.
- Work in the worktree `.claude/worktrees/part2-stage-7` on branch `part2-stage-7`, made from `main` after the stage 6 PR merges. Each task commits there.

## Known setup traps

- `pnpm test:browser` needs Chromium (`pnpm exec playwright install chromium`), a free port 8787, `.dev.vars` with each key filled by `openssl rand -base64 32`, then `pnpm migrate:local` and `pnpm seed --local`.
- `pnpm test -t "X"` filters; `pnpm test -- -t "X"` runs everything.
- `docs-rules` checks relative links only; external URLs are skipped. Link to `docs/...` paths that exist.

## Review Focus

- Every README claim about the code (folder, ADR, endpoint, command) matches the file it names. The folder-to-ADR table follows the header comment of the files in each folder.
- Each section of the stage text appears, in its order, and the README promises nothing the repository does not do (the redrive script, the external probe, preview deploys are design-only and say so).
- The DEMO-7 rows, the five-step request path and the 302 text do not contradict the cards.

---

### Task 1: the README

**Files:**
- Modify: `README.md`

**Interfaces:** none. Keep the existing "Run", "Check", "Demo", "Expected results", "Deploy" and "Spend to date" text where it is still true, move it into the order below, and delete the sentence "Stage 7 of that plan completes this README".

**Sections, in order.** Each row lists the facts the section must contain and where each comes from. Do not copy a source's prose; write it fresh.

| # | Section | Facts it must contain | Source |
|---|---|---|---|
| 1 | Opening paragraph | One Worker (Hono), two D1 databases, a Queue, R2; links to design.md and part2-mvp-stages.md | current README; `docs/design/design.md` |
| 2 | Architecture in the code | The diagram (an image of `docs/design/architecture.png`) with one sentence per path (live, event, postback, report). | `docs/design/design.md` section 2 |
| 2a | Component table | Columns: component, folder, ADR. Rows: routes (`src/routes/`), selection and signature and crypto (`src/domain/`, ADR 0004, 0002, 0007), D1 SQL (`src/db/`, ADR 0003), events producer, consumer, loader (`src/events/`, ADR 0005, 0006), operations (`src/ops/`, metrics-and-operations.md), pages (`src/pages/`), quiz flow config (`config/prelanders/`), migrations (`migrations/facts/`, `migrations/events/`), scripts (`scripts/`). Check each folder's file headers for the ADR. | layout block in `docs/plans/part2-mvp-stages.md`; file headers under `src/` |
| 2b | Request path of the five demo steps | For DEMO-2 to DEMO-6, the route file and the function that handle each request, e.g. `GET /p/demo`, `POST /api/events`, `POST /api/complete`, `GET /go`, `POST /postback/v1/partnerA`, repeated postback. Name events written and tables touched. | `docs/design/request-flow.md`; `docs/design/data-model.md` "Trace of the demo"; open the route files to confirm names |
| 2c | What to read first (30 minutes) | An ordered list of at most 6 items: design.md section 2, request-flow.md, ADR 0003, ADR 0005, `src/domain/select.ts`, `src/events/loader.ts`. | Arthur's reviewer note in `docs/plans/part2-mvp-stages.md` ("What the reviewer looks for") |
| 3 | Demo | The Worker URL (decision 7) as DLV-1; what a reviewer can do there (quiz at `/p/demo`, `/report`, `GET /healthz`) and that signed steps are local (decision 2). | stage 5 plan Verify block; stage 3 notes |
| 4 | Install and run | `pnpm install`, `.dev.vars` from the example with `openssl rand -base64 32` for each key (and the two optional alert keys), `pnpm migrate:local`, `pnpm seed --local`, `pnpm dev`, `curl /healthz`. Node 24, pnpm 10. | `package.json`; `.dev.vars.example`; current README "Run" |
| 5 | Tests and the gate | `pnpm check` and what it runs; the pre-commit hook and the no `--no-verify` rule; test levels (`tests/unit`, `integration`, `e2e`) and `pnpm test -t "<id>"`; `pnpm test:browser` with Chromium; `pnpm test:email-scan`. | `package.json`; current README "Check"; `docs/plans/_subagent-brief.md` |
| 6 | Send a test postback | `pnpm postback lead\|purchase --click <id> --txn <id>`, the options, where the click id comes from (`/__test/state` or the `Location` of `/go`), the answers `202`, `200 duplicate`, `401`; secret read from `.dev.vars` for localhost; says reviewers run postbacks locally. | `scripts/postback.ts` header; ADR 0007; acceptance-checks.md DEMO-3 and DEMO-6 blocks |
| 7 | Repeat the demo | Local and Cloudflare commands from current "Demo"; timing (1.5 min local, 2 to 3 min deployed); the Cloudflare run needs the owner's `.dev.vars.remote` (decision 2); the paused-loader mode. | current README "Demo"; `scripts/demo.sh` header |
| 8 | Expected results | The current two tables unchanged (they match the DEMO-7 table). Add a line that rows 1, 3, 5, 6 and 16 exist in offer-selection.md. | current README; acceptance-checks.md "The DEMO-7 table" |
| 9 | How the transition is reproduced | `/go` answers `302` with a `Location` header; offer URLs are `.example` targets; nothing follows the redirect; no `-L` in any command. Name the test `DEMO-9` if one exists (`pnpm test -t "DEMO-9"`), else the `/go` tests. | acceptance-checks.md DEMO-9; `config/` catalog; `tests/integration/go.test.ts` |
| 10 | Implemented, simulated, design-only | Three lists, copied from the plan's lists and corrected to what stage 6 built (the alert cron and probe are implemented; the external probe, the redrive script, BigQuery load jobs, Postgres migration, Durable Objects, consent banner, attribution, cross-device identity are design-only). If `dlq_not_empty` moved to design-only in stage 6, say so. | "Implemented, simulated, design-only" in part2-mvp-stages.md; stage 6 PR notes |
| 11 | Known limitations | One bullet per item, with the test that shows it or "no test; documented here". Items: R2 buffer and 503 behaviour (`NFR-4` tests in `producer.test.ts`), out-of-order events and last completion wins (`NFR-8 R-3` x2), loader outage (`NFR-5 R-16`, `NFR-5 R-8`), a bad row goes to `rejected/` (`NFR-8` loader cases), `catalog_config_error` only at `/complete` (decision 4), plus the "Deferred" sentences of the stage 1 to 5 notes in progress.json (no body cap streaming; re-seeding keeps an old partner secret; two completions in the same millisecond keep the first; D1 that answers `SELECT 1` but refuses writes; overlapping loader runs; unparsable manifest skipped; drop-offs not clamped; cohort and postback totals not cross-tested). List the `NFR-8` test names as the card requires. | `docs/state/progress.json` notes; acceptance-checks.md NFR-8; `grep -rhn "NFR-8" tests` |
| 12 | CI | The badge at the top of the README and in this section; what the three jobs run (`check`, `e2e`, `deploy`). | `.github/workflows/ci.yml` |
| 13 | Operations | `GET /__probe`, the alert cron and what a firing alert looks like (one JSON log line), the redrive command (decision 6). | metrics-and-operations.md; ADR 0005; stage 6 plan decisions 8, 9, 13 |
| 14 | Deploy | A push to `main` deploys (current text, keep); `wrangler versions upload` per pull request as the team workflow with feature branches, merge to `main` after review and green CI, flags for unfinished work, no `develop`, no staging, no tags (design-only); the "One Worker, not a monorepo" paragraph and the "No frontend framework" paragraph, each ending with when that would change. | decisions table rows "Environments", "Deployment", "Frontend" in part2-mvp-stages.md |
| 15 | Spend to date | The 2026-11-04 line and `2026-11-06: [spend]` (decision 5). | current README |

- [ ] **Step 1: Write the section list above into the README**, replacing the stage 0 to 6 layout. Put the CI badge on the first line under the title.
- [ ] **Step 2: Run every command the README shows that can run locally** (`pnpm check`, `pnpm test -t "DEMO-9"`, `pnpm test:e2e`, `pnpm -s postback` against the local demo). Fix the README where the output differs.
- [ ] **Step 3: Run the checks.**

  ```sh
  pnpm lint:docs && pnpm fmt:check
  grep -rnE -- "curl .*-L( |$)|redirect: ?'follow'" README.md tests/        # prints nothing
  grep -nE "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}" README.md | grep -v "@example\.com"   # prints nothing
  grep -nE "—|–" README.md                                                   # prints nothing
  grep -c "^## " README.md                                                   # at least 12
  ```

  Expected: each command exits 0 and each grep prints what its comment says. Then compare the README tables with the DEMO-7 card by eye and say so in the report.
- [ ] **Step 4: Commit** `docs: README, demo instructions and the implementation split`.

### Task 2: the `/go?prelander=demo` link in the browser test

**Files:**
- Modify: `tests/e2e/quiz.spec.ts`

**Interfaces:** none. The page sets the link's `href` in `src/pages/quiz.ts` to `/go?prelander=<id>&visit=<visit>`; the test already holds `visit` from `main[data-visit]`.

- [ ] **Step 1: Add the assertion** right after `[data-offer-name]` is checked: the locator `section[data-result="offer"] a` has the attribute `href` equal to `/go?prelander=demo&visit=${visit}`. At the end of the test add one check that no request in `requests` has the pathname `/go` (DEMO-9: the browser never follows it). Update the file's header comment to name DEMO-9.
- [ ] **Step 2: See it fail once.** Run with the expected `href` changed to `/go?prelander=wrong`, expect a failure that prints both values, then restore it.
- [ ] **Step 3: Run `pnpm test:browser`.** Expected: `1 passed`, then `email-scan: clean`. Run `pnpm typecheck && pnpm lint && pnpm fmt:check`; expected: exit 0.
- [ ] **Step 4: Commit** `test: the browser test checks the /go link`.

### Task 3: a known-answer HMAC vector

**Files:**
- Modify: `tests/unit/signature.test.ts`

The stage 3 notes asked for a vector computed outside the code, so a bug in `signPayload()` and in the test helper that uses it cannot hide each other. The vector below was computed with OpenSSL, not with the repository code:

```sh
printf '%s' '1762300000.{"type":"lead"}' | openssl dgst -sha256 -hmac 'test-partner-a-secret'
# 21616546dd8456dae4ba84a88257532f4b3205f419763767490fbfe9d7286963
```

The inputs are the file's own `secret`, `t` and `body` constants.

- [ ] **Step 1: Write the test** `PB-3 R-11 a signature matches a vector computed with openssl`: `signPayload(secret, t, body)` equals the hex above, and `check("t=1762300000,v1=<hex>")` gives `"ok"`. Put the openssl command in a comment above it. The expected hex is a literal, never computed in the test.
- [ ] **Step 2: Run `pnpm test -t "PB-3 R-11 a signature matches"`.** Expected: 1 passed. To see it can fail, change the last hex digit, expect a failure showing both strings, then restore.
- [ ] **Step 3: Run `pnpm test -t "PB-3"`, `pnpm lint`, `pnpm fmt:check`.** Expected: all pass.
- [ ] **Step 4: Commit** `test: HMAC known-answer vector from openssl`.

---

## Closing steps (controller)

- [ ] Fill `[spend]` in the README from the Cloudflare billing page. Run `pnpm check`; expected: exit 0.
- [ ] Open the PR with the stage 7 explain-back: Arthur runs the demo from the README and says what each command proves.
- [ ] Fresh clone, following only the README:

  ```sh
  export TMP=$(mktemp -d)
  git clone "$(git remote get-url origin)" "$TMP/fresh" && cd "$TMP/fresh" && git checkout part2-stage-7
  ```

  Then run, in order, only what the README says: `pnpm install`, the `.dev.vars` step, `pnpm migrate:local`, `pnpm seed --local`, `pnpm check`, `pnpm dev` with `curl /healthz`, `pnpm test:e2e`. Then, from the original worktree, `pnpm test:e2e --base $BASE` (the owner's `.dev.vars.remote`). Paste the output. Every step matches the README text.
- [ ] DEMO-7 card: each README row exists in `docs/requirements/offer-selection.md` with the same result. DEMO-9 grep prints nothing (Task 1 step 3). The CI badge on the PR page shows green.
- [ ] After CI is green, merge (`gh pr merge --squash --delete-branch`, subject `docs: README, demo instructions and the implementation split`), remove the worktree, pull `main`, watch the deploy run.
- [ ] Run against the deployed Worker, from the main checkout:

  ```sh
  export BASE=https://funnels-analytics-events.bblog.workers.dev
  curl -s $BASE/healthz                      # {"sha":"<git rev-parse HEAD>"}
  BASE=$BASE pnpm test:browser               # 1 passed; the eight events arrive, browser seq 1 to 5, server none; about 2.5 minutes
  ```

  Expected: the summary says `1 passed` and `email-scan skipped: BASE is remote`. Paste it.
- [ ] Update `docs/state/progress.json` through `pnpm stage:close` with the stage 7 notes (the fresh-clone result, the limitations list, the stage 8 note below). Tell Arthur in one paragraph what is left.

## Notes for the controller

- Stage 8's secret grep `(token|secret|api[_-]?key)["' ]*[:=]["' ]*[A-Za-z0-9_-]{20,}` matches `const secret = "test-partner-a-secret"` in `tests/unit/signature.test.ts` (21 characters). Task 3 reuses that constant. Stage 8 will need to exclude it or rename it.
