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
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

// fakeRunClient stands in for the host package's unexported pipelineRunner.
//
// triggerCalls is the field that matters most in this file. Almost every test
// below asserts it is *zero*: the endpoint under test is the only one in this
// program that spends money, so "nothing was triggered" is the property worth
// pinning, far more than any response field.
type fakeRunClient struct {
	project    *circleci.Project
	projectErr error

	projectSettings    *circleci.ProjectSettings
	projectSettingsErr error

	orgSettings    *circleci.OrgSettings
	orgSettingsErr error

	pipeline    *circleci.Pipeline
	pipelineErr error

	definitions    []circleci.PipelineDefinition
	definitionsErr error

	// ranConfig is what GetPipelineConfig reports the pipeline is running.
	// Empty means "nothing stored yet", which is a real state and must read
	// as unverified rather than as a mismatch.
	ranConfig    string
	ranConfigErr error

	gotSettingsProjectID    string
	gotDefinitionsProjectID string

	gotTrigger   circleci.TriggerPipelineWithConfigRequest
	triggerCalls atomic.Int32
	// runEndpointCalls counts the *newer* endpoint separately, so a test can
	// assert which of the two carried the config.
	runEndpointCalls atomic.Int32
	gotOrgID         string
}

func (f *fakeRunClient) ListPipelineDefinitions(
	_ context.Context, projectID string,
) ([]circleci.PipelineDefinition, error) {
	f.gotDefinitionsProjectID = projectID
	if f.definitionsErr != nil {
		return nil, f.definitionsErr
	}
	return f.definitions, nil
}

func (f *fakeRunClient) TriggerPipelineRunWithConfig(
	_ context.Context, req circleci.TriggerPipelineWithConfigRequest,
) (*circleci.Pipeline, error) {
	f.runEndpointCalls.Add(1)
	f.triggerCalls.Add(1)
	f.gotTrigger = req
	if f.pipelineErr != nil {
		return nil, f.pipelineErr
	}
	return f.pipeline, nil
}

func (f *fakeRunClient) GetPipelineConfig(
	_ context.Context, _ string,
) (*circleci.PipelineConfig, error) {
	if f.ranConfigErr != nil {
		return nil, f.ranConfigErr
	}
	return &circleci.PipelineConfig{Source: f.ranConfig}, nil
}

func (f *fakeRunClient) GetProject(_ context.Context, _ string) (*circleci.Project, error) {
	if f.projectErr != nil {
		return nil, f.projectErr
	}
	return f.project, nil
}

func (f *fakeRunClient) GetProjectSettings(_ context.Context, projectID string) (*circleci.ProjectSettings, error) {
	f.gotSettingsProjectID = projectID
	if f.projectSettingsErr != nil {
		return nil, f.projectSettingsErr
	}
	return f.projectSettings, nil
}

func (f *fakeRunClient) GetOrgSettings(_ context.Context, orgID string) (*circleci.OrgSettings, error) {
	f.gotOrgID = orgID
	if f.orgSettingsErr != nil {
		return nil, f.orgSettingsErr
	}
	return f.orgSettings, nil
}

func (f *fakeRunClient) TriggerPipelineWithConfig(
	_ context.Context, req circleci.TriggerPipelineWithConfigRequest,
) (*circleci.Pipeline, error) {
	f.triggerCalls.Add(1)
	f.gotTrigger = req
	if f.pipelineErr != nil {
		return nil, f.pipelineErr
	}
	return f.pipeline, nil
}

const (
	runTestBranch = "feature/try-it"
	runTestConfig = "version: 2.1\njobs: {}\n"
)

// runnableClient is the fully-permitted case: both gates on, a project record
// with an organization, and a pipeline waiting to be returned.
func runnableClient() *fakeRunClient {
	return &fakeRunClient{
		project: &circleci.Project{
			ID:               "326c2a9e-2311-45c0-965f-ccf26c8ca03e",
			Slug:             "gh/acme/widgets",
			Name:             "widgets",
			OrganizationID:   "efc130dc-284f-4533-964e-844f5c173860",
			OrganizationName: "Acme",
			OrganizationSlug: "gh/acme",
			DefaultBranch:    "main",
		},
		orgSettings:     &circleci.OrgSettings{UnversionedConfig: true},
		projectSettings: &circleci.ProjectSettings{UnversionedConfig: true},
		// One implicit OAuth definition -- the shape a classic GitHub
		// project really returns, verified live.
		definitions: []circleci.PipelineDefinition{{
			ID:                   "421f9f68-eb2a-53d8-9532-63f091c1e012",
			Name:                 "widgets",
			ConfigSourceProvider: circleci.ProviderGitHubOAuth,
		}},
		ranConfig: runTestConfig,
		pipeline: &circleci.Pipeline{
			ID:     "7c8f7b1e-0b3f-4a2f-9f2c-2f5b8a1d9e11",
			Number: 4211,
			State:  "pending",
		},
	}
}

// newRunTestServer builds a host with the CLI-plugin environment a run needs.
//
// The compiler defaults to a *valid* result rather than to
// errAssertNeverCalled, because unlike the policy endpoint this one is
// *supposed* to compile before it triggers -- that gate is the subject of its
// own test below.
func newRunTestServer(t *testing.T, token string, client *fakeRunClient, compiler *fakeCompiler) *httptest.Server {
	t.Helper()
	return newRunTestServerIn(t, t.TempDir(), runTestEnv(token), client, compiler)
}

// runTestEnv is the CLI-plugin environment a run needs. Split out so a test can
// vary the environment-derived slug independently of the recorded binding, which
// is the whole point of the disagreement cases below.
type runEnv struct {
	token   string
	vcsType string
	org     string
	repo    string
}

func runTestEnv(token string) runEnv {
	return runEnv{token: token, vcsType: "github", org: "acme", repo: "widgets"}
}

// newRunTestServerIn is newRunTestServer rooted at a caller-supplied directory,
// so a test can put a `.circleci/info.yml` there first.
func newRunTestServerIn(
	t *testing.T, dir string, env runEnv, client *fakeRunClient, compiler *fakeCompiler,
) *httptest.Server {
	t.Helper()

	clearCircleEnv(t)
	t.Setenv("CIRCLE_TOKEN", env.token)
	t.Setenv("CIRCLE_VCS_TYPE", env.vcsType)
	t.Setenv("CIRCLE_PROJECT_USERNAME", env.org)
	t.Setenv("CIRCLE_PROJECT_REPONAME", env.repo)
	t.Setenv("CIRCLE_BRANCH", runTestBranch)

	if compiler == nil {
		compiler = &fakeCompiler{result: &circleci.CompileResult{Valid: true}}
	}

	// A bare temp dir by default, so LoadGitInfo finds no checkout and the
	// branch comes from CIRCLE_BRANCH. That is deliberate: it makes
	// runTestBranch the branch under test rather than whatever branch the
	// machine running the suite happens to be on.
	opts := host.Options{WorkDir: dir, Version: "test-version", Compiler: compiler}
	if client != nil {
		opts.RunClient = client
	}

	srv, err := host.New(opts)
	assert.NilError(t, err)

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// runAvailabilityBody mirrors runAvailabilityResponse for decoding in tests.
type runAvailabilityBody struct {
	Status            string `json:"status"`
	Reason            string `json:"reason"`
	ProjectSlug       string `json:"projectSlug"`
	Branch            string `json:"branch"`
	BranchSource      string `json:"branchSource"`
	DefaultBranch     string `json:"defaultBranch"`
	DynamicConfig     bool   `json:"dynamicConfig"`
	ConfigRoute       string `json:"configRoute"`
	IdentitySource    string `json:"identitySource"`
	EnvironmentSlug   string `json:"environmentSlug"`
	IdentityDisagrees bool   `json:"identityDisagrees"`
}

// runBody mirrors runResponse for decoding in tests.
type runBody struct {
	Triggered      bool   `json:"triggered"`
	Reason         string `json:"reason"`
	Status         string `json:"status"`
	PipelineID     string `json:"pipelineId"`
	PipelineNumber int64  `json:"pipelineNumber"`
	State          string `json:"state"`
	WebURL         string `json:"webUrl"`
	ProjectSlug    string `json:"projectSlug"`
	Branch         string `json:"branch"`
	ConfigRoute    string `json:"configRoute"`
	ConfigVerified string `json:"configVerified"`
}

func getRunAvailability(t *testing.T, ts *httptest.Server) (int, runAvailabilityBody) {
	t.Helper()
	status, body := doRequest(t, ts, http.MethodGet, "/api/run/availability", nil)

	var got runAvailabilityBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Assert(t, !strings.Contains(body, sentinelToken), "the token must never reach a response")
	return status, got
}

func postRun(t *testing.T, ts *httptest.Server, payload map[string]any) (int, string, runBody) {
	t.Helper()
	reqBody, err := json.Marshal(payload)
	assert.NilError(t, err)

	status, body := doRequest(t, ts, http.MethodPost, "/api/run", reqBody)
	assert.Assert(t, !strings.Contains(body, sentinelToken), "the token must never reach a response")

	var got runBody
	// A 502 carries the error envelope rather than a runResponse, so a
	// decode failure there is expected and not asserted on.
	_ = json.Unmarshal([]byte(body), &got)
	return status, body, got
}

func runPayload() map[string]any {
	return map[string]any{"contents": runTestConfig, "branch": runTestBranch}
}

// The six availability states, each asserted from what the host actually read
// rather than inferred from a missing value. This is issue #194's honest
// degradation requirement as a table: the whole point is that no two rows
// share a Status, so no client can render "disabled" and "we could not tell"
// alike.
func TestServer_RunAvailability_States(t *testing.T) {
	tests := []struct {
		name        string
		token       string
		client      func() *fakeRunClient
		wantStatus  string
		wantReasonN []string
	}{
		{
			name:        "no token",
			token:       "",
			client:      func() *fakeRunClient { return nil },
			wantStatus:  "no-token",
			wantReasonN: []string{"token"},
		},
		{
			name:  "project unknown to CircleCI",
			token: sentinelToken,
			client: func() *fakeRunClient {
				c := runnableClient()
				c.projectErr = &circleci.APIError{StatusCode: http.StatusNotFound, Method: "GET", Path: "/p"}
				return c
			},
			wantStatus:  "no-project",
			wantReasonN: []string{"404", "nowhere to run"},
		},
		{
			name:  "organization has not opted in",
			token: sentinelToken,
			client: func() *fakeRunClient {
				c := runnableClient()
				c.orgSettings = &circleci.OrgSettings{UnversionedConfig: false}
				return c
			},
			wantStatus: "organization-disabled",
			// The organization's own name, and the fact that it overrides
			// the project: without the second half someone opens the wrong
			// settings page.
			wantReasonN: []string{"Acme", "overrides the project"},
		},
		{
			name:  "project has opted out",
			token: sentinelToken,
			client: func() *fakeRunClient {
				c := runnableClient()
				c.projectSettings = &circleci.ProjectSettings{UnversionedConfig: false}
				return c
			},
			wantStatus:  "project-disabled",
			wantReasonN: []string{"gh/acme/widgets", "organization allows it"},
		},
		{
			name:  "organization setting unreadable",
			token: sentinelToken,
			client: func() *fakeRunClient {
				c := runnableClient()
				c.orgSettingsErr = &circleci.APIError{StatusCode: http.StatusInternalServerError, Method: "GET", Path: "/o"}
				return c
			},
			wantStatus:  "unknown",
			wantReasonN: []string{"could not be determined"},
		},
		{
			name:        "everything permits it",
			token:       sentinelToken,
			client:      runnableClient,
			wantStatus:  "available",
			wantReasonN: []string{"without committing", "costs credits", "your team can see it"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client := tc.client()
			ts := newRunTestServer(t, tc.token, client, nil)

			status, got := getRunAvailability(t, ts)
			assert.Equal(t, status, http.StatusOK)
			assert.Equal(t, got.Status, tc.wantStatus)
			for _, want := range tc.wantReasonN {
				assert.Assert(t, is.Contains(got.Reason, want))
			}

			// Checking availability must never start a build.
			if client != nil {
				assert.Equal(t, client.triggerCalls.Load(), int32(0))
			}
		})
	}
}

// "Disabled" and "we could not tell" are the two the issue names explicitly,
// so they get an assertion of their own rather than only appearing as rows.
func TestServer_RunAvailability_DisabledAndUnknownAreNotTheSame(t *testing.T) {
	disabled := runnableClient()
	disabled.orgSettings = &circleci.OrgSettings{UnversionedConfig: false}
	_, disabledBody := getRunAvailability(t, newRunTestServer(t, sentinelToken, disabled, nil))

	unknown := runnableClient()
	unknown.orgSettingsErr = &circleci.APIError{StatusCode: http.StatusInternalServerError, Method: "GET", Path: "/o"}
	_, unknownBody := getRunAvailability(t, newRunTestServer(t, sentinelToken, unknown, nil))

	assert.Assert(t, disabledBody.Status != unknownBody.Status)
	assert.Assert(t, disabledBody.Reason != unknownBody.Reason)

	// The one substitution that would be actively harmful: telling someone
	// the feature is off when we simply failed to ask.
	assert.Assert(t, !strings.Contains(unknownBody.Reason, "has not turned on"))
}

// The organization gate is reported before the project gate, because it
// overrides it. Reporting the project's `false` first sends someone to a
// settings page that cannot help them -- which is the exact failure the
// issue's own premise fell into.
func TestServer_RunAvailability_OrgGateBeatsProjectGate(t *testing.T) {
	client := runnableClient()
	client.orgSettings = &circleci.OrgSettings{UnversionedConfig: false}
	client.projectSettings = &circleci.ProjectSettings{UnversionedConfig: false}

	_, got := getRunAvailability(t, newRunTestServer(t, sentinelToken, client, nil))
	assert.Equal(t, got.Status, "organization-disabled")
}

// The project-level flag alone is not the signal, which is the finding that
// sent this feature back to the drawing board: on the project issue #194 was
// filed against, the project flag is true and the organization flag is false.
func TestServer_RunAvailability_ProjectFlagAloneIsNotEnough(t *testing.T) {
	client := runnableClient()
	client.projectSettings = &circleci.ProjectSettings{UnversionedConfig: true}
	client.orgSettings = &circleci.OrgSettings{UnversionedConfig: false}

	_, got := getRunAvailability(t, newRunTestServer(t, sentinelToken, client, nil))
	assert.Assert(t, got.Status != "available")
	assert.Equal(t, got.Status, "organization-disabled")
}

func TestServer_RunAvailability_ReportsTargetAndDynamicConfig(t *testing.T) {
	client := runnableClient()
	client.projectSettings = &circleci.ProjectSettings{UnversionedConfig: true, DynamicConfig: true}

	_, got := getRunAvailability(t, newRunTestServer(t, sentinelToken, client, nil))
	assert.Equal(t, got.Status, "available")

	// CircleCI's own canonical slug, not the one assembled from the
	// environment, plus everything a confirmation has to quote.
	assert.Equal(t, got.ProjectSlug, "gh/acme/widgets")
	assert.Equal(t, got.Branch, runTestBranch)
	assert.Equal(t, got.BranchSource, "environment")
	assert.Equal(t, got.DefaultBranch, "main")

	// A caveat, not a gate: the docs say dynamic-config projects are
	// excluded, and that could not be verified, so it is reported and the
	// run is still offered.
	assert.Assert(t, got.DynamicConfig)
}

func TestServer_Run_TriggersWithTheConfigFromTheEditor(t *testing.T) {
	client := runnableClient()
	ts := newRunTestServer(t, sentinelToken, client, nil)

	status, _, got := postRun(t, ts, runPayload())
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, got.Triggered)

	assert.Equal(t, client.triggerCalls.Load(), int32(1))
	assert.Equal(t, client.gotTrigger.ConfigYAML, runTestConfig)
	assert.Equal(t, client.gotTrigger.Branch, runTestBranch)
	assert.Equal(t, client.gotTrigger.ProjectSlug, "gh/acme/widgets")

	// The organization gate is read by UUID, not by slug.
	assert.Equal(t, client.gotOrgID, "efc130dc-284f-4533-964e-844f5c173860")

	// What the user is handed afterwards: a number, and a link to the web UI.
	// No status field beyond CircleCI's word at creation, and nothing to poll.
	assert.Equal(t, got.PipelineNumber, int64(4211))
	assert.Equal(t, got.State, "pending")
	assert.Equal(t, got.WebURL, "https://app.circleci.com/pipelines/gh/acme/widgets/4211")

	// The echo, so a client can prove the run went where it said it would.
	assert.Equal(t, got.ProjectSlug, "gh/acme/widgets")
	assert.Equal(t, got.Branch, runTestBranch)
}

// Availability is re-checked immediately before triggering rather than
// trusted from the browser: the answer the client holds may be an hour old,
// and the cost of acting on a stale one is a pipeline nobody wanted.
func TestServer_Run_RechecksAvailabilityAndRefusesWhenDisabled(t *testing.T) {
	client := runnableClient()
	client.orgSettings = &circleci.OrgSettings{UnversionedConfig: false}
	ts := newRunTestServer(t, sentinelToken, client, nil)

	status, _, got := postRun(t, ts, runPayload())
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !got.Triggered)
	assert.Equal(t, got.Status, "organization-disabled")
	assert.Equal(t, client.triggerCalls.Load(), int32(0))
}

// The branch the user confirmed must be the branch that runs. A host that
// helpfully substituted its own would make the confirmation a decoration.
func TestServer_Run_RefusesWhenTheBranchIsNotTheOneOffered(t *testing.T) {
	client := runnableClient()
	ts := newRunTestServer(t, sentinelToken, client, nil)

	status, _, got := postRun(t, ts, map[string]any{
		"contents": runTestConfig,
		"branch":   "some-other-branch",
	})
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !got.Triggered)
	assert.Equal(t, client.triggerCalls.Load(), int32(0))
	assert.Assert(t, is.Contains(got.Reason, "Nothing was triggered"))
}

func TestServer_Run_RefusesAConfigThatDoesNotCompile(t *testing.T) {
	client := runnableClient()
	compiler := &fakeCompiler{result: &circleci.CompileResult{
		Valid:  false,
		Errors: []circleci.CompileError{{Message: "ERROR IN CONFIG FILE:"}},
	}}
	ts := newRunTestServer(t, sentinelToken, client, compiler)

	status, _, got := postRun(t, ts, runPayload())
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !got.Triggered)
	assert.Equal(t, client.triggerCalls.Load(), int32(0))
	assert.Assert(t, is.Contains(got.Reason, "does not compile"))
}

// A compile that could not be *performed* must not block the run. Turning
// "we could not reach CircleCI to check" into "you may not run" would be a
// worse failure than letting through a run CircleCI rejects a moment later.
func TestServer_Run_AnUnreachableCompilerDoesNotBlockTheRun(t *testing.T) {
	client := runnableClient()
	compiler := &fakeCompiler{err: &circleci.APIError{
		StatusCode: http.StatusInternalServerError, Method: "POST", Path: "/c",
	}}
	ts := newRunTestServer(t, sentinelToken, client, compiler)

	status, _, got := postRun(t, ts, runPayload())
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, got.Triggered)
	assert.Equal(t, client.triggerCalls.Load(), int32(1))
}

func TestServer_Run_NoToken_NeverTriggers(t *testing.T) {
	ts := newRunTestServer(t, "", nil, &fakeCompiler{err: errAssertNeverCalled})

	status, _, got := postRun(t, ts, runPayload())
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !got.Triggered)
	assert.Equal(t, got.Status, "no-token")
	assert.Assert(t, is.Contains(got.Reason, "token"))
}

// Upstream failures, each mapped to a settled state the user can act on --
// and every one of them stating that no pipeline was created, because after
// pressing a button that spends money that is the first thing anyone wants to
// know.
func TestServer_Run_UpstreamFailures(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantHTTP   int
		wantStatus string
		wantReason []string
	}{
		{
			name:       "forbidden",
			err:        &circleci.APIError{StatusCode: http.StatusForbidden, Method: "POST", Path: "/p"},
			wantHTTP:   http.StatusOK,
			wantStatus: "unknown",
			wantReason: []string{"403", "No pipeline was created"},
		},
		{
			name:       "project not found",
			err:        &circleci.APIError{StatusCode: http.StatusNotFound, Method: "POST", Path: "/p"},
			wantHTTP:   http.StatusOK,
			wantStatus: "no-project",
			wantReason: []string{"404", "No pipeline was created"},
		},
		{
			name:       "bad request names the branch as the likely cause",
			err:        &circleci.APIError{StatusCode: http.StatusBadRequest, Method: "POST", Path: "/p"},
			wantHTTP:   http.StatusOK,
			wantStatus: "unknown",
			wantReason: []string{"400", runTestBranch, "No pipeline was created"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client := runnableClient()
			client.pipelineErr = tc.err
			ts := newRunTestServer(t, sentinelToken, client, nil)

			status, _, got := postRun(t, ts, runPayload())
			assert.Equal(t, status, tc.wantHTTP)
			assert.Assert(t, !got.Triggered)
			assert.Equal(t, got.Status, tc.wantStatus)
			for _, want := range tc.wantReason {
				assert.Assert(t, is.Contains(got.Reason, want))
			}
		})
	}
}

// A transient failure is a 502, and it must admit that it does not know
// whether a pipeline was created -- the one case where this host cannot
// honestly say "nothing happened".
func TestServer_Run_TransientFailureAdmitsUncertainty(t *testing.T) {
	client := runnableClient()
	client.pipelineErr = &circleci.APIError{StatusCode: http.StatusInternalServerError, Method: "POST", Path: "/p"}
	ts := newRunTestServer(t, sentinelToken, client, nil)

	status, body, _ := postRun(t, ts, runPayload())
	assert.Equal(t, status, http.StatusBadGateway)
	assert.Assert(t, is.Contains(body, "cannot tell whether a pipeline was created"))
}

func TestServer_Run_BadRequests(t *testing.T) {
	tests := []struct {
		name    string
		method  string
		payload map[string]any
		raw     []byte
		want    int
	}{
		{name: "GET is not allowed", method: http.MethodGet, want: http.StatusMethodNotAllowed},
		{name: "malformed body", method: http.MethodPost, raw: []byte("{"), want: http.StatusBadRequest},
		{
			name:    "missing contents",
			method:  http.MethodPost,
			payload: map[string]any{"branch": runTestBranch},
			want:    http.StatusBadRequest,
		},
		{
			name:    "missing branch",
			method:  http.MethodPost,
			payload: map[string]any{"contents": runTestConfig},
			want:    http.StatusBadRequest,
		},
		{
			name:    "blank branch",
			method:  http.MethodPost,
			payload: map[string]any{"contents": runTestConfig, "branch": "   "},
			want:    http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client := runnableClient()
			ts := newRunTestServer(t, sentinelToken, client, nil)

			body := tc.raw
			if body == nil && tc.payload != nil {
				var err error
				body, err = json.Marshal(tc.payload)
				assert.NilError(t, err)
			}

			status, _ := doRequest(t, ts, tc.method, "/api/run", body)
			assert.Equal(t, status, tc.want)
			assert.Equal(t, client.triggerCalls.Load(), int32(0))
		})
	}
}

func TestServer_Run_RefusesAnEmptyConfig(t *testing.T) {
	client := runnableClient()
	ts := newRunTestServer(t, sentinelToken, client, nil)

	status, _, got := postRun(t, ts, map[string]any{"contents": "   \n", "branch": runTestBranch})
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !got.Triggered)
	assert.Equal(t, client.triggerCalls.Load(), int32(0))
	assert.Assert(t, is.Contains(got.Reason, "nothing to run"))
}

func TestServer_Run_PassesPipelineParametersThrough(t *testing.T) {
	client := runnableClient()
	ts := newRunTestServer(t, sentinelToken, client, nil)

	status, _, got := postRun(t, ts, map[string]any{
		"contents":   runTestConfig,
		"branch":     runTestBranch,
		"parameters": map[string]any{"deploy_prod": false},
	})
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, got.Triggered)
	assert.Equal(t, client.gotTrigger.Parameters["deploy_prod"], false)
}

func TestEnvironment_PipelineWebURL(t *testing.T) {
	tests := []struct {
		name   string
		slug   string
		number int64
		want   string
	}{
		{
			name:   "github project",
			slug:   "gh/acme/widgets",
			number: 4211,
			want:   "https://app.circleci.com/pipelines/gh/acme/widgets/4211",
		},
		{
			name:   "the long VCS spelling is canonicalised",
			slug:   "github/acme/widgets",
			number: 7,
			want:   "https://app.circleci.com/pipelines/gh/acme/widgets/7",
		},
		{
			name:   "bitbucket project",
			slug:   "bb/acme/widgets",
			number: 1,
			want:   "https://app.circleci.com/pipelines/bb/acme/widgets/1",
		},
		{
			// A standalone project's slug carries opaque IDs and no
			// name-addressed URL form was ever verified, so no link
			// is offered and the client renders plain text.
			name:   "standalone projects get no link",
			slug:   "circleci/org-uuid/project-uuid",
			number: 12,
			want:   "",
		},
		{name: "no slug", slug: "", number: 12, want: ""},
		{name: "incomplete slug", slug: "gh/acme", number: 12, want: ""},
		{name: "no pipeline number", slug: "gh/acme/widgets", number: 0, want: ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			env := host.Environment{Host: "https://circleci.com"}
			assert.Equal(t, env.PipelineWebURL(tc.slug, tc.number), tc.want)
		})
	}
}

// ---------------------------------------------------------------------------
// Routing: which of CircleCI's two trigger endpoints carries the config.
//
// The reason this is a routing decision rather than a preference is the
// wrong-green failure: on a classic GitHub OAuth project the newer
// `/pipeline/run` endpoint accepts an inline config, answers 201, and runs the
// committed config instead. See circleci.ConfigRoute.
// ---------------------------------------------------------------------------

func TestServer_Run_RoutesByConfigSourceProvider(t *testing.T) {
	tests := []struct {
		name             string
		provider         string
		wantRoute        string
		wantLegacy       bool
		wantDefinitionID string
	}{
		{
			// The one endpoint that honours an inline config here. The newer
			// one would silently run the committed config.
			name:       "github_oauth uses the legacy endpoint",
			provider:   circleci.ProviderGitHubOAuth,
			wantRoute:  "legacy",
			wantLegacy: true,
		},
		{
			// The legacy endpoint does not serve these projects at all.
			name:             "github_app uses the newer pipeline/run endpoint",
			provider:         circleci.ProviderGitHubApp,
			wantRoute:        "pipeline-run",
			wantDefinitionID: "def-1",
		},
		{
			name:             "gitlab uses the newer pipeline/run endpoint",
			provider:         circleci.ProviderGitLab,
			wantRoute:        "pipeline-run",
			wantDefinitionID: "def-1",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client := runnableClient()
			client.definitions = []circleci.PipelineDefinition{{
				ID: "def-1", Name: "widgets", ConfigSourceProvider: tc.provider,
			}}
			ts := newRunTestServer(t, sentinelToken, client, nil)

			_, availability := getRunAvailability(t, ts)
			assert.Equal(t, availability.Status, "available")
			assert.Equal(t, availability.ConfigRoute, tc.wantRoute)

			status, _, got := postRun(t, ts, runPayload())
			assert.Equal(t, status, http.StatusOK)
			assert.Assert(t, got.Triggered)
			assert.Equal(t, got.ConfigRoute, tc.wantRoute)

			assert.Equal(t, client.triggerCalls.Load(), int32(1))
			if tc.wantLegacy {
				assert.Equal(t, client.runEndpointCalls.Load(), int32(0),
					"a classic OAuth project must not go through /pipeline/run")
			} else {
				assert.Equal(t, client.runEndpointCalls.Load(), int32(1))
			}
			// The newer endpoint needs a definition; the legacy one has no
			// such concept and must not be handed one.
			assert.Equal(t, client.gotTrigger.DefinitionID, tc.wantDefinitionID)
		})
	}
}

// Uncertainty about the route resolves to a refusal, because silent-ignore
// cannot be detected before the money is spent. Each row is a state observed or
// documented upstream, not a hypothetical.
func TestServer_Run_RefusesWhenTheRouteCannotBeEstablished(t *testing.T) {
	tests := []struct {
		name        string
		definitions []circleci.PipelineDefinition
		wantReason  string
	}{
		{
			// Several real standalone projects answer {"items":[]}.
			name:        "no pipeline definitions",
			definitions: []circleci.PipelineDefinition{},
			wantReason:  "no pipeline definitions",
		},
		{
			name: "more than one definition",
			definitions: []circleci.PipelineDefinition{
				{ID: "a", ConfigSourceProvider: circleci.ProviderGitHubApp},
				{ID: "b", ConfigSourceProvider: circleci.ProviderGitHubApp},
			},
			wantReason: "2 pipeline definitions",
		},
		{
			// github_server and the Bitbucket providers exist and were never
			// tested here. Assuming one behaves like a provider we did test is
			// exactly the guess that produces a wrong green.
			name:        "a provider this build has not verified",
			definitions: []circleci.PipelineDefinition{{ID: "a", ConfigSourceProvider: "github_server"}},
			wantReason:  "github_server",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client := runnableClient()
			client.definitions = tc.definitions
			ts := newRunTestServer(t, sentinelToken, client, nil)

			_, availability := getRunAvailability(t, ts)
			assert.Equal(t, availability.Status, "unroutable")
			assert.Assert(t, is.Contains(availability.Reason, tc.wantReason))
			// The refusal must say *why* guessing is not an option, or it
			// reads as an arbitrary limitation.
			assert.Assert(t, is.Contains(availability.Reason, "without ever testing your changes"))

			status, _, got := postRun(t, ts, runPayload())
			assert.Equal(t, status, http.StatusOK)
			assert.Assert(t, !got.Triggered)
			assert.Equal(t, got.Status, "unroutable")
			assert.Equal(t, client.triggerCalls.Load(), int32(0))
		})
	}
}

// "Unroutable" and "unknown" are different answers and must not be collapsed:
// one is "CircleCI told us something we cannot act on safely", the other is
// "we could not ask".
func TestServer_RunAvailability_UnroutableIsNotUnknown(t *testing.T) {
	unroutable := runnableClient()
	unroutable.definitions = nil
	_, unroutableBody := getRunAvailability(t, newRunTestServer(t, sentinelToken, unroutable, nil))

	unknown := runnableClient()
	unknown.definitionsErr = &circleci.APIError{StatusCode: http.StatusInternalServerError, Method: "GET", Path: "/d"}
	_, unknownBody := getRunAvailability(t, newRunTestServer(t, sentinelToken, unknown, nil))

	assert.Equal(t, unroutableBody.Status, "unroutable")
	assert.Equal(t, unknownBody.Status, "unknown")
	assert.Assert(t, unroutableBody.Reason != unknownBody.Reason)
}

// ---------------------------------------------------------------------------
// The silent-ignore detector: read the pipeline's config back and compare.
// ---------------------------------------------------------------------------

func TestServer_Run_VerifiesTheConfigThePipelineActuallyRan(t *testing.T) {
	tests := []struct {
		name         string
		ranConfig    string
		ranConfigErr error
		wantVerdict  string
		wantReason   string
	}{
		{
			name:        "the pipeline is running what we sent",
			ranConfig:   runTestConfig,
			wantVerdict: "confirmed",
		},
		{
			// The wrong-green case this whole mechanism exists for.
			name:        "the pipeline is running something else",
			ranConfig:   "version: 2.1\njobs:\n  committed: {}\n",
			wantVerdict: "mismatch",
			wantReason:  "config you see was ignored",
		},
		{
			// The config is stored asynchronously, so an empty read is a real
			// state and must not be reported as a mismatch.
			name:        "nothing stored yet",
			ranConfig:   "",
			wantVerdict: "unverified",
			wantReason:  "could not read the pipeline's config back",
		},
		{
			name:         "the read failed",
			ranConfigErr: &circleci.APIError{StatusCode: http.StatusNotFound, Method: "GET", Path: "/c"},
			wantVerdict:  "unverified",
			wantReason:   "could not read the pipeline's config back",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client := runnableClient()
			client.ranConfig = tc.ranConfig
			client.ranConfigErr = tc.ranConfigErr
			ts := newRunTestServer(t, sentinelToken, client, nil)

			status, _, got := postRun(t, ts, runPayload())
			assert.Equal(t, status, http.StatusOK)

			// Every row is still a real pipeline the user is paying for, so
			// every row reports Triggered -- the verdict is a separate axis.
			assert.Assert(t, got.Triggered)
			assert.Equal(t, got.ConfigVerified, tc.wantVerdict)
			if tc.wantReason != "" {
				assert.Assert(t, is.Contains(got.Reason, tc.wantReason))
			}
		})
	}
}

// Trailing whitespace is forgiven and nothing else is. Anything cleverer would
// start forgiving the difference this check exists to find.
func TestServer_Run_ConfigVerificationIgnoresOnlyTrailingWhitespace(t *testing.T) {
	client := runnableClient()
	client.ranConfig = runTestConfig + "\n\n"
	ts := newRunTestServer(t, sentinelToken, client, nil)

	_, _, got := postRun(t, ts, runPayload())
	assert.Equal(t, got.ConfigVerified, "confirmed")
}

// A 2xx this host cannot parse is still a pipeline somebody is paying for. It
// must not be reported as a failure (which implies nothing happened) and must
// not produce a deep link built from a missing number (which would 404 and look
// like the run vanished). The success-path response fields were never
// observed live, so this is the branch that has to be right.
func TestServer_Run_AcceptedButUnreadableResponse(t *testing.T) {
	tests := []struct {
		name     string
		pipeline *circleci.Pipeline
	}{
		{name: "no pipeline at all", pipeline: nil},
		{name: "no pipeline number", pipeline: &circleci.Pipeline{ID: "abc", State: "created"}},
		{name: "a zero pipeline number", pipeline: &circleci.Pipeline{ID: "abc", Number: 0}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client := runnableClient()
			client.pipeline = tc.pipeline
			ts := newRunTestServer(t, sentinelToken, client, nil)

			status, _, got := postRun(t, ts, runPayload())
			assert.Equal(t, status, http.StatusOK)

			// Reported as a run, because it was one.
			assert.Assert(t, got.Triggered)
			// But with no link, and saying so.
			assert.Equal(t, got.WebURL, "")
			assert.Equal(t, got.PipelineNumber, int64(0))
			assert.Equal(t, got.ConfigVerified, "unverified")
			assert.Assert(t, is.Contains(got.Reason, "could not read which pipeline it created"))
			assert.Assert(t, is.Contains(got.Reason, "almost certainly started"))
		})
	}
}

// ---------------------------------------------------------------------------
// Project identity. The run path must name the same project the
// rest of the app names, and must never be the one surface that quietly picks a
// side when the two sources disagree -- because it is the surface that spends
// money.
// ---------------------------------------------------------------------------

func TestServer_RunAvailability_PrefersTheRecordedBinding(t *testing.T) {
	dir := t.TempDir()
	writeBinding(t, dir, projectBindingFixture)

	client := runnableClient()
	client.project.Slug = "gh/example-org/flaky-todo-list"

	// The environment still names the pre-rename repository, which is the case
	// issue #198 was filed about.
	env := runTestEnv(sentinelToken)
	env.org, env.repo = "example-org", "flakey-todo-list"

	ts := newRunTestServerIn(t, dir, env, client, nil)

	_, got := getRunAvailability(t, ts)
	assert.Equal(t, got.Status, "available")

	// The binding's slug, not the environment's -- and the same one
	// GET /api/project-context reports, which is the point.
	assert.Equal(t, got.ProjectSlug, "gh/example-org/flaky-todo-list")
	assert.Equal(t, got.IdentitySource, "binding")
}

// A disagreement is carried, not resolved away. This endpoint follows the
// same precedence every other surface uses rather than inventing a second
// one; what it must not do is be the only surface that picked a side in
// silence.
func TestServer_RunAvailability_ReportsAnIdentityDisagreement(t *testing.T) {
	dir := t.TempDir()
	writeBinding(t, dir, projectBindingFixture)

	client := runnableClient()
	client.project.Slug = "gh/example-org/flaky-todo-list"

	env := runTestEnv(sentinelToken)
	env.org, env.repo = "example-org", "some-other-repo"

	ts := newRunTestServerIn(t, dir, env, client, nil)

	_, got := getRunAvailability(t, ts)
	assert.Assert(t, got.IdentityDisagrees)
	assert.Equal(t, got.EnvironmentSlug, "gh/example-org/some-other-repo")

	// The same precedence still applies: the binding wins the run.
	assert.Equal(t, got.ProjectSlug, "gh/example-org/flaky-todo-list")
	assert.Equal(t, got.IdentitySource, "binding")

	// And a run is still offered -- a disagreement is a thing to *say*, not a
	// refusal. The refusals in this feature are for cases where proceeding could
	// be wrong; here proceeding is right, and only ambiguity is the problem.
	assert.Equal(t, got.Status, "available")
}

// Agreement must not be reported as a disagreement, or the warning becomes noise
// and stops being read.
func TestServer_RunAvailability_NoDisagreementWhenSourcesAgree(t *testing.T) {
	dir := t.TempDir()
	writeBinding(t, dir, projectBindingFixture)

	client := runnableClient()
	client.project.Slug = "gh/example-org/flaky-todo-list"

	env := runTestEnv(sentinelToken)
	env.org, env.repo = "example-org", "flaky-todo-list"

	ts := newRunTestServerIn(t, dir, env, client, nil)

	_, got := getRunAvailability(t, ts)
	assert.Assert(t, !got.IdentityDisagrees)
	assert.Equal(t, got.IdentitySource, "binding")
}

// With no binding the environment is the source, and that is not a warning
// either -- most checkouts have never been linked.
func TestServer_RunAvailability_FallsBackToTheEnvironment(t *testing.T) {
	client := runnableClient()
	ts := newRunTestServer(t, sentinelToken, client, nil)

	_, got := getRunAvailability(t, ts)
	assert.Equal(t, got.Status, "available")
	assert.Equal(t, got.IdentitySource, "environment")
	assert.Assert(t, !got.IdentityDisagrees)
}

// The same-source invariant, applied to this endpoint's two
// ID-keyed calls. Both go through settingsProjectID, so neither can end up
// reading a *different* project's `enable_unversioned_config` or pipeline
// definitions -- which would not degrade the answer, it would invert it.
func TestServer_RunAvailability_IDKeyedCallsUseTheRecordsOwnID(t *testing.T) {
	dir := t.TempDir()
	writeBinding(t, dir, projectBindingFixture)

	client := runnableClient()
	client.project.Slug = "gh/example-org/flaky-todo-list"
	client.project.ID = "11111111-1111-1111-1111-111111111111"

	env := runTestEnv(sentinelToken)
	env.org, env.repo = "example-org", "flakey-todo-list"

	ts := newRunTestServerIn(t, dir, env, client, nil)
	_, got := getRunAvailability(t, ts)
	assert.Equal(t, got.Status, "available")

	// CircleCI's own record wins over the recorded ID, and both
	// ID-keyed calls agree on it.
	assert.Equal(t, client.gotSettingsProjectID, "11111111-1111-1111-1111-111111111111")
	assert.Equal(t, client.gotDefinitionsProjectID, "11111111-1111-1111-1111-111111111111")
}

// When no ID can be shown to describe the same project as the slug, the answer
// is "we could not tell" rather than another project's settings. `unknown` is an
// honest answer; a wrong `available` is not.
func TestServer_RunAvailability_RefusesWhenNoSameSourceIDExists(t *testing.T) {
	client := runnableClient()
	// A record with no ID, and no binding to fall back on.
	client.project.ID = ""

	ts := newRunTestServer(t, sentinelToken, client, nil)

	_, got := getRunAvailability(t, ts)
	assert.Equal(t, got.Status, "unknown")
	assert.Assert(t, is.Contains(got.Reason, "same source as its slug"))
	assert.Equal(t, client.triggerCalls.Load(), int32(0))
}
