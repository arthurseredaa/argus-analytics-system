# Funnels analytics events system

Paid test assignment for Unicorn Pro (Senior Full-Stack Engineer, AI & Automation). The spec is `requirements.pdf`, written in Ukrainian. Part 1 is a system design, Part 2 an MVP deployed to Cloudflare. The spec describes a design review between the two, but the company said on 2026-10-30 that it does not do one: everything is delivered at once (`docs/ai/plan-history.md`, entry of 2026-11-03). The design is still written before the code, and open questions keep the defaults the MVP implements.

## Language

- Talk to the user in Ukrainian.
- Everything committed to the repo (docs, ADRs, README, code comments, commit messages) is in English. The one exception is `docs/requirements/open-questions.md`, which is in Ukrainian since it goes to the company unchanged.
- Use the `humanizer` skill for every piece of prose that goes into the repo.
- Use the `plain-tech-report` skill for chat replies to the user that report on finished or partly finished work or explain a technical concept, cause or mechanism. It is for chat, not for repo files.

## Where things live

- `docs/requirements/`: the spec broken down into requirements, open questions, assumptions, risks, proposals and research notes.
- `docs/design/`: the Part 1 design document and diagrams.
- `docs/adr/`: architecture decision records, one decision per file.
- `docs/plans/`: implementation plans, one file per stage.
- `docs/testing/`: acceptance checks, one card per requirement, run when that requirement is implemented.
- `docs/ai/`: evidence of AI-assisted work, which the spec asks for explicitly.

## ADRs

Start from `docs/adr/0000-template.md` and number files sequentially. Write one for a decision that is expensive to reverse and has at least two real options (storage, queue, user identity, postback auth, and so on). Reversible choices go into the stage plan instead. Once an ADR is accepted, its decision is not edited: write a new ADR that supersedes it and change the old one's status line. Details in `.claude/rules/adr.md`.

## AI work log

The spec asks for the agent instructions (this file), the initial plan, significant plan changes, and two or three real examples in the form "task given to AI, what it proposed, what was decided, how it was verified".

- When a plan changes materially, append an entry to `docs/ai/plan-history.md` with the date, the change and the reason.
- When a session produces a good example (the AI proposed something, the user accepted, rejected or changed it, and the result was checked), draft it in `docs/ai/examples/` from the template and tell the user. These are candidates; the user picks the final two or three.
- No secrets, tokens, real emails or other personal data in any of these files.

## Session ritual

- Start: the SessionStart hook prints the stage brief (next stage, last plan-history entry, open questions and risks, last commits). Read the stage plan it names. Once `docs/state/progress.json` names a stage as next, that is the only stage worked on.
- End: one squash-merged commit for the stage, state and plan history updated, and a one-paragraph note to the user on what is left, with the stage's explain-back questions. Nothing half-done is left uncommitted without a note.
- Path-scoped rules in `.claude/rules/` say how to write ADRs, requirements, plans and the AI log. They load when those files are touched.

## Working rules

- Work in stages. Every implementation stage is followed by a verification step. From Part 2 stage 4 on (Arthur, 2026-11-05, see `docs/ai/plan-history.md`), stages run back to back with no approval gate: the AI squash-merges each stage PR once CI is green, checks the deployed Worker and starts the next stage. It stops only when it needs something from Arthur. Before stage 4 each stage waited for his approval.
- Do not claim something works without showing the command output that proves it.
- Ambiguities in the spec go to `docs/requirements/open-questions.md` before implementation. Do not settle them silently in code.
- Email addresses never go into URLs or logs. Tests and fixtures use synthetic `@example.com` addresses only.
- Every prompt to a subagent starts with: read `docs/plans/_subagent-brief.md` first. The task brief and the stage plan come after it.
- When a measurement misses a target, find the cause before proposing a fix. A target is not moved to fit a result without Arthur's decision.

## How a Part 2 stage runs

This is how the Part 2 stages ran. Each one went to `main` as one squash-merged PR from the branch `part2-stage-<n>`; stages 0 to 3 also waited for Arthur's approval before the merge.

1. Plan. The stage text in `docs/plans/part2-mvp-stages.md` becomes a plan file `docs/plans/part2-stage-<n>-<topic>.md`, written with the `superpowers:writing-plans` skill. It lists the decisions the stage text leaves open and the exact verification. The plan is the first commit of the stage.
2. Isolation. Each stage gets a git worktree under `.claude/worktrees/part2-stage-<n>` on the branch `part2-stage-<n>`, which goes to `main` through one PR.
3. Code. From stage 4 on, the `superpowers:subagent-driven-development` skill runs the plan task by task. Sonnet subagents implement, each task gets a review, and Opus reviews the whole branch at the end. Fable does cold reads of documents meant for a reader who has not seen the project, such as the README.
4. Limits on subagents. They never push. They never run anything against the deployed Worker: no `--remote` and no `BASE` of the real URL. Drills and load tests against the deployed Worker are run by the main session after the merge.
5. Secrets. Arthur sets Worker secrets himself with `wrangler secret put`. Their values never pass through the AI. Scripts that need a token read it from `.dev.vars.remote` inside the shell and print only the result.
6. Close. The `close-stage` skill runs the verification, `pnpm stage:close`, the "What to show at the review" row and the PR. From stage 4 on, once CI is green, the AI squash-merges, removes the worktree, pulls `main`, waits for the deploy run and checks `/healthz` and the stage's deployed behaviour.
7. Known CI noise. The `e2e` job sometimes hits its 3-minute timeout while installing Chromium's system libraries. `gh run rerun <id> --failed` fixes it; the tests themselves did not fail.
