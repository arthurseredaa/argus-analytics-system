# Funnels analytics events system

An MVP on Cloudflare Workers that collects funnel events: one Worker built with Hono, two D1 databases, a Queue and R2. The system design is in [docs/design/design.md](docs/design/design.md) and the implementation plan is in [docs/plans/part2-mvp-stages.md](docs/plans/part2-mvp-stages.md). Stage 7 of that plan completes this README.

## Run

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm migrate:local
pnpm dev
```

Then, in another terminal:

```sh
curl http://localhost:8787/healthz
```

## Check

```sh
pnpm check
```

`pnpm check` runs what the CI `check` job runs: typecheck, lint, format check, docs lint, state check and tests. `pnpm typecheck` generates `worker-configuration.d.ts` first, so it works on a fresh checkout.

`pnpm install` wires `pnpm check` as the git pre-commit hook. `git commit --no-verify` skips it and is not used in this repository.

The browser test needs Chromium, installed once, a free port 8787 and the `.dev.vars` copied from the example, with each key filled by `openssl rand -base64 32`. Do that before seeding:

```sh
pnpm exec playwright install chromium
pnpm migrate:local
pnpm seed --local
pnpm test:browser
```

`pnpm test:browser` starts `wrangler dev` and drives the quiz in Chromium. The page's own JavaScript sends five events and the server adds three, eight in total. The test proves that the email reaches only the completion request. The scan of the wrangler log and the local state for the email runs only against local `wrangler dev`.

## Demo

`pnpm test:e2e` runs the demo scenario from [docs/testing/acceptance-checks.md](docs/testing/acceptance-checks.md) with every answer asserted. It resets the store, takes a user through the quiz to offer 003, sends a signed Lead, sends the user back, sends a signed Purchase and repeats both postbacks. It prints `ok <step>` for each passed check, the `diff` of the report before and after the Purchase, and `demo passed against <base>` at the end; on the first mismatch it prints `FAIL <step>: expected <x>, got <y>` and exits 1.

```sh
pnpm migrate:local && pnpm seed --local   # once
pnpm test:e2e                             # starts its own wrangler dev on port 8787
pnpm test:e2e --base https://<worker>.workers.dev
```

Without `--base` and `BASE`, the script starts `wrangler dev` itself, with a ticker that runs the loader every 10 seconds because `wrangler dev` runs no cron, and needs port 8787 free. A local run takes about 1.5 minutes and a deployed run about 2 to 3 minutes, because the report counts events and an event reaches D1 through the Queue batch (up to 30 seconds) and the loader's next minute. Each wait covers both. While the loader is paused (`pnpm sink outage on`) the demo expects the funnel cells to stay 0 and checks everything else as usual. A run against a deployed Worker resets that Worker's store and signs its postbacks with the secrets from `.dev.vars.remote`. The deployed Worker's secrets are not in the repository, so only its owner can run it that way; everyone else runs the demo locally with their own `.dev.vars`.

No step follows a redirect: the transition to a partner is a `302`, and the demo reads its `Location` header.

## Expected results

Offer selection for the answers a reviewer is most likely to try. The full table, 29 rows, is in [docs/requirements/offer-selection.md](docs/requirements/offer-selection.md). Rows 1, 3, 5, 6 and 16 are the spec's own examples.

| Row | Answers        | Lead | Result                  | Reason               |
| --- | -------------- | ---- | ----------------------- | -------------------- |
| 1   | women + asia   | none | offer 003               | `best_epu`           |
| 3   | women + europe | none | offer 004               | `best_epu`           |
| 5   | women + latam  | none | offer 007               | `fallback_universal` |
| 6   | men + latam    | none | offer 006               | `best_epu`           |
| 16  | women + asia   | 001  | offer 001, quiz skipped | `lead_return`        |

The report after each step of the demo, from an empty store:

| After  | visits | started | step_1 | step_2 | step_3 | completed | went_to_offer | transitions | lead | purchase |
| ------ | ------ | ------- | ------ | ------ | ------ | --------- | ------------- | ----------- | ---- | -------- |
| reset  | 0      | 0       | 0      | 0      | 0      | 0         | 0             | 0           | 0    | 0        |
| DEMO-2 | 1      | 1       | 1      | 1      | 1      | 1         | 1             | 1           | 0    | 0        |
| DEMO-3 | 1      | 1       | 1      | 1      | 1      | 1         | 1             | 1           | 1    | 0        |
| DEMO-4 | 2      | 1       | 1      | 1      | 1      | 1         | 1             | 2           | 1    | 0        |
| DEMO-5 | 2      | 1       | 1      | 1      | 1      | 1         | 1             | 2           | 1    | 1        |
| DEMO-6 | 2      | 1       | 1      | 1      | 1      | 1         | 1             | 2           | 1    | 1        |

DEMO-2 is the quiz, the offer and the click. DEMO-3 is the Lead, DEMO-4 the return visit, DEMO-5 the Purchase and DEMO-6 the same two postbacks again. DEMO-5 also moves offer 003's `lead_to_purchase` from 0 to 1, and these are the only cells the Purchase changes. The return visit counts as a visit and a transition, not as a start or a new user on the offer. Open `/report` in a browser to see the same numbers as a page.

## Deploy

A push to `main` runs the checks, applies the remote D1 migrations, then deploys the Worker. If a migration fails, the deploy does not run. The two secrets, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, are secrets of the GitHub Environment `argus-cloudflare`, which only `main` may deploy to; without them the deploy job fails. `GET /healthz` on the deployed Worker returns the commit sha it was built from.

## Spend to date

2026-11-04: account on Workers Paid, $5 a month. The design assumes Paid (Queue retention, D1 size); the demo alone would fit on Free.
