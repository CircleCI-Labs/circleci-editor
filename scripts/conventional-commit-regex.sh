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

# conventional-commit-regex.sh -- the single definition of "is this subject a
# Conventional Commit release-please will actually act on", shared by
# check-pr-title.sh and check-main-history.sh (issue #119) so the two checks
# can never silently drift apart from each other or from what they claim to
# enforce.
#
# CONVENTIONAL_COMMIT_TYPES must equal the set of "type" keys in
# release-please-config.json's changelog-sections, plus CONTRIBUTING.md's
# documented list -- all three must be edited together. A type that is
# syntactically valid Conventional Commits but missing from
# changelog-sections is *not* a safe type to allow here: release-please
# still parses it, but silently omits it from the release notes, which is exactly
# the bug issue #119 reports (it happened to "research" and "oxfmt", neither
# ever a real type; make sure it can't happen to a real one by construction).
CONVENTIONAL_COMMIT_TYPES='feat|fix|perf|deps|docs|chore|refactor|test|ci|build'

# Matches either:
#   - a Conventional Commits subject: one of the types above, an optional
#     (scope), an optional breaking-change "!", ": ", then a description.
#     GitHub's squash-merge suffix (" (#123)") is swallowed by the
#     description's ".+" without needing special handling.
#   - GitHub's own auto-generated revert title, Revert "<original subject>",
#     optionally with the same squash suffix. Conventional Commits has no
#     "revert PR title" convention of its own, and clicking GitHub's Revert
#     button produces this exact shape -- rejecting it would break a normal,
#     supported GitHub workflow for no benefit.
# shellcheck disable=SC2034 # consumed by scripts that source this file.
CONVENTIONAL_COMMIT_RE="^(${CONVENTIONAL_COMMIT_TYPES})(\([^)]+\))?!?: .+\$|^Revert \"[^\"]+\"( \(#[0-9]+\))?\$"
