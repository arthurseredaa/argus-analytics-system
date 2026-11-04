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
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm test
```

`pnpm typecheck` generates `worker-configuration.d.ts` first, so it works on a fresh checkout.

## Deploy

A push to `main` runs the checks, applies the remote D1 migrations, then deploys the Worker. If a migration fails, the deploy does not run. The two secrets, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, are secrets of the GitHub Environment `argus-cloudflare`, which only `main` may deploy to; without them the deploy job fails. `GET /healthz` on the deployed Worker returns the commit sha it was built from.

## Spend to date

2026-11-04: account on Workers Paid, $5 a month. The design assumes Paid (Queue retention, D1 size); the demo alone would fit on Free.
