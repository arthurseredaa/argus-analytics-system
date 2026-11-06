#!/usr/bin/env bash
# Scans for the test email address in logs, local state, event files and the events table.
# Serves DEMO-8 and R-12; ADR 0002 (identity) is why the user id is checked beside it in the tests. Three modes:
#   bash scripts/email-scan.sh <wrangler-log>   a local dev log and the local state (D1, Queue, KV), run after the browser test
#   bash scripts/email-scan.sh --dir <dir>      every file under <dir>
#   bash scripts/email-scan.sh --remote <tail-log> --since <ms>
#       a `wrangler tail` capture, the event files the Worker wrote to R2 since <ms> and the events rows
#       received since <ms>; needs BASE to start with https://, a wrangler login and jq. It first waits until
#       GET $BASE/__test/health shows no pending file (the loader moves each one to loaded/), polling every
#       EMAIL_SCAN_POLL_SECONDS (default 10) for up to EMAIL_SCAN_WAIT_SECONDS (default 180)
# Exit 0 clean, 1 the address was found, 2 usage error or nothing to scan (no R2 file, an empty tail log, no events row).
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

# Polls the health route until it shows no pending file; exits 2 when that does not happen in time.
wait_for_empty_pending() {
  local interval="${EMAIL_SCAN_POLL_SECONDS:-10}" limit="${EMAIL_SCAN_WAIT_SECONDS:-180}"
  case "$interval$limit" in
    '' | *[!0-9]*) usage "EMAIL_SCAN_POLL_SECONDS and EMAIL_SCAN_WAIT_SECONDS must be whole numbers" ;;
  esac
  if [ "$interval" -lt 1 ]; then
    usage "EMAIL_SCAN_POLL_SECONDS must be at least 1"
  fi
  local waited=0 pending
  while true; do
    # Never follow a redirect: the health route is a plain 200 or an error.
    pending="$(curl -s -S -f --max-time 30 "$BASE/__test/health" | jq -r '.pending_files // empty' 2>/dev/null || true)"
    case "$pending" in
      0) return 0 ;;
    esac
    if [ "$waited" -ge "$limit" ]; then
      usage "pending/ still holds files after ${limit}s (pending_files: ${pending:-unknown}); the loader has not caught up, run the scan later"
    fi
    sleep "$interval"
    waited=$((waited + interval))
  done
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
  if ! command -v jq >/dev/null 2>&1; then
    usage "jq is required for the remote scan, install it first"
  fi

  local work
  work="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" EXIT
  mkdir "$work/r2"
  cp "$tail_log" "$work/tail.log"

  # The loader deletes each pending file once it has written the loaded/ file with the same rows, so list
  # only when none is left: a key listed now would often be gone before it is fetched.
  wait_for_empty_pending

  # Never follow a redirect: the listing is a plain 200 or an error.
  if ! curl -s -S -f --max-time 30 "$BASE/__test/files?since=$since" >"$work/files.json"; then
    usage "cannot list the event files at $BASE/__test/files (is TEST_ROUTES on?)"
  fi
  if ! jq -e '(.keys | type == "array") and .truncated == false' "$work/files.json" >/dev/null 2>&1; then
    usage "the file list is truncated or malformed, pass a later --since so that fewer than 1000 files match"
  fi
  jq -r '.keys[]' "$work/files.json" >"$work/keys.txt"
  if [ ! -s "$work/keys.txt" ]; then
    usage "no event file was written since $since, a scan over nothing proves nothing"
  fi

  # k counts the files fetched. wrangler gets </dev/null so that it cannot read the key list.
  local key k=0
  while IFS= read -r key; do
    case "$key" in
      pending/* | loaded/* | rejected/*) ;;
      *) usage "unexpected key in the file list" ;;
    esac
    case "$key" in
      *[!A-Za-z0-9._/-]* | *..*) usage "unexpected key in the file list" ;;
    esac
    if pnpm -s exec wrangler r2 object get "$BUCKET/$key" --remote --pipe \
      >"$work/r2/$(printf '%s' "$key" | tr '/' '_')" 2>"$work/r2-error.txt" </dev/null; then
      k=$((k + 1))
    elif grep -q "does not exist" "$work/r2-error.txt"; then
      # Gone since the listing: the loader moved it to loaded/, which holds the same rows.
      rm -f "$work/r2/$(printf '%s' "$key" | tr '/' '_')"
      echo "email-scan: $key is gone, skipped" >&2
    else
      usage "cannot read $key from the bucket (is wrangler logged in?)"
    fi
  done <"$work/keys.txt"
  if [ "$k" -eq 0 ]; then
    usage "no event file could be read, a scan over nothing proves nothing"
  fi

  if ! pnpm -s exec wrangler d1 execute "$EVENTS_DB" --remote --json \
    --command "SELECT * FROM events WHERE received_at >= $since" >"$work/events.json" </dev/null; then
    usage "cannot read the events table (is wrangler logged in?)"
  fi
  local r lines
  if ! r="$(jq '[.[].results | length] | add // 0' "$work/events.json" 2>/dev/null)"; then
    usage "the events dump is not the JSON that wrangler d1 execute --json prints"
  fi
  lines="$(grep -c '' "$work/tail.log" || true)"
  # A scan over a channel with nothing in it proves nothing. An empty tail log usually means that
  # wrangler tail did not attach.
  if [ "$lines" -eq 0 ]; then
    usage "the tail log has 0 lines, wrangler tail probably did not attach, so the logs were not scanned"
  fi
  if [ "$r" -eq 0 ]; then
    usage "the events query returned 0 rows since $since, so the events table was not scanned"
  fi

  scan_dir "$work" "tail $lines lines, $k R2 files, $r events rows"
}

case "${1:-}" in
  --dir)
    scan_directory_mode "${2:-}"
    exit $?
    ;;
  --remote)
    shift
    scan_remote_mode ${1+"$@"}
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
