# Shell helpers: start and stop a local wrangler dev on port 8787 for the scripts that need one.
# Source it, do not run it. Used by scripts/test-browser.sh and scripts/demo.sh (QZ-1, R-12, MVP-1).
# Needs .dev.vars with TEST_ROUTES=on, and pnpm migrate:local and pnpm seed --local run before.

DEV_SERVER_PID=""

# start_dev_server <log file>: the port check, wrangler dev in its own process group, /healthz within
# 60 seconds, and the check that the test routes are on. It exits the calling script on failure.
start_dev_server() {
  local log="$1" ready=0 state_code
  if (exec 3<>/dev/tcp/127.0.0.1/8787) 2>/dev/null; then
    echo "port 8787 is busy: stop the other dev server first, its logs would hide the scan" >&2
    exit 1
  fi

  # set -m gives the background job its own process group, so one signal reaches pnpm, wrangler and workerd.
  set -m
  pnpm exec wrangler dev --port 8787 >"$log" 2>&1 </dev/null &
  DEV_SERVER_PID=$!

  for _ in $(seq 1 60); do
    if curl -sf http://localhost:8787/healthz >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    echo "wrangler dev did not answer /healthz within 60 s, last 40 lines of $log:" >&2
    tail -n 40 "$log" >&2
    exit 1
  fi

  state_code="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8787/__test/state)"
  if [ "$state_code" = "404" ]; then
    echo "/__test/state answered 404: set TEST_ROUTES=on in .dev.vars, then run pnpm migrate:local and pnpm seed --local" >&2
    exit 1
  fi
}

stop_dev_server() {
  if [ -n "${DEV_SERVER_PID:-}" ]; then
    kill -- "-$DEV_SERVER_PID" 2>/dev/null || kill "$DEV_SERVER_PID" 2>/dev/null || true
    wait "$DEV_SERVER_PID" 2>/dev/null || true
    DEV_SERVER_PID=""
  fi
}
