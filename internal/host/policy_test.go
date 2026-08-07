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

package host_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"gopkg.in/yaml.v3"
	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

// defaultTestCompiledYAML is what newPolicyTestServer's default fakeCompiler
// hands back when a test does not care about compile behaviour specifically
// -- distinct from any test's own source text, so a test that forgets to
// pass its own compiler still gets a visibly-merged input rather than one
// that happens to look like source-only by coincidence.
const defaultTestCompiledYAML = "version: 2\njobs: {}\n"

// fakePolicyClient stands in for the host package's unexported policyDecider.
// It records what it was asked, so the tests can assert that the config, the
// owner UUID and the metadata all arrive as intended -- and that nothing is
// sent at all in the states where no decision should be attempted.
type fakePolicyClient struct {
	org    *circleci.Organization
	orgErr error

	decision    *circleci.PolicyDecision
	decisionErr error

	gotOrgSlug   string
	orgCalls     atomic.Int32
	gotRequest   circleci.PolicyDecisionRequest
	decideCalls  atomic.Int32
	sentContents []string
}

func (f *fakePolicyClient) GetOrganization(_ context.Context, slug string) (*circleci.Organization, error) {
	f.orgCalls.Add(1)
	f.gotOrgSlug = slug
	if f.orgErr != nil {
		return nil, f.orgErr
	}
	return f.org, nil
}

func (f *fakePolicyClient) DecidePolicy(_ context.Context, req circleci.PolicyDecisionRequest) (*circleci.PolicyDecision, error) {
	f.decideCalls.Add(1)
	f.gotRequest = req
	f.sentContents = append(f.sentContents, req.ConfigYAML)
	if f.decisionErr != nil {
		return nil, f.decisionErr
	}
	return f.decision, nil
}

// policyEnv is the CLI-plugin environment a policy check needs: a token, and
// enough of a project identity to know which organization owns it.
type policyEnv struct {
	token     string
	vcsType   string
	org       string
	repo      string
	projectID string
	branch    string
}

// connectedPolicyEnv is the fully-populated case: a token, an org slug and
// both metadata facts.
func connectedPolicyEnv() policyEnv {
	return policyEnv{
		token:     sentinelToken,
		vcsType:   "github",
		org:       "acme",
		repo:      "web",
		projectID: "93d2dc11-7495-41a9-ad8c-4ce0773a9789",
		branch:    "feature/policies",
	}
}

// compiler may be nil: a test that does not care how compilation went gets
// a compiler that succeeds trivially (issue #25's default), so its
// assertions about org resolution, verdict passthrough or upstream errors
// are not also silently pinning compile behaviour it never meant to
// exercise. A test that does care -- the ones in this file named for
// "CompiledConfig" -- passes its own fakeCompiler instead.
func newPolicyTestServer(t *testing.T, env policyEnv, client *fakePolicyClient, compiler *fakeCompiler) *httptest.Server {
	t.Helper()

	clearCircleEnv(t)
	t.Setenv("CIRCLE_TOKEN", env.token)
	t.Setenv("CIRCLE_VCS_TYPE", env.vcsType)
	t.Setenv("CIRCLE_PROJECT_USERNAME", env.org)
	t.Setenv("CIRCLE_PROJECT_REPONAME", env.repo)
	t.Setenv("CIRCLE_PROJECT_ID", env.projectID)
	t.Setenv("CIRCLE_BRANCH", env.branch)

	opts := host.Options{WorkDir: t.TempDir(), Version: "test-version"}
	if client != nil {
		opts.PolicyClient = client
	}
	if compiler == nil {
		compiler = &fakeCompiler{result: &circleci.CompileResult{Valid: true, OutputYAML: defaultTestCompiledYAML}}
	}
	opts.Compiler = compiler

	srv, err := host.New(opts)
	assert.NilError(t, err)

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// policyBody mirrors policyResponse for decoding in tests.
type policyBody struct {
	Available      bool     `json:"available"`
	Source         string   `json:"source"`
	Reason         string   `json:"reason"`
	Status         string   `json:"status"`
	EnabledRules   []string `json:"enabledRules"`
	DecisionReason string   `json:"decisionReason"`
	OrgSlug        string   `json:"orgSlug"`
	PolicyContext  string   `json:"policyContext"`
	MetadataSent   []string `json:"metadataSent"`
	HardFailures   []struct {
		Rule   string `json:"rule"`
		Reason string `json:"reason"`
	} `json:"hardFailures"`
	SoftFailures []struct {
		Rule   string `json:"rule"`
		Reason string `json:"reason"`
	} `json:"softFailures"`
	CompiledConfigIncluded bool   `json:"compiledConfigIncluded"`
	CompiledConfigReason   string `json:"compiledConfigReason"`
}

func decidePolicy(t *testing.T, ts *httptest.Server, contents string) (int, string, policyBody) {
	t.Helper()

	reqBody, err := json.Marshal(map[string]string{"contents": contents})
	assert.NilError(t, err)

	status, body := doRequest(t, ts, http.MethodPost, "/api/policy/decide", reqBody)
	assert.Assert(t, !strings.Contains(body, sentinelToken), "response leaked the token: %s", body)

	var got policyBody
	if strings.HasPrefix(strings.TrimSpace(body), "{") {
		assert.NilError(t, json.Unmarshal([]byte(body), &got))
	}
	return status, body, got
}

func passingClient() *fakePolicyClient {
	return &fakePolicyClient{
		org: &circleci.Organization{ID: "owner-uuid", Slug: "gh/acme"},
		decision: &circleci.PolicyDecision{
			Status:       circleci.PolicyStatusPass,
			EnabledRules: []string{"use_official_docker_image"},
		},
	}
}

func TestServer_PolicyDecide_Pass(t *testing.T) {
	client := passingClient()
	ts := newPolicyTestServer(t, connectedPolicyEnv(), client, nil)

	status, _, got := decidePolicy(t, ts, "version: 2.1\n")
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, got.Available, true)
	assert.Equal(t, got.Source, "api")
	assert.Equal(t, got.Status, "PASS")
	assert.DeepEqual(t, got.EnabledRules, []string{"use_official_docker_image"})
	assert.Equal(t, got.OrgSlug, "gh/acme")
	assert.Equal(t, got.PolicyContext, "config")

	// The org slug this host assembled is what was looked up, and the UUID
	// that came back is what the decision was keyed by.
	assert.Equal(t, client.gotOrgSlug, "gh/acme")
	assert.Equal(t, client.gotRequest.OwnerID, "owner-uuid")
	assert.Equal(t, client.gotRequest.PolicyContext, "config")

	// Issue #25: with a compiler that succeeds (newPolicyTestServer's
	// default), what actually reaches the decision endpoint is no longer
	// the bare source -- it is source-plus-compiled, so this asserts on the
	// parsed document rather than a literal string match against either
	// input's own YAML rendering. See
	// TestServer_PolicyDecide_MergesCompiledConfigWhenAvailable for the
	// shape in full.
	var sentInput map[string]any
	assert.NilError(t, yaml.Unmarshal([]byte(client.gotRequest.ConfigYAML), &sentInput))
	assert.Equal(t, sentInput["version"], 2.1)
	assert.Assert(t, sentInput["_compiled_"] != nil)
	assert.Equal(t, got.CompiledConfigIncluded, true)
	assert.Equal(t, got.CompiledConfigReason, "")
}

func TestServer_PolicyDecide_ThreeVerdictsAreReportedVerbatim(t *testing.T) {
	tests := []struct {
		name     string
		decision *circleci.PolicyDecision
		want     string
		wantHard int
		wantSoft int
	}{
		{
			name: "soft fail",
			decision: &circleci.PolicyDecision{
				Status:       circleci.PolicyStatusSoftFail,
				EnabledRules: []string{"use_official_docker_image"},
				SoftFailures: []circleci.PolicyViolation{{
					Rule:   "use_official_docker_image",
					Reason: "nginx:latest is not an approved Docker image",
				}},
			},
			want:     "SOFT_FAIL",
			wantSoft: 1,
		},
		{
			name: "hard fail with both lists",
			decision: &circleci.PolicyDecision{
				Status:       circleci.PolicyStatusHardFail,
				EnabledRules: []string{"check_orb_version", "use_official_docker_image"},
				HardFailures: []circleci.PolicyViolation{{
					Rule:   "check_orb_version",
					Reason: "It looks like this orb version is not allowed",
				}},
				SoftFailures: []circleci.PolicyViolation{{
					Rule:   "use_official_docker_image",
					Reason: "nginx:latest is not an approved Docker image",
				}},
			},
			want:     "HARD_FAIL",
			wantHard: 1,
			wantSoft: 1,
		},
		{
			name: "engine error is a decision, not a transport failure",
			decision: &circleci.PolicyDecision{
				Status: circleci.PolicyStatusError,
				Reason: "policy example: eval_conflict_error",
			},
			want: "ERROR",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client := &fakePolicyClient{
				org:      &circleci.Organization{ID: "owner-uuid"},
				decision: tc.decision,
			}
			ts := newPolicyTestServer(t, connectedPolicyEnv(), client, nil)

			status, _, got := decidePolicy(t, ts, "version: 2.1\n")
			assert.Equal(t, status, http.StatusOK)
			assert.Equal(t, got.Available, true, "a verdict was reached, whatever it says")
			assert.Equal(t, got.Status, tc.want)
			assert.Equal(t, len(got.HardFailures), tc.wantHard)
			assert.Equal(t, len(got.SoftFailures), tc.wantSoft)

			if tc.decision.Reason != "" {
				assert.Equal(t, got.DecisionReason, tc.decision.Reason)
			}
			for _, violation := range append(got.HardFailures, got.SoftFailures...) {
				assert.Assert(t, violation.Rule != "", "a violation without its rule is not actionable")
				assert.Assert(t, violation.Reason != "")
			}
		})
	}
}

func TestServer_PolicyDecide_PassAgainstAnEmptyBundleKeepsItsEmptyRuleList(t *testing.T) {
	// The live shape for an org with no policies: `{"status":"PASS"}`. The
	// empty rule list is the only thing that stops the UI reporting "your
	// policies are satisfied" when there are none, so it must survive the
	// round trip as empty rather than being filled in.
	client := &fakePolicyClient{
		org:      &circleci.Organization{ID: "owner-uuid"},
		decision: &circleci.PolicyDecision{Status: circleci.PolicyStatusPass},
	}
	ts := newPolicyTestServer(t, connectedPolicyEnv(), client, nil)

	_, _, got := decidePolicy(t, ts, "version: 2.1\n")
	assert.Equal(t, got.Available, true)
	assert.Equal(t, got.Status, "PASS")
	assert.Equal(t, len(got.EnabledRules), 0)
}

// TestServer_PolicyDecide_MergesCompiledConfigWhenAvailable is issue #25's
// core assertion: when this config compiles, the document that reaches the
// decision endpoint is source-plus-compiled, in the exact nested shape
// `circleci policy eval` produces for a real evaluation (see
// circleci.MergePolicyInput's own doc comment for how that shape was
// confirmed), not the source alone #215 always sent.
func TestServer_PolicyDecide_MergesCompiledConfigWhenAvailable(t *testing.T) {
	client := passingClient()
	compiler := &fakeCompiler{result: &circleci.CompileResult{
		Valid: true,
		OutputYAML: "version: 2\n" +
			"jobs:\n" +
			"  build:\n" +
			"    resource_class: medium\n",
	}}
	ts := newPolicyTestServer(t, connectedPolicyEnv(), client, compiler)

	source := "version: 2.1\n" +
		"executors:\n" +
		"  e:\n" +
		"    resource_class: medium\n" +
		"jobs:\n" +
		"  build:\n" +
		"    executor: e\n"

	status, _, got := decidePolicy(t, ts, source)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, got.Available, true)
	assert.Equal(t, got.CompiledConfigIncluded, true)
	assert.Equal(t, got.CompiledConfigReason, "")

	// Compiled in this project's own org context -- the same one the
	// decision itself is keyed by, not an anonymous compile.
	assert.Equal(t, compiler.gotReq.ConfigYAML, source)
	assert.Equal(t, compiler.gotReq.OwnerID, "owner-uuid")

	var sentInput map[string]any
	assert.NilError(t, yaml.Unmarshal([]byte(client.gotRequest.ConfigYAML), &sentInput))
	assert.Assert(t, sentInput["executors"] != nil, "the source's own top-level keys must still be present")

	compiledSection, ok := sentInput["_compiled_"].(map[string]any)
	assert.Assert(t, ok, "_compiled_ must be a nested document, not a compiled-YAML string")
	jobs, ok := compiledSection["jobs"].(map[string]any)
	assert.Assert(t, ok)
	build, ok := jobs["build"].(map[string]any)
	assert.Assert(t, ok)
	assert.Equal(t, build["resource_class"], "medium")
}

// TestServer_PolicyDecide_SourceOnlyWhenCompileFails covers the honesty
// requirement issue #25 makes non-optional: a compile failure degrades the
// check to source-only, it does not cancel it, and the response says so
// rather than looking identical to a decision that did see the compiled
// form.
func TestServer_PolicyDecide_SourceOnlyWhenCompileFails(t *testing.T) {
	client := passingClient()
	compiler := &fakeCompiler{err: &circleci.APIError{
		StatusCode: http.StatusInternalServerError,
		Method:     http.MethodPost,
		Path:       "/api/v2/compile-config-with-defaults",
		Body:       "boom",
	}}
	ts := newPolicyTestServer(t, connectedPolicyEnv(), client, compiler)

	status, body, got := decidePolicy(t, ts, "version: 2.1\n")
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, got.Available, true, "a compile failure degrades the input, it does not cancel the check")
	assert.Equal(t, got.CompiledConfigIncluded, false)
	assert.Assert(t, is.Contains(got.CompiledConfigReason, "compiled"))
	assert.Assert(t, !strings.Contains(body, "boom"), "the compile endpoint's own response body must not leak through this one")

	// Exactly what issue #215 always sent: nothing invented, nothing missing.
	assert.Equal(t, client.gotRequest.ConfigYAML, "version: 2.1\n")
}

// TestServer_PolicyDecide_SourceOnlyWhenConfigDoesNotCompile covers the
// other way compilation can fail to produce a "_compiled_" key: the call
// itself succeeds, but CircleCI says the config is invalid. A config that
// does not compile never reaches a real pipeline-trigger evaluation either,
// so there is no compiled form to include -- but the source-only check
// still runs and still says why.
func TestServer_PolicyDecide_SourceOnlyWhenConfigDoesNotCompile(t *testing.T) {
	client := passingClient()
	compiler := &fakeCompiler{result: &circleci.CompileResult{
		Valid:  false,
		Errors: []circleci.CompileError{{Message: "unknown top-level key: nonsense"}},
	}}
	ts := newPolicyTestServer(t, connectedPolicyEnv(), client, compiler)

	status, _, got := decidePolicy(t, ts, "version: 2.1\nnonsense: true\n")
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, got.Available, true)
	assert.Equal(t, got.CompiledConfigIncluded, false)
	assert.Assert(t, is.Contains(got.CompiledConfigReason, "did not compile"))
	assert.Equal(t, client.gotRequest.ConfigYAML, "version: 2.1\nnonsense: true\n")
}

func TestServer_PolicyDecide_SendsOnlyTheMetadataItActuallyHas(t *testing.T) {
	tests := []struct {
		name string
		env  policyEnv
		want []string
	}{
		{
			name: "both facts known",
			env:  connectedPolicyEnv(),
			want: []string{"project_id", "vcs.branch"},
		},
		{
			name: "no branch",
			env: policyEnv{
				token: sentinelToken, vcsType: "github", org: "acme", repo: "web",
				projectID: "93d2dc11",
			},
			want: []string{"project_id"},
		},
		{
			name: "neither",
			env: policyEnv{
				token: sentinelToken, vcsType: "github", org: "acme", repo: "web",
			},
			want: nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client := passingClient()
			ts := newPolicyTestServer(t, tc.env, client, nil)

			_, _, got := decidePolicy(t, ts, "version: 2.1\n")
			assert.Equal(t, got.Available, true)
			assert.DeepEqual(t, got.MetadataSent, tc.want)

			// Nothing invented: the metadata that went upstream holds
			// exactly the keys the response claims.
			assert.Equal(t, len(client.gotRequest.Metadata), len(tc.want))
		})
	}
}

func TestServer_PolicyDecide_NoTokenSendsNothingAndSaysWhy(t *testing.T) {
	client := passingClient()
	env := connectedPolicyEnv()
	env.token = ""
	ts := newPolicyTestServer(t, env, client, nil)

	status, _, got := decidePolicy(t, ts, "version: 2.1\n")
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, got.Available, false, "no token means no decision, which must not read as a pass")
	assert.Equal(t, got.Source, "unavailable")
	assert.Assert(t, is.Contains(got.Reason, "token"))
	assert.Equal(t, got.Status, "", "there is no verdict to report")

	// The config must not leave this host when nothing can be done with it.
	assert.Equal(t, client.decideCalls.Load(), int32(0))
	assert.Equal(t, client.orgCalls.Load(), int32(0))
}

func TestServer_PolicyDecide_NoOrganizationSendsNothingAndSaysWhy(t *testing.T) {
	client := passingClient()
	ts := newPolicyTestServer(t, policyEnv{token: sentinelToken}, client, nil)

	status, _, got := decidePolicy(t, ts, "version: 2.1\n")
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, got.Available, false)
	assert.Assert(t, is.Contains(got.Reason, "organization"))
	assert.Equal(t, client.decideCalls.Load(), int32(0))
}

func TestServer_PolicyDecide_EmptyConfigIsNotAPass(t *testing.T) {
	client := passingClient()
	ts := newPolicyTestServer(t, connectedPolicyEnv(), client, nil)

	status, _, got := decidePolicy(t, ts, "   \n\n")
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, got.Available, false)
	assert.Assert(t, is.Contains(got.Reason, "empty"))
	assert.Equal(t, client.decideCalls.Load(), int32(0))
}

func TestServer_PolicyDecide_UpstreamFailures(t *testing.T) {
	apiError := func(status int) error {
		return &circleci.APIError{
			StatusCode: status,
			Method:     http.MethodPost,
			Path:       "/api/v2/owner/owner-uuid/context/config/decision",
			Body:       `{"error":"Forbidden: plan does not have sufficient permissions","context":{"org-id":"secret-org-uuid"}}`,
		}
	}

	tests := []struct {
		name           string
		err            error
		wantStatus     int
		wantAvailable  bool
		wantReasonHas  []string
		wantNotInReply []string
	}{
		{
			// A Scale-plan feature the org may not have, or a token that
			// cannot see the org. This host will not read the body to find
			// out which, so it names both possibilities.
			name:           "forbidden is a settled state, not a retry",
			err:            apiError(http.StatusForbidden),
			wantStatus:     http.StatusOK,
			wantAvailable:  false,
			wantReasonHas:  []string{"403", "Scale"},
			wantNotInReply: []string{"secret-org-uuid", "sufficient permissions"},
		},
		{
			name:           "bad request means the engine never saw a config",
			err:            apiError(http.StatusBadRequest),
			wantStatus:     http.StatusOK,
			wantAvailable:  false,
			wantReasonHas:  []string{"400", "parse"},
			wantNotInReply: []string{"secret-org-uuid"},
		},
		{
			name:           "a rejected token is worth retrying after fixing it",
			err:            apiError(http.StatusUnauthorized),
			wantStatus:     http.StatusBadGateway,
			wantReasonHas:  nil,
			wantNotInReply: []string{"secret-org-uuid", "sufficient permissions"},
		},
		{
			name:           "rate limiting is transient",
			err:            apiError(http.StatusTooManyRequests),
			wantStatus:     http.StatusBadGateway,
			wantNotInReply: []string{"secret-org-uuid"},
		},
		{
			name:           "a server error is transient",
			err:            apiError(http.StatusBadGateway),
			wantStatus:     http.StatusBadGateway,
			wantNotInReply: []string{"secret-org-uuid"},
		},
		{
			name:           "a transport failure names no status",
			err:            errors.New("dial tcp: lookup circleci.com: no such host"),
			wantStatus:     http.StatusBadGateway,
			wantNotInReply: []string{"no such host"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client := &fakePolicyClient{
				org:         &circleci.Organization{ID: "owner-uuid"},
				decisionErr: tc.err,
			}
			ts := newPolicyTestServer(t, connectedPolicyEnv(), client, nil)

			status, body, got := decidePolicy(t, ts, "version: 2.1\n")
			assert.Equal(t, status, tc.wantStatus)

			if tc.wantStatus == http.StatusOK {
				assert.Equal(t, got.Available, tc.wantAvailable)
				assert.Equal(t, got.Status, "", "a failed check has no verdict")
				for _, want := range tc.wantReasonHas {
					assert.Assert(t, is.Contains(got.Reason, want))
				}
			}

			// The upstream response body never reaches the browser, whichever
			// channel the failure came back through (issue #150's rule).
			for _, forbidden := range tc.wantNotInReply {
				assert.Assert(t, !strings.Contains(body, forbidden),
					"response leaked upstream detail %q: %s", forbidden, body)
			}
		})
	}
}

func TestServer_PolicyDecide_OrganizationLookupFailures(t *testing.T) {
	tests := []struct {
		name          string
		err           error
		wantStatus    int
		wantReasonHas string
	}{
		{
			name:          "no such organization",
			err:           &circleci.APIError{StatusCode: http.StatusNotFound, Body: `{"message":"Org not found."}`},
			wantStatus:    http.StatusOK,
			wantReasonHas: "404",
		},
		{
			name:          "no permission to read the organization",
			err:           &circleci.APIError{StatusCode: http.StatusForbidden, Body: "nope"},
			wantStatus:    http.StatusOK,
			wantReasonHas: "403",
		},
		{
			name:       "a server error is worth retrying",
			err:        &circleci.APIError{StatusCode: http.StatusInternalServerError, Body: "boom"},
			wantStatus: http.StatusBadGateway,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client := &fakePolicyClient{orgErr: tc.err}
			ts := newPolicyTestServer(t, connectedPolicyEnv(), client, nil)

			status, body, got := decidePolicy(t, ts, "version: 2.1\n")
			assert.Equal(t, status, tc.wantStatus)
			assert.Assert(t, !strings.Contains(body, "boom"))
			assert.Assert(t, !strings.Contains(body, "nope"))

			if tc.wantStatus == http.StatusOK {
				assert.Equal(t, got.Available, false)
				assert.Assert(t, is.Contains(got.Reason, tc.wantReasonHas))
			}

			// The config is never posted when we do not know whose policies
			// to post it to.
			assert.Equal(t, client.decideCalls.Load(), int32(0))
			assert.Equal(t, len(client.sentContents), 0)
		})
	}
}

func TestServer_PolicyDecide_UnknownStatusIsNotAVerdict(t *testing.T) {
	client := &fakePolicyClient{
		org: &circleci.Organization{ID: "owner-uuid"},
		decision: &circleci.PolicyDecision{
			Status:       circleci.PolicyStatus("SOFT_BLOCK\nlog-forging attempt"),
			EnabledRules: []string{"whatever"},
		},
	}
	ts := newPolicyTestServer(t, connectedPolicyEnv(), client, nil)

	status, body, got := decidePolicy(t, ts, "version: 2.1\n")
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, got.Available, false, "an uninterpretable answer must not be shown as a verdict")
	assert.Assert(t, is.Contains(got.Reason, "does not recognise"))
	// Echoed back de-controlled: it is upstream text, and the only upstream
	// text this endpoint ever quotes.
	assert.Assert(t, !strings.Contains(body, "SOFT_BLOCK\\nlog-forging"))
	assert.Assert(t, is.Contains(got.Reason, "SOFT_BLOCK log-forging attempt"))
}

func TestServer_PolicyDecide_OrganizationIsResolvedOncePerProcess(t *testing.T) {
	client := passingClient()
	ts := newPolicyTestServer(t, connectedPolicyEnv(), client, nil)

	for range 3 {
		status, _, got := decidePolicy(t, ts, "version: 2.1\n")
		assert.Equal(t, status, http.StatusOK)
		assert.Equal(t, got.Available, true)
	}

	assert.Equal(t, client.decideCalls.Load(), int32(3))
	assert.Equal(t, client.orgCalls.Load(), int32(1), "the slug-to-UUID mapping does not change under a running editor")
}

func TestServer_PolicyDecide_FailedOrganizationLookupIsNotCached(t *testing.T) {
	client := &fakePolicyClient{orgErr: &circleci.APIError{StatusCode: http.StatusInternalServerError}}
	ts := newPolicyTestServer(t, connectedPolicyEnv(), client, nil)

	_, _, _ = decidePolicy(t, ts, "version: 2.1\n")
	_, _, _ = decidePolicy(t, ts, "version: 2.1\n")

	assert.Equal(t, client.orgCalls.Load(), int32(2), "a cached failure is a failure the user cannot retry out of")
}

func TestServer_PolicyDecide_MalformedRequests(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "not json", body: "{"},
		{name: "missing contents", body: `{}`},
		{name: "null contents", body: `{"contents":null}`},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client := passingClient()
			ts := newPolicyTestServer(t, connectedPolicyEnv(), client, nil)

			status, _ := doRequest(t, ts, http.MethodPost, "/api/policy/decide", []byte(tc.body))
			assert.Equal(t, status, http.StatusBadRequest)
			assert.Equal(t, client.decideCalls.Load(), int32(0))
		})
	}
}

func TestServer_PolicyDecide_RejectsNonPost(t *testing.T) {
	client := passingClient()
	ts := newPolicyTestServer(t, connectedPolicyEnv(), client, nil)

	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		status, _ := doRequest(t, ts, method, "/api/policy/decide", nil)
		assert.Equal(t, status, http.StatusMethodNotAllowed, "method %s", method)
	}
	assert.Equal(t, client.decideCalls.Load(), int32(0))
}
