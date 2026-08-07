// Copyright (c) 2026 Circle Internet Services, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
//
// SPDX-License-Identifier: MIT

package configcheck_test

import (
	"os"
	"strings"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/configcheck"
)

func messages(t *testing.T, contents string) []string {
	t.Helper()
	issues, err := configcheck.Check([]byte(contents))
	assert.NilError(t, err)
	out := make([]string, len(issues))
	for i, issue := range issues {
		out[i] = issue.Message
	}
	return out
}

func assertNoneContain(t *testing.T, msgs []string, substr string) {
	t.Helper()
	for _, m := range msgs {
		assert.Assert(t, !strings.Contains(m, substr), "unexpected issue containing %q: %s", substr, m)
	}
}

func assertOneContains(t *testing.T, msgs []string, substr string) {
	t.Helper()
	for _, m := range msgs {
		if strings.Contains(m, substr) {
			return
		}
	}
	t.Fatalf("expected an issue containing %q, got: %v", substr, msgs)
}

func TestCheck_MinimalValidConfig_NoIssues(t *testing.T) {
	msgs := messages(t, `
version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
`)
	assert.Assert(t, is.Len(msgs, 0), "expected no issues, got: %v", msgs)
}

func TestCheck_ThisRepositoriesOwnConfig_NoIssues(t *testing.T) {
	// The whole point of this checker is to run clean against the config it
	// ships alongside -- if it can't, either the config broke or the
	// checker has a false positive, and either is worth knowing immediately
	// rather than discovering it in CI.
	contents, err := os.ReadFile("../../.circleci/config.yml")
	assert.NilError(t, err)
	msgs := messages(t, string(contents))
	assert.Assert(t, is.Len(msgs, 0), "expected no issues against .circleci/config.yml, got: %v", msgs)
}

func TestCheck_InvalidYAML_ReportsParseFailure(t *testing.T) {
	msgs := messages(t, "jobs:\n  build:\n\tsteps: []\n") // a tab where YAML requires spaces
	assert.Assert(t, is.Len(msgs, 1))
	assertOneContains(t, msgs, "not valid YAML")
}

func TestCheck_EmptyFile_ReportsEmpty(t *testing.T) {
	msgs := messages(t, "")
	assert.Assert(t, is.Len(msgs, 1))
	assertOneContains(t, msgs, "empty")
}

func TestCheck_NonMappingTopLevel_Reported(t *testing.T) {
	msgs := messages(t, "- just\n- a\n- list\n")
	assertOneContains(t, msgs, "must be a YAML mapping")
}

func TestCheck_TopLevelKeyTypo_MatchedToTheOneKnownKeyItIsNear(t *testing.T) {
	// Issue #5's exact bug: "workflow" instead of "workflows". CircleCI's
	// compiler has no opinion on this at all (it never checks top-level
	// keys), so this checker is the only layer that ever will.
	msgs := messages(t, `
version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflow:
  main:
    jobs:
      - build
`)
	assertOneContains(t, msgs, `"workflow" looks like a typo of "workflows"`)
}

func TestCheck_UnknownTopLevelKey_NotNearAnyKnownKey_NotReported(t *testing.T) {
	// A wide-open, forward-looking key (like "setup" was before this app
	// knew about it) must never be treated as a typo just because this
	// checker hasn't heard of it -- see topLevelKeys.ts's identical
	// reasoning, ported here on purpose.
	msgs := messages(t, `
version: 2.1
some_future_top_level_key:
  anything: goes
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
`)
	assertNoneContain(t, msgs, "some_future_top_level_key")
}

func TestCheck_SetupKey_Recognised(t *testing.T) {
	msgs := messages(t, `
version: 2.1
setup: true
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
`)
	assertNoneContain(t, msgs, "setup")
}

func TestCheck_MissingVersion_Reported(t *testing.T) {
	msgs := messages(t, `
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
`)
	assertOneContains(t, msgs, `missing required top-level "version" key`)
}

func TestCheck_UnrecognisedVersionValue_Reported(t *testing.T) {
	msgs := messages(t, `
version: 3
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
`)
	assertOneContains(t, msgs, `version: "3" is not a value CircleCI accepts`)
}

func TestCheck_LegacyVersion2_Accepted(t *testing.T) {
	msgs := messages(t, `
version: 2
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
`)
	assertNoneContain(t, msgs, "version")
}

func TestCheck_WorkflowReferencesUndefinedJob_Reported(t *testing.T) {
	msgs := messages(t, `
version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflows:
  main:
    jobs:
      - biuld
`)
	assertOneContains(t, msgs, `workflow "main" uses job "biuld", which is not defined`)
}

func TestCheck_RequiresUndefinedJob_Reported(t *testing.T) {
	msgs := messages(t, `
version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
  deploy:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
      - deploy:
          requires:
            - biuld
`)
	assertOneContains(t, msgs, `"deploy" requiring "biuld", which is not any job or approval gate`)
}

func TestCheck_ApprovalGate_NotFlaggedAsUndefinedJob(t *testing.T) {
	msgs := messages(t, `
version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
  deploy:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
      - hold-for-approval:
          type: approval
          requires:
            - build
      - deploy:
          requires:
            - hold-for-approval
`)
	assert.Assert(t, is.Len(msgs, 0), "expected no issues, got: %v", msgs)
}

func TestCheck_RenamedJobInvocation_RequiresMatchesTheOverrideName(t *testing.T) {
	msgs := messages(t, `
version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
  deploy:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build:
          name: build-2
      - deploy:
          requires:
            - build-2
`)
	assert.Assert(t, is.Len(msgs, 0), "expected no issues, got: %v", msgs)
}

func TestCheck_OrbNamespacedJobName_NeverFlagged(t *testing.T) {
	// An orb-provided job ("myorb/lint") cannot be resolved offline at all
	// -- that is precisely the capability this checker does not have (see
	// its package doc comment) -- so any name containing "/" is skipped
	// rather than guessed at.
	msgs := messages(t, `
version: 2.1
orbs:
  myorb: circleci/myorb@1.0
workflows:
  main:
    jobs:
      - myorb/lint
      - myorb/deploy:
          requires:
            - myorb/lint
`)
	assert.Assert(t, is.Len(msgs, 0), "expected no issues, got: %v", msgs)
}

func TestCheck_DuplicateTopLevelKey_Reported(t *testing.T) {
	msgs := messages(t, `
version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
jobs:
  other:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
`)
	assertOneContains(t, msgs, `duplicate top-level key "jobs"`)
}

func TestCheck_DuplicateJobName_Reported(t *testing.T) {
	msgs := messages(t, `
version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
  build:
    docker:
      - image: cimg/other:current
    steps:
      - checkout
workflows:
  main:
    jobs:
      - build
`)
	assertOneContains(t, msgs, `duplicate job name "build"`)
}

func TestCheck_AnchoredFilters_DoesNotCrashOrMisreport(t *testing.T) {
	// This repository's own config anchors a `filters:` block
	// (&release-filters / *release-filters); the checker has to walk past
	// an alias node in a job invocation's params without choking on it.
	msgs := messages(t, `
version: 2.1
jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
workflows:
  release:
    jobs:
      - build:
          filters: &release-filters
            branches:
              ignore: /.*/
            tags:
              only: /^v\d+\.\d+\.\d+$/
  ci:
    jobs:
      - build:
          filters: *release-filters
`)
	assert.Assert(t, is.Len(msgs, 0), "expected no issues, got: %v", msgs)
}
