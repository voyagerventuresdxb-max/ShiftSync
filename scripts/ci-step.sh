#!/usr/bin/env bash
# Runs one CI step and, on failure, republishes the tail of its output as a
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
  # Strip ANSI colour, keep the last 120 lines, encode newlines for the annotation.
  msg="$(sed -e 's/\x1b\[[0-9;]*m//g' "$out" | tail -n 120 | sed -e 's/%/%25/g' | awk '{printf "%s%%0A", $0}')"
  echo "::error title=${title} (exit ${code})::${msg}"
fi
exit $code
