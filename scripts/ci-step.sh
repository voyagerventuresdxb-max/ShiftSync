#!/usr/bin/env bash
# Runs one CI step and, on failure, republishes a digest of its output as
# GitHub annotations. Annotations are readable through the REST API, so a
# reviewer (or an agent) without access to the raw log storage can still see
# why a step failed. One annotation holds at most ~4 KB, so the digest is
# split over several (GitHub keeps up to 10 per step).
# Usage: scripts/ci-step.sh "<title>" <command...>
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
    # node:test TAP. Totals first, then the failing files, then every failing
    # test (names shortened), then each distinct error message with a count —
    # enough to tell a new failure from a pre-existing environment one.
    { echo "TOTALS:"; grep '^# \(tests\|suites\|pass\|fail\|cancelled\|skipped\|todo\)' "$clean";
      echo; echo "FAILING FILES:"; grep '^not ok [0-9]* - /' "$clean" | sed -e 's#^not ok [0-9]* - .*/\(server\|src\|scripts\|shared\)/#\1/#';
      echo; echo "ERRORS (count, message):"; awk '/^ +error: [|>]-?$/ { if ((getline nxt) > 0) { sub(/^ +/, "", nxt); print nxt }; next } /^ +error: / { sub(/^ +error: */, ""); print }' "$clean" | sed -e 's/^\(.\{160\}\).*/\1…/' | sort | uniq -c | sort -rn | head -60;
      echo; echo "FAILING TESTS:"; grep '^ *not ok' "$clean" | grep -v '^not ok [0-9]* - /' | sed -e 's/^ *not ok [0-9]* - //' -e 's/^\(.\{100\}\).*/\1…/' | head -200; } >"$digest"
  else
    tail -n 140 "$clean" >"$digest"
  fi
  # Chunks of ~3900 bytes on line boundaries, at most 9 annotations.
  awk -v max=3900 'BEGIN{n=1; size=0} { len=length($0)+1; if (size+len>max && size>0) {n++; size=0} if (n>9) exit; print > (FILENAME ".part" n); size+=len }' "$digest"
  total=$(ls "$digest".part* 2>/dev/null | wc -l)
  i=0
  for n in $(seq 1 "$total"); do
    part="$digest.part$n"
    i=$((i+1))
    msg="$(sed -e 's/%/%25/g' "$part" | awk '{printf "%s%%0A", $0}')"
    echo "::error title=${title} (exit ${code}) [${i}/${total}]::${msg}"
  done
fi
exit $code
