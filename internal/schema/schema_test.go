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

package schema_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/schema"
)

func TestJSON_IsValidJSON(t *testing.T) {
	var doc map[string]any
	err := json.Unmarshal(schema.JSON(), &doc)
	assert.NilError(t, err)

	// Sanity-check this is actually the CircleCI config schema and not an
	// empty or unrelated document: it must declare a "jobs" and "workflows"
	// property, and every real release of the upstream schema.json has
	// both.
	props, ok := doc["properties"].(map[string]any)
	assert.Assert(t, ok, "schema.json must have a top-level \"properties\" object")
	_, hasJobs := props["jobs"]
	_, hasWorkflows := props["workflows"]
	assert.Assert(t, hasJobs, "schema.json's properties must include \"jobs\"")
	assert.Assert(t, hasWorkflows, "schema.json's properties must include \"workflows\"")
}

func TestJSON_ReturnsNonEmptyBytes(t *testing.T) {
	assert.Assert(t, len(schema.JSON()) > 1000, "embedded schema.json looks suspiciously small")
}

func TestETag_IsAQuotedNonEmptyValue(t *testing.T) {
	tag := schema.ETag()
	assert.Assert(t, is.Contains(tag, `"`))
	assert.Assert(t, len(tag) > 2)
}

func TestETag_IsStableAcrossCalls(t *testing.T) {
	assert.Equal(t, schema.ETag(), schema.ETag())
}

// TestSchemaChecksum pins the vendored schema to the exact bytes published
// upstream, verified by downloading the 0.36.1 release asset and diffing.
//
// This project redistributes someone else's Apache-2.0 file and claims in
// CONTRIBUTING.md's third-party attributions that it is unmodified. Without
// this, a well-meaning local edit -- reformatting it, or "fixing" a
// definition -- would quietly make that claim false. If this fails after a
// deliberate refresh, update the constant in the same commit that updates
// that attribution's version note, so the two cannot drift.
func TestSchemaChecksum(t *testing.T) {
	t.Parallel()

	const upstream0_36_1 = "7e3d291ea3ebba1d76b1752c925420c2637863cbac1e3f723e10e80e4be31220"

	sum := sha256.Sum256(schema.JSON())
	assert.Equal(t, hex.EncodeToString(sum[:]), upstream0_36_1,
		"vendored schema.json no longer matches the upstream release it is attributed to")
}

// TestSchemaCoversTheOrchestrationConstructs is issue #220's validation
// question, answered against the artifact this host actually serves.
//
// The three constructs the owner flagged -- job groups, serial groups and
// "deploy" jobs -- are only correctly *validated* if the vendored schema
// defines them, and one of them (`job-groups`) was previously undocumented
// in the JSON Schema. It is documented now, and this test is what will
// notice if a future snapshot bump silently drops any of them: the checksum
// test above pins the bytes, but a deliberate re-vendor changes the checksum
// on purpose and would sail past it.
//
// Nothing here validates a config. It asserts only that the vocabulary exists,
// which is what makes the compile API's verdict on these keys trustworthy and
// the editor's completions correct.
func TestSchemaCoversTheOrchestrationConstructs(t *testing.T) {
	var doc struct {
		Properties  map[string]json.RawMessage `json:"properties"`
		Definitions struct {
			WorkflowJobInvocation json.RawMessage `json:"workflowJobInvocation"`
			JobInvocation         json.RawMessage `json:"jobInvocation"`
		} `json:"definitions"`
	}
	assert.NilError(t, json.Unmarshal(schema.JSON(), &doc))

	// `job-groups` is a top-level key alongside `jobs` and `workflows`.
	_, hasJobGroups := doc.Properties["job-groups"]
	assert.Assert(t, hasJobGroups,
		"the vendored schema must define the top-level job-groups key (#220)")

	// `serial-group` and `override-with` are keys of a workflow job
	// invocation -- the shape a workflow's `jobs:` entries and a job group's
	// own `jobs:` entries both use.
	invocation := string(doc.Definitions.WorkflowJobInvocation)
	for _, key := range []string{"serial-group", "override-with", "requires"} {
		assert.Assert(t, is.Contains(invocation, `"`+key+`"`),
			"workflowJobInvocation must define %q (#220)", key)
	}

	// The job `type` enum is where "no-op" and "release" live. `no-op` is the
	// supported spelling of a fan-in gate job, and `release` -- not a job
	// merely *named* deploy -- is the construct that actually means "deploy
	// job" in current CircleCI config. There is deliberately no assertion
	// about a `deploy` step: the reference marks it DEPRECATED and this schema
	// does not define it at all, which is the finding, not a gap.
	jobTypes := string(doc.Definitions.JobInvocation)
	for _, jobType := range []string{"no-op", "release", "approval", "build"} {
		assert.Assert(t, is.Contains(jobTypes, `"`+jobType+`"`),
			"the job type enum must offer %q (#220)", jobType)
	}
}
