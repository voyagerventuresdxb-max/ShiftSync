#!/usr/bin/env bash
# Runs one CI step and, on failure, republishes a digest of its output as a
# GitHub annotation. Annotations are readable through the REST API, so a
# reviewer (or an agent) without access to the raw log storage can still see
# why a step failed. Usage: scripts/ci-step.sh "<title>" <command...>
set -o pipefail
title="$1"; shift
out="$(mktemp)"
"$@" >"$out" 2>&1
code=$?
cat "$out"
if [ $code -ne 0 ]; then
  clean="$(mktemp)"
  sed -e 's/\x1b\[[0-9;]*m//g' "$out" >"$clean"
  digest="$(mktemp)"
  if grep -q '^not ok\|^# fail' "$clean"; then
    # node:test TAP: every failing test's name + first error line, then the totals.
    { echo "FAILING TESTS:"; grep -n '^not ok\|^    not ok' "$clean" | head -80;
      echo; echo "TOTALS:"; grep '^# \(tests\|pass\|fail\|cancelled\|skipped\)' "$clean";
      echo; echo "FIRST FAILURES:"; grep -A14 '^not ok' "$clean" | grep -E "not ok|error:|expected|actual|location|Raw query|Error" | head -60; } >"$digest"
  else
    tail -n 140 "$clean" >"$digest"
  fi
  msg="$(sed -e 's/%/%25/g' "$digest" | awk '{printf "%s%%0A", $0}')"
  echo "::error title=${title} (exit ${code})::${msg}"
fi
exit $code
