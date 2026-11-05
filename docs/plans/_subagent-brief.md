# Brief for every subagent

Read this before your task brief. The task brief and the stage plan come after it.

## What this is

- An MVP on Cloudflare Workers that collects funnel events: one Worker built with Hono, two D1 databases, a Queue and R2.
- It is a paid test assignment, built in stages. Each stage has a plan in `docs/plans/`.
- Binding rules for the repository are in [CLAUDE.md](../../CLAUDE.md).
- The stage list is in [part2-mvp-stages.md](part2-mvp-stages.md).
- Decisions are in [docs/adr/](../adr/README.md).
- Tables and events are in [data-model.md](../design/data-model.md).

## Language and data

- Everything committed is in English, including comments and commit messages.
- No secrets, tokens, account ids or real emails in any committed file.
- Tests and fixtures use `user1@example.com` and other `@example.com` addresses only.
- The quiz email never reaches an event, a Queue message, a log line, a URL, an error response or localStorage.
- A log line is one JSON object. It names fields and never prints values from a request.

## Code

- Raw SQL lives in `src/db/` only.
- Every Queue send goes through `sendEvent()` in `src/events/producer.ts`.
- Times are Unix milliseconds in UTC.
- Each new file under `src/` opens with a comment of two or three lines. It names the component, the ADR and the requirement ids.
- Add no dependency unless the task says so.

## Tests

- Write the failing test first, see it fail, then write the code.
- A test name starts with the requirement id, then any R- or Q- id, then plain words.
- Unit tests go in `tests/unit/`, integration tests in `tests/integration/`, browser tests in `tests/e2e/`.
- `pnpm test -t "X"` runs the tests whose name matches X. `pnpm test -- -t "X"` runs all of them.
- Event tests call `call()` from `tests/fixtures/events.ts` with a captured Queue.
- A test never asserts a global row count. It makes its own user.

## Commands

- `pnpm check` runs typecheck, lint, format check, docs lint, state check and tests. The pre-commit hook runs it.
- Never commit with `--no-verify`.
- `pnpm fmt` formats the files.
- Run wrangler as `pnpm exec wrangler ...`.

## How to work

- Work only inside the worktree you were given.
- If the task brief and the code disagree, stop and report `NEEDS_CONTEXT`. Do not guess.
- Do not dispatch subagents of your own.
- Read your own diff before you report.
- The controller adds the commit trailer.
