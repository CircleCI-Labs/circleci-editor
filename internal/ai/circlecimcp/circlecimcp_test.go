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

package circlecimcp_test

import (
	"testing"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai/circlecimcp"
)

// TestIsReadOnly_KnownReadTools pins every tool this package has actually
// observed the live server classify readOnlyHint=true (see the package
// doc's three-way verification) as eligible.
func TestIsReadOnly_KnownReadTools(t *testing.T) {
	for _, tool := range []string{
		"hello", "list_runs", "get_run", "list_workflows", "get_workflow",
		"list_jobs", "get_job", "get_job_logs", "list_artifacts", "list_job_tests",
	} {
		assert.Assert(t, circlecimcp.IsReadOnly(tool), "expected %q to be read-only", tool)
	}
}

// TestIsReadOnly_KnownWriteTools_AreGated is issue #11's central requirement
// checked against every write tool this package has actually seen the
// server advertise -- cancel_workflow and rerun_workflow act, and
// download_usage_data starts a side-effecting export, none of which may
// reach the assistant unconfirmed.
func TestIsReadOnly_KnownWriteTools_AreGated(t *testing.T) {
	for _, tool := range []string{"cancel_workflow", "rerun_workflow", "download_usage_data"} {
		assert.Assert(t, !circlecimcp.IsReadOnly(tool), "expected %q to be gated, not read-only", tool)
	}
}

// TestIsReadOnly_UnknownTool_IsGated is the deny-by-default property itself:
// a tool this package has never heard of -- the shape a future upstream
// addition to CircleCI's hosted server takes before anyone has reviewed and
// classified it -- must gate exactly like an explicit write tool, with no
// third "not sure, let it through" outcome available. This is the test
// issue #11 asks for by name: "a tool that appears upstream later is gated
// until someone classifies it".
func TestIsReadOnly_UnknownTool_IsGated(t *testing.T) {
	for _, tool := range []string{
		"", "trigger_pipeline", "run_pipeline", "approve_job",
		"delete_project", "GET_JOB_LOGS", "get_job_logs ",
	} {
		assert.Assert(t, !circlecimcp.IsReadOnly(tool), "expected unclassified tool %q to be gated", tool)
	}
}

// TestClassify_DistinguishesUnknownFromExplicitWrite: both gate identically
// in IsReadOnly, but Classify's second return tells them apart, which
// matters for a diagnostic that wants to say *why* a tool is gated rather
// than just that it is.
func TestClassify_DistinguishesUnknownFromExplicitWrite(t *testing.T) {
	class, known := circlecimcp.Classify("cancel_workflow")
	assert.Equal(t, known, true)
	assert.Equal(t, class, circlecimcp.ClassWrite)

	_, known = circlecimcp.Classify("some_future_tool_nobody_has_reviewed")
	assert.Equal(t, known, false)
}

// TestAllowedTools_MatchesIsReadOnly_ExactlyBothDirections is the
// consistency check between the two exported surfaces: AllowedTools and
// IsReadOnly must agree on every name in either direction, or a caller
// consulting one and not the other could reach a different verdict than
// internal/ai/anthropic's Complete does when it builds the actual request.
func TestAllowedTools_MatchesIsReadOnly_ExactlyBothDirections(t *testing.T) {
	allowed := circlecimcp.AllowedTools()
	assert.Assert(t, len(allowed) > 0, "expected at least one read tool")

	seen := make(map[string]bool, len(allowed))
	for _, tool := range allowed {
		seen[tool] = true
		assert.Assert(t, circlecimcp.IsReadOnly(tool), "AllowedTools included %q but IsReadOnly disagrees", tool)
	}

	for _, tool := range []string{
		"hello", "list_runs", "get_run", "list_workflows", "get_workflow",
		"list_jobs", "get_job", "get_job_logs", "list_artifacts", "list_job_tests",
	} {
		assert.Assert(t, seen[tool], "expected %q in AllowedTools()", tool)
	}
	for _, tool := range []string{"cancel_workflow", "rerun_workflow", "download_usage_data"} {
		assert.Assert(t, !seen[tool], "did not expect write tool %q in AllowedTools()", tool)
	}
}

// TestAllowedTools_ReturnsAFreshSliceEachCall guards against a caller (or a
// future refactor) that mutates the returned slice in place corrupting this
// package's own idea of what is allowed for every later caller -- a shared
// backing array here would turn "the assistant proposed a bad edit" into
// "the assistant can now see a write tool for the rest of this process".
func TestAllowedTools_ReturnsAFreshSliceEachCall(t *testing.T) {
	first := circlecimcp.AllowedTools()
	assert.Assert(t, len(first) > 1)
	first[0] = "cancel_workflow"

	second := circlecimcp.AllowedTools()
	assert.Assert(t, second[0] != "cancel_workflow", "mutating a previously returned slice must not affect a later call")
	assert.Assert(t, circlecimcp.IsReadOnly(second[0]))
}

// TestAllowedTools_IsSorted pins the deterministic ordering
// internal/ai/anthropic's Complete relies on only for a stable wire
// encoding across calls -- correctness never depends on the order, but a
// test asserting on it (or a diff between two requests) should not have to
// account for map iteration order leaking through.
func TestAllowedTools_IsSorted(t *testing.T) {
	allowed := circlecimcp.AllowedTools()
	for i := 1; i < len(allowed); i++ {
		assert.Assert(t, allowed[i-1] < allowed[i], "expected sorted order, got %v", allowed)
	}
}
