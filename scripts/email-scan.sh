#!/usr/bin/env bash
# Scans a wrangler dev log and the local state (D1, Queue, KV) for the test email address.
# Serves R-12 (the address never reaches logs or storage in clear): run after the browser test.
# Usage: bash scripts/email-scan.sh <wrangler-log>   Exit 0 clean, 1 hits found, 2 usage error.
set -euo pipefail

NEEDLE="user1@example.com"
ENCODED="user1%40example.com"

LOG="${1:-}"
if [ -z "$LOG" ] || [ ! -f "$LOG" ]; then
  echo "usage: bash scripts/email-scan.sh <wrangler-log> (the log file must exist)" >&2
  exit 2
fi

ROOT="$(git rev-parse --show-toplevel)"
STATE="$ROOT/.wrangler/state/v3"
if [ ! -d "$STATE" ]; then
  echo "usage: no local state at $STATE, run pnpm migrate:local and pnpm seed --local first" >&2
  exit 2
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
