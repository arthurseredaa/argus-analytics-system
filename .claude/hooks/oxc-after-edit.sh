#!/usr/bin/env bash
# PostToolUse hook: after Edit, Write, MultiEdit and Bash, format the changed files with oxfmt,
# then lint the JS/TS ones with oxlint. After Bash the files come from git status.
# Prints nothing on success; exit 2 feeds stderr back to Claude.
set -u

command -v jq >/dev/null 2>&1 || exit 0

input="$(cat)"
IFS=$'\x1f' read -r tool cwd file < <(
  printf '%s' "$input" | jq -r '[.tool_name // "", .cwd // "", .tool_input.file_path // .tool_response.filePath // ""] | join("\u001f")'
)

has_ext() {
  case "${1##*.}" in
    ts | tsx | mts | cts | js | mjs | cjs | json | jsonc) return 0 ;;
    *) return 1 ;;
  esac
}

files=()

if [ "$tool" = "Bash" ]; then
  dir="${cwd:-${CLAUDE_PROJECT_DIR:-}}"
  if [ -z "$dir" ] || ! cd "$dir" 2>/dev/null; then
    exit 0
  fi
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
  cd "$root" || exit 0
  skip_next=0
  while IFS= read -r -d '' entry; do
    # A rename or copy entry is followed by a second entry holding the old name.
    if [ "$skip_next" = 1 ]; then
      skip_next=0
      continue
    fi
    status="${entry:0:2}"
    path="${entry:3}"
    case "$status" in *R* | *C*) skip_next=1 ;; esac
    case "$status" in *D*) continue ;; esac
    if [ -f "$path" ] && has_ext "$path"; then
      files+=("$path")
    fi
  done < <(git status --porcelain=v1 -z -uall 2>/dev/null)
else
  if [ -z "$file" ] || [ ! -f "$file" ]; then
    exit 0
  fi
  root="$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null)" || exit 0
  cd "$root" || exit 0
  files=("$file")
fi

if [ "${#files[@]}" -eq 0 ]; then
  exit 0
fi

if [ ! -x node_modules/.bin/oxfmt ]; then
  exit 0
fi

if ! fmt_out="$(node_modules/.bin/oxfmt --no-error-on-unmatched-pattern "${files[@]}" 2>&1)"; then
  {
    echo "oxfmt failed on: ${files[*]}"
    echo "$fmt_out"
  } >&2
  exit 2
fi

lint_files=()
for f in "${files[@]}"; do
  case "${f##*.}" in
    ts | tsx | mts | cts | js | mjs | cjs) lint_files+=("$f") ;;
  esac
done

if [ "${#lint_files[@]}" -eq 0 ] || [ ! -x node_modules/.bin/oxlint ]; then
  exit 0
fi

if ! lint_out="$(node_modules/.bin/oxlint --deny-warnings "${lint_files[@]}" 2>&1)"; then
  case "$lint_out" in
    *"No files found to lint"*) exit 0 ;;
  esac
  {
    echo "oxlint failed on: ${lint_files[*]}"
    echo "$lint_out"
  } >&2
  exit 2
fi

exit 0
