#!/usr/bin/env bash
# Runs the Playwright quiz test, locally against a fresh wrangler dev or remotely when BASE is set.
# Serves QZ-1 and R-12; the local run also scans the dev log and local state for the test email.
# Assumes .dev.vars exists and pnpm migrate:local and pnpm seed --local have run.
set -euo pipefail

if [ -n "${BASE:-}" ]; then
  rc=0
  pnpm exec playwright test || rc=$?
  echo "email-scan skipped: BASE is remote, only the request assertions in the spec ran"
  exit "$rc"
fi

# shellcheck source=lib/dev-server.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/dev-server.sh"

LOG="${TMPDIR:-/tmp}/wrangler-dev-$$.log"
trap stop_dev_server EXIT
start_dev_server "$LOG"

export BASE=http://localhost:8787
pw_rc=0
pnpm exec playwright test || pw_rc=$?

stop_dev_server

scan_rc=0
bash scripts/email-scan.sh "$LOG" || scan_rc=$?

if [ "$pw_rc" -ne 0 ] || [ "$scan_rc" -ne 0 ]; then
  exit 1
fi
