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

package circleci_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
)

// The response bodies below are copied verbatim from the live decision
// endpoint, captured on 2026-07-29 while establishing that a personal API
// token can call it at all (issue #215). Keeping the real bytes here is what
// makes the decoding assertions worth anything: the field names, the
// omitted-when-empty behaviour and the `{rule, reason}` violation shape are
// all upstream's choices, not ours.
const (
	// A PASS against an org whose bundle has three enabled rules.
	livePassBody = `{"status":"PASS","enabled_rules":["check_orb_version","required_jobs_in_workflow","use_official_docker_image"]}`

	// A SOFT_FAIL: one non-blocking rule fired. Note there is no
	// hard_failures key at all.
	liveSoftFailBody = `{"status":"SOFT_FAIL","enabled_rules":["check_orb_version","required_jobs_in_workflow","use_official_docker_image"],` +
		`"soft_failures":[{"rule":"use_official_docker_image","reason":"nginx:latest is not an approved Docker image. Please only use images approved by our organization"}]}`

	// A HARD_FAIL carrying both lists at once — the case that proves hard
	// and soft failures are not mutually exclusive.
	liveHardFailBody = `{"status":"HARD_FAIL","enabled_rules":["check_orb_version","required_jobs_in_workflow","use_official_docker_image"],` +
		`"hard_failures":[{"rule":"check_orb_version","reason":"It looks like this orb version is not allowed. Please pick a different orb_version or check with your admin"},` +
		`{"rule":"required_jobs_in_workflow","reason":"Job 'security-scan' is enforced by your Security Team but missing from this workflow"}],` +
		`"soft_failures":[{"rule":"use_official_docker_image","reason":"nginx:latest is not an approved Docker image. Please only use images approved by our organization"}]}`

	// A PASS against an org with no policies at all. The single-field body
	// is why "PASS" alone cannot be reported as "your policies are
	// satisfied" — there were none.
	liveEmptyBundlePassBody = `{"status":"PASS"}`
)

func TestDecidePolicy_RequestShape(t *testing.T) {
	var gotBody map[string]any
	var gotPath, gotMethod, gotToken string

	_, client := newFakeCircleCI(t, "the-token", func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		gotToken = r.Header.Get("Circle-Token")
		assert.NilError(t, json.NewDecoder(r.Body).Decode(&gotBody))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(livePassBody))
	})

	_, err := client.DecidePolicy(context.Background(), circleci.PolicyDecisionRequest{
		OwnerID:    "4ada2c32-f0c2-4b60-a6b8-af674858fd51",
		ConfigYAML: "version: 2.1\n",
		Metadata:   map[string]any{"project_id": "93d2dc11", "vcs": map[string]any{"branch": "main"}},
	})
	assert.NilError(t, err)

	// The exact request `circleci policy decide` makes, including the
	// default policy context.
	assert.Equal(t, gotMethod, http.MethodPost)
	assert.Equal(t, gotPath, "/api/v2/owner/4ada2c32-f0c2-4b60-a6b8-af674858fd51/context/config/decision")
	assert.Equal(t, gotToken, "the-token")
	assert.Equal(t, gotBody["input"], "version: 2.1\n")

	metadata, ok := gotBody["metadata"].(map[string]any)
	assert.Assert(t, ok, "metadata should be sent as an object")
	assert.Equal(t, metadata["project_id"], "93d2dc11")
}

func TestDecidePolicy_PolicyContextIsOverridable(t *testing.T) {
	var gotPath string
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		// The escaped form: what actually went over the wire, which is
		// the point of the assertion.
		gotPath = r.URL.EscapedPath()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(livePassBody))
	})

	_, err := client.DecidePolicy(context.Background(), circleci.PolicyDecisionRequest{
		OwnerID:       "owner-1",
		PolicyContext: "custom context",
		ConfigYAML:    "version: 2.1\n",
	})
	assert.NilError(t, err)
	assert.Equal(t, gotPath, "/api/v2/owner/owner-1/context/custom%20context/decision")
}

func TestDecidePolicy_OmitsMetadataWhenEmpty(t *testing.T) {
	var gotBody map[string]any
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		assert.NilError(t, json.NewDecoder(r.Body).Decode(&gotBody))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(livePassBody))
	})

	_, err := client.DecidePolicy(context.Background(), circleci.PolicyDecisionRequest{
		OwnerID:    "owner-1",
		ConfigYAML: "version: 2.1\n",
	})
	assert.NilError(t, err)

	_, present := gotBody["metadata"]
	assert.Assert(t, !present, "no metadata should mean no metadata key, not an empty object")
}

func TestDecidePolicy_DecodesLiveResponses(t *testing.T) {
	tests := []struct {
		name         string
		body         string
		wantStatus   circleci.PolicyStatus
		wantRules    int
		wantHard     int
		wantSoft     int
		wantFirstOne string
	}{
		{
			name:       "pass",
			body:       livePassBody,
			wantStatus: circleci.PolicyStatusPass,
			wantRules:  3,
		},
		{
			name:         "soft fail",
			body:         liveSoftFailBody,
			wantStatus:   circleci.PolicyStatusSoftFail,
			wantRules:    3,
			wantSoft:     1,
			wantFirstOne: "use_official_docker_image",
		},
		{
			name:         "hard fail carries soft failures too",
			body:         liveHardFailBody,
			wantStatus:   circleci.PolicyStatusHardFail,
			wantRules:    3,
			wantHard:     2,
			wantSoft:     1,
			wantFirstOne: "check_orb_version",
		},
		{
			name:       "pass against an empty bundle",
			body:       liveEmptyBundlePassBody,
			wantStatus: circleci.PolicyStatusPass,
			wantRules:  0,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(tc.body))
			})

			decision, err := client.DecidePolicy(context.Background(), circleci.PolicyDecisionRequest{
				OwnerID:    "owner-1",
				ConfigYAML: "version: 2.1\n",
			})
			assert.NilError(t, err)
			assert.Equal(t, decision.Status, tc.wantStatus)
			assert.Assert(t, decision.Status.Known())
			assert.Equal(t, len(decision.EnabledRules), tc.wantRules)
			assert.Equal(t, len(decision.HardFailures), tc.wantHard)
			assert.Equal(t, len(decision.SoftFailures), tc.wantSoft)

			if tc.wantFirstOne != "" {
				violations := decision.HardFailures
				if len(violations) == 0 {
					violations = decision.SoftFailures
				}
				assert.Equal(t, violations[0].Rule, tc.wantFirstOne)
				assert.Assert(t, violations[0].Reason != "", "a violation's reason is the only actionable part")
			}
		})
	}
}

func TestPolicyStatus_UnknownStatusIsNotSilentlyAccepted(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"SOFT_BLOCK"}`))
	})

	decision, err := client.DecidePolicy(context.Background(), circleci.PolicyDecisionRequest{
		OwnerID:    "owner-1",
		ConfigYAML: "version: 2.1\n",
	})
	assert.NilError(t, err)
	// The raw value is preserved rather than coerced, and Known() is the
	// gate every caller must pass before treating it as a verdict.
	assert.Equal(t, string(decision.Status), "SOFT_BLOCK")
	assert.Assert(t, !decision.Status.Known())

	assert.Assert(t, circleci.PolicyStatusPass.Known())
	assert.Assert(t, circleci.PolicyStatusSoftFail.Known())
	assert.Assert(t, circleci.PolicyStatusHardFail.Known())
	assert.Assert(t, circleci.PolicyStatusError.Known())
	assert.Assert(t, !circleci.PolicyStatus("").Known())
}

func TestDecidePolicy_ErrorStatusIsAVerdictNotAnError(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ERROR","reason":"policy example: eval_conflict_error"}`))
	})

	decision, err := client.DecidePolicy(context.Background(), circleci.PolicyDecisionRequest{
		OwnerID:    "owner-1",
		ConfigYAML: "version: 2.1\n",
	})
	assert.NilError(t, err, "an ERROR decision is an answer, not a transport failure")
	assert.Equal(t, decision.Status, circleci.PolicyStatusError)
	assert.Equal(t, decision.Reason, "policy example: eval_conflict_error")
}

func TestDecidePolicy_RefusesWithoutAnOwner(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", func(http.ResponseWriter, *http.Request) {
		t.Error("no request should be made without an owner ID")
	})

	_, err := client.DecidePolicy(context.Background(), circleci.PolicyDecisionRequest{ConfigYAML: "version: 2.1\n"})
	assert.ErrorIs(t, err, circleci.ErrPolicyOwnerRequired)
}

func TestDecidePolicy_UpstreamStatusesAreClassifiable(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
		check  func(error) bool
	}{
		{
			// The live behaviour when the org's plan does not include
			// config policies, or the token cannot see the org.
			name:   "forbidden",
			status: http.StatusForbidden,
			body:   `{"error":"Forbidden: plan does not have sufficient permissions"}`,
			check:  circleci.IsForbidden,
		},
		{
			// The live behaviour when the input is not parseable.
			name:   "bad request",
			status: http.StatusBadRequest,
			body:   `{"error":"failed to make decision: invalid input: yaml: line 1: did not find expected ',' or ']'"}`,
			check:  circleci.IsBadRequest,
		},
		{
			name:   "unauthorized",
			status: http.StatusUnauthorized,
			body:   `{"message":"You must log in first"}`,
			check:  circleci.IsUnauthorized,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})

			decision, err := client.DecidePolicy(context.Background(), circleci.PolicyDecisionRequest{
				OwnerID:    "owner-1",
				ConfigYAML: "version: 2.1\n",
			})
			assert.Assert(t, err != nil, "a refused request must never yield a decision")
			assert.Assert(t, is.Nil(decision))
			assert.Assert(t, tc.check(err))

			status, ok := circleci.StatusCode(err)
			assert.Assert(t, ok)
			assert.Equal(t, status, tc.status)
		})
	}
}

func TestGetOrganization_ResolvesASlugToAUUID(t *testing.T) {
	var gotPath string
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
		// Verbatim from the live endpoint.
		_, _ = w.Write([]byte(`{"slug":"gh/CircleCI-Labs","name":"CircleCI-Labs","vcs_type":"github","id":"4ada2c32-f0c2-4b60-a6b8-af674858fd51"}`))
	})

	org, err := client.GetOrganization(context.Background(), "gh/CircleCI-Labs")
	assert.NilError(t, err)
	assert.Equal(t, gotPath, "/api/v2/organization/gh/CircleCI-Labs")
	assert.Equal(t, org.ID, "4ada2c32-f0c2-4b60-a6b8-af674858fd51")
	assert.Equal(t, org.Slug, "gh/CircleCI-Labs")
	assert.Equal(t, org.Name, "CircleCI-Labs")
	assert.Equal(t, org.VCSType, "github")
}

func TestGetOrganization_KeepsTheSlugsSegmentsIntact(t *testing.T) {
	var gotPath, gotEscaped string
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotEscaped = r.URL.EscapedPath()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"x"}`))
	})

	// An org name with a space is escaped, but the slug separator is not:
	// escaping it would address a different endpoint entirely.
	_, err := client.GetOrganization(context.Background(), "gh/my org")
	assert.NilError(t, err)
	assert.Equal(t, gotEscaped, "/api/v2/organization/gh/my%20org")
	assert.Equal(t, gotPath, "/api/v2/organization/gh/my org")
}

func TestGetOrganization_NotFoundIsItsOwnClass(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"Org not found."}`))
	})

	org, err := client.GetOrganization(context.Background(), "gh/nope")
	assert.Assert(t, is.Nil(org))
	assert.Assert(t, circleci.IsNotFound(err))
}

func TestGetOrganization_RefusesWithoutASlug(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", func(http.ResponseWriter, *http.Request) {
		t.Error("no request should be made without a slug")
	})

	_, err := client.GetOrganization(context.Background(), "")
	assert.ErrorIs(t, err, circleci.ErrOrganizationSlugRequired)
}
