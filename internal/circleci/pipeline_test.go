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

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
)

// Bodies captured from the live API on 2026-07-30 while establishing that the
// undocumented `config` field on the v2 trigger endpoint is real and that a
// personal API token may use it (issue #194). Keeping the real bytes matters
// here for one specific reason: `created_at` is snake_case in the response
// while the `config` request field is not nested anywhere, and both are
// upstream's choices rather than ours.
const (
	// The v3 organization settings envelope, verbatim, from an org that has
	// *not* opted in. This is the row that matters: the project this issue
	// was filed against has the project-level flag on and this one off.
	liveOrgSettingsGateOffBody = `{"data":{"attributes":{"is_runner_terms_of_service_accepted":true,` +
		`"enable_ai_error_summarization":true,"enable_ai_agents":true,"enable_unversioned_config":false,` +
		`"enable_certified_public_orbs":true,"enable_chunk_ip_ranges":false,"enable_minor_ai_features":true,` +
		`"enable_private_orbs":true,"enable_uncertified_public_orbs":true,` +
		`"is_bitbucket_workspace_member_org_member":false,"is_user_checkout_keys_disabled":false,` +
		`"is_running_disabled":false,"enable_image_brownouts":true,` +
		`"is_context_group_restriction_required":false,"enable_resource_class_brownouts":true}}}`

	// The same envelope from an org that has opted in.
	liveOrgSettingsGateOnBody = `{"data":{"attributes":{"enable_unversioned_config":true}}}`

	// A created pipeline. Shape from CircleCI's published OpenAPI document
	// for this endpoint's 201 response.
	livePipelineCreatedBody = `{"id":"7c8f7b1e-0b3f-4a2f-9f2c-2f5b8a1d9e11","state":"pending",` +
		`"number":4211,"created_at":"2026-07-30T11:22:33.123Z"}`
)

func TestTriggerPipelineWithConfig_RequestShape(t *testing.T) {
	var gotBody map[string]any
	var gotPath, gotMethod, gotToken string

	_, client := newFakeCircleCI(t, "the-token", func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		gotToken = r.Header.Get("Circle-Token")
		assert.NilError(t, json.NewDecoder(r.Body).Decode(&gotBody))
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(livePipelineCreatedBody))
	})

	_, err := client.TriggerPipelineWithConfig(context.Background(), circleci.TriggerPipelineWithConfigRequest{
		ProjectSlug: "gh/acme/widgets",
		Branch:      "feature/try-it",
		ConfigYAML:  "version: 2.1\n",
		Parameters:  map[string]any{"deploy_prod": false},
	})
	assert.NilError(t, err)

	// The exact request CircleCI's own VS Code extension makes. The slug
	// occupies three path segments, and `config` is a *top-level* string --
	// not nested under `parameters`, which is the shape the original plan
	// document guessed at. See issue #194.
	assert.Equal(t, gotMethod, http.MethodPost)
	assert.Equal(t, gotPath, "/api/v2/project/gh/acme/widgets/pipeline")
	assert.Equal(t, gotToken, "the-token")
	assert.Equal(t, gotBody["branch"], "feature/try-it")
	assert.Equal(t, gotBody["config"], "version: 2.1\n")

	params, ok := gotBody["parameters"].(map[string]any)
	assert.Assert(t, ok, "parameters should be sent as an object")
	assert.Equal(t, params["deploy_prod"], false)
}

// The tripwire for anyone who "tidies up" by folding config into parameters,
// which is what #194's original plan document assumed and what the live API
// does not accept.
func TestTriggerPipelineWithConfig_ConfigIsNotAPipelineParameter(t *testing.T) {
	var gotBody map[string]any

	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		assert.NilError(t, json.NewDecoder(r.Body).Decode(&gotBody))
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(livePipelineCreatedBody))
	})

	_, err := client.TriggerPipelineWithConfig(context.Background(), circleci.TriggerPipelineWithConfigRequest{
		ProjectSlug: "gh/acme/widgets",
		Branch:      "topic",
		ConfigYAML:  "version: 2.1\n",
	})
	assert.NilError(t, err)

	_, present := gotBody["parameters"]
	assert.Assert(t, !present, "no parameters should mean no parameters key, not an empty object")
}

func TestTriggerPipelineWithConfig_DecodesLiveResponse(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(livePipelineCreatedBody))
	})

	pipeline, err := client.TriggerPipelineWithConfig(context.Background(), circleci.TriggerPipelineWithConfigRequest{
		ProjectSlug: "gh/acme/widgets",
		Branch:      "topic",
		ConfigYAML:  "version: 2.1\n",
	})
	assert.NilError(t, err)
	assert.Equal(t, pipeline.ID, "7c8f7b1e-0b3f-4a2f-9f2c-2f5b8a1d9e11")

	// The number, not the id, is what addresses a pipeline in the web UI.
	assert.Equal(t, pipeline.Number, int64(4211))
	assert.Equal(t, pipeline.State, "pending")
	assert.Assert(t, !pipeline.CreatedAt.IsZero(), "created_at is snake_case upstream and must still decode")
}

// Requests this client refuses to make at all. Each omission would produce a
// well-formed request with a meaning nobody asked for -- the config one most
// of all, because without it this endpoint builds whatever is committed to
// the branch, which is precisely the act this editor hands to the web UI.
func TestTriggerPipelineWithConfig_RefusedArguments(t *testing.T) {
	tests := []struct {
		name string
		req  circleci.TriggerPipelineWithConfigRequest
		want error
	}{
		{
			name: "no project slug",
			req:  circleci.TriggerPipelineWithConfigRequest{Branch: "topic", ConfigYAML: "version: 2.1\n"},
			want: circleci.ErrPipelineProjectSlugRequired,
		},
		{
			name: "no branch",
			req:  circleci.TriggerPipelineWithConfigRequest{ProjectSlug: "gh/acme/widgets", ConfigYAML: "version: 2.1\n"},
			want: circleci.ErrPipelineBranchRequired,
		},
		{
			name: "no config would trigger the committed config instead",
			req:  circleci.TriggerPipelineWithConfigRequest{ProjectSlug: "gh/acme/widgets", Branch: "topic"},
			want: circleci.ErrPipelineConfigRequired,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, client := newFakeCircleCI(t, "tok", func(http.ResponseWriter, *http.Request) {
				t.Error("no HTTP request should be made for a refused argument")
			})

			_, err := client.TriggerPipelineWithConfig(context.Background(), tc.req)
			assert.ErrorIs(t, err, tc.want)
		})
	}
}

// The 403 the live API answers when the organization has not opted in. The
// host must be able to tell it apart from every other failure, because it is
// the one that is settled rather than transient.
func TestTriggerPipelineWithConfig_ForbiddenIsRecognisable(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"User is not authorized to supply custom config."}`))
	})

	_, err := client.TriggerPipelineWithConfig(context.Background(), circleci.TriggerPipelineWithConfigRequest{
		ProjectSlug: "gh/acme/widgets",
		Branch:      "topic",
		ConfigYAML:  "version: 2.1\n",
	})
	assert.Assert(t, err != nil)
	assert.Assert(t, circleci.IsForbidden(err))

	status, ok := circleci.StatusCode(err)
	assert.Assert(t, ok)
	assert.Equal(t, status, http.StatusForbidden)
}

func TestGetOrgSettings_PathAndDecoding(t *testing.T) {
	tests := []struct {
		name string
		body string
		want bool
	}{
		{name: "organization has not opted in", body: liveOrgSettingsGateOffBody, want: false},
		{name: "organization has opted in", body: liveOrgSettingsGateOnBody, want: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var gotPath, gotMethod string

			_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, r *http.Request) {
				gotPath = r.URL.Path
				gotMethod = r.Method
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(tc.body))
			})

			settings, err := client.GetOrgSettings(context.Background(),
				"efc130dc-284f-4533-964e-844f5c173860")
			assert.NilError(t, err)

			// Keyed by UUID, not by slug: the v1.1 form is slug-keyed and
			// is deliberately not the one used.
			assert.Equal(t, gotMethod, http.MethodGet)
			assert.Equal(t, gotPath, "/api/v3/orgs/efc130dc-284f-4533-964e-844f5c173860/settings")
			assert.Equal(t, settings.UnversionedConfig, tc.want)
		})
	}
}

func TestGetOrgSettings_RefusesEmptyID(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", func(http.ResponseWriter, *http.Request) {
		t.Error("an empty organization ID must not produce a request")
	})

	_, err := client.GetOrgSettings(context.Background(), "")
	assert.ErrorIs(t, err, circleci.ErrOrgIDRequired)
}

// ---------------------------------------------------------------------------
// The newer endpoint. Two different inline-config shapes exist and neither
// endpoint serves every project, so both are pinned here -- each with where it
// came from and whether it was seen working against the live API.
// ---------------------------------------------------------------------------

// The 400s the live API returned on 2026-07-30 for the newer endpoint's schema.
// These are the whole of the evidence that `config.content` is a real field: the
// second one shows the endpoint rejects unknown fields, which is what makes a
// mere *type* complaint about `config.content` proof that it is in the schema.
// Neither probe created a pipeline.
const (
	liveConfigContentTypeErrorBody = `{"message":"Field 'config.content' should be 'string', but was 'number'."}`
	liveUnknownFieldErrorBody      = `{"message":"Unexpected field 'config.totally_not_a_field'."}`
)

// The request shape, taken from the CircleCI CLI's own
// internal/apiclient/pipeline_definition.go:TriggerPipelineRun at
// CircleCI-Public/circleci-cli@8256776, plus the `config.content` field the CLI
// does not send and the live 400s above establish.
//
// NOT OBSERVED LIVE: a successful 201 from this endpoint. The request shape is
// pinned; the success response is not verified. See issue #194.
func TestTriggerPipelineRunWithConfig_RequestShape(t *testing.T) {
	var gotBody map[string]any
	var gotPath, gotMethod string

	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		assert.NilError(t, json.NewDecoder(r.Body).Decode(&gotBody))
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(livePipelineCreatedBody))
	})

	_, err := client.TriggerPipelineRunWithConfig(context.Background(), circleci.TriggerPipelineWithConfigRequest{
		ProjectSlug:  "gh/acme/widgets",
		Branch:       "feature/try-it",
		ConfigYAML:   "version: 2.1\n",
		DefinitionID: "421f9f68-eb2a-53d8-9532-63f091c1e012",
	})
	assert.NilError(t, err)

	assert.Equal(t, gotMethod, http.MethodPost)
	assert.Equal(t, gotPath, "/api/v2/project/gh/acme/widgets/pipeline/run")
	assert.Equal(t, gotBody["definition_id"], "421f9f68-eb2a-53d8-9532-63f091c1e012")

	// The inline config is NESTED, under `config.content`. The legacy
	// endpoint's field is a top-level `config` string; sending either shape to
	// the other endpoint does not work, which is the whole reason routing
	// exists. This assertion is the tripwire for anyone who unifies them.
	config, ok := gotBody["config"].(map[string]any)
	assert.Assert(t, ok, "config must be an object on this endpoint, not a string")
	assert.Equal(t, config["content"], "version: 2.1\n")
	assert.Equal(t, config["branch"], "feature/try-it")

	// The CLI sets the config branch and the checkout branch from the same
	// flag. Asserted because an earlier report described a CLI that hardcoded
	// a "cli-run" config branch, creating a mismatch between the two -- no
	// such string has ever existed in the CLI's history.
	checkout, ok := gotBody["checkout"].(map[string]any)
	assert.Assert(t, ok, "checkout must be an object")
	assert.Equal(t, checkout["branch"], "feature/try-it")
}

// The newer endpoint chooses its code path from the definition, so a request
// without one could land on the path that drops the config.
func TestTriggerPipelineRunWithConfig_RefusesWithoutADefinition(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", func(http.ResponseWriter, *http.Request) {
		t.Error("no request should be made without a definition ID")
	})

	_, err := client.TriggerPipelineRunWithConfig(context.Background(), circleci.TriggerPipelineWithConfigRequest{
		ProjectSlug: "gh/acme/widgets",
		Branch:      "topic",
		ConfigYAML:  "version: 2.1\n",
	})
	assert.ErrorIs(t, err, circleci.ErrPipelineDefinitionRequired)
}

// The two live 400s, decoded as this client would see them: both are plain
// upstream status failures, and the host must not try to read the message out
// of them (response bodies never leave the host).
func TestTriggerPipelineRunWithConfig_SchemaRejections(t *testing.T) {
	for _, body := range []string{liveConfigContentTypeErrorBody, liveUnknownFieldErrorBody} {
		_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(body))
		})

		_, err := client.TriggerPipelineRunWithConfig(context.Background(), circleci.TriggerPipelineWithConfigRequest{
			ProjectSlug: "gh/acme/widgets", Branch: "topic",
			ConfigYAML: "version: 2.1\n", DefinitionID: "def-1",
		})
		assert.Assert(t, circleci.IsBadRequest(err))
	}
}

// The live response, verbatim, for a classic OAuth project. The description
// text is CircleCI's own and is what identifies the implicit definition.
const liveOAuthDefinitionsBody = `{"items":[{"id":"421f9f68-eb2a-53d8-9532-63f091c1e012",` +
	`"name":"project-1","description":"Implicit pipeline definition associated with an OAuth-based project.",` +
	`"config_source":{"provider":"github_oauth","repo":{"full_name":"gh-oauth-cci-1/project-1",` +
	`"external_id":"1268403322"},"file_path":".circleci/config.yml"},` +
	`"checkout_source":{"provider":"github_oauth","repo":{"full_name":"gh-oauth-cci-1/project-1",` +
	`"external_id":"1268403322"}}}]}`

func TestListPipelineDefinitions_DecodesLiveResponse(t *testing.T) {
	var gotPath string
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(liveOAuthDefinitionsBody))
	})

	definitions, err := client.ListPipelineDefinitions(context.Background(),
		"d8fc5b21-353a-4743-9969-6a24a189527a")
	assert.NilError(t, err)

	assert.Equal(t, gotPath, "/api/v2/projects/d8fc5b21-353a-4743-9969-6a24a189527a/pipeline-definitions")
	assert.Equal(t, len(definitions), 1)
	assert.Equal(t, definitions[0].ConfigSourceProvider, circleci.ProviderGitHubOAuth)
	assert.Equal(t, definitions[0].ID, "421f9f68-eb2a-53d8-9532-63f091c1e012")
}

// The providers this build recognises were each observed on a real project;
// everything else is a refusal rather than a guess.
func TestConfigRouteFor(t *testing.T) {
	tests := []struct {
		name        string
		definitions []circleci.PipelineDefinition
		wantRoute   circleci.ConfigRoute
		wantDefID   string
	}{
		{
			name:        "github_oauth routes to the legacy endpoint and needs no definition",
			definitions: []circleci.PipelineDefinition{{ID: "a", ConfigSourceProvider: "github_oauth"}},
			wantRoute:   circleci.ConfigRouteLegacy,
			wantDefID:   "",
		},
		{
			name:        "github_app routes to pipeline/run",
			definitions: []circleci.PipelineDefinition{{ID: "a", ConfigSourceProvider: "github_app"}},
			wantRoute:   circleci.ConfigRoutePipelineRun,
			wantDefID:   "a",
		},
		{
			name:        "gitlab routes to pipeline/run",
			definitions: []circleci.PipelineDefinition{{ID: "b", ConfigSourceProvider: "gitlab"}},
			wantRoute:   circleci.ConfigRoutePipelineRun,
			wantDefID:   "b",
		},
		{
			// Observed live on several real standalone projects.
			name:        "no definitions cannot be routed",
			definitions: nil,
			wantRoute:   circleci.ConfigRouteUnknown,
		},
		{
			name: "more than one definition cannot be routed",
			definitions: []circleci.PipelineDefinition{
				{ID: "a", ConfigSourceProvider: "github_app"},
				{ID: "b", ConfigSourceProvider: "github_app"},
			},
			wantRoute: circleci.ConfigRouteUnknown,
		},
		{
			// Real, and never tested here. Assuming it behaves like a
			// provider we did test is how a wrong green happens.
			name:        "github_server is not assumed to behave like github_app",
			definitions: []circleci.PipelineDefinition{{ID: "a", ConfigSourceProvider: "github_server"}},
			wantRoute:   circleci.ConfigRouteUnknown,
		},
		{
			name:        "a definition with no ID cannot be run",
			definitions: []circleci.PipelineDefinition{{ConfigSourceProvider: "github_app"}},
			wantRoute:   circleci.ConfigRouteUnknown,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			route, defID := circleci.ConfigRouteFor(tc.definitions)
			assert.Equal(t, route, tc.wantRoute)
			assert.Equal(t, defID, tc.wantDefID)
		})
	}
}

// The live response, verbatim (truncated): four keys, of which `source` is the
// one that answers "did our bytes run".
const livePipelineConfigBody = `{"compiled":"version: 2\njobs:\n  build:\n    steps: []\n",` +
	`"compiled_setup_config":"","setup_config":"","source":"version: 2.1\njobs: {}\n"}`

func TestGetPipelineConfig_DecodesLiveResponse(t *testing.T) {
	var gotPath string
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(livePipelineConfigBody))
	})

	config, err := client.GetPipelineConfig(context.Background(),
		"374b427a-c2a9-4ff1-b173-8838a813d448")
	assert.NilError(t, err)

	assert.Equal(t, gotPath, "/api/v2/pipeline/374b427a-c2a9-4ff1-b173-8838a813d448/config")
	// `source` is what a submitted config is compared against. `compiled` is
	// deliberately not: compilation rewrites the document legitimately, so
	// comparing it would report a mismatch for every orb.
	assert.Equal(t, config.Source, "version: 2.1\njobs: {}\n")
	assert.Assert(t, config.Compiled != "")
}

func TestGetPipelineConfig_RefusesEmptyID(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", func(http.ResponseWriter, *http.Request) {
		t.Error("an empty pipeline ID must not produce a request")
	})
	_, err := client.GetPipelineConfig(context.Background(), "")
	assert.ErrorIs(t, err, circleci.ErrPipelineIDRequired)
}
