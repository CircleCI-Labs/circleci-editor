#!/usr/bin/env bash
# Copyright (c) 2026 Circle Internet Services, Inc.
#
# SPDX-License-Identifier: MIT
#
# A cheap whole-repository invariant that nothing else was checking, added
# after it failed for real.
#
# NO CONFLICT MARKERS IN TRACKED FILES.
#
#    Three `<<<<<<<`/`=======`/`>>>>>>>` lines shipped to main inside a
#    Markdown doc and survived: a rebase resolved its first commit's
#    conflict, `rebase --continue` hit a second one on the next commit, and the
#    verification that followed -- tsc, 1735 unit tests, a full Playwright run --
#    could not possibly have noticed, because the corrupted file is Markdown.
#    Nothing compiles it, nothing imports it, no test reads it. It was found
#    later by an agent that happened to open the file.
#
#    That is the whole lesson: a green test suite is evidence about code, not
#    about the repository. This check costs milliseconds and covers every
#    tracked file, including the ones no test will ever look at.
#
# This check runs over `git ls-files`, so it sees exactly what is committed
# and nothing that isn't -- no node_modules, no build output, no local scratch.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

status=0

# --- conflict markers ---------------------------------------------------------
#
# Anchored at column 0 and requiring the full seven characters, which is the
# form git actually writes. `<<<` inside prose or a code sample is not a marker
# and must not fail this check -- and note this very file contains the strings
# being searched for, in comments, which is why the pattern needs the anchor and
# the length: `grep -n '^<<<<<<< '` does not match `\`<<<<<<<\`` in a sentence.
#
# `git ls-files -z` plus a NUL-delimited read handles paths with spaces.
markers=""
while IFS= read -r -d '' file; do
  # Skip this script: it documents the markers it looks for.
  [ "$file" = "scripts/check-repo-integrity.sh" ] && continue
  # Binary files have no lines to match; -I makes grep skip them.
  if hits="$(grep -InE '^(<{7} |={7}$|>{7} )' -- "$file" 2>/dev/null)"; then
    markers+="${file}:"$'\n'"${hits}"$'\n'
  fi
done < <(git ls-files -z)

if [ -n "${markers}" ]; then
  cat >&2 <<EOF
error: git conflict markers are committed in tracked files.

${markers}
A rebase or merge was resolved incompletely. Note that a passing test suite
cannot detect this in a file nothing compiles or imports -- which is exactly how
it reached main once already.
EOF
  status=1
fi

if [ "${status}" -eq 0 ]; then
  echo "Repository integrity OK: no conflict markers."
fi

exit "${status}"
