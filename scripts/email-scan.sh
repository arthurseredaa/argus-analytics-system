#!/usr/bin/env bash
# Scans for the test email address in logs, local state, event files and the events table.
# Serves DEMO-8 and R-12; ADR 0002 (identity) is why the user id is checked beside it in the tests. Three modes:
#   bash scripts/email-scan.sh <wrangler-log>   a local dev log and the local state (D1, Queue, KV), run after the browser test
#   bash scripts/email-scan.sh --dir <dir>      every file under <dir>
#   bash scripts/email-scan.sh --remote <tail-log> --since <ms>
#       a `wrangler tail` capture, the event files the Worker wrote to R2 since <ms> and the events rows
#       received since <ms>; needs BASE to start with https:// and a wrangler login
# Exit 0 clean, 1 the address was found, 2 usage error or nothing to scan.
set -euo pipefail

NEEDLE="user1@example.com"
ENCODED="user1%40example.com"
# The bucket the Worker binds as EVENTS_BUCKET (wrangler.jsonc); a unit test keeps the two equal.
BUCKET="funnels-events"
EVENTS_DB="events"

usage() {
  echo "usage: $1" >&2
  exit 2
}

# Scans every file under $1; $2 is the text inside the parentheses of the clean line.
# Paths in the FOUND output are relative to $1.
scan_dir() {
  local dir="$1" summary="$2" hits
  hits="$(grep -a -r -l -F -e "$NEEDLE" -e "$ENCODED" "$dir" || true)"
  if [ -z "$hits" ]; then
    echo "email-scan: clean ($summary)"
    return 0
  fi
  echo "email-scan: FOUND the address"
  printf '%s\n' "$hits" | sed "s|^$dir/||; s/^/  /"
  return 1
}

count_files() {
  find "$1" -type f | wc -l | tr -d ' '
}

scan_directory_mode() {
  local dir="${1:-}" n
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then
    usage "bash scripts/email-scan.sh --dir <dir> (the directory must exist)"
  fi
  n="$(count_files "$dir")"
  if [ "$n" -eq 0 ]; then
    usage "nothing to scan in $dir, a scan over no files proves nothing"
  fi
  scan_dir "$dir" "$n files"
}

scan_remote_mode() {
  local tail_log="" since=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --since)
        since="${2:-}"
        shift 2 || shift
        ;;
      *)
        tail_log="$1"
        shift
        ;;
    esac
  done
  local form="bash scripts/email-scan.sh --remote <tail-log> --since <ms>"
  case "${BASE:-}" in
    https://*) ;;
    *) usage "$form (BASE must start with https://, it is the deployed Worker)" ;;
  esac
  case "$since" in
    '' | *[!0-9]*) usage "$form (--since is a time in Unix milliseconds)" ;;
  esac
  if [ -z "$tail_log" ] || [ ! -f "$tail_log" ]; then
    usage "$form (the tail log must exist)"
  fi

  local work
  work="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" EXIT
  mkdir "$work/r2"
  cp "$tail_log" "$work/tail.log"

  # Never follow a redirect: the listing is a plain 200 or an error.
  if ! curl -s -S -f --max-time 30 "$BASE/__test/files?since=$since" >"$work/files.json"; then
    usage "cannot list the event files at $BASE/__test/files (is TEST_ROUTES on?)"
  fi
  if ! jq -e '(.keys | type == "array") and .truncated == false' "$work/files.json" >/dev/null 2>&1; then
    usage "the file list is truncated or malformed, pass a later --since so that fewer than 1000 files match"
  fi
  jq -r '.keys[]' "$work/files.json" >"$work/keys.txt"
  local k
  k="$(wc -l <"$work/keys.txt" | tr -d ' ')"
  if [ "$k" -eq 0 ]; then
    usage "no event file was written since $since, a scan over nothing proves nothing"
  fi

  local key
  while IFS= read -r key; do
    case "$key" in
      pending/* | loaded/* | rejected/*) ;;
      *) usage "unexpected key in the file list" ;;
    esac
    case "$key" in
      *[!A-Za-z0-9._/-]* | *..*) usage "unexpected key in the file list" ;;
    esac
    if ! pnpm -s exec wrangler r2 object get "$BUCKET/$key" --remote --pipe \
      >"$work/r2/$(printf '%s' "$key" | tr '/' '_')"; then
      usage "cannot read $key from the bucket (is wrangler logged in?)"
    fi
  done <"$work/keys.txt"

  if ! pnpm -s exec wrangler d1 execute "$EVENTS_DB" --remote --json \
    --command "SELECT * FROM events WHERE received_at >= $since" >"$work/events.json"; then
    usage "cannot read the events table (is wrangler logged in?)"
  fi
  local r lines
  r="$(jq '[.[].results | length] | add // 0' "$work/events.json")"
  lines="$(wc -l <"$work/tail.log" | tr -d ' ')"

  scan_dir "$work" "tail $lines lines, $k R2 files, $r events rows"
}

case "${1:-}" in
  --dir)
    scan_directory_mode "${2:-}"
    exit $?
    ;;
  --remote)
    shift
    scan_remote_mode "$@"
    exit $?
    ;;
esac

LOG="${1:-}"
if [ -z "$LOG" ] || [ ! -f "$LOG" ]; then
  usage "bash scripts/email-scan.sh <wrangler-log> (the log file must exist), or --dir <dir>, or --remote <tail-log> --since <ms>"
fi

ROOT="$(git rev-parse --show-toplevel)"
STATE="$ROOT/.wrangler/state/v3"
if [ ! -d "$STATE" ]; then
  usage "no local state at $STATE, run pnpm migrate:local and pnpm seed --local first"
fi

LOG_HITS="$(grep -c -F -e "$NEEDLE" -e "$ENCODED" "$LOG" || true)"
STATE_HITS="$(grep -a -r -l -F -e "$NEEDLE" -e "$ENCODED" "$STATE" || true)"
STATE_COUNT=0
if [ -n "$STATE_HITS" ]; then
  STATE_COUNT="$(printf '%s\n' "$STATE_HITS" | wc -l | tr -d ' ')"
fi

if [ "$LOG_HITS" -eq 0 ] && [ "$STATE_COUNT" -eq 0 ]; then
  echo "email-scan: clean (log $LOG_HITS lines, $STATE_COUNT state files)"
  exit 0
fi

echo "email-scan: FOUND the address (log $LOG_HITS lines, $STATE_COUNT state files)"
if [ "$LOG_HITS" -gt 0 ]; then
  echo "log lines:"
  grep -n -F -e "$NEEDLE" -e "$ENCODED" "$LOG" | sed 's/^/  /'
fi
if [ "$STATE_COUNT" -gt 0 ]; then
  echo "state files:"
  printf '%s\n' "$STATE_HITS" | sed 's/^/  /'
fi
exit 1
