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
