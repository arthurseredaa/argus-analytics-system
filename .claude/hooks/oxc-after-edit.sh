#!/usr/bin/env bash
# PostToolUse hook: format the edited file with oxfmt, then lint JS/TS files with oxlint.
# Exit 2 feeds stderr back to Claude.
set -u

input="$(cat)"
file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_response.filePath // empty')"

if [ -z "$file" ] || [ ! -f "$file" ]; then
  exit 0
fi

root="$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$root" || exit 0

if [ ! -x node_modules/.bin/oxfmt ]; then
  exit 0
fi

if ! fmt_out="$(node_modules/.bin/oxfmt --no-error-on-unmatched-pattern "$file" 2>&1)"; then
  {
    echo "oxfmt failed on $file:"
    echo "$fmt_out"
  } >&2
  exit 2
fi

case "${file##*.}" in
  ts | tsx | mts | cts | js | mjs | cjs) ;;
  *) exit 0 ;;
esac

if [ ! -x node_modules/.bin/oxlint ]; then
  exit 0
fi

if ! lint_out="$(node_modules/.bin/oxlint --deny-warnings "$file" 2>&1)"; then
  case "$lint_out" in
    *"No files found to lint"*) exit 0 ;;
  esac
  {
    echo "oxlint failed on $file:"
    echo "$lint_out"
  } >&2
  exit 2
fi

exit 0
