# Example 12: security audit, fix or record

- Date: 2026-11-06
- Stage: between stage 9 and stage 10

## Task given to the AI

"ми не проганяли скіл cloudflare security audit". After the report: "що краще - фіксити це все чи записати як відомі моменти які можна покращити?"

## What the AI proposed

The AI ran the `security-audit` skill as a `quick` profile that read source only, because Arthur chose not to let it run code. Four agents mapped the system, five hunted, one checked coverage and eight verified. One verifier answer broke the result schema, so the AI dropped it unrepaired and ran a fresh verifier. No finding was confirmed. Seven leads were left as "needs validation", and the verifiers corrected two of them: seeded Leads do not inflate payout, and the event id clash does not reach the report.

For the second question the AI proposed a split. Three fixes are small and each has a test: a streamed body cap on `/api/events` and `/api/complete`, a same-origin check on both, and browser EventIDs limited to lowercase UUID v4. One item needed Arthur's call, because the documents promised something the code did not do: Q-15 and R-14 named rate limiting, and the code had none. The AI gave two options, build it or write "not in the MVP". The remaining leads would be recorded as known limitations.

## Decision

Arthur accepted the split. For rate limiting he wrote: "там де треба моє рішення - написати "не в mvp", не хочу ще витрачати час на фікси, й так дуже багато роботи зроблено". Q-15 and R-14 now say rate limiting is not in the MVP. The open test routes on the demo stay as they are and are recorded as R-25.

## Verification

- `pnpm check`: 50 test files, 532 tests passed, along with typecheck, lint, docs lint and state check.
- New tests: `R-14 a streamed body over 4 KB without content-length is rejected with 413`, `NFR-2 a completion body over 4 KB is rejected with 413 and nothing is stored`, the `R-26` tests (a cross-site POST gets `403` and no cookie), `R-27 a browser event cannot take the version 8 id of a postback event`.
- `pnpm test:browser` passed locally and the email scan was clean. The first run failed because the new worktree had an empty local catalog. After `pnpm seed --local` it passed.
- `pnpm test:e2e` against local `wrangler dev`: `demo passed`.
