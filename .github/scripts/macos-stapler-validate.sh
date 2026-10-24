#!/usr/bin/env bash
# `stapler validate` asks CloudKit whether the ticket is stapled. GitHub's
# macOS arm64 runners drop that connection after a successful staple
# (Error 68, NSURLError -1005, "network connection was lost"). Retry only
# that lookup. Error 65 means the ticket really is missing.
#
# Defaults: 5 attempts, then 10s, 20s, 40s, 80s between them.
# Tests point XCRUN and STAPLER_VALIDATE_SLEEP_CMD at stubs.
set -euo pipefail

if [[ $# -ne 1 || -z ${1:-} ]]; then
  printf 'usage: macos-stapler-validate.sh <app>\n' >&2
  exit 2
fi

app=$1
attempts=${STAPLER_VALIDATE_ATTEMPTS:-5}
delay=${STAPLER_VALIDATE_INITIAL_DELAY:-10}
xcrun_bin=${XCRUN:-xcrun}
name=$(basename "$app")

if ! [[ $attempts =~ ^[1-9][0-9]*$ ]]; then
  printf 'STAPLER_VALIDATE_ATTEMPTS must be a positive integer\n' >&2
  exit 2
fi
if ! [[ $delay =~ ^[0-9]+$ ]]; then
  printf 'STAPLER_VALIDATE_INITIAL_DELAY must be a non-negative integer\n' >&2
  exit 2
fi

# Bash =~ is unanchored. Reject Error 650 / Error 680 and Code=-10050.
# These stay global. macOS runners still ship bash 3.2, which mishandles
# =~ when the pattern variable is local to the function.
missing_re='(^|[^0-9])error 65([^0-9]|$)'
transient_re='(^|[^0-9])error 68([^0-9]|$)'
code_re='code=-1005([^0-9]|$)'
nsurl_re='nsurlerror -1005([^0-9]|$)'

is_missing_ticket() {
  [[ "$1" =~ $missing_re ]]
}

is_transient() {
  local lower="$1"
  if [[ "$lower" =~ $transient_re ]]; then
    return 0
  fi
  if [[ "$lower" =~ $code_re ]]; then
    return 0
  fi
  if [[ "$lower" =~ $nsurl_re ]]; then
    return 0
  fi
  if [[ "$lower" == *"network connection was lost"* ]]; then
    return 0
  fi
  return 1
}

log=''
attempt=1
while [[ $attempt -le $attempts ]]; do
  set +e
  output=$("$xcrun_bin" stapler validate "$app" 2>&1)
  status=$?
  set -e
  chunk="attempt ${attempt}/${attempts} exit ${status}"$'\n'"${output}"
  printf '%s\n' "$chunk"
  log="${log}${chunk}"$'\n'
  if [[ $status -eq 0 ]]; then
    exit 0
  fi

  lower=$(printf '%s' "$output" | LC_ALL=C tr '[:upper:]' '[:lower:]')
  if is_missing_ticket "$lower"; then
    printf '::error::%s carries no stapled notarization ticket, so it would be checked online on first launch.\n' "$name" >&2
    exit 1
  fi
  if is_transient "$lower"; then
    if [[ $attempt -eq $attempts ]]; then
      printf '::error::%s stapler validate kept hitting a network error after %s attempts.\n' "$name" "$attempts" >&2
      printf '%s' "$log" >&2
      exit 1
    fi
    printf 'stapler validate hit a network error (attempt %s/%s); retrying in %ss\n' "$attempt" "$attempts" "$delay" >&2
    if [[ -n ${STAPLER_VALIDATE_SLEEP_CMD:-} ]]; then
      "$STAPLER_VALIDATE_SLEEP_CMD" "$delay"
    else
      sleep "$delay"
    fi
    delay=$((delay * 2))
    attempt=$((attempt + 1))
    continue
  fi

  printf '::error::%s stapler validate failed (exit %s).\n' "$name" "$status" >&2
  printf '%s\n' "$output" >&2
  exit 1
done

printf '::error::%s stapler validate did not finish.\n' "$name" >&2
exit 1
