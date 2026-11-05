---
paths:
  - "docs/state/**"
  - "docs/plans/**"
  - "docs/ai/**"
---

# Progress, plans and AI log

- `docs/state/progress.json` is the only record of stage status. Change it in the same commit as the stage, and only after the stage's verification has run and its output was shown to the user. Status values come from `docs/state/progress.schema.json`; free text goes into `notes`.
- `pnpm state:check` validates the file and runs inside `pnpm check`; `pnpm stage:close <id>` is the only way a stage is closed.
- Finish the stage, update the state, commit. From Part 2 stage 4 on the stages run back to back (Arthur, 2026-11-05); before that it was one stage per session.
- A stage plan in `docs/plans/` lists the goal, the files or areas it touches, and the exact verification command or drill. A stage without a verification step is not a stage.
- Any change to the number, order or scope of stages gets an entry in `docs/ai/plan-history.md`: date, what changed, why. Append at the bottom; never rewrite earlier entries.
- When a session has an exchange where the AI proposed something, the user accepted, rejected or changed it, and the result was checked, draft it in `docs/ai/examples/` from `_template.md` and tell the user. Quote the real prompt. Record only what happened.
- No secrets, tokens, real emails or personal data in any of these files.
