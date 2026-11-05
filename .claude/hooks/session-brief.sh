#!/usr/bin/env bash
# SessionStart hook: print the stage brief (next stage, plan file, last plan-history entry,
# open questions and risks, last commits) so the start-of-session ritual does not depend on memory.
# Never blocks a session: a missing tool or file only changes the line it affects.
set -u

if ! command -v jq >/dev/null 2>&1; then
  echo "Stage brief: jq not found, read docs/state/progress.json yourself"
  exit 0
fi

input="$(cat)"
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
dir="${cwd:-${CLAUDE_PROJECT_DIR:-}}"

root=""
if [ -n "$dir" ] && cd "$dir" 2>/dev/null; then
  root="$(git rev-parse --show-toplevel 2>/dev/null)"
fi
if [ -z "$root" ] && [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  root="$(git -C "$CLAUDE_PROJECT_DIR" rev-parse --show-toplevel 2>/dev/null)"
fi
if [ -z "$root" ] || ! cd "$root" 2>/dev/null; then
  echo "Stage brief: repository root not found, read docs/state/progress.json yourself"
  exit 0
fi

echo "## Stage brief (printed by .claude/hooks/session-brief.sh)"

stage_id=""
stage_title=""
if [ -f docs/state/progress.json ]; then
  IFS=$'\x1f' read -r stage_id stage_title < <(
    jq -r '[.stages[] | select(.status == "next" or .status == "in_progress")][0] | if . == null then "" else [(.id | tostring), .title] | join("\u001f") end' docs/state/progress.json 2>/dev/null
  )
fi

if [ -n "$stage_id" ]; then
  echo "Next stage: $stage_id \"$stage_title\" (docs/plans/part2-stage-$stage_id-*.md)"
  plan_file=""
  for f in docs/plans/part2-stage-"$stage_id"-*.md; do
    if [ -f "$f" ]; then
      plan_file="$f"
      break
    fi
  done
  if [ -n "$plan_file" ]; then
    echo "Stage plan file: present ($plan_file)"
  else
    echo "Stage plan file: missing (expected docs/plans/part2-stage-$stage_id-*.md)"
  fi
else
  echo "Next stage: unknown (docs/state/progress.json is missing or no stage is next or in_progress)"
  echo "Stage plan file: unknown"
fi

last_entry=""
if [ -f docs/ai/plan-history.md ]; then
  last_entry="$(grep '^## ' docs/ai/plan-history.md | tail -n 1 | sed 's/^## //')"
fi
echo "Last plan-history entry: ${last_entry:-none found in docs/ai/plan-history.md}"

open_q="no file"
if [ -f docs/requirements/open-questions.md ]; then
  open_q="$(grep -c '| open |' docs/requirements/open-questions.md)"
fi
risks="no file"
if [ -f docs/requirements/risks.md ]; then
  risks="$(grep -c '^| R-' docs/requirements/risks.md)"
fi
echo "Open questions: $open_q rows marked open in docs/requirements/open-questions.md; risks: $risks rows in docs/requirements/risks.md"

echo "Last commits:"
git log --oneline -5 2>/dev/null
echo "Read the stage plan before doing anything else."

exit 0
