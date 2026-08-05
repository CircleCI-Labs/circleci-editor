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

# check-pr-title.sh -- issue #119. This repo squash-merges, so a PR's title
# (not its individual commits) becomes the commit subject on main that
# release-please parses to build the release notes. #114, #115 and #101 all had
# non-Conventional-Commits titles that release-please silently dropped --
# discovered only after release, by hand-diffing the changelog. This job
# fails the CircleCI build for the PR's branch instead, before merge.
#
# Reads the PR number from CIRCLE_PULL_REQUEST (populated by CircleCI once a
# GitHub PR exists for the branch being built -- chosen over a second GitHub
# Actions workflow in a repo that just finished removing its only one: this
# repo's release automation already moved off GitHub Actions onto CircleCI,
# and CIRCLE_PULL_REQUEST is confirmed populated for GitHub App pipelines,
# so a plain CircleCI job needs no second CI system to enforce this)
# and looks the current title up via the GitHub REST API, so a title edited
# after the last push is still checked against whatever was true at the time
# this job last ran (a real, documented limitation: editing the title with
# no new commit does not re-trigger this job -- CircleCI has no equivalent of
# GitHub Actions' `pull_request: [edited]` trigger).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./conventional-commit-regex.sh
source "${SCRIPT_DIR}/conventional-commit-regex.sh"

REPO="CircleCI-Labs/circleci-editor"

if [ -z "${CIRCLE_PULL_REQUEST:-}" ]; then
  echo "CIRCLE_PULL_REQUEST is unset: no open pull request for this build yet."
  echo "Nothing to check -- this is expected on the first push to a new branch"
  echo "(before a PR exists) and on main itself (the PR is closed by the time"
  echo "its squash commit lands there). scripts/check-main-history.sh is the"
  echo "belt-and-braces check that covers main directly."
  exit 0
fi

pr_number="${CIRCLE_PULL_REQUEST##*/}"
if ! [[ "${pr_number}" =~ ^[0-9]+$ ]]; then
  echo "error: could not parse a PR number from CIRCLE_PULL_REQUEST=${CIRCLE_PULL_REQUEST}" >&2
  exit 1
fi

if [ -z "${GH_PR_READ_TOKEN:-}" ]; then
  # Skip, loudly, rather than fail.
  #
  # This check needs a GitHub token with read access to pull requests on
  # ${REPO} (this repo is GitHub-visibility INTERNAL, so the unauthenticated
  # API 404s). It is deliberately a separate, read-only credential from the
  # devex-release context's write-scoped GITHUB_TOKEN: this job runs on every
  # PR-associated build, including branches nobody has reviewed, and must not
  # be able to do anything the release job can.
  #
  # That credential has to be provisioned by a human, so until it exists this
  # job would fail on *every* PR -- blocking all work to enforce a convention,
  # which is worse than not enforcing it yet. A check that cannot run should
  # not be a gate.
  #
  # Skipping is safe here specifically because it is not the only guard:
  # check-main-history catches the same defect (a subject release-please
  # cannot parse) directly on main's own history, needs no credential, and
  # runs unconditionally. This job is the earlier, friendlier version of that
  # check -- it tells you before you merge instead of after -- so losing it
  # temporarily costs timeliness, not coverage.
  cat >&2 <<EOF
warning: GH_PR_READ_TOKEN is not set -- skipping the PR title check.

To enable it, create a CircleCI context named github-pr-read containing
GH_PR_READ_TOKEN, a token with read-only pull-request access to ${REPO}.

Not failing the build: check-main-history enforces the same rule against
main's history without needing a credential, so the convention is still
guarded -- just after merge rather than before.
EOF
  exit 0
fi

response="$(curl -fsS \
  -H "Authorization: Bearer ${GH_PR_READ_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/pulls/${pr_number}")"

# Parsed with node, not jq: jq is not preinstalled on the cimg/go:*-node
# executor this job runs on, while node already is (release-please itself
# needs it) -- one fewer tool to install for a single field extraction.
title="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).title)' <<<"${response}")"

echo "PR #${pr_number} title: ${title}"

if [[ "${title}" =~ ${CONVENTIONAL_COMMIT_RE} ]]; then
  echo "OK: title is a Conventional Commit."
  exit 0
fi

cat >&2 <<EOF

error: PR title is not a Conventional Commit:

  ${title}

This repo squash-merges (see CONTRIBUTING.md), so this title becomes the
commit subject on main that release-please parses. A title it can't
recognize is silently dropped from the release notes, not rejected -- see issue
#119, where this happened to three real PRs (#114, #115, #101).

Allowed types: ${CONVENTIONAL_COMMIT_TYPES//|/, }
See CONTRIBUTING.md#commit-messages-and-pr-titles, e.g.:
  feat: add support for reusable executors
EOF
exit 1
