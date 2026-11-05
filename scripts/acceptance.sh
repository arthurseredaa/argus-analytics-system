# Shell helpers for the acceptance cards in docs/testing/acceptance-checks.md.
# Source it, do not run it: source scripts/acceptance.sh. It sets BASE, TMP and JAR when unset.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
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
