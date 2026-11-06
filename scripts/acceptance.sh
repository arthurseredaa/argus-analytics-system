# Shell helpers for the acceptance cards in docs/testing/acceptance-checks.md.
# Source it, do not run it: source scripts/acceptance.sh. It sets BASE, TMP and JAR when unset.
if [[ -n ${BASH_SOURCE[0]:-} && ${BASH_SOURCE[0]} == "$0" ]] || [[ -n ${ZSH_EVAL_CONTEXT:-} && ${ZSH_EVAL_CONTEXT} != *:file* ]]; then
  echo "source this file: source scripts/acceptance.sh" >&2
  exit 1
fi

: "${BASE:=http://localhost:8787}"
: "${TMP:=$(mktemp -d)}"
: "${JAR:=$TMP/user1.jar}"
export BASE TMP JAR

state() { curl -s -b "$1" "$BASE/__test/state" | jq -S .; }
snap()  { { state "$JAR"; curl -s "$BASE/api/report" | jq -S .; } > "$1"; }
answer() { # answer <jar> <question_key> <value> [seq]: one step_answered event, analytics only
  step=$([ "$2" = gender ] && echo 1 || echo 2)
  curl -s -b "$1" -c "$1" -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/events" -H 'content-type: application/json' \
    -d "{\"event_id\":\"$(uuidgen | tr A-Z a-z)\",\"schema_version\":1,\"type\":\"step_answered\",\"client_time\":$(date +%s)000,\"visit_id\":\"v1\",\"seq\":${4:-1},\"prelander_id\":\"demo\",\"payload\":{\"step\":$step,\"question_key\":\"$2\",\"value\":\"$3\"}}"
}
complete() { # complete <jar> <gender> <ethnicity> <email>: the only call that writes answers and email to D1
  curl -s -b "$1" -c "$1" -X POST "$BASE/api/complete" -H 'content-type: application/json' \
    -d "{\"prelander_id\":\"demo\",\"answers\":{\"gender\":\"$2\",\"ethnicity\":\"$3\"},\"email\":\"$4\"}"
}
viewstep() { # viewstep <jar> <step> [seq]: one step_viewed event, analytics only, prints the HTTP status
  curl -s -b "$1" -c "$1" -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/events" -H 'content-type: application/json' \
    -d "{\"event_id\":\"$(uuidgen | tr A-Z a-z)\",\"schema_version\":1,\"type\":\"step_viewed\",\"client_time\":$(date +%s)000,\"visit_id\":\"v1\",\"seq\":${3:-1},\"prelander_id\":\"demo\",\"payload\":{\"step\":$2,\"prefilled\":false}}"
}
report() { # report [query]: the report as sorted JSON without the two fields that change on every call
  curl -s "$BASE/api/report${1:+?$1}" | jq -S 'del(.as_of, .events_newest_at)'
}
health() { # health: the pipeline health from /__test/health as sorted JSON
  curl -s "$BASE/__test/health" | jq -S .
}
wait_report() { # wait_report <jq filter> <expected> [seconds]: polls every 3 seconds, default 150; prints the last value and returns 1 on timeout
  local deadline got
  deadline=$(( $(date +%s) + ${3:-150} ))
  while :; do
    got=$(curl -s "$BASE/api/report" | jq -r "$1" 2>/dev/null || true)
    [ "$got" = "$2" ] && return 0
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "$got"
      return 1
    fi
    sleep 3
  done
}
wait_health() { # wait_health <jq filter> <expected> [seconds]: like wait_report, on /__test/health
  local deadline got
  deadline=$(( $(date +%s) + ${3:-150} ))
  while :; do
    got=$(curl -s "$BASE/__test/health" | jq -r "$1" 2>/dev/null || true)
    [ "$got" = "$2" ] && return 0
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "$got"
      return 1
    fi
    sleep 3
  done
}
