#!/usr/bin/env bash
# Local check for the stapler validate retry. A fake xcrun stands in for
# Apple's tool so this runs on Linux.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
script=$here/macos-stapler-validate.sh
root=$(cd "$here/../.." && pwd)
workflow=$root/.github/workflows/release-desktop.yml
app="/tmp/S2Code (Nightly).app"
failures=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

assert_eq() {
  local label=$1 expected=$2 actual=$3
  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL: %s\nexpected:\n%s\nactual:\n%s\n' "$label" "$expected" "$actual" >&2
    failures=$((failures + 1))
  fi
}

assert_contains() {
  local label=$1 needle=$2 file=$3
  if ! grep -F -q -- "$needle" "$file"; then
    printf 'FAIL: %s missing [%s]\n' "$label" "$needle" >&2
    printf '---- %s ----\n' "$file" >&2
    cat "$file" >&2 || true
    failures=$((failures + 1))
  fi
}

assert_absent() {
  local label=$1 needle=$2 file=$3
  if grep -F -q -- "$needle" "$file"; then
    printf 'FAIL: %s unexpectedly contains [%s]\n' "$label" "$needle" >&2
    cat "$file" >&2 || true
    failures=$((failures + 1))
  fi
}

prepare() {
  tmp=$(mktemp -d)
  seq_file=$tmp/sequence
  count_file=$tmp/count
  args_file=$tmp/args
  sleeps_file=$tmp/sleeps
  printf '' >"$args_file"
  printf '' >"$sleeps_file"
  cat >"$tmp/xcrun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
n=0
if [[ -s $STUB_COUNT_FILE ]]; then
  n=$(cat "$STUB_COUNT_FILE")
fi
n=$((n + 1))
printf '%s' "$n" >"$STUB_COUNT_FILE"
printf '%s\n' "$*" >>"$STUB_ARGS_FILE"
mode=$(sed -n "${n}p" "$STUB_SEQUENCE_FILE")
case $mode in
  ok)
    printf '%s\n' 'The validate action worked!'
    exit 0
    ;;
  65)
    printf '%s\n' 'Processing: /tmp/S2Code (Nightly).app' 'The validate action failed! Error 65.' >&2
    exit 65
    ;;
  '65+net')
    printf '%s\n' 'The validate action failed! Error 65.' 'The network connection was lost.' >&2
    exit 65
    ;;
  68)
    printf '%s\n' 'The validate action failed! Error 68.' 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."' >&2
    exit 68
    ;;
  lost)
    printf '%s\n' 'NSURLError -1005: The network connection was lost.' >&2
    exit 1
    ;;
  680)
    printf '%s\n' 'The validate action failed! Error 680.' >&2
    exit 1
    ;;
  other)
    printf '%s\n' 'xcrun: error: unable to find utility "stapler"' >&2
    exit 1
    ;;
  empty)
    exit 1
    ;;
  *)
    printf 'unexpected stub mode: %s\n' "${mode:-<none>}" >&2
    exit 99
    ;;
esac
EOF
  cat >"$tmp/sleep" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$1" >>"$STUB_SLEEPS_FILE"
EOF
  chmod +x "$tmp/xcrun" "$tmp/sleep"
}

run_validate() {
  local sequence=$1
  prepare
  printf '%s\n' "$sequence" >"$seq_file"
  set +e
  STUB_SEQUENCE_FILE=$seq_file \
    STUB_COUNT_FILE=$count_file \
    STUB_ARGS_FILE=$args_file \
    STUB_SLEEPS_FILE=$sleeps_file \
    XCRUN=$tmp/xcrun \
    STAPLER_VALIDATE_SLEEP_CMD=$tmp/sleep \
    "$script" "$app" >"$tmp/out" 2>"$tmp/err"
  status=$?
  set -e
  calls=0
  if [[ -s $count_file ]]; then
    calls=$(cat "$count_file")
  fi
  sleeps=$(cat "$sleeps_file")
}

# Error 65 is a missing ticket. Do not retry, and do not call it a network error.
run_validate '65'
assert_eq 'error 65 exit' 1 "$status"
assert_eq 'error 65 calls' 1 "$calls"
assert_eq 'error 65 sleeps' '' "$sleeps"
assert_contains 'error 65 message' 'carries no stapled notarization ticket' "$tmp/err"
assert_absent 'error 65 is not a network failure' 'kept hitting a network error' "$tmp/err"
assert_contains 'error 65 output kept' 'Error 65.' "$tmp/out"

# Error 65 wins even when the same output mentions a dropped connection.
run_validate '65+net'
assert_eq 'error 65 plus network exit' 1 "$status"
assert_eq 'error 65 plus network calls' 1 "$calls"
assert_eq 'error 65 plus network sleeps' '' "$sleeps"
assert_contains 'error 65 plus network message' 'carries no stapled notarization ticket' "$tmp/err"
assert_absent 'error 65 plus network is not retried' 'retrying in' "$tmp/err"

# One CloudKit drop, then a normal validate.
run_validate $'68\nok'
assert_eq '68 then success exit' 0 "$status"
assert_eq '68 then success calls' 2 "$calls"
assert_eq '68 then success sleeps' '10' "$sleeps"
assert_contains '68 then success output' 'The validate action worked!' "$tmp/out"
assert_absent '68 then success has no ticket message' 'carries no stapled notarization ticket' "$tmp/err"
assert_absent '68 then success did not exhaust retries' 'kept hitting a network error' "$tmp/err"
assert_eq '68 then success argv' "stapler validate ${app}" "$(head -n 1 "$args_file")"

# The phrase alone is enough; stapler does not have to print "Error 68".
run_validate $'lost\nok'
assert_eq 'network phrase then success exit' 0 "$status"
assert_eq 'network phrase then success calls' 2 "$calls"
assert_eq 'network phrase then success sleeps' '10' "$sleeps"

# Five drops use 10s, 20s, 40s, 80s and then stop. No sixth call, no sleep after the last.
run_validate $'68\n68\n68\n68\n68\n68'
assert_eq 'persistent 68 exit' 1 "$status"
assert_eq 'persistent 68 calls' 5 "$calls"
assert_eq 'persistent 68 sleeps' $'10\n20\n40\n80' "$sleeps"
assert_contains 'persistent 68 message' 'stapler validate kept hitting a network error after 5 attempts.' "$tmp/err"
assert_contains 'persistent 68 log' 'Code=-1005' "$tmp/err"
assert_contains 'persistent 68 log keeps Error 68' 'Error 68.' "$tmp/err"
assert_absent 'persistent 68 is not a missing ticket' 'carries no stapled notarization ticket' "$tmp/err"

# A clean validate does not sleep.
run_validate 'ok'
assert_eq 'success exit' 0 "$status"
assert_eq 'success calls' 1 "$calls"
assert_eq 'success sleeps' '' "$sleeps"
assert_contains 'success output' 'The validate action worked!' "$tmp/out"
assert_absent 'success stderr stays quiet' '::error::' "$tmp/err"

# Anything else fails on the first attempt with the tool's own output.
run_validate 'other'
assert_eq 'other exit' 1 "$status"
assert_eq 'other calls' 1 "$calls"
assert_eq 'other sleeps' '' "$sleeps"
assert_contains 'other output' 'unable to find utility "stapler"' "$tmp/err"
assert_absent 'other is not a missing ticket' 'carries no stapled notarization ticket' "$tmp/err"
assert_absent 'other is not a network failure' 'kept hitting a network error' "$tmp/err"

# Error 680 is not Error 68.
run_validate '680'
assert_eq 'error 680 calls' 1 "$calls"
assert_eq 'error 680 sleeps' '' "$sleeps"
assert_contains 'error 680 fails immediately' 'stapler validate failed (exit 1).' "$tmp/err"
assert_absent 'error 680 is not retried' 'retrying in' "$tmp/err"

# A bare non-zero exit with no CloudKit text is not a network drop.
run_validate 'empty'
assert_eq 'empty exit' 1 "$status"
assert_eq 'empty calls' 1 "$calls"
assert_eq 'empty sleeps' '' "$sleeps"
assert_contains 'empty fails immediately' 'stapler validate failed (exit 1).' "$tmp/err"
assert_absent 'empty is not a missing ticket' 'carries no stapled notarization ticket' "$tmp/err"
assert_absent 'empty is not a network failure' 'kept hitting a network error' "$tmp/err"

if ! grep -q 'macos-stapler-validate.sh' "$workflow"; then
  fail 'release workflow does not call macos-stapler-validate.sh'
fi
if grep -q 'xcrun stapler validate' "$workflow"; then
  fail 'release workflow still invokes xcrun stapler validate directly'
fi

if [[ $failures -ne 0 ]]; then
  printf '%s check(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'macos-stapler-validate tests passed\n'
