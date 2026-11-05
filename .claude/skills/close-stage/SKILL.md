---
name: close-stage
description: "Close the current stage of docs/plans/part2-mvp-stages.md: verify, record, commit, open the PR. Use when Arthur approves a stage or says \"закриваємо етап\"."
---

# Close a stage

Work through the list in order. Stop at the first step that fails and tell Arthur.

1. Run the stage's Verify steps from its plan file and paste the output in the chat. If anything fails, stop here.
2. Run `pnpm check` in the worktree. It must pass.
3. Write a notes file from the stage's decisions, rulings, defects found in review and what was deferred. Then run `pnpm stage:close <id> --verified "<the commands run, as in the plan>" --notes-file <path>`.
4. Add the stage's row to "What to show at the review" in `docs/plans/part2-mvp-stages.md` and tick the stage's checkboxes.
5. If the number, order or scope of stages changed, append to `docs/ai/plan-history.md`. If the session has an example worth keeping, draft it in `docs/ai/examples/`.
6. Commit `docs: close stage <id>, <title>` with only those doc changes and push the branch. Open the PR with `gh pr create --body-file`. The body lists what the stage built, the decisions, and the verify output in a details block. The PR is squash-merged, so the stage lands on `main` as one commit with its `progress.json` change, which is what `.claude/rules/state.md` requires.
7. After Arthur merges, back in the main checkout, remove the worktree with `git worktree remove`, then run `git checkout main && git pull --ff-only`. Wait for the `main` run to be green with `gh run watch`, then check the deployed Worker by hand as the stage says.
8. Tell Arthur in one paragraph what is left.
