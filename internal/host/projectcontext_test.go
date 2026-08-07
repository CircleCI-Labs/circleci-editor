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
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

// fakeProjectClient is a fake implementation of the host package's unexported
// projectMetadataClient interface. Every value it returns is invented; no test
// in this package ever reaches CircleCI, so no real context or variable name
// is ever involved.
type fakeProjectClient struct {
	project    *circleci.Project
	projectErr error

	settings    *circleci.ProjectSettings
	settingsErr error

	contexts    []circleci.Context
	contextsErr error

	variables    []circleci.ContextVariable
	variablesErr error

	restrictions    []circleci.ContextRestriction
	restrictionsErr error

	projectVariables    []circleci.ProjectVariable
	projectVariablesErr error

	// followedProjects and followedProjectsErr back ListFollowedProjects, the
	// near-miss suggestion's data source (issue #20). Unset (nil, nil) in
	// every fixture that does not care: that reads as "this token follows no
	// projects", which is a perfectly fine thing for
	// projectNearMissCandidates to receive and never something that needs a
	// warning of its own.
	followedProjects      []circleci.FollowedProject
	followedProjectsErr   error
	followedProjectsCalls int

	gotOwner       circleci.ContextOwner
	gotContextID   string
	gotProjectSlug string
	// gotVariablesSlug is the slug ListProjectVariables was called with, which
	// issue #182 made worth distinguishing from gotProjectSlug: the project
	// lookup uses the slug this host assembled, and everything after it should
	// use the canonical slug CircleCI returned.
	gotVariablesSlug string
	contextsCalls    int
	// gotSettingsProjectID is the ID GetProjectSettings was called with, and
	// settingsCalls whether it was called at all. Issue #198 made both worth
	// recording: settings are keyed by project *ID*, and the recorded binding
	// carries one that survives the rename which made the slug lookup 404 -- so
	// "was this called, and with whose ID" is now behaviour rather than detail.
	gotSettingsProjectID string
	settingsCalls        int
}

func (f *fakeProjectClient) GetProject(_ context.Context, projectSlug string) (*circleci.Project, error) {
	f.gotProjectSlug = projectSlug
	return f.project, f.projectErr
}

func (f *fakeProjectClient) GetProjectSettings(_ context.Context, projectID string) (*circleci.ProjectSettings, error) {
	f.settingsCalls++
	f.gotSettingsProjectID = projectID
	return f.settings, f.settingsErr
}

func (f *fakeProjectClient) ListContexts(_ context.Context, owner circleci.ContextOwner) ([]circleci.Context, error) {
	f.gotOwner = owner
	f.contextsCalls++
	return f.contexts, f.contextsErr
}

func (f *fakeProjectClient) ListContextVariables(_ context.Context, contextID string) ([]circleci.ContextVariable, error) {
	f.gotContextID = contextID
	return f.variables, f.variablesErr
}

func (f *fakeProjectClient) ListContextRestrictions(_ context.Context, _ string) ([]circleci.ContextRestriction, error) {
	return f.restrictions, f.restrictionsErr
}

func (f *fakeProjectClient) ListProjectVariables(_ context.Context, projectSlug string) ([]circleci.ProjectVariable, error) {
	f.gotVariablesSlug = projectSlug
	return f.projectVariables, f.projectVariablesErr
}

func (f *fakeProjectClient) ListFollowedProjects(_ context.Context) ([]circleci.FollowedProject, error) {
	f.followedProjectsCalls++
	return f.followedProjects, f.followedProjectsErr
}

// projectContextEnv describes the CLI-injected environment a test wants.
type projectContextEnv struct {
	token     string
	vcsType   string
	org       string
	repo      string
	projectID string
}

// The IDs the fakes hand out, UUID-shaped on purpose.
//
// A CircleCI project ID *is* a UUID, and since issue #198 that shape is
// load-bearing rather than cosmetic: a project restriction's `restriction_value`
// is a project UUID -- verified against the live API across every restricted
// context in a real organization -- so an ID in any other shape can never match
// one, and effectiveProjectID discards it instead of reporting a confident wrong
// answer. The placeholders these replaced ("proj-uuid") therefore exercised the
// discard path while claiming to exercise the comparison.
//
// They are this repository's own real project and organization IDs, which are not
// secret (`circleci project get` prints them) and which keep these fixtures
// consistent with projectBindingFixture's recorded IDs.
const (
	fakeProjectUUID = "93d2dc11-7495-41a9-ad8c-4ce0773a9789"
	fakeOrgUUID     = "4ada2c32-f0c2-4b60-a6b8-af674858fd51"

	// otherProjectUUID is a *different* project: the one CIRCLE_PROJECT_ID names
	// when the CLI was started in a different checkout than --config points at.
	otherProjectUUID = "0e0dd0b0-1111-4222-8333-444455556666"
)

// connectedEnv is the normal case: a token and a full project slug.
func connectedEnv() projectContextEnv {
	return projectContextEnv{
		token:     sentinelToken,
		vcsType:   "github",
		org:       "acme",
		repo:      "web",
		projectID: fakeProjectUUID,
	}
}

func newProjectContextTestServer(t *testing.T, env projectContextEnv, client *fakeProjectClient) *httptest.Server {
	t.Helper()
	return newProjectContextTestServerIn(t, t.TempDir(), env, client)
}

// newProjectContextTestServerIn is newProjectContextTestServer rooted at a
// caller-supplied directory, so a test can put a `.circleci/info.yml` there first
// (issue #198). The plain form keeps its own fresh temp directory, which has no
// binding in it and therefore exercises the environment-only path.
func newProjectContextTestServerIn(
	t *testing.T, dir string, env projectContextEnv, client *fakeProjectClient,
) *httptest.Server {
	t.Helper()

	clearCircleEnv(t)
	t.Setenv("CIRCLE_TOKEN", env.token)
	t.Setenv("CIRCLE_VCS_TYPE", env.vcsType)
	t.Setenv("CIRCLE_PROJECT_USERNAME", env.org)
	t.Setenv("CIRCLE_PROJECT_REPONAME", env.repo)
	t.Setenv("CIRCLE_PROJECT_ID", env.projectID)

	opts := host.Options{WorkDir: dir, Version: "test-version"}
	if client != nil {
		opts.ProjectClient = client
	}

	srv, err := host.New(opts)
	assert.NilError(t, err)

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// projectContextBody is the decoded shape of GET /api/project-context.
type projectContextBody struct {
	Available   bool   `json:"available"`
	Reason      string `json:"reason"`
	ProjectSlug string `json:"projectSlug"`
	Project     *struct {
		Name               string `json:"name"`
		Slug               string `json:"slug"`
		OrganizationName   string `json:"organizationName"`
		OrganizationSlug   string `json:"organizationSlug"`
		VCSProvider        string `json:"vcsProvider"`
		DefaultBranch      string `json:"defaultBranch"`
		WebURL             string `json:"webUrl"`
		SettingsURL        string `json:"settingsUrl"`
		OrganizationWebURL string `json:"organizationWebUrl"`
	} `json:"project"`
	Settings *struct {
		DynamicConfig     bool `json:"dynamicConfig"`
		UnversionedConfig bool `json:"unversionedConfig"`
	} `json:"settings"`
	Contexts []struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		WebURL string `json:"webUrl"`
	} `json:"contexts"`
	ProjectVariables []struct {
		Name string `json:"name"`
	} `json:"projectVariables"`
	Warnings []warningBody `json:"warnings"`
}

// warningBody is the decoded shape of one entry in either endpoint's
// "warnings" array (issue #150): which part failed, what happened, and what
// the user consequently cannot see.
type warningBody struct {
	Kind         string   `json:"kind"`
	Headline     string   `json:"headline"`
	Detail       string   `json:"detail"`
	Consequences []string `json:"consequences"`
	// Suggestions is what to do about it (issue #198), in the CircleCI CLI's
	// own words where there is one.
	Suggestions []string `json:"suggestions"`
	// Candidates lists other repository names visible to this token, in the
	// same organization, for the near-miss suggestion (issue #20).
	Candidates []string `json:"candidates"`
}

// text flattens a warning into one string, for the assertions that only care
// that some part of it says a particular thing.
func (w warningBody) text() string {
	return w.Headline + " " + w.Detail + " " +
		strings.Join(w.Consequences, " ") + " " + strings.Join(w.Suggestions, " ")
}

// contextVariablesBody is the decoded shape of
// GET /api/project-context/variables.
type contextVariablesBody struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason"`
	ContextID string `json:"contextId"`
	Variables []struct {
		Name           string `json:"name"`
		TruncatedValue string `json:"truncatedValue"`
	} `json:"variables"`
	Usability          string `json:"usability"`
	RestrictionSummary string `json:"restrictionSummary"`
	// Restrictions is a pointer to a slice so a test can tell an empty array
	// ("the call succeeded and there are none") from an absent/null key ("the
	// call failed"). Issue #251 makes that distinction a requirement, so the
	// fixture has to be able to observe it.
	Restrictions      *[]restrictionBody `json:"restrictions"`
	ProjectIdentified bool               `json:"projectIdentified"`
	Warnings          []warningBody      `json:"warnings"`
}

// restrictionBody is the decoded shape of one entry in the variables endpoint's
// "restrictions" array (issue #251): what kind of thing restricts this context
// and, where CircleCI named it, which one.
type restrictionBody struct {
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	Expression  string `json:"expression"`
	ThisProject bool   `json:"thisProject"`
	RawType     string `json:"rawType"`
}

func fullFakeClient() *fakeProjectClient {
	return &fakeProjectClient{
		// The slug and organization slug are in CircleCI's canonical short
		// form, because that is what the live API returns even when asked with
		// the long one -- verified against it, and the premise of issue #182.
		project: &circleci.Project{
			ID:               fakeProjectUUID,
			Slug:             "gh/acme/web",
			Name:             "web",
			OrganizationID:   fakeOrgUUID,
			OrganizationName: "acme",
			OrganizationSlug: "gh/acme",
			VCSProvider:      "GitHub",
			DefaultBranch:    "trunk",
		},
		settings: &circleci.ProjectSettings{
			DynamicConfig:     true,
			UnversionedConfig: true,
		},
		contexts: []circleci.Context{
			{ID: "ctx-1", Name: "build-secrets"},
			{ID: "ctx-2", Name: "deploy-prod"},
		},
		projectVariables: []circleci.ProjectVariable{
			{Name: "DEPLOY_TARGET"},
			{Name: "NPM_TOKEN"},
		},
	}
}

func TestServer_ProjectContext_HappyPath(t *testing.T) {
	client := fullFakeClient()
	ts := newProjectContextTestServer(t, connectedEnv(), client)

	status, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !strings.Contains(body, sentinelToken), "response leaked the token: %s", body)

	var got projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))

	assert.Assert(t, got.Available)
	assert.Equal(t, got.ProjectSlug, "gh/acme/web")
	assert.Equal(t, len(got.Warnings), 0)

	assert.Assert(t, got.Project != nil)
	assert.Equal(t, got.Project.DefaultBranch, "trunk")
	assert.Equal(t, got.Project.OrganizationName, "acme")
	// The deep link is built from the record's slug, host-side, so the browser
	// never has to assemble a URL out of a VCS type it was handed (issue #182).
	assert.Equal(t, got.Project.WebURL, "https://app.circleci.com/projects/gh/acme/web")
	// The settings deep link (issue #248) is built the same way, from the same
	// canonical slug, one path segment different.
	assert.Equal(t, got.Project.SettingsURL, "https://app.circleci.com/settings/project/gh/acme/web")

	assert.Assert(t, got.Settings != nil)
	assert.Assert(t, got.Settings.DynamicConfig)
	assert.Assert(t, got.Settings.UnversionedConfig)

	assert.Equal(t, len(got.Contexts), 2)
	assert.Equal(t, got.Contexts[0].Name, "build-secrets")

	assert.Equal(t, len(got.ProjectVariables), 2)
	assert.Equal(t, got.ProjectVariables[0].Name, "DEPLOY_TARGET")

	// Contexts are org-scoped, and the org ID from the project record is
	// preferred over the environment's slug because it is unambiguous.
	assert.Equal(t, client.gotOwner.ID, fakeOrgUUID)
	assert.Equal(t, client.gotOwner.Slug, "")
	// The lookup itself uses the slug this host assembled -- normalised to the
	// CLI's short spelling, which is the change issue #182 makes.
	assert.Equal(t, client.gotProjectSlug, "gh/acme/web")
	assert.Equal(t, client.gotVariablesSlug, "gh/acme/web")
}

// TestServer_ProjectContext_PrefersTheCanonicalSlug is issue #182's core claim:
// once CircleCI has named the project, that name is used for the rest of the
// request, for what the response reports, and for the link -- not the slug this
// host assembled from CIRCLE_VCS_TYPE and friends.
//
// The fixture exaggerates the difference on purpose (the record disagrees about
// letter case as well as about the VCS spelling), because the real API does
// normalise organization and repository names and the injected environment does
// not have to match.
func TestServer_ProjectContext_PrefersTheCanonicalSlug(t *testing.T) {
	client := fullFakeClient()
	client.project.Slug = "gh/Acme/Web"
	client.project.OrganizationID = ""
	client.project.OrganizationSlug = "gh/Acme"
	ts := newProjectContextTestServer(t, connectedEnv(), client)

	status, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
	assert.Equal(t, status, http.StatusOK)

	var got projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))

	// The project lookup could only use what this host had at the time.
	assert.Equal(t, client.gotProjectSlug, "gh/acme/web")

	// Everything after it uses CircleCI's own spelling.
	assert.Equal(t, got.ProjectSlug, "gh/Acme/Web")
	assert.Assert(t, got.Project != nil)
	assert.Equal(t, got.Project.WebURL, "https://app.circleci.com/projects/gh/Acme/Web")
	assert.Equal(t, client.gotVariablesSlug, "gh/Acme/Web")
	// With no organization ID in the record, its own organization slug beats the
	// one derived from the environment.
	assert.Equal(t, client.gotOwner.Slug, "gh/Acme")
}

// TestServer_ProjectContext_StandaloneProjectGetsNoWebURL is the VCS variety the
// owner raised, in its most misleading shape: a GitHub App (standalone) project
// whose *injected* VCS type would happily have produced a name-addressed URL,
// while CircleCI addresses it by ID.
//
// The record's slug is the only thing that knows, which is why the link is built
// from it. Empty here is a real answer -- the client renders plain text and does
// not fall back to GET /api/meta's environment-derived URL.
// TestServer_ProjectContext_StandaloneProjectGetsAWebURL covers issue #20's
// second item: a standalone (GitLab / GitHub App) project's opaque-ID slug now
// gets an overview link, because that route's shape was verified live against
// a real standalone project (see host.overviewRouteVCS) -- it is no longer
// refused just for carrying "circleci" as its VCS segment.
//
// The settings link is the deliberate exception, named in the test below this
// one: ProjectSettingsWebURLForSlug's route was never itself checked against a
// live standalone project, so it stays refused. Both links being gated by the
// same map before this issue was never a promise that they would change
// together.
func TestServer_ProjectContext_StandaloneProjectGetsAWebURL(t *testing.T) {
	client := fullFakeClient()
	client.project.Slug = "circleci/PBz3EbdyZmZ4jNfLQCdXhs/QqvJmXcbSNvcbFxhVZDPTF"
	client.project.OrganizationSlug = "circleci/PBz3EbdyZmZ4jNfLQCdXhs"
	client.project.VCSProvider = "GitHub"
	ts := newProjectContextTestServer(t, connectedEnv(), client)

	status, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
	assert.Equal(t, status, http.StatusOK)

	var got projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))

	assert.Assert(t, got.Project != nil)
	assert.Equal(t, got.Project.Slug, "circleci/PBz3EbdyZmZ4jNfLQCdXhs/QqvJmXcbSNvcbFxhVZDPTF")
	assert.Equal(t, got.Project.WebURL,
		"https://app.circleci.com/projects/circleci/PBz3EbdyZmZ4jNfLQCdXhs/QqvJmXcbSNvcbFxhVZDPTF")
	assert.Equal(t, got.Project.OrganizationWebURL,
		"https://app.circleci.com/pipelines/circleci/PBz3EbdyZmZ4jNfLQCdXhs")
	assert.Equal(t, got.ProjectSlug, "circleci/PBz3EbdyZmZ4jNfLQCdXhs/QqvJmXcbSNvcbFxhVZDPTF")

	// A meta response built from the same environment still offers its own
	// (name-addressed) link, which is correct for what it knows and is exactly
	// why a client holding a record must ignore it in favour of the record's
	// own webUrl/organizationWebUrl above.
	_, metaBody := doRequest(t, ts, http.MethodGet, "/api/meta", nil)
	assert.Assert(t, is.Contains(metaBody, "/projects/gh/acme/web"))
}

// TestServer_ProjectContext_StandaloneProjectStillGetsNoSettingsURL is the
// half of issue #20 that deliberately did not move: unlike the overview and
// organization-pipelines routes, `/settings/project/circleci/<org-id>/<project-id>`
// was never checked against a live standalone project, so
// ProjectSettingsWebURLForSlug keeps refusing it. See overviewRouteVCS for why
// that predicate, not nameAddressedVCSSegments, is what changed.
func TestServer_ProjectContext_StandaloneProjectStillGetsNoSettingsURL(t *testing.T) {
	client := fullFakeClient()
	client.project.Slug = "circleci/PBz3EbdyZmZ4jNfLQCdXhs/QqvJmXcbSNvcbFxhVZDPTF"
	client.project.VCSProvider = "GitHub"
	ts := newProjectContextTestServer(t, connectedEnv(), client)

	_, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)

	var got projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Assert(t, got.Project != nil)
	assert.Equal(t, got.Project.SettingsURL, "")
}

// TestServer_ProjectContext_NoToken is one half of the degrade-honestly
// invariant: no token must produce an explanation, not an empty list and not
// an error.
func TestServer_ProjectContext_NoToken(t *testing.T) {
	env := connectedEnv()
	env.token = ""
	ts := newProjectContextTestServer(t, env, nil)

	status, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
	assert.Equal(t, status, http.StatusOK)

	var got projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))

	assert.Assert(t, !got.Available)
	assert.Assert(t, is.Contains(got.Reason, "token"))
	// The empty lists must still be present, so a client can render them
	// without a null check -- but Available:false is what it must key off.
	assert.Equal(t, len(got.Contexts), 0)
	assert.Equal(t, len(got.ProjectVariables), 0)
}

// TestServer_ProjectContext_NoProjectSlug is the other half: a config that is
// not part of a CircleCI project is a normal thing to edit, and the response
// says so rather than looking broken.
func TestServer_ProjectContext_NoProjectSlug(t *testing.T) {
	env := connectedEnv()
	env.repo = ""
	ts := newProjectContextTestServer(t, env, fullFakeClient())

	status, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
	assert.Equal(t, status, http.StatusOK)

	var got projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))

	assert.Assert(t, !got.Available)
	assert.Assert(t, is.Contains(got.Reason, "not associated with a CircleCI project"))
}

// TestServer_ProjectContext_PartialFailureWarnsAndStillServes covers the
// realistic permissions gap: a token that reads the project fine but is
// refused the organization's context list. The parts that worked are still
// served, and the part that did not contributes a warning.
func TestServer_ProjectContext_PartialFailureWarnsAndStillServes(t *testing.T) {
	client := fullFakeClient()
	client.contexts = nil
	client.contextsErr = &circleci.APIError{
		StatusCode: http.StatusForbidden,
		Method:     http.MethodGet,
		Path:       "/api/v2/context",
		// A real body here can quote context metadata; this asserts we
		// never forward it.
		Body: `{"message":"secret-context-name-should-not-appear"}`,
	}
	ts := newProjectContextTestServer(t, connectedEnv(), client)

	status, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
	assert.Equal(t, status, http.StatusOK)

	var got projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))

	// Still available, still serving what it could.
	assert.Assert(t, got.Available)
	assert.Assert(t, got.Project != nil)
	assert.Equal(t, len(got.ProjectVariables), 2)
	assert.Equal(t, len(got.Contexts), 0)

	assert.Equal(t, len(got.Warnings), 1)
	assert.Equal(t, got.Warnings[0].Kind, "contexts")
	assert.Assert(t, is.Contains(got.Warnings[0].Detail, "does not have permission"))
	// Issue #150's UX half: a warning must say what is consequently missing,
	// so a user can tell whether it matters.
	assert.Assert(t, len(got.Warnings[0].Consequences) > 0)

	// The upstream error body must never reach the browser.
	assert.Assert(t, !strings.Contains(body, "secret-context-name-should-not-appear"),
		"forwarded an upstream error body: %s", body)
}

// TestServer_ProjectContext_FallsBackToOrgSlug covers losing the project
// lookup: contexts are still listable via the environment's "<vcs>/<org>"
// slug, so one permissions gap does not take out the other section.
func TestServer_ProjectContext_FallsBackToOrgSlug(t *testing.T) {
	client := fullFakeClient()
	client.project = nil
	client.projectErr = &circleci.APIError{StatusCode: http.StatusNotFound}
	ts := newProjectContextTestServer(t, connectedEnv(), client)

	status, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
	assert.Equal(t, status, http.StatusOK)

	var got projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))

	assert.Assert(t, got.Available)
	assert.Assert(t, got.Project == nil)
	assert.Equal(t, len(got.Contexts), 2)
	assert.Equal(t, client.gotOwner.Slug, "gh/acme")
}

// TestServer_ProjectContext_CachesAndRefreshes pins both halves of the caching
// decision: repeated reads do not re-hit the API, and ?refresh=1 exists so a
// context added in the web UI does not have to wait out the TTL.
func TestServer_ProjectContext_CachesAndRefreshes(t *testing.T) {
	client := fullFakeClient()
	ts := newProjectContextTestServer(t, connectedEnv(), client)

	for range 3 {
		status, _ := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
		assert.Equal(t, status, http.StatusOK)
	}
	assert.Equal(t, client.contextsCalls, 1)

	status, _ := doRequest(t, ts, http.MethodGet, "/api/project-context?refresh=1", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, client.contextsCalls, 2)
}

func TestServer_ProjectContext_MethodNotAllowed(t *testing.T) {
	ts := newProjectContextTestServer(t, connectedEnv(), fullFakeClient())

	status, _ := doRequest(t, ts, http.MethodPost, "/api/project-context", []byte("{}"))
	assert.Equal(t, status, http.StatusMethodNotAllowed)

	status, _ = doRequest(t, ts, http.MethodPost, "/api/project-context/variables", []byte("{}"))
	assert.Equal(t, status, http.StatusMethodNotAllowed)
}

func TestServer_ContextVariables_HappyPath(t *testing.T) {
	client := fullFakeClient()
	client.variables = []circleci.ContextVariable{
		{Name: "AWS_ROLE", TruncatedValue: "arn:"},
		{Name: "AWS_ROLE_ARN", TruncatedValue: "arn:"},
	}
	ts := newProjectContextTestServer(t, connectedEnv(), client)

	status, body := doRequest(t, ts, http.MethodGet, "/api/project-context/variables?contextId=ctx-1", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !strings.Contains(body, sentinelToken))

	var got contextVariablesBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))

	assert.Assert(t, got.Available)
	assert.Equal(t, got.ContextID, "ctx-1")
	assert.Equal(t, len(got.Variables), 2)
	assert.Equal(t, got.Variables[0].Name, "AWS_ROLE")
	assert.Equal(t, got.Variables[0].TruncatedValue, "arn:")

	// No restrictions on the fake, so the context is usable org-wide.
	assert.Equal(t, got.Usability, "unrestricted")
	assert.Equal(t, got.RestrictionSummary, "")
	assert.Equal(t, client.gotContextID, "ctx-1")

	// The wire field is "truncatedValue", never "value": a client must not
	// be able to mistake the preview for a secret.
	assert.Assert(t, is.Contains(body, `"truncatedValue"`))
	assert.Assert(t, !strings.Contains(body, `"value"`))
}

func TestServer_ContextVariables_RequiresContextID(t *testing.T) {
	ts := newProjectContextTestServer(t, connectedEnv(), fullFakeClient())

	status, body := doRequest(t, ts, http.MethodGet, "/api/project-context/variables", nil)
	assert.Equal(t, status, http.StatusBadRequest)
	assert.Assert(t, is.Contains(body, "contextId"))
}

func TestServer_ContextVariables_NoToken(t *testing.T) {
	env := connectedEnv()
	env.token = ""
	ts := newProjectContextTestServer(t, env, nil)

	status, body := doRequest(t, ts, http.MethodGet, "/api/project-context/variables?contextId=ctx-1", nil)
	assert.Equal(t, status, http.StatusOK)

	var got contextVariablesBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Assert(t, !got.Available)
	assert.Assert(t, is.Contains(got.Reason, "token"))
}

// TestServer_ContextVariables_Usability walks every branch of the usability
// classification, which is the part that keeps the palette from lying about
// whether a context can actually be used here -- and, since issue #251, of the
// per-restriction detail behind it.
//
// The restriction fixtures below are shaped after real records read from the
// live v2 API: a project restriction's value is a project UUID and its name is
// the project's name (sometimes absent), a group restriction names the group, and
// an expression restriction carries the rule itself with no name at all. See
// circleci.ContextRestriction for the full table.
func TestServer_ContextVariables_Usability(t *testing.T) {
	tests := []struct {
		name             string
		restrictions     []circleci.ContextRestriction
		projectID        string
		wantUsable       string
		wantSummary      string
		wantRestrictions []restrictionBody
	}{
		{
			name:             "no restrictions is unrestricted, with an empty list and not a null one",
			projectID:        fakeProjectUUID,
			wantUsable:       "unrestricted",
			wantRestrictions: []restrictionBody{},
		},
		{
			name: "a project restriction naming this project is allowed, and says which project is us",
			restrictions: []circleci.ContextRestriction{
				{Type: circleci.RestrictionTypeProject, Value: fakeProjectUUID, Name: "web"},
			},
			projectID:   fakeProjectUUID,
			wantUsable:  "allowed",
			wantSummary: "restricted to 1 project",
			wantRestrictions: []restrictionBody{
				{Kind: "project", Name: "web", ThisProject: true},
			},
		},
		{
			name: "project restrictions naming other projects only, named so the user can see which",
			restrictions: []circleci.ContextRestriction{
				{Type: circleci.RestrictionTypeProject, Value: otherProjectUUID, Name: "circle-banking-app"},
				{Type: circleci.RestrictionTypeProject, Value: "1decba3c-94f3-4b8d-b612-dfbc8aeba844", Name: "mobile"},
			},
			projectID:   fakeProjectUUID,
			wantUsable:  "other-projects-only",
			wantSummary: "restricted to 2 projects",
			wantRestrictions: []restrictionBody{
				{Kind: "project", Name: "circle-banking-app"},
				{Kind: "project", Name: "mobile"},
			},
		},
		{
			name: "a project restriction CircleCI did not name still reports its kind, never a UUID",
			restrictions: []circleci.ContextRestriction{
				{Type: circleci.RestrictionTypeProject, Value: otherProjectUUID},
			},
			projectID:   fakeProjectUUID,
			wantUsable:  "other-projects-only",
			wantSummary: "restricted to 1 project",
			wantRestrictions: []restrictionBody{
				{Kind: "project"},
			},
		},
		{
			name: "a group restriction is not evaluable, so unknown -- but the group is named",
			restrictions: []circleci.ContextRestriction{
				{Type: circleci.RestrictionTypeGroup, Value: "7a70ae13-326c-4711-88f0-0e65553264ed", Name: "Field Engineering"},
			},
			projectID:   fakeProjectUUID,
			wantUsable:  "unknown",
			wantSummary: "restricted to 1 group",
			wantRestrictions: []restrictionBody{
				{Kind: "group", Name: "Field Engineering"},
			},
		},
		{
			name: "an expression restriction carries the rule verbatim and counts as an expression, not a group",
			restrictions: []circleci.ContextRestriction{
				{Type: circleci.RestrictionTypeExpression, Value: `not (pipeline.config_source starts-with "api")`},
			},
			projectID:   fakeProjectUUID,
			wantUsable:  "unknown",
			wantSummary: "restricted to 1 expression",
			wantRestrictions: []restrictionBody{
				{Kind: "expression", Expression: `not (pipeline.config_source starts-with "api")`},
			},
		},
		{
			name: "mixed project and group restrictions summarise both",
			restrictions: []circleci.ContextRestriction{
				{Type: circleci.RestrictionTypeProject, Value: otherProjectUUID, Name: "circle-banking-app"},
				{Type: circleci.RestrictionTypeGroup, Value: "group-uuid", Name: "Pipelines"},
			},
			projectID:   fakeProjectUUID,
			wantUsable:  "other-projects-only",
			wantSummary: "restricted to 1 project and 1 group",
			wantRestrictions: []restrictionBody{
				{Kind: "project", Name: "circle-banking-app"},
				{Kind: "group", Name: "Pipelines"},
			},
		},
		{
			name: "all three kinds at once join with an Oxford-less comma list",
			restrictions: []circleci.ContextRestriction{
				{Type: circleci.RestrictionTypeProject, Value: otherProjectUUID, Name: "circle-banking-app"},
				{Type: circleci.RestrictionTypeGroup, Value: "group-uuid", Name: "Pipelines"},
				{Type: circleci.RestrictionTypeExpression, Value: `pipeline.git.branch == "main"`},
			},
			projectID:   fakeProjectUUID,
			wantUsable:  "other-projects-only",
			wantSummary: "restricted to 1 project, 1 group and 1 expression",
			wantRestrictions: []restrictionBody{
				{Kind: "project", Name: "circle-banking-app"},
				{Kind: "group", Name: "Pipelines"},
				{Kind: "expression", Expression: `pipeline.git.branch == "main"`},
			},
		},
		{
			name: "an unknown project ID cannot be compared, so unknown",
			restrictions: []circleci.ContextRestriction{
				{Type: circleci.RestrictionTypeProject, Value: otherProjectUUID, Name: "circle-banking-app"},
			},
			projectID:   "",
			wantUsable:  "unknown",
			wantSummary: "restricted to 1 project",
			wantRestrictions: []restrictionBody{
				{Kind: "project", Name: "circle-banking-app"},
			},
		},
		{
			name: "an unrecognised restriction type is counted and named, never ignored or called a group",
			restrictions: []circleci.ContextRestriction{
				{Type: "something-new", Value: "opaque-value-nobody-can-read", Name: "whatever"},
			},
			projectID:   fakeProjectUUID,
			wantUsable:  "unknown",
			wantSummary: "restricted to 1 unrecognised restriction",
			wantRestrictions: []restrictionBody{
				{Kind: "other", Name: "whatever", RawType: "something-new"},
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client := fullFakeClient()
			client.restrictions = tc.restrictions

			env := connectedEnv()
			env.projectID = tc.projectID
			ts := newProjectContextTestServer(t, env, client)

			_, body := doRequest(t, ts,
				http.MethodGet, "/api/project-context/variables?contextId=ctx-1", nil)

			var got contextVariablesBody
			assert.NilError(t, json.Unmarshal([]byte(body), &got))
			assert.Equal(t, got.Usability, tc.wantUsable)
			assert.Equal(t, got.RestrictionSummary, tc.wantSummary)
			assert.Equal(t, got.ProjectIdentified, tc.projectID != "")

			assert.Assert(t, got.Restrictions != nil,
				"a successful restrictions call must send a list, even an empty one: %s", body)
			assert.DeepEqual(t, *got.Restrictions, tc.wantRestrictions)

			// No restriction value ever reaches the browser as an identifier
			// (issue #251): a UUID tells the reader nothing and invites a UI to
			// render it as though it did.
			for _, r := range tc.restrictions {
				if r.Type == circleci.RestrictionTypeExpression {
					continue
				}
				assert.Assert(t, !strings.Contains(body, r.Value),
					"the response leaked restriction value %q: %s", r.Value, body)
			}
		})
	}
}

// TestServer_ContextVariables_RestrictionsFailureIsNotAnEmptyList is issue #251's
// sharpest constraint as a test: "no restrictions" and "we could not check" must
// never look alike. They differ here by a null rather than an empty array, and by
// a warning -- so a client that keys off either cannot conflate them.
func TestServer_ContextVariables_RestrictionsFailureIsNotAnEmptyList(t *testing.T) {
	client := fullFakeClient()
	client.restrictionsErr = &circleci.APIError{
		StatusCode: http.StatusForbidden,
		Body:       `{"message":"leak-me-CONTEXT_NAME"}`,
	}
	ts := newProjectContextTestServer(t, connectedEnv(), client)

	status, body := doRequest(t, ts,
		http.MethodGet, "/api/project-context/variables?contextId=ctx-1", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !strings.Contains(body, "leak-me"),
		"the response forwarded the upstream body: %s", body)

	var got contextVariablesBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))

	assert.Assert(t, got.Available)
	assert.Equal(t, got.Usability, "unknown")
	assert.Equal(t, got.RestrictionSummary, "")
	assert.Assert(t, got.Restrictions == nil,
		"a failed restrictions call must not send a list at all: %s", body)

	assert.Equal(t, len(got.Warnings), 1)
	assert.Equal(t, got.Warnings[0].Kind, "restrictions")
	assert.Assert(t, is.Contains(got.Warnings[0].text(), "not the same as the context being unrestricted"))
}

// TestServer_ContextVariables_WarnsWithoutForwardingErrorBodies is the
// counterpart to the project-context test: a failing variables call must
// warn, keep Available true, and never quote the upstream body.
func TestServer_ContextVariables_WarnsWithoutForwardingErrorBodies(t *testing.T) {
	client := fullFakeClient()
	client.variablesErr = &circleci.APIError{
		StatusCode: http.StatusUnauthorized,
		Body:       `{"message":"leak-me-VARIABLE_NAME"}`,
	}
	ts := newProjectContextTestServer(t, connectedEnv(), client)

	status, body := doRequest(t, ts, http.MethodGet, "/api/project-context/variables?contextId=ctx-1", nil)
	assert.Equal(t, status, http.StatusOK)

	var got contextVariablesBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))

	assert.Assert(t, got.Available)
	assert.Equal(t, len(got.Variables), 0)
	assert.Equal(t, len(got.Warnings), 1)
	assert.Equal(t, got.Warnings[0].Kind, "contextVariables")
	assert.Assert(t, is.Contains(got.Warnings[0].Detail, "rejected this token"))
	assert.Assert(t, !strings.Contains(body, "leak-me-VARIABLE_NAME"))
}

// TestServer_ContextVariables_FailuresAreNotCached: caching a permissions or
// network blip would make it stick for the whole TTL, so only successes are
// cached.
func TestServer_ContextVariables_FailuresAreNotCached(t *testing.T) {
	client := fullFakeClient()
	client.restrictionsErr = &circleci.APIError{StatusCode: http.StatusInternalServerError}
	ts := newProjectContextTestServer(t, connectedEnv(), client)

	_, body := doRequest(t, ts, http.MethodGet, "/api/project-context/variables?contextId=ctx-1", nil)
	var first contextVariablesBody
	assert.NilError(t, json.Unmarshal([]byte(body), &first))
	assert.Equal(t, len(first.Warnings), 1)

	// The transient failure clears; the next request must see the good data
	// rather than a cached warning.
	client.restrictionsErr = nil
	_, body = doRequest(t, ts, http.MethodGet, "/api/project-context/variables?contextId=ctx-1", nil)
	var second contextVariablesBody
	assert.NilError(t, json.Unmarshal([]byte(body), &second))
	assert.Equal(t, len(second.Warnings), 0)
	assert.Equal(t, second.Usability, "unrestricted")
}

// captureHostLog redirects the standard logger -- which is where the host
// writes its own diagnostics (see server.go) -- into a buffer for the
// duration of one test, restoring it afterwards.
//
// Issue #150's second half: the useful place for an upstream status code is
// the terminal the user launched the editor from, and before this it printed
// nothing at all when a project lookup failed.
func captureHostLog(t *testing.T) *bytes.Buffer {
	t.Helper()

	buf := &bytes.Buffer{}
	prevOut, prevFlags := log.Writer(), log.Flags()
	log.SetOutput(buf)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(prevOut)
		log.SetFlags(prevFlags)
	})
	return buf
}

// TestServer_ProjectContext_ProjectLookupFailureBranches is issue #150's core
// regression: one case per way the project lookup can fail, each of which used
// to produce the single sentence "the CircleCI API request did not succeed".
//
// Every case asserts three things -- what the browser is told, that the host's
// stderr says something at all, and that the upstream response body reaches
// neither -- because those three together are the defect: the message was
// useless, the log was silent, and the reason it was written that way (bodies
// can quote secret metadata) is still a constraint.
func TestServer_ProjectContext_ProjectLookupFailureBranches(t *testing.T) {
	const leakSentinel = "leak-me-CONTEXT_NAME"

	tests := []struct {
		name string
		err  error
		// wantPhrases must all appear somewhere in the warning.
		wantPhrases []string
		// wantAbsent must appear nowhere in the response body.
		wantAbsent []string
		// wantLogPhrases must all appear in the host's log output.
		wantLogPhrases []string
	}{
		{
			// The reported case (issue #150): a checkout of
			// example-org/flakey-todo-list, whose CircleCI project is
			// spelled flaky-todo-list. Verified against the live v2 API:
			// 404 for the injected slug, 200 for the near-miss, 200 for
			// the organization's contexts.
			name: "404 names the slug and points at onboarding, not at the token",
			err: &circleci.APIError{
				StatusCode: http.StatusNotFound,
				Method:     http.MethodGet,
				Path:       "/api/v2/project/gh/acme/web",
				Body:       `{"message":"Project not found: ` + leakSentinel + `"}`,
			},
			wantPhrases: []string{
				"gh/acme/web",
				"HTTP 404",
				"has not been set up on CircleCI",
				// Issue #198 identified the cause #150 could only describe.
				// The old wording ("a repository whose name differs by a
				// character from an existing project looks exactly like this")
				// named the symptom; this names the mechanism, which is what
				// makes it actionable -- and the remedy is the CLI's own.
				"renamed",
				"circleci project link",
				// Where the slug came from, which after #198 is one of two
				// places and therefore has to be said rather than assumed.
				"records no project binding of its own",
			},
			// The wording must not send a reader hunting through their
			// credentials, which is where the owner lost time.
			wantAbsent:     []string{leakSentinel, "rejected this token", "does not have permission"},
			wantLogPhrases: []string{"HTTP 404", "look up project gh/acme/web"},
		},
		{
			name: "401 says the token was rejected",
			err: &circleci.APIError{
				StatusCode: http.StatusUnauthorized,
				Method:     http.MethodGet,
				Path:       "/api/v2/project/gh/acme/web",
				Body:       `{"message":"` + leakSentinel + `"}`,
			},
			wantPhrases:    []string{"rejected this token", "HTTP 401"},
			wantAbsent:     []string{leakSentinel},
			wantLogPhrases: []string{"HTTP 401"},
		},
		{
			name: "403 says the token lacks permission",
			err: &circleci.APIError{
				StatusCode: http.StatusForbidden,
				Method:     http.MethodGet,
				Path:       "/api/v2/project/gh/acme/web",
				Body:       `{"message":"` + leakSentinel + `"}`,
			},
			wantPhrases:    []string{"does not have permission", "HTTP 403"},
			wantAbsent:     []string{leakSentinel},
			wantLogPhrases: []string{"HTTP 403"},
		},
		{
			name: "429 says it was rate-limited",
			err: &circleci.APIError{
				StatusCode: http.StatusTooManyRequests,
				Method:     http.MethodGet,
				Path:       "/api/v2/project/gh/acme/web",
				Body:       `{"message":"` + leakSentinel + `"}`,
			},
			wantPhrases:    []string{"rate-limited", "HTTP 429"},
			wantAbsent:     []string{leakSentinel},
			wantLogPhrases: []string{"HTTP 429"},
		},
		{
			name:           "500 is a server error, not a client mistake",
			err:            &circleci.APIError{StatusCode: http.StatusBadGateway, Method: http.MethodGet, Path: "/api/v2/project/x"},
			wantPhrases:    []string{"server error", "HTTP 502"},
			wantLogPhrases: []string{"HTTP 502"},
		},
		{
			name:           "a timeout says so instead of blaming CircleCI",
			err:            fmt.Errorf("circleci: GET /api/v2/project/x: %w", context.DeadlineExceeded),
			wantPhrases:    []string{"did not respond before this request's time limit"},
			wantAbsent:     []string{"HTTP"},
			wantLogPhrases: []string{"context deadline exceeded"},
		},
		{
			name: "a network error says this host could not reach CircleCI",
			err: fmt.Errorf("circleci: GET /api/v2/project/x: %w",
				&net.OpError{Op: "dial", Net: "tcp", Err: errors.New("no such host")}),
			wantPhrases:    []string{"could not reach the CircleCI API"},
			wantAbsent:     []string{"HTTP"},
			wantLogPhrases: []string{"dial tcp"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			logs := captureHostLog(t)

			client := fullFakeClient()
			client.project = nil
			client.projectErr = tc.err
			ts := newProjectContextTestServer(t, connectedEnv(), client)

			status, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
			assert.Equal(t, status, http.StatusOK)

			var got projectContextBody
			assert.NilError(t, json.Unmarshal([]byte(body), &got))

			// Degrading honestly: the org's contexts are looked up by
			// organization and are unaffected by a failed project lookup.
			assert.Assert(t, got.Available)
			assert.Assert(t, got.Project == nil)
			assert.Equal(t, len(got.Contexts), 2)

			assert.Equal(t, len(got.Warnings), 1)
			warning := got.Warnings[0]
			assert.Equal(t, warning.Kind, "project")
			assert.Assert(t, len(warning.Consequences) > 0,
				"a warning with no stated consequence is the defect #150 reports")

			for _, phrase := range tc.wantPhrases {
				assert.Assert(t, is.Contains(warning.text(), phrase))
			}
			for _, phrase := range tc.wantAbsent {
				assert.Assert(t, !strings.Contains(body, phrase),
					"response should not mention %q: %s", phrase, body)
			}

			assert.Assert(t, logs.Len() > 0, "the host logged nothing about the failure")
			for _, phrase := range tc.wantLogPhrases {
				assert.Assert(t, is.Contains(logs.String(), phrase))
			}
			assert.Assert(t, !strings.Contains(logs.String(), leakSentinel),
				"logged an upstream response body: %s", logs.String())
			assert.Assert(t, !strings.Contains(logs.String(), sentinelToken),
				"logged the token: %s", logs.String())
		})
	}
}

// TestServer_ProjectContext_NearMissCandidates covers issue #20's third item:
// a 404'd project lookup carries the raw list of other repository names this
// token can see in the same organization, for the client's own `nearestUnique`
// to judge. This host decides nothing about which (if any) is a near miss --
// see warningPayload.Candidates and projectNearMissCandidates.
func TestServer_ProjectContext_NearMissCandidates(t *testing.T) {
	// The reported case (issue #20): a checkout named some-org/flakey-widgets
	// against a CircleCI project actually called flaky-widgets.
	client := fullFakeClient()
	client.project = nil
	client.projectErr = &circleci.APIError{StatusCode: http.StatusNotFound}
	client.followedProjects = []circleci.FollowedProject{
		{Org: "some-org", Repo: "flaky-widgets", VCSType: "github"},
		// Same repository name, but neither the right organization nor the
		// right VCS -- both must be filtered out rather than offered as if
		// they were candidates in the organization that actually 404'd.
		{Org: "other-org", Repo: "flaky-widgets", VCSType: "github"},
		{Org: "some-org", Repo: "flaky-widgets", VCSType: "bitbucket"},
		// A second, genuinely unrelated project in the right organization:
		// present in the list, because filtering is by organization and VCS
		// only. Whether it is close enough to count as a near miss is
		// `nearestUnique`'s decision, not this host's.
		{Org: "some-org", Repo: "completely-different-name", VCSType: "github"},
	}

	env := connectedEnv()
	env.org, env.repo = "some-org", "flakey-widgets"
	ts := newProjectContextTestServer(t, env, client)

	_, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)

	var got projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, len(got.Warnings), 1)
	warning := got.Warnings[0]
	assert.Equal(t, warning.Kind, "project")
	assert.DeepEqual(t, warning.Candidates, []string{"flaky-widgets", "completely-different-name"})
	assert.Equal(t, client.followedProjectsCalls, 1)
}

// TestServer_ProjectContext_NearMissCandidates_SilentOnFailure: the near-miss
// list is a best-effort enhancement to a 404 message that is already complete
// and honest without it, so a failure to fetch it degrades to no candidates --
// never to a second warning the existing 404 tests do not expect, and never to
// a crash.
func TestServer_ProjectContext_NearMissCandidates_SilentOnFailure(t *testing.T) {
	logs := captureHostLog(t)

	client := fullFakeClient()
	client.project = nil
	client.projectErr = &circleci.APIError{StatusCode: http.StatusNotFound}
	client.followedProjectsErr = &circleci.APIError{StatusCode: http.StatusForbidden}
	ts := newProjectContextTestServer(t, connectedEnv(), client)

	_, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)

	var got projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, len(got.Warnings), 1)
	assert.Equal(t, len(got.Warnings[0].Candidates), 0)

	// Still logged, on the "nothing upstream fails silently" rule every other
	// call in this file follows -- even though nothing user-facing says so.
	assert.Assert(t, is.Contains(logs.String(), "near-miss"))
}

// TestServer_ProjectContext_NearMissCandidates_SkippedForNonNotFound: spending
// a second upstream call chasing a typo theory makes sense only when the
// first call actually said "no such project" -- a 401/403/429/5xx/timeout is
// about the token, the network or CircleCI, not about the slug.
func TestServer_ProjectContext_NearMissCandidates_SkippedForNonNotFound(t *testing.T) {
	client := fullFakeClient()
	client.project = nil
	client.projectErr = &circleci.APIError{StatusCode: http.StatusUnauthorized}
	ts := newProjectContextTestServer(t, connectedEnv(), client)

	doRequest(t, ts, http.MethodGet, "/api/project-context", nil)

	assert.Equal(t, client.followedProjectsCalls, 0)
}

// TestServer_ProjectContext_NearMissCandidates_SkippedForStandaloneSlugs: the
// v1.1 API this feature calls predates GitHub App and GitLab standalone
// projects and has no record shaped like a `circleci/<org-id>/<project-id>`
// slug to compare against, so the round trip is skipped rather than spent on
// a call that could only ever come back empty.
func TestServer_ProjectContext_NearMissCandidates_SkippedForStandaloneSlugs(t *testing.T) {
	client := fullFakeClient()
	client.project = nil
	client.projectErr = &circleci.APIError{StatusCode: http.StatusNotFound}

	env := connectedEnv()
	env.vcsType, env.org, env.repo = "circleci", "org-id", "project-id"
	ts := newProjectContextTestServer(t, env, client)

	doRequest(t, ts, http.MethodGet, "/api/project-context", nil)

	assert.Equal(t, client.followedProjectsCalls, 0)
}

// TestServer_ProjectContext_LogLineCannotBeForged: the slug in a log line comes
// from environment variables this host did not choose, and the error text
// (indirectly) from a remote server. Neither may smuggle a newline and invent a
// second log line that looks like it came from here.
func TestServer_ProjectContext_LogLineCannotBeForged(t *testing.T) {
	logs := captureHostLog(t)

	client := fullFakeClient()
	client.project = nil
	client.projectErr = &circleci.APIError{StatusCode: http.StatusNotFound}

	env := connectedEnv()
	env.repo = "web\nproject-context: everything is fine"
	ts := newProjectContextTestServer(t, env, client)

	status, _ := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
	assert.Equal(t, status, http.StatusOK)

	// captureHostLog clears the standard logger's flags, so the only newline a
	// well-formed log line can contain is the one that terminates it.
	logged := strings.TrimSuffix(logs.String(), "\n")
	assert.Assert(t, !strings.Contains(logged, "\n"),
		"a tainted value forged a second log line: %q", logs.String())
	assert.Assert(t, is.Contains(logged, "HTTP 404"))
}

// TestServer_ProjectContext_FailuresAreNotCached is the second bug found while
// confirming #150: the response was cached unconditionally, so a warning
// outlived the problem that caused it by up to a full projectContextCacheTTL.
// A user who fixed a network blip (or onboarded the project) went on being
// told it was broken for another minute.
func TestServer_ProjectContext_FailuresAreNotCached(t *testing.T) {
	captureHostLog(t)

	client := fullFakeClient()
	client.project = nil
	client.projectErr = &circleci.APIError{StatusCode: http.StatusNotFound}
	ts := newProjectContextTestServer(t, connectedEnv(), client)

	_, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
	var first projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &first))
	assert.Equal(t, len(first.Warnings), 1)

	// The failure clears (the blip passed, or the project was onboarded).
	// The very next request must reflect that, with no ?refresh=1 needed.
	client.project = fullFakeClient().project
	client.projectErr = nil

	_, body = doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
	var second projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &second))
	assert.Equal(t, len(second.Warnings), 0)
	assert.Assert(t, second.Project != nil)

	// A fully successful response *is* still cached -- the TTL exists to stop
	// the palette re-requesting on every click, and that half must not
	// regress along with the fix.
	callsAfterSuccess := client.contextsCalls
	_, _ = doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
	assert.Equal(t, client.contextsCalls, callsAfterSuccess)
}

// TestServer_ProjectContext_WarningsNameTheirConsequences pins the other half
// of #150's UX complaint ("I couldn't tell whether the warning mattered"): a
// failure in one part must name what that part was for, and the parts that
// worked must still be served.
func TestServer_ProjectContext_WarningsNameTheirConsequences(t *testing.T) {
	captureHostLog(t)

	client := fullFakeClient()
	client.settings = nil
	client.settingsErr = &circleci.APIError{StatusCode: http.StatusForbidden}
	client.projectVariables = nil
	client.projectVariablesErr = &circleci.APIError{StatusCode: http.StatusForbidden}
	ts := newProjectContextTestServer(t, connectedEnv(), client)

	_, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)

	var got projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))

	assert.Equal(t, len(got.Warnings), 2)
	byKind := map[string]warningBody{}
	for _, w := range got.Warnings {
		byKind[w.Kind] = w
	}

	settings, ok := byKind["settings"]
	assert.Assert(t, ok)
	assert.Assert(t, is.Contains(strings.Join(settings.Consequences, " "), "dynamic config"))

	vars, ok := byKind["projectVariables"]
	assert.Assert(t, ok)
	assert.Assert(t, is.Contains(strings.Join(vars.Consequences, " "), "$NAME"))

	// Still partial, not total: the project record and the contexts are here.
	assert.Assert(t, got.Project != nil)
	assert.Equal(t, len(got.Contexts), 2)
}

// TestServer_ProjectContext_MissingContextListSaysSoForTheInspector ties #150
// to #152: the inspector's combobox may only call a typed context name
// unrecognised when the list it is checking against is known to be complete,
// so a failed context listing has to be distinguishable by kind.
func TestServer_ProjectContext_MissingContextListSaysSoForTheInspector(t *testing.T) {
	captureHostLog(t)

	client := fullFakeClient()
	client.contexts = nil
	client.contextsErr = &circleci.APIError{StatusCode: http.StatusForbidden}
	ts := newProjectContextTestServer(t, connectedEnv(), client)

	_, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)

	var got projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))

	assert.Equal(t, len(got.Warnings), 1)
	assert.Equal(t, got.Warnings[0].Kind, "contexts")
	assert.Assert(t, is.Contains(strings.Join(got.Warnings[0].Consequences, " "),
		"cannot be checked against the real list"))
}

// TestEnvironment_ProjectWebURL covers the environment-derived deep link. Note
// the VCS segment: every case emits CircleCI's canonical short spelling, because
// issue #182 normalises the slug before the URL is built. Both spellings were
// verified to render the real project page in a browser, so this is about
// speaking the platform's own dialect rather than about a broken link.
func TestEnvironment_ProjectWebURL(t *testing.T) {
	tests := []struct {
		name    string
		host    string
		vcsType string
		org     string
		repo    string
		want    string
	}{
		{
			name: "github on circleci.com links to the app subdomain, in canonical form",
			host: "https://circleci.com", vcsType: "github", org: "acme", repo: "web",
			want: "https://app.circleci.com/projects/gh/acme/web",
		},
		{
			name: "an already-canonical spelling is unchanged",
			host: "https://circleci.com", vcsType: "gh", org: "acme", repo: "web",
			want: "https://app.circleci.com/projects/gh/acme/web",
		},
		{
			name: "bitbucket is linkable too, as bb",
			host: "https://circleci.com", vcsType: "bitbucket", org: "acme", repo: "web",
			want: "https://app.circleci.com/projects/bb/acme/web",
		},
		{
			name:    "an unset host defaults to circleci.com",
			vcsType: "github", org: "acme", repo: "web",
			want: "https://app.circleci.com/projects/gh/acme/web",
		},
		{
			// CircleCI Server serves the API and the UI from one hostname,
			// so no app. prefix is invented for it.
			name: "a server installation keeps its own hostname",
			host: "https://circleci.example.com", vcsType: "github", org: "acme", repo: "web",
			want: "https://circleci.example.com/projects/gh/acme/web",
		},
		{
			// A standalone (GitLab / GitHub App) project: the web UI addresses
			// these by ID rather than by name, and issue #20 verified live that
			// the overview route still fits -- the IDs simply occupy the same
			// path segments a name would. See overviewRouteVCS.
			name: "a standalone project is linkable too, since issue #20",
			host: "https://circleci.com", vcsType: "circleci", org: "acme", repo: "web",
			want: "https://app.circleci.com/projects/circleci/acme/web",
		},
		{
			// The CLI emits gl for a GitLab remote, so this host does too --
			// but a GitLab project's CircleCI page is ID-addressed, and no
			// gl/<org>/<repo> web URL was verified to exist. Normalising the
			// slug and refusing to link it are separate decisions.
			name: "gitlab normalises but stays unlinked",
			host: "https://circleci.com", vcsType: "gitlab", org: "acme", repo: "web",
		},
		{
			name: "no repo means no project, so no url",
			host: "https://circleci.com", vcsType: "github", org: "acme",
		},
		{
			name: "a name needing escaping is escaped",
			host: "https://circleci.com", vcsType: "github", org: "acme corp", repo: "web ui",
			want: "https://app.circleci.com/projects/gh/acme%20corp/web%20ui",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clearCircleEnv(t)
			t.Setenv("CIRCLE_HOST", tc.host)
			t.Setenv("CIRCLE_VCS_TYPE", tc.vcsType)
			t.Setenv("CIRCLE_PROJECT_USERNAME", tc.org)
			t.Setenv("CIRCLE_PROJECT_REPONAME", tc.repo)

			assert.Equal(t, host.LoadEnvironment().ProjectWebURL(), tc.want)
		})
	}
}

// TestEnvironment_ContextWebURL covers the link to a context's own settings page
// (issue #251) -- the page that can actually change a restriction, which this
// host deliberately cannot.
//
// Note the two deliberate differences from ProjectWebURL above, both argued in
// ContextWebURL's own doc comment: this route takes an *organization* slug
// (two segments, not three), and it is offered for every VCS type including
// `circleci`, because for a GitLab or GitHub App organization `circleci/<org-id>`
// is how CircleCI itself addresses the organization rather than a stand-in for a
// name we lack.
func TestEnvironment_ContextWebURL(t *testing.T) {
	tests := []struct {
		name      string
		host      string
		orgSlug   string
		contextID string
		want      string
	}{
		{
			name: "github on circleci.com links to the app subdomain, in canonical form",
			host: "https://circleci.com", orgSlug: "github/acme", contextID: "ctx-1",
			want: "https://app.circleci.com/settings/organization/gh/acme/contexts/ctx-1",
		},
		{
			name: "an already-canonical slug is unchanged",
			host: "https://circleci.com", orgSlug: "gh/acme", contextID: "ctx-1",
			want: "https://app.circleci.com/settings/organization/gh/acme/contexts/ctx-1",
		},
		{
			name: "a standalone organization is addressed by its own id, and is still linkable",
			host: "https://circleci.com", orgSlug: "circleci/LmhyFJ56pbaEFz4NsPonHD", contextID: "ctx-1",
			want: "https://app.circleci.com/settings/organization/circleci/LmhyFJ56pbaEFz4NsPonHD/contexts/ctx-1",
		},
		{
			name:    "an unset host defaults to circleci.com",
			orgSlug: "gh/acme", contextID: "ctx-1",
			want: "https://app.circleci.com/settings/organization/gh/acme/contexts/ctx-1",
		},
		{
			name: "a server installation keeps its own hostname",
			host: "https://circleci.example.com", orgSlug: "gh/acme", contextID: "ctx-1",
			want: "https://circleci.example.com/settings/organization/gh/acme/contexts/ctx-1",
		},
		{
			name: "no context id means no link",
			host: "https://circleci.com", orgSlug: "gh/acme",
		},
		{
			name: "no organization slug means no link",
			host: "https://circleci.com", contextID: "ctx-1",
		},
		{
			// A three-segment *project* slug is not an organization slug, and
			// silently using its first two segments would build a URL for an
			// organization nobody named.
			name: "a project slug is refused rather than truncated",
			host: "https://circleci.com", orgSlug: "gh/acme/web", contextID: "ctx-1",
		},
		{
			name: "an empty organization segment is refused",
			host: "https://circleci.com", orgSlug: "gh/", contextID: "ctx-1",
		},
		{
			name: "an organization name and a context id needing escaping are escaped",
			host: "https://circleci.com", orgSlug: "github/acme corp", contextID: "a b",
			want: "https://app.circleci.com/settings/organization/gh/acme%20corp/contexts/a%20b",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clearCircleEnv(t)
			t.Setenv("CIRCLE_HOST", tc.host)

			got := host.LoadEnvironment().ContextWebURL(tc.orgSlug, tc.contextID)
			assert.Equal(t, got, tc.want)
		})
	}
}

// TestServer_ProjectContext_ContextsCarryTheirSettingsLink is the wiring half:
// the link has to reach the palette, and it has to be built from CircleCI's own
// organization slug rather than the one this host assembled.
func TestServer_ProjectContext_ContextsCarryTheirSettingsLink(t *testing.T) {
	client := fullFakeClient()
	// CircleCI's record says `gh/acme`; the injected environment would have
	// produced the same thing here, so make them differ to prove which one wins.
	client.project.OrganizationSlug = "gh/acme-canonical"
	ts := newProjectContextTestServer(t, connectedEnv(), client)

	_, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)

	var got projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, len(got.Contexts), 2)
	assert.Equal(t, got.Contexts[0].WebURL,
		"https://app.circleci.com/settings/organization/gh/acme-canonical/contexts/ctx-1")
	assert.Equal(t, got.Contexts[1].WebURL,
		"https://app.circleci.com/settings/organization/gh/acme-canonical/contexts/ctx-2")
}

// TestServer_ProjectContext_ContextLinkFallsBackToTheInjectedOrganization: with
// no project record there is no canonical organization slug, and the link is
// still worth having -- the contexts listed beside it were fetched by
// organization and are perfectly real.
func TestServer_ProjectContext_ContextLinkFallsBackToTheInjectedOrganization(t *testing.T) {
	client := fullFakeClient()
	client.project = nil
	client.projectErr = &circleci.APIError{StatusCode: http.StatusNotFound}
	ts := newProjectContextTestServer(t, connectedEnv(), client)

	_, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)

	var got projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, len(got.Contexts), 2)
	assert.Equal(t, got.Contexts[0].WebURL,
		"https://app.circleci.com/settings/organization/gh/acme/contexts/ctx-1")
}

// TestServer_Meta_CarriesTheProjectWebURL is issue #149's host half: the top
// bar needs the deep link without a token and without a request to CircleCI.
func TestServer_Meta_CarriesTheProjectWebURL(t *testing.T) {
	env := connectedEnv()
	env.token = ""
	ts := newProjectContextTestServer(t, env, nil)

	status, body := doRequest(t, ts, http.MethodGet, "/api/meta", nil)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		ProjectSlug   string `json:"projectSlug"`
		HasToken      bool   `json:"hasToken"`
		ProjectWebURL string `json:"projectWebUrl"`
		OrgWebURL     string `json:"orgWebUrl"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))

	assert.Equal(t, got.ProjectSlug, "gh/acme/web")
	assert.Assert(t, !got.HasToken)
	assert.Equal(t, got.ProjectWebURL, "https://app.circleci.com/projects/gh/acme/web")
	// The organization half of issue #20's link pair, available on the same
	// terms as ProjectWebURL: from the CLI-injected environment alone, no
	// token needed.
	assert.Equal(t, got.OrgWebURL, "https://app.circleci.com/pipelines/gh/acme")
}

// TestEnvironment_ProjectWebURLForSlug covers the other half of issue #182: the
// URL built from a slug CircleCI supplied, rather than from one this host
// assembled. The interesting cases are the ones that must refuse.
func TestEnvironment_ProjectWebURLForSlug(t *testing.T) {
	tests := []struct {
		name string
		slug string
		want string
	}{
		{
			name: "the canonical slug the API reports",
			slug: "gh/example-org/flaky-todo-list",
			want: "https://app.circleci.com/projects/gh/example-org/flaky-todo-list",
		},
		{
			name: "a long spelling is canonicalised rather than echoed",
			slug: "github/acme/web",
			want: "https://app.circleci.com/projects/gh/acme/web",
		},
		{
			name: "bitbucket",
			slug: "bb/acme/web",
			want: "https://app.circleci.com/projects/bb/acme/web",
		},
		{
			// A GitHub App or GitLab project, ID-addressed rather than
			// name-addressed. Issue #20 verified this exact route against a
			// live standalone project (see overviewRouteVCS), so this now
			// yields a URL rather than refusing -- the record's own slug is
			// what makes this worth keying off rather than the injected VCS
			// type: such a project can perfectly well sit in an organization
			// whose other projects are name-addressed.
			name: "an ID-addressed standalone slug is linkable too, since issue #20",
			slug: "circleci/PBz3EbdyZmZ4jNfLQCdXhs/QqvJmXcbSNvcbFxhVZDPTF",
			want: "https://app.circleci.com/projects/circleci/PBz3EbdyZmZ4jNfLQCdXhs/QqvJmXcbSNvcbFxhVZDPTF",
		},
		{
			// GitLab OAuth (non-standalone) projects still have no verified
			// route: issue #20's evidence covered "circleci"-addressed
			// organizations and projects, not "gl" ones. See
			// nameAddressedVCSSegments' own doc comment.
			name: "a gitlab oauth project is still unlinked",
			slug: "gl/acme/web",
		},
		{name: "an organization slug is not a project slug", slug: "gh/acme"},
		{name: "a slug with an empty segment", slug: "gh//web"},
		{name: "empty"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clearCircleEnv(t)
			assert.Equal(t, host.LoadEnvironment().ProjectWebURLForSlug(tc.slug), tc.want)
		})
	}
}

// TestEnvironment_OrgWebURLForSlug covers issue #20's organization link: the
// same live evidence that unlocked a standalone project's overview link also
// covers a standalone *organization's* pipelines page, and both a
// name-addressed and an ID-addressed organization slug are checked here for
// exactly that reason.
func TestEnvironment_OrgWebURLForSlug(t *testing.T) {
	tests := []struct {
		name string
		host string
		slug string
		want string
	}{
		{
			name: "a name-addressed organization",
			slug: "gh/CircleCI-Labs",
			want: "https://app.circleci.com/pipelines/gh/CircleCI-Labs",
		},
		{
			name: "a long vcs spelling is canonicalised",
			slug: "github/CircleCI-Labs",
			want: "https://app.circleci.com/pipelines/gh/CircleCI-Labs",
		},
		{
			name: "bitbucket",
			slug: "bb/acme",
			want: "https://app.circleci.com/pipelines/bb/acme",
		},
		{
			// The standalone-organization half of issue #20's evidence:
			// /pipelines/circleci/LmhyFJ56pbaEFz4NsPonHD answered 200 live.
			name: "a standalone organization, addressed by its own id",
			slug: "circleci/LmhyFJ56pbaEFz4NsPonHD",
			want: "https://app.circleci.com/pipelines/circleci/LmhyFJ56pbaEFz4NsPonHD",
		},
		{
			name: "a gitlab oauth organization is still unlinked",
			slug: "gl/acme",
		},
		{
			name: "a server installation keeps its own hostname",
			host: "https://circleci.example.com", slug: "gh/acme",
			want: "https://circleci.example.com/pipelines/gh/acme",
		},
		{
			// A three-segment *project* slug is not an organization slug, and
			// silently using its first two segments would build a URL for an
			// organization nobody named -- the same refusal ContextWebURL
			// already applies for its own organization-scoped route.
			name: "a project slug is refused rather than truncated",
			slug: "gh/acme/web",
		},
		{name: "no organization segment", slug: "gh/"},
		{name: "empty"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clearCircleEnv(t)
			if tc.host != "" {
				t.Setenv("CIRCLE_HOST", tc.host)
			}
			env := host.LoadEnvironment()
			assert.Equal(t, env.OrgWebURLForSlug(tc.slug), tc.want)
		})
	}
}

// TestEnvironment_ProjectSettingsWebURLForSlug covers the settings-page half
// of issue #248's link pair: same route shape as ProjectWebURLForSlug
// (confirmed against the live API), same refusal cases, different path segment.
func TestEnvironment_ProjectSettingsWebURLForSlug(t *testing.T) {
	tests := []struct {
		name string
		slug string
		want string
	}{
		{
			name: "the canonical slug the API reports",
			slug: "gh/example-org/flaky-todo-list",
			want: "https://app.circleci.com/settings/project/gh/example-org/flaky-todo-list",
		},
		{
			name: "a long spelling is canonicalised rather than echoed",
			slug: "github/acme/web",
			want: "https://app.circleci.com/settings/project/gh/acme/web",
		},
		{
			name: "bitbucket",
			slug: "bb/acme/web",
			want: "https://app.circleci.com/settings/project/bb/acme/web",
		},
		{
			name: "an ID-addressed standalone slug yields no url",
			slug: "circleci/PBz3EbdyZmZ4jNfLQCdXhs/QqvJmXcbSNvcbFxhVZDPTF",
		},
		{name: "an organization slug is not a project slug", slug: "gh/acme"},
		{name: "a slug with an empty segment", slug: "gh//web"},
		{name: "empty"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clearCircleEnv(t)
			assert.Equal(t, host.LoadEnvironment().ProjectSettingsWebURLForSlug(tc.slug), tc.want)
		})
	}
}

func TestEnvironment_OrgSlug(t *testing.T) {
	tests := []struct {
		name    string
		vcsType string
		org     string
		want    string
	}{
		{name: "full", vcsType: "github", org: "acme", want: "gh/acme"},
		{name: "an already-canonical spelling is unchanged", vcsType: "gh", org: "acme", want: "gh/acme"},
		{name: "bitbucket", vcsType: "bitbucket", org: "acme", want: "bb/acme"},
		{name: "missing vcs", org: "acme"},
		{name: "missing org", vcsType: "github"},
		{name: "empty"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clearCircleEnv(t)
			t.Setenv("CIRCLE_VCS_TYPE", tc.vcsType)
			t.Setenv("CIRCLE_PROJECT_USERNAME", tc.org)

			assert.Equal(t, host.LoadEnvironment().OrgSlug(), tc.want)
		})
	}
}

// TestServer_ProjectContext_UsesRecordedBinding is issue #198's items 1 and 2
// together, which is how they actually appear: the recorded binding decides which
// project is looked up, and its recorded IDs decide what the calls that want an ID
// are keyed by.
func TestServer_ProjectContext_UsesRecordedBinding(t *testing.T) {
	dir := t.TempDir()
	writeBinding(t, dir, projectBindingFixture)

	client := fullFakeClient()
	// The lookup succeeds for the *recorded* slug, which is the whole point: the
	// environment below still names the pre-rename repository.
	client.project.Slug = "gh/example-org/flaky-todo-list"
	client.project.ID = "93d2dc11-7495-41a9-ad8c-4ce0773a9789"
	client.project.OrganizationID = "4ada2c32-f0c2-4b60-a6b8-af674858fd51"

	env := connectedEnv()
	env.org, env.repo = "example-org", "flakey-todo-list"
	// No CIRCLE_PROJECT_ID: the editor launched outside the CLI, which is one of
	// the two cases reading this file ourselves is for.
	env.projectID = ""
	ts := newProjectContextTestServerIn(t, dir, env, client)

	status, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
	assert.Equal(t, status, http.StatusOK)

	var got projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))

	assert.Assert(t, got.Available)
	assert.Equal(t, len(got.Warnings), 0)
	// Not gh/example-org/flakey-todo-list, which is what the environment claimed
	// and what 404'd in the reported case.
	assert.Equal(t, client.gotProjectSlug, "gh/example-org/flaky-todo-list")
	assert.Equal(t, got.ProjectSlug, "gh/example-org/flaky-todo-list")
	assert.Equal(t, got.Project.Slug, "gh/example-org/flaky-todo-list")
	assert.Equal(t, got.Project.WebURL,
		"https://app.circleci.com/projects/gh/example-org/flaky-todo-list")
	// The organization is looked up by ID rather than by slug, and the ID came
	// from CircleCI's own record -- the usual order, unchanged by this issue.
	assert.Equal(t, client.gotOwner.ID, "4ada2c32-f0c2-4b60-a6b8-af674858fd51")
	assert.Equal(t, client.gotOwner.Slug, "")
}

// TestServer_ProjectContext_RecordedIDsSurviveA404 is the case issue #198's item 2
// exists for. The project lookup 404s -- a renamed repository, or a slug the API
// does not know -- and the settings and contexts sections are *still* answerable,
// because `.circleci/info.yml` recorded the IDs those two calls are keyed by and an
// ID survives a rename that a slug does not.
//
// Verified against the live API that this is a real capability rather than a
// hopeful one: `GET /api/v3/projects/{uuid}/settings` answers 200 for a bare
// project UUID with no slug involved anywhere.
func TestServer_ProjectContext_RecordedIDsSurviveA404(t *testing.T) {
	dir := t.TempDir()
	writeBinding(t, dir, projectBindingFixture)

	client := fullFakeClient()
	client.project = nil
	client.projectErr = &circleci.APIError{
		StatusCode: http.StatusNotFound,
		Method:     http.MethodGet,
		Path:       "/api/v2/project/gh/example-org/flaky-todo-list",
	}

	env := connectedEnv()
	env.org, env.repo, env.projectID = "example-org", "flakey-todo-list", ""
	ts := newProjectContextTestServerIn(t, dir, env, client)

	status, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
	assert.Equal(t, status, http.StatusOK)

	var got projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))

	assert.Assert(t, got.Available)
	assert.Assert(t, got.Project == nil)

	// Before this issue, no project record meant no settings call at all.
	assert.Equal(t, client.settingsCalls, 1)
	assert.Equal(t, client.gotSettingsProjectID, "93d2dc11-7495-41a9-ad8c-4ce0773a9789")
	assert.Assert(t, got.Settings != nil, "the recorded ID is what makes settings answerable here")
	assert.Assert(t, got.Settings.DynamicConfig)

	// And the organization's contexts, by the recorded organization ID.
	assert.Equal(t, client.gotOwner.ID, "4ada2c32-f0c2-4b60-a6b8-af674858fd51")
	assert.Equal(t, len(got.Contexts), 2)

	// One warning, about the project lookup, carrying the CLI's own remedy --
	// which for a binding that exists is `--force`, not a bare `project link`,
	// because the CLI preserves an existing file otherwise.
	assert.Equal(t, len(got.Warnings), 1)
	warning := got.Warnings[0]
	assert.Equal(t, warning.Kind, "project")
	assert.Assert(t, len(warning.Suggestions) > 0)
	assert.Assert(t, is.Contains(warning.text(), "circleci project link --force"))
	assert.Assert(t, is.Contains(warning.text(), "info.yml"))
	// The disagreement is named rather than silently resolved: it is the single
	// most diagnostic fact available without asking a third party anything.
	assert.Assert(t, is.Contains(warning.text(), "gh/example-org/flakey-todo-list"))
	assert.Assert(t, is.Contains(warning.text(), "out of date"))
}

// TestServer_ProjectContext_RecordedIDIsNotSentUnlessItIsAUUID pins the guard on
// the recorded project ID. `GET /api/v3/projects/{id}/settings` answers HTTP 400
// ("The value provided is not a valid UUID") rather than 404 for anything else --
// verified against the live API -- and the CLI's own `gitremote.ProjectInfo` warns
// that a recorded ID need not be a UUID. Sending it anyway would turn "we have no
// project ID" into an unactionable 400.
func TestServer_ProjectContext_RecordedIDIsNotSentUnlessItIsAUUID(t *testing.T) {
	dir := t.TempDir()
	writeBinding(t, dir, "project:\n  id: PBz3EbdyZmZ4jNfLQCdXhs\n  slug: gh/acme/web\n")

	client := fullFakeClient()
	client.project = nil
	client.projectErr = &circleci.APIError{
		StatusCode: http.StatusNotFound,
		Method:     http.MethodGet,
		Path:       "/api/v2/project/gh/acme/web",
	}

	env := connectedEnv()
	env.projectID = ""
	ts := newProjectContextTestServerIn(t, dir, env, client)

	status, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
	assert.Equal(t, status, http.StatusOK)

	var got projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))

	assert.Equal(t, client.settingsCalls, 0,
		"a non-UUID project ID must not be sent to an endpoint that rejects one with a 400")
	assert.Assert(t, got.Settings == nil)
}

// TestServer_ProjectContext_MalformedBindingIsNeverSilent is the honest-degrade
// constraint, in the state that is easiest to get wrong: a binding exists, cannot
// be read, and *something else* named a project — so the editor keeps working
// while showing a project the user did not record.
func TestServer_ProjectContext_MalformedBindingIsNeverSilent(t *testing.T) {
	dir := t.TempDir()
	bindingPath := writeBinding(t, dir, "project: [not a mapping")

	client := fullFakeClient()
	ts := newProjectContextTestServerIn(t, dir, connectedEnv(), client)

	status, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
	assert.Equal(t, status, http.StatusOK)

	var got projectContextBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))

	// Working: the environment's slug was used and everything resolved.
	assert.Assert(t, got.Available)
	assert.Equal(t, client.gotProjectSlug, "gh/acme/web")
	assert.Assert(t, got.Project != nil)
	assert.Equal(t, len(got.Contexts), 2)

	// Degraded, and saying so.
	assert.Equal(t, len(got.Warnings), 1)
	warning := got.Warnings[0]
	assert.Equal(t, warning.Kind, "projectBinding")
	assert.Assert(t, is.Contains(warning.Detail, bindingPath))
	assert.Assert(t, is.Contains(warning.Detail, "not parseable as YAML"))
	// The constraint, stated to the user rather than only in a comment.
	assert.Assert(t, is.Contains(warning.Detail, "never writes that file"))
	assert.Assert(t, len(warning.Consequences) > 0)
	assert.Assert(t, is.Contains(warning.text(), "circleci project link --force"))
}

// TestServer_ProjectContext_UnavailableReasonsDoNotReadAlike: with no project from
// any source, "this is not a CircleCI project" and "the file that says which
// project this is could not be read" are different situations with different fixes,
// and the second must not borrow the first's calm sentence.
func TestServer_ProjectContext_UnavailableReasonsDoNotReadAlike(t *testing.T) {
	unconnected := projectContextEnv{token: sentinelToken}

	noProject := t.TempDir()
	malformed := t.TempDir()
	bindingPath := writeBinding(t, malformed, "project: [not a mapping")

	read := func(dir string) projectContextBody {
		t.Helper()
		ts := newProjectContextTestServerIn(t, dir, unconnected, fullFakeClient())
		status, body := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
		assert.Equal(t, status, http.StatusOK)

		var got projectContextBody
		assert.NilError(t, json.Unmarshal([]byte(body), &got))
		assert.Assert(t, !got.Available)
		return got
	}

	plain := read(noProject)
	assert.Assert(t, is.Contains(plain.Reason, "not associated with a CircleCI project"))
	assert.Assert(t, !strings.Contains(plain.Reason, "info.yml"))

	broken := read(malformed)
	assert.Assert(t, is.Contains(broken.Reason, bindingPath))
	assert.Assert(t, is.Contains(broken.Reason, "not parseable as YAML"))
	assert.Assert(t, is.Contains(broken.Reason, "not the same as not being a CircleCI project"))
	assert.Assert(t, plain.Reason != broken.Reason)
}

// TestServer_ContextVariables_UsabilityUsesTheBoundProjectsID is the invariant
// behind effectiveProjectID: **the project ID and the project slug must come from
// the same source.**
//
// The case is `--config` pointing into a checkout other than the one the CircleCI
// CLI was started in. The slug then comes from that checkout's
// `.circleci/info.yml` while CIRCLE_PROJECT_ID describes the CLI's own checkout,
// and preferring the environment compared one project's ID against another
// project's restrictions — reporting "other-projects-only" for a context this
// project is in fact allowed to use. Silently, and in the one place the palette
// makes a promise about run-time behaviour.
func TestServer_ContextVariables_UsabilityUsesTheBoundProjectsID(t *testing.T) {
	dir := t.TempDir()
	// The binding names project A (fakeProjectUUID) — see projectBindingFixture.
	writeBinding(t, dir, projectBindingFixture)

	client := fullFakeClient()
	// ...and the context is restricted to project A only.
	client.restrictions = []circleci.ContextRestriction{
		{Type: circleci.RestrictionTypeProject, Value: fakeProjectUUID, Name: "flaky-todo-list"},
	}

	env := connectedEnv()
	// The environment names project B, in a repository whose name is stale too.
	env.org, env.repo = "example-org", "flakey-todo-list"
	env.projectID = otherProjectUUID
	ts := newProjectContextTestServerIn(t, dir, env, client)

	status, body := doRequest(t, ts, http.MethodGet, "/api/project-context/variables?contextId=ctx-1", nil)
	assert.Equal(t, status, http.StatusOK)

	var got contextVariablesBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))

	assert.Assert(t, got.Available)
	assert.Equal(t, got.Usability, "allowed",
		"the ID must come from the same source as the slug; CIRCLE_PROJECT_ID here is a different project")
	assert.Equal(t, got.RestrictionSummary, "restricted to 1 project")
}

// TestServer_ContextVariables_UsabilityDeclinesToGuess covers the other side of
// that invariant, and is the reason it is stated as "same source or nothing"
// rather than "prefer the binding".
//
// When the binding won the slug but recorded no usable ID — `circleci project
// link` populates the IDs only when it verified the slug against the API — and the
// environment is known to name a *different* project, there is no ID that
// describes this project. `unknown` is the honest answer; a confident
// "other-projects-only" from the wrong project's ID is not.
func TestServer_ContextVariables_UsabilityDeclinesToGuess(t *testing.T) {
	tests := []struct {
		name string
		// binding is written to `.circleci/info.yml`; empty means no file.
		binding string
		// envRepo and envProjectID are what the CLI injected.
		envRepo      string
		envProjectID string
		wantUsable   string
	}{
		{
			// The disagreement case with no recorded ID to fall back on.
			name:    "a binding with no recorded ID and a disagreeing environment",
			binding: "project:\n  slug: gh/example-org/flaky-todo-list\n",
			envRepo: "flakey-todo-list", envProjectID: otherProjectUUID,
			wantUsable: "unknown",
		},
		{
			// No recorded ID, but nothing disagrees: the CLI resolved
			// CIRCLE_PROJECT_ID from this very slug, so it is the same project.
			name:    "a binding with no recorded ID and an agreeing environment",
			binding: "project:\n  slug: gh/example-org/flaky-todo-list\n",
			envRepo: "flaky-todo-list", envProjectID: fakeProjectUUID,
			wantUsable: "allowed",
		},
		{
			// No binding at all: the environment is the only source, and it is
			// self-consistent.
			name:    "no binding leaves the environment as the single source",
			binding: "",
			envRepo: "flaky-todo-list", envProjectID: fakeProjectUUID,
			wantUsable: "allowed",
		},
		{
			// The other shape the CLI warns a recorded ID can take. It could
			// never match a UUID restriction value, so passing it would produce
			// a confident "other-projects-only" rather than a shrug.
			name:    "a non-UUID project ID is discarded rather than compared",
			binding: "",
			envRepo: "flaky-todo-list", envProjectID: "PBz3EbdyZmZ4jNfLQCdXhs",
			wantUsable: "unknown",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if tc.binding != "" {
				writeBinding(t, dir, tc.binding)
			}

			client := fullFakeClient()
			client.restrictions = []circleci.ContextRestriction{
				{Type: circleci.RestrictionTypeProject, Value: fakeProjectUUID},
			}

			env := connectedEnv()
			env.org, env.repo = "example-org", tc.envRepo
			env.projectID = tc.envProjectID
			ts := newProjectContextTestServerIn(t, dir, env, client)

			status, body := doRequest(t, ts, http.MethodGet,
				"/api/project-context/variables?contextId=ctx-1", nil)
			assert.Equal(t, status, http.StatusOK)

			var got contextVariablesBody
			assert.NilError(t, json.Unmarshal([]byte(body), &got))
			assert.Equal(t, got.Usability, tc.wantUsable)
		})
	}
}
