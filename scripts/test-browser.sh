#!/usr/bin/env bash
# Runs the Playwright quiz test, locally against a fresh wrangler dev or remotely when BASE is set.
# Serves QZ-1 and R-12; the local run also scans the dev log and local state for the test email.
# Assumes .dev.vars exists and pnpm migrate:local and pnpm seed --local have run.
set -euo pipefail
set -m

if [ -n "${BASE:-}" ]; then
  rc=0
  pnpm exec playwright test || rc=$?
  echo "email-scan skipped: BASE is remote, only the request assertions in the spec ran"
  exit "$rc"
fi

if (exec 3<>/dev/tcp/127.0.0.1/8787) 2>/dev/null; then
  echo "port 8787 is busy: stop the other dev server first, its logs would hide the scan" >&2
  exit 1
fi

LOG="${TMPDIR:-/tmp}/wrangler-dev-$$.log"
pnpm exec wrangler dev --port 8787 >"$LOG" 2>&1 &
WRANGLER_PID=$!

# set -m gives the background job its own process group, so one signal reaches pnpm, wrangler and workerd.
stop_wrangler() {
  if [ -n "${WRANGLER_PID:-}" ]; then
    kill -- "-$WRANGLER_PID" 2>/dev/null || kill "$WRANGLER_PID" 2>/dev/null || true
    wait "$WRANGLER_PID" 2>/dev/null || true
    WRANGLER_PID=""
  fi
}
trap stop_wrangler EXIT

ready=0
for _ in $(seq 1 60); do
  if curl -sf http://localhost:8787/healthz >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "wrangler dev did not answer /healthz within 60 s, last 40 lines of $LOG:" >&2
  tail -n 40 "$LOG" >&2
  exit 1
fi

STATE_CODE="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8787/__test/state)"
if [ "$STATE_CODE" = "404" ]; then
  echo "/__test/state answered 404: set TEST_ROUTES=on in .dev.vars, then run pnpm migrate:local and pnpm seed --local" >&2
  exit 1
fi

export BASE=http://localhost:8787
pw_rc=0
pnpm exec playwright test || pw_rc=$?

stop_wrangler

scan_rc=0
bash scripts/email-scan.sh "$LOG" || scan_rc=$?

if [ "$pw_rc" -ne 0 ] || [ "$scan_rc" -ne 0 ]; then
  exit 1
fi
