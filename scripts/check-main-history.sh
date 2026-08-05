#!/usr/bin/env bash
# Copyright (c) 2026 Circle Internet Services, Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of
# this software and associated documentation files (the "Software"), to deal in
# the Software without restriction, including without limitation the rights to
# use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
# the Software, and to permit persons to whom the Software is furnished to do so,
# subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
# FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
# COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
# IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
# CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
#
# SPDX-License-Identifier: MIT

# check-main-history.sh -- issue #119's belt-and-braces check. Runs on main
# itself, after merge, and fails if any commit subject since the last tag is
# not something release-please will act on. This is the direct check for the
# actual failure mode (a bad subject reaches main and release-please quietly
# ignores it) rather than the proxy check in check-pr-title.sh (a bad PR
# title, which is *usually* but not provably the same thing -- a squash
# commit's subject can in principle be hand-edited at merge time to differ
# from the PR title GitHub proposes). Would have caught #114, #115 and #101
# directly, on main, the day each merged, instead of at changelog review.
#
# Merge commits are excluded (--no-merges): parallel-agent branches were once
# deliberately integrated with a real merge commit instead of a squash,
# specifically to preserve every individual Conventional Commit on main.
# Multi-parent commits are not PR squash subjects and were never meant to
# satisfy this format.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./conventional-commit-regex.sh
source "${SCRIPT_DIR}/conventional-commit-regex.sh"

# CircleCI's checkout is a full clone, but this guards the (rare) case of a
# shallow local checkout -- e.g. a contributor testing this script by hand
# after a shallow `git clone --depth=1`. Best-effort: a stale cache or an
# already-full clone makes this a harmless no-op either way.
git fetch --tags --unshallow 2>/dev/null || git fetch --tags 2>/dev/null || true

last_tag="$(git describe --tags --abbrev=0 2>/dev/null || true)"

if [ -z "${last_tag}" ]; then
  echo "No tags found yet; checking the full history instead of a since-last-tag range."
  range="HEAD"
else
  echo "Checking commit subjects since the last tag (${last_tag})."
  range="${last_tag}..HEAD"
fi

failed=0
while IFS= read -r subject; do
  [ -z "${subject}" ] && continue
  if [[ "${subject}" =~ ${CONVENTIONAL_COMMIT_RE} ]]; then
    continue
  fi
  echo "NOT A CONVENTIONAL COMMIT: ${subject}" >&2
  failed=1
done < <(git log --no-merges --format='%s' "${range}")

if [ "${failed}" -ne 0 ]; then
  cat >&2 <<EOF

error: main has at least one commit subject since ${last_tag:-the beginning of history} that release-please cannot recognize.

release-please does not error on a subject like this -- it silently drops it
from the generated release notes (see issue #119). This check exists so that failure is
loud instead. If this fired, one of:
  - check-pr-title.sh's job didn't run or was overridden for the PR that
    introduced this commit (e.g. an admin merge bypassing required checks);
  - the squash commit's subject was hand-edited at merge time to differ
    from the PR title that check-pr-title.sh actually validated.
Either way, the generated release notes may now be missing an entry: check by hand
against the commit(s) named above, per CONTRIBUTING.md#commit-messages-and-pr-titles.
EOF
  exit 1
fi

echo "OK: every commit subject since ${last_tag:-the beginning of history} is a Conventional Commit."
