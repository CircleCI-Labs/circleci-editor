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
	"net/http"
	"net/http/httptest"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
)

// invalidTestToken is deliberately not a real credential shape: every test in
// this file talks to an httptest server, never to CircleCI, and this value
// exists only so the client sends *a* Circle-Token header for assertions to
// check. Nothing in this repo may ever contain a working token.
const invalidTestToken = "not-a-real-token-do-not-use"

// newProjectTestClient returns a client pointed at handler, plus the recorded
// request paths handler saw.
func newProjectTestClient(t *testing.T, handler http.HandlerFunc) (*circleci.Client, *[]string) {
	t.Helper()

	var seen []string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.RequestURI())
		handler(w, r)
	}))
	t.Cleanup(ts.Close)

	client, err := circleci.NewClient(circleci.Config{Host: ts.URL, Token: invalidTestToken})
	assert.NilError(t, err)
	return client, &seen
}

func TestListContexts_UsesOwnerIDAndFollowsPagination(t *testing.T) {
	page := 0
	client, seen := newProjectTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		page++
		if page == 1 {
			_, _ = w.Write([]byte(`{"items":[{"id":"ctx-1","name":"build-secrets","created_at":"2026-01-01T00:00:00Z"}],"next_page_token":"tok-2"}`))
			return
		}
		_, _ = w.Write([]byte(`{"items":[{"id":"ctx-2","name":"deploy-prod","created_at":"2026-01-02T00:00:00Z"}],"next_page_token":null}`))
	})

	contexts, err := client.ListContexts(context.Background(), circleci.ContextOwner{ID: "org-uuid"})
	assert.NilError(t, err)
	assert.Equal(t, len(contexts), 2)
	assert.Equal(t, contexts[0].Name, "build-secrets")
	assert.Equal(t, contexts[1].Name, "deploy-prod")
	assert.Assert(t, !contexts[0].CreatedAt.IsZero())

	// Contexts live only on v2 -- /api/v3/contexts exists but refuses
	// personal API tokens. If someone "upgrades" this path, this assertion
	// is the tripwire.
	assert.Assert(t, is.Contains((*seen)[0], "/api/v2/context?"))
	assert.Assert(t, is.Contains((*seen)[0], "owner-id=org-uuid"))
	assert.Assert(t, is.Contains((*seen)[1], "page-token=tok-2"))
}

func TestListContexts_UsesOwnerSlugWhenNoID(t *testing.T) {
	client, seen := newProjectTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"items":[],"next_page_token":null}`))
	})

	_, err := client.ListContexts(context.Background(), circleci.ContextOwner{Slug: "github/acme"})
	assert.NilError(t, err)
	assert.Assert(t, is.Contains((*seen)[0], "owner-slug=github%2Facme"))
}

func TestListContexts_RequiresAnOwner(t *testing.T) {
	client, seen := newProjectTestClient(t, func(_ http.ResponseWriter, _ *http.Request) {
		t.Error("no request should have been made without an owner")
	})

	_, err := client.ListContexts(context.Background(), circleci.ContextOwner{})
	assert.ErrorContains(t, err, "requires an owner ID or slug")
	assert.Equal(t, len(*seen), 0)
}

func TestListContextVariables_ReturnsNamesAndTruncatedPreviews(t *testing.T) {
	// Fake fixture data throughout: "abcd" is not a secret, truncated or
	// otherwise.
	client, seen := newProjectTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"items":[
			{"variable":"AWS_ROLE","truncated_value":"arn:","context_id":"ctx-1"},
			{"variable":"AWS_ROLE_ARN","truncated_value":"arn:","context_id":"ctx-1"}
		],"next_page_token":null}`))
	})

	vars, err := client.ListContextVariables(context.Background(), "ctx-1")
	assert.NilError(t, err)
	assert.Equal(t, len(vars), 2)
	assert.Equal(t, vars[0].Name, "AWS_ROLE")
	assert.Equal(t, vars[0].TruncatedValue, "arn:")
	assert.Equal(t, vars[1].Name, "AWS_ROLE_ARN")

	assert.Assert(t, is.Contains((*seen)[0], "/api/v2/context/ctx-1/environment-variable"))
}

// TestListContextVariables_ClampsAnOverlongPreview pins the safety clamp: the
// point of the feature is a short disambiguating hint, and if CircleCI ever
// widened truncated_value (or filled it with a whole secret by mistake), this
// package must not become a way to read one.
func TestListContextVariables_ClampsAnOverlongPreview(t *testing.T) {
	client, _ := newProjectTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"items":[{"variable":"OVERSHARE","truncated_value":"0123456789abcdef"}],"next_page_token":null}`))
	})

	vars, err := client.ListContextVariables(context.Background(), "ctx-1")
	assert.NilError(t, err)
	assert.Equal(t, len(vars), 1)
	assert.Equal(t, vars[0].TruncatedValue, "01234567")
	assert.Equal(t, len(vars[0].TruncatedValue), 8)
}

// TestListContextVariables_MissingPreviewIsEmpty covers the documented
// possibility that truncated_value is absent -- it is returned by the live API
// but is not in CircleCI's published OpenAPI document for this endpoint, so it
// is not contractually guaranteed.
func TestListContextVariables_MissingPreviewIsEmpty(t *testing.T) {
	client, _ := newProjectTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"items":[{"variable":"NO_PREVIEW"}],"next_page_token":null}`))
	})

	vars, err := client.ListContextVariables(context.Background(), "ctx-1")
	assert.NilError(t, err)
	assert.Equal(t, vars[0].Name, "NO_PREVIEW")
	assert.Equal(t, vars[0].TruncatedValue, "")
}

func TestListContextVariables_RequiresAContextID(t *testing.T) {
	client, _ := newProjectTestClient(t, func(_ http.ResponseWriter, _ *http.Request) {
		t.Error("no request should have been made without a context ID")
	})

	_, err := client.ListContextVariables(context.Background(), "")
	assert.ErrorContains(t, err, "requires a context ID")
}

func TestListContextRestrictions(t *testing.T) {
	client, seen := newProjectTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"items":[
			{"id":"r-1","name":"web","restriction_type":"project","restriction_value":"proj-uuid"},
			{"id":"r-2","name":"platform","restriction_type":"group","restriction_value":"group-uuid"}
		]}`))
	})

	restrictions, err := client.ListContextRestrictions(context.Background(), "ctx-1")
	assert.NilError(t, err)
	assert.Equal(t, len(restrictions), 2)
	assert.Equal(t, restrictions[0].Type, circleci.RestrictionTypeProject)
	assert.Equal(t, restrictions[0].Value, "proj-uuid")
	assert.Equal(t, restrictions[1].Type, circleci.RestrictionTypeGroup)

	assert.Assert(t, is.Contains((*seen)[0], "/api/v2/context/ctx-1/restrictions"))
}

// TestListProjectVariables_DropsTheMaskedValueField is the load-bearing test
// for ProjectVariable's design: the v2 API returns a field literally named
// "value" (holding a mask, not the secret), and this package must not carry it
// any further. ProjectVariable has no field it could land in.
func TestListProjectVariables_DropsTheMaskedValueField(t *testing.T) {
	client, seen := newProjectTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"items":[
			{"name":"DEPLOY_TARGET","value":"xxxxdev1","created_at":null},
			{"name":"NPM_TOKEN","value":"xxxxbeef","created_at":null}
		],"next_page_token":null}`))
	})

	vars, err := client.ListProjectVariables(context.Background(), "github/acme/web")
	assert.NilError(t, err)
	assert.Equal(t, len(vars), 2)
	assert.Equal(t, vars[0].Name, "DEPLOY_TARGET")
	assert.Equal(t, vars[1].Name, "NPM_TOKEN")

	// The struct has exactly one field; there is nowhere for a mask to hide.
	assert.Equal(t, vars[0], circleci.ProjectVariable{Name: "DEPLOY_TARGET"})

	assert.Assert(t, is.Contains((*seen)[0], "/api/v2/project/github/acme/web/envvar"))
}

func TestGetProject(t *testing.T) {
	client, seen := newProjectTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{
			"id":"proj-uuid","slug":"github/acme/web","name":"web",
			"organization_id":"org-uuid","organization_name":"acme","organization_slug":"gh/acme",
			"vcs_info":{"vcs_url":"https://github.com/acme/web","provider":"GitHub","default_branch":"trunk"}
		}`))
	})

	project, err := client.GetProject(context.Background(), "github/acme/web")
	assert.NilError(t, err)
	assert.Equal(t, project.ID, "proj-uuid")
	assert.Equal(t, project.DefaultBranch, "trunk")
	assert.Equal(t, project.OrganizationID, "org-uuid")
	assert.Equal(t, project.VCSProvider, "GitHub")

	assert.Assert(t, is.Contains((*seen)[0], "/api/v2/project/github/acme/web"))
}

// TestListFollowedProjects_DecodesTheThreeIdentifyingFields pins the
// deliberately narrow decode this method performs (issue #20): the fixture
// below includes a `branches` field shaped like the live v1.1 API's own
// (recent build outcomes per branch) specifically to prove it is ignored
// rather than decoded into anything this package holds on to.
func TestListFollowedProjects_DecodesTheThreeIdentifyingFields(t *testing.T) {
	client, seen := newProjectTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[
			{
				"username":"acme","reponame":"web","vcs_type":"github",
				"branches":{"main":{"recent_builds":[{"status":"success","build_num":42}]}}
			},
			{"username":"acme","reponame":"widgets","vcs_type":"github"}
		]`))
	})

	projects, err := client.ListFollowedProjects(context.Background())
	assert.NilError(t, err)
	assert.Equal(t, len(projects), 2)
	assert.Equal(t, projects[0], circleci.FollowedProject{Org: "acme", Repo: "web", VCSType: "github"})
	assert.Equal(t, projects[1], circleci.FollowedProject{Org: "acme", Repo: "widgets", VCSType: "github"})

	assert.Assert(t, is.Contains((*seen)[0], "/api/v1.1/projects"))
}

func TestListFollowedProjects_SurfacesUpstreamFailure(t *testing.T) {
	client, _ := newProjectTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"Permission denied"}`))
	})

	_, err := client.ListFollowedProjects(context.Background())
	assert.Assert(t, err != nil)
	assert.Assert(t, circleci.IsForbidden(err))
}

// TestGetProjectSettings_UsesV3 pins both the version choice and the field
// names: v3 is the one endpoint in this file with a usable v3 form, and it
// names enable_dynamic_config directly where v2 only has
// advanced.setup_workflows.
func TestGetProjectSettings_UsesV3(t *testing.T) {
	client, seen := newProjectTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"attributes":{
			"enable_dynamic_config":true,
			"enable_unversioned_config":true,
			"is_oss":false,
			"enable_building_fork_prs":true,
			"can_pass_secrets_to_fork_pr_jobs":false
		}}}`))
	})

	settings, err := client.GetProjectSettings(context.Background(), "proj-uuid")
	assert.NilError(t, err)
	assert.Assert(t, settings.DynamicConfig)
	assert.Assert(t, settings.UnversionedConfig)
	assert.Assert(t, !settings.OSS)
	assert.Assert(t, settings.BuildForkPRs)
	assert.Assert(t, !settings.PassSecretsToForkPR)

	assert.Assert(t, is.Contains((*seen)[0], "/api/v3/projects/proj-uuid/settings"))
}

func TestGetProjectSettings_RequiresAProjectID(t *testing.T) {
	client, _ := newProjectTestClient(t, func(_ http.ResponseWriter, _ *http.Request) {
		t.Error("no request should have been made without a project ID")
	})

	_, err := client.GetProjectSettings(context.Background(), "")
	assert.ErrorContains(t, err, "requires a project ID")
}

// TestProjectMetadata_SurfacesForbidden covers the realistic failure this
// feature has to degrade around: a token that can read the project but is not
// permitted to list the organization's contexts.
func TestProjectMetadata_SurfacesForbidden(t *testing.T) {
	client, _ := newProjectTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"Permission denied"}`))
	})

	_, err := client.ListContexts(context.Background(), circleci.ContextOwner{ID: "org-uuid"})
	assert.Assert(t, err != nil)
	assert.Assert(t, circleci.IsForbidden(err))
}

// TestProjectMetadata_SlugSegmentsAreEscapedIndividually pins escapeSlug's
// behaviour: the slug occupies three path segments, so its separators must
// survive while each segment is escaped.
func TestProjectMetadata_SlugSegmentsAreEscapedIndividually(t *testing.T) {
	client, seen := newProjectTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"items":[],"next_page_token":null}`))
	})

	_, err := client.ListProjectVariables(context.Background(), "github/acme corp/web app")
	assert.NilError(t, err)
	assert.Assert(t, is.Contains((*seen)[0], "/api/v2/project/github/acme%20corp/web%20app/envvar"))
}
