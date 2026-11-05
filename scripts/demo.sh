#!/usr/bin/env bash
# Runs the demo scenario of docs/testing/acceptance-checks.md (DEMO-2 to DEMO-6) with every answer asserted.
# Serves MVP-1 and the DEMO cards. Usage: bash scripts/demo.sh [--base <url>], or pnpm test:e2e [--base <url>].
# The base is --base, then BASE, else a local wrangler dev started here and stopped on exit. The script resets
# the store first. A local run needs .dev.vars, pnpm migrate:local and pnpm seed --local; a remote run needs
# .dev.vars.remote for pnpm postback. Prints "ok <step>" per passed check; on the first mismatch it prints
# "FAIL <step>: expected <x>, got <y>" and exits 1.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
  echo "usage: bash scripts/demo.sh [--base <url>]" >&2
  exit 2
}

base_arg=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      [ $# -ge 2 ] || usage
      base_arg="$2"
      shift 2
      ;;
    --) shift ;;
    *) usage ;;
  esac
done

TMP="$(mktemp -d)"
export TMP
LOCAL_LOG=""
cleanup() {
  stop_dev_server 2>/dev/null || true
  rm -rf "$TMP"
}

# shellcheck source=lib/dev-server.sh
source scripts/lib/dev-server.sh
trap cleanup EXIT

if [ -n "$base_arg" ]; then
  BASE="$base_arg"
elif [ -z "${BASE:-}" ]; then
  LOCAL_LOG="$TMP/wrangler-dev.log"
  start_dev_server "$LOCAL_LOG"
  BASE=http://localhost:8787
fi
BASE="${BASE%/}"
export BASE

# shellcheck source=acceptance.sh
source scripts/acceptance.sh

fail() { # fail <step> <expected> <got>
  echo "FAIL $1: expected $2, got $3"
  if [ -n "$LOCAL_LOG" ] && [ -f "$LOCAL_LOG" ]; then
    echo "last 20 lines of the wrangler dev log:" >&2
    tail -n 20 "$LOCAL_LOG" >&2
  fi
  exit 1
}
check() { # check <step> <expected> <got>
  if [ "$2" = "$3" ]; then echo "ok $1"; else fail "$1" "$2" "$3"; fi
}
check_match() { # check_match <step> <regex> <got>
  if printf '%s\n' "$3" | grep -Eq "$2"; then echo "ok $1"; else fail "$1" "/$2/" "$3"; fi
}
expect_report() { # expect_report <step> <jq filter> <expected> [seconds]: polls until the report matches
  local got
  if got="$(wait_report "$2" "$3" "${4:-90}")"; then echo "ok $1"; else fail "$1" "$3" "$got"; fi
}

JAR="$TMP/demo.jar"
FINAL_FIELDS='.visits,.started,.step_1,.step_2,.step_3,.completed,.went_to_offer,.transitions,.lead,.purchase'

check "reset" '{"ok":true}' "$(curl -s -X POST "$BASE/__test/reset" | jq -c .)"

# DEMO-2: new user, quiz, offer
check "DEMO-2 entry 200" 200 "$(curl -s -c "$JAR" -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/p/demo")"
check "DEMO-2 step 1 viewed 202" 202 "$(viewstep "$JAR" 1 1)"
check "DEMO-2 gender answered 202" 202 "$(answer "$JAR" gender women 2)"
check "DEMO-2 step 2 viewed 202" 202 "$(viewstep "$JAR" 2 3)"
check "DEMO-2 ethnicity answered 202" 202 "$(answer "$JAR" ethnicity asia 4)"
check "DEMO-2 step 3 viewed 202" 202 "$(viewstep "$JAR" 3 5)"
check "DEMO-2 complete gives 003 best_epu" '{"offer_id":"003","reason":"best_epu"}' \
  "$(complete "$JAR" women asia user1@example.com | jq -c '{offer_id,reason}')"
go="$(curl -s -b "$JAR" -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE/go?prelander=demo")"
check "DEMO-2 go 302" 302 "${go%% *}"
CLICK="${go##*click_id=}"
check_match "DEMO-2 go click id is 32 hex" '^[0-9a-f]{32}$' "$CLICK"
expect_report "DEMO-2 report" '[.visits,.started,.step_2,.step_3,.completed]|@csv' '1,1,1,1,1'

# DEMO-3: Lead for that click
lead="$(pnpm -s postback lead --click "$CLICK" --txn DEMO-L1 --base "$BASE")"
echo "$lead"
check_match "DEMO-3 lead accepted" '^202' "$lead"
expect_report "DEMO-3 report lead 1" '.lead' 1

# DEMO-4: return without the quiz
back="$(curl -s -b "$JAR" -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE/p/demo")"
echo "$back"
check_match "DEMO-4 return redirects to the offer" '^302 https://asia-connect\.example/\?click_id=[0-9a-f]{32}$' "$back"
if [ "${back##*click_id=}" = "$CLICK" ]; then fail "DEMO-4 return gets a new click id" "an id other than $CLICK" "${back##*click_id=}"; fi
echo "ok DEMO-4 return gets a new click id"
expect_report "DEMO-4 report visits 2" '.visits' 2

# DEMO-5: Purchase, report changes
report >"$TMP/before.json"
purchase="$(pnpm -s postback purchase --click "$CLICK" --txn DEMO-P1 --base "$BASE")"
echo "$purchase"
check_match "DEMO-5 purchase accepted" '^202' "$purchase"
report >"$TMP/after.json"
echo "diff before after"
diff "$TMP/before.json" "$TMP/after.json" || true
changed="$(jq -n -r --slurpfile a "$TMP/before.json" --slurpfile b "$TMP/after.json" '
  def flat: [paths(scalars) as $p | {key: ($p | map(tostring) | join(".")), value: getpath($p)}] | from_entries;
  ($a[0] | flat) as $x | ($b[0] | flat) as $y
  | [($x | keys[]), ($y | keys[])] | unique | map(select($x[.] != $y[.])) | sort | join(",")')"
check "DEMO-5 only the Purchase cells changed" \
  'purchase,rows.0.offers.0.purchase,rows.0.offers.0.rates.lead_to_purchase,rows.0.purchase' "$changed"
page="$(curl -s "$BASE/report" | grep -o 'data-metric="purchase">[0-9]*<' | head -n 1 || true)"
check "DEMO-5 /report shows the Purchase" 'data-metric="purchase">1<' "$page"

# DEMO-6: the same postbacks again
again="$(pnpm -s postback purchase --click "$CLICK" --txn DEMO-P1 --base "$BASE")"
echo "$again"
check "DEMO-6 purchase again is a duplicate" '200 {"status":"duplicate"}' "$again"
lead_again="$(pnpm -s postback lead --click "$CLICK" --txn DEMO-L1 --base "$BASE")"
echo "$lead_again"
check_match "DEMO-6 lead again answers 200" '^200' "$lead_again"
counts="$(report | jq -c '{lead,purchase}')"
echo "$counts"
check "DEMO-6 lead and purchase stay at 1" '{"lead":1,"purchase":1}' "$counts"

# Final: the whole report against the DEMO-7 row for DEMO-6
final="$(curl -s "$BASE/api/report" | jq -r "[$FINAL_FIELDS] | @csv")"
check "final report" '2,1,1,1,1,1,1,2,1,1' "$final"

echo "demo passed against $BASE"
