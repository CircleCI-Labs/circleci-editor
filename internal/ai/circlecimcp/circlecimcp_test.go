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
	"sort"
	"strings"
	"testing"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai/circlecimcp"
)

// knownReadTools and knownWriteTools are the exact 24 tools this package's
// toolClassifications map holds as of the 2026-08-20 live verification (see
// its doc comment). Tests below share these two lists rather than each
// hardcoding their own subset, so a future reclassification only has to be
// made consistent in one place.
var (
	knownReadTools = []string{
		"list_runs", "get_run", "list_run_workflows", "get_workflow", "list_workflow_jobs",
		"get_job", "get_job_logs", "list_job_tests", "list_job_artifacts", "get_job_resource_usage",
		"get_orb", "get_orb_source", "validate_config", "get_me",
		"list_deployments", "list_deploy_components", "list_deploy_environments",
		"list_deploy_component_versions", "get_deploy_component", "get_deploy_environment",
	}
	knownWriteTools = []string{
		"cancel_workflow", "rerun_workflow", "download_usage_data", "rollback_deploy_component",
	}
)

// TestIsReadOnly_KnownReadTools pins every tool this package has actually
// observed the live server classify readOnlyHint=true (see the package
// doc's verification) as eligible.
func TestIsReadOnly_KnownReadTools(t *testing.T) {
	for _, tool := range knownReadTools {
		assert.Assert(t, circlecimcp.IsReadOnly(tool), "expected %q to be read-only", tool)
	}
}

// TestIsReadOnly_KnownWriteTools_AreGated is issue #11's central requirement
// checked against every write tool this package has actually seen the
// server advertise -- cancel_workflow, rerun_workflow, and
// rollback_deploy_component act, and download_usage_data starts a
// side-effecting export, none of which may reach the assistant unconfirmed.
func TestIsReadOnly_KnownWriteTools_AreGated(t *testing.T) {
	for _, tool := range knownWriteTools {
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

	for _, tool := range knownReadTools {
		assert.Assert(t, seen[tool], "expected %q in AllowedTools()", tool)
	}
	for _, tool := range knownWriteTools {
		assert.Assert(t, !seen[tool], "did not expect write tool %q in AllowedTools()", tool)
	}
}

// TestAllowedTools_IsExactlyTheClassReadSet is the shape of bug this PR
// fixes, pinned directly: AllowedTools() must equal knownReadTools exactly --
// not a superset, not a subset -- and must not contain a single entry from
// knownWriteTools. A renamed or deleted tool that still appears under its
// old name (this bug's actual shape: list_workflows/list_jobs/list_artifacts
// renamed upstream, hello removed outright) would silently enable nothing
// on the wire without this failing, because the old name is simply absent
// from the live server's tools/list -- the assertions above that iterate
// AllowedTools() would never even see it. Asserting the exact set both
// directions is what catches "we classified a name the server no longer
// has" as well as "the server has a tool we never classified".
func TestAllowedTools_IsExactlyTheClassReadSet(t *testing.T) {
	assert.DeepEqual(t, circlecimcp.AllowedTools(), sortedCopy(knownReadTools))
}

// TestClassifications_NoEmptyOrMalformedNames guards against the literal
// shape of a copy-paste mistake in toolClassifications: an empty string key,
// or a name carrying leading/trailing whitespace that would never match
// anything the server actually sends in a tools/list response (and so would
// silently classify nothing, exactly like this bug's stale names did).
func TestClassifications_NoEmptyOrMalformedNames(t *testing.T) {
	for _, tool := range append(append([]string{}, knownReadTools...), knownWriteTools...) {
		assert.Assert(t, tool != "", "classified tool name must not be empty")
		assert.Equal(t, tool, strings.TrimSpace(tool), "classified tool name %q must not carry surrounding whitespace", tool)
	}
}

// TestClassifications_ReadAndWriteSetsAreDisjoint is the property a
// classification map must never violate: no tool name may appear in both
// knownReadTools and knownWriteTools, because Classify and IsReadOnly can
// only return one answer for a given key -- a name present in both lists in
// this test would just mean the test itself is wrong, but a name classified
// both ways in toolClassifications proper is impossible (a Go map has one
// value per key), so this pins the *test's* two lists agree with that
// invariant rather than silently talking past each other.
func TestClassifications_ReadAndWriteSetsAreDisjoint(t *testing.T) {
	write := make(map[string]bool, len(knownWriteTools))
	for _, tool := range knownWriteTools {
		write[tool] = true
	}
	for _, tool := range knownReadTools {
		assert.Assert(t, !write[tool], "tool %q listed as both read and write", tool)
	}
}

// TestAllClassifiedTools_IsTheUnionOfReadAndWrite pins AllClassifiedTools
// against the same two lists the rest of this file already trusts: it must
// contain every read tool and every write tool, and nothing else -- the
// property cmd/check-tools relies on to report "we classify a tool the
// server no longer has" without also flagging every write tool it can
// never see confirmed live (see AllClassifiedTools's doc comment for why
// AllowedTools alone can't play this role).
func TestAllClassifiedTools_IsTheUnionOfReadAndWrite(t *testing.T) {
	want := sortedCopy(append(append([]string{}, knownReadTools...), knownWriteTools...))
	assert.DeepEqual(t, circlecimcp.AllClassifiedTools(), want)
}

func sortedCopy(in []string) []string {
	out := make([]string, len(in))
	copy(out, in)
	sort.Strings(out)
	return out
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
