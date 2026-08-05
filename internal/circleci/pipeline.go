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

package circleci

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// The unversioned-config trigger, and the organization half of its
// availability gate.
//
// ## Where the request shape came from (issue #194)
//
// The `config` field on the v2 trigger endpoint is **not** in CircleCI's
// published OpenAPI document: `TriggerPipelineParameters` in
// circleci-docs/src-api/openapi-patched.json declares `branch`, `tag` and
// `parameters`, and nothing else. So the shape here was not read off the API
// reference, because the API reference does not describe it.
//
// It was read off CircleCI's own VS Code extension, which is the shipping
// product this capability was built for —
// `packages/api/src/config.ts:triggerPipeline` posts
// `{branch, tag, config, parameters}` to `/api/v2/project/{slug}/pipeline`
// with a personal API token in `Circle-Token` — and then confirmed against
// the live API. The confirmation is worth recording because it distinguishes
// "the server accepts this field" from "the server ignores this field",
// which a successful trigger alone would not:
//
//	POST /api/v2/project/gh/<org>/<repo>/pipeline, branch that does not exist
//	  without `config`, org gate off  -> 400 {"message":"Branch not found"}
//	  with    `config`, org gate off  -> 403 {"message":"User is not authorized
//	                                          to supply custom config."}
//	  with    `config`, org gate on   -> 400 {"message":"Branch not found"}
//
// A field the server ignored could not have produced the middle row. A field
// the server rejected outright could not have produced the last one. And
// because authorization is evaluated *before* the branch is resolved, all
// three probes created no pipeline at all — which is how this was established
// without spending anyone's money.
//
// ## No `X-CircleCI-API-Source` header
//
// The VS Code extension sends `X-CircleCI-API-Source: vscode`, which CircleCI
// records in the audit log as `trigger-source: api, vscode`. Verified to have
// no bearing on authorization (the 403 above is identical with and without
// it), so the only thing it would buy this editor is a label — and the only
// label available is a claim to be a different program. An audit log entry
// saying `api` is less useful than one saying `circleci-editor`; it is
// considerably more useful than one that is wrong.
const (
	// triggerPipelinePathFmt takes a "<vcs>/<org>/<repo>" slug, escaped by
	// escapeSlug so it stays three path segments.
	triggerPipelinePathFmt = "/api/v2/project/%s/pipeline"

	// orgSettingsV3PathFmt takes an organization UUID. The v1.1 form the VS
	// Code extension uses (`GET /api/v1.1/organization/{slug}/settings`,
	// field `allow_api_trigger_with_config_enabled?`) reports the same fact;
	// v3 is preferred -- this project favors v3 wherever the API surface
	// allows it -- and both were verified to agree on the same org.
	orgSettingsV3PathFmt = "/api/v3/orgs/%s/settings"

	// pipelineRunPathFmt takes a "<vcs>/<org>/<repo>" slug and addresses the
	// *newer* trigger endpoint, whose inline-config field is the nested
	// `config.content` rather than the legacy endpoint's top-level `config`.
	//
	// Both are real and neither covers every project. See ConfigRoute.
	pipelineRunPathFmt = "/api/v2/project/%s/pipeline/run"

	// pipelineDefinitionsPathFmt takes a project UUID. Its
	// `config_source.provider` is what tells the two trigger endpoints apart
	// for a given project.
	pipelineDefinitionsPathFmt = "/api/v2/projects/%s/pipeline-definitions"

	// pipelineConfigPathFmt takes a pipeline UUID and returns the config that
	// pipeline actually ran. This is the silent-ignore detector -- see
	// GetPipelineConfig.
	pipelineConfigPathFmt = "/api/v2/pipeline/%s/config"
)

// Config-source providers, as returned in
// `config_source.provider` by GET /api/v2/projects/{id}/pipeline-definitions.
//
// Observed live on 2026-07-30, one project of each kind:
//
//	github_oauth -- "Implicit pipeline definition associated with an
//	                OAuth-based project", i.e. a classic GitHub OAuth project
//	github_app   -- a GitHub App project
//	gitlab       -- a GitLab (standalone) project
//
// `github_server` and the Bitbucket spellings are named by the CircleCI CLI's
// own CreateTrigger documentation (`provider must be one of: github_app,
// github_server, github_oauth, webhook, schedule`) but were not observed here,
// so they are deliberately *not* listed as known: an unrecognised provider must
// resolve to "we cannot tell which endpoint honours an inline config", which is
// a refusal. See ConfigRouteFor.
const (
	ProviderGitHubOAuth = "github_oauth"
	ProviderGitHubApp   = "github_app"
	ProviderGitLab      = "gitlab"
)

// ConfigRoute names which endpoint will actually *honour* an inline config for
// a given project.
//
// ## Why this type exists at all
//
// There are two trigger endpoints, they take the inline config in two different
// shapes, and neither works everywhere:
//
//	                       | POST .../pipeline/run  | POST .../pipeline
//	                       | (`config.content`)     | (top-level `config`)
//	-----------------------+------------------------+---------------------
//	GitHub OAuth (classic) | SILENTLY IGNORED       | works
//	GitHub App / GitLab    | works                  | not supported
//
// The top-left cell is the reason this is a routing decision rather than a
// preference. On a classic OAuth project, `/pipeline/run` accepts
// `config.content`, returns a normal 201, and runs **the config committed to
// the repository instead**. It does not error. For this editor that is the
// worst failure available: we would report "your edits ran", CircleCI would run
// the file on disk, and a green result would attest to a config that was never
// tested. A wrong green is worse than no button.
//
// So the route is chosen from evidence, and when there is no evidence the
// answer is ConfigRouteUnknown, which callers must turn into a refusal rather
// than a guess. Silent-ignore cannot be detected before spending money, so
// uncertainty here has to resolve to "no".
type ConfigRoute string

const (
	// ConfigRouteLegacy means POST /api/v2/project/{slug}/pipeline with a
	// top-level `config` string. Classic GitHub OAuth projects.
	ConfigRouteLegacy ConfigRoute = "legacy"

	// ConfigRoutePipelineRun means POST /api/v2/project/{slug}/pipeline/run
	// with a nested `config.content`. GitHub App and GitLab projects, which
	// the legacy endpoint does not serve at all.
	ConfigRoutePipelineRun ConfigRoute = "pipeline-run"

	// ConfigRouteUnknown means this host cannot establish which endpoint
	// would honour an inline config for this project. Never trigger on this.
	ConfigRouteUnknown ConfigRoute = "unknown"
)

// PipelineDefinition is one of a project's pipeline definitions, reduced to the
// part that decides how to trigger it: its ID and where its config comes from.
type PipelineDefinition struct {
	ID   string `json:"id"`
	Name string `json:"name"`

	// ConfigSourceProvider is `config_source.provider` -- one of the
	// Provider* constants, or something this build does not know.
	ConfigSourceProvider string `json:"configSourceProvider"`
}

// ConfigRouteFor decides which endpoint would honour an inline config, given a
// project's pipeline definitions.
//
// Returns the route and the definition ID `/pipeline/run` requires (empty for
// the legacy route, which does not take one).
//
// Deliberately strict. Anything other than "exactly one definition, whose
// provider this build recognises" is ConfigRouteUnknown:
//
//   - **No definitions.** Nothing to reason from. Observed live on several real
//     standalone projects, which answer `{"items":[]}` -- so this is a normal
//     state, not a broken one, and it still cannot be routed.
//   - **More than one definition.** Which one a bare trigger would pick is not
//     knowable from here, and picking wrong could mean picking the one that
//     drops the config.
//   - **An unrecognised provider.** `github_server` and the Bitbucket
//     spellings exist and were never observed; assuming one behaves like a
//     provider we did test is exactly the guess that produces a wrong green.
func ConfigRouteFor(definitions []PipelineDefinition) (ConfigRoute, string) {
	if len(definitions) != 1 {
		return ConfigRouteUnknown, ""
	}

	definition := definitions[0]
	switch definition.ConfigSourceProvider {
	case ProviderGitHubOAuth:
		// The legacy endpoint takes no definition ID.
		return ConfigRouteLegacy, ""
	case ProviderGitHubApp, ProviderGitLab:
		if definition.ID == "" {
			return ConfigRouteUnknown, ""
		}
		return ConfigRoutePipelineRun, definition.ID
	default:
		return ConfigRouteUnknown, ""
	}
}

// pipelineDefinitionsResponse is the JSON response body of
// GET /api/v2/projects/{id}/pipeline-definitions.
type pipelineDefinitionsResponse struct {
	Items []struct {
		ID           string `json:"id"`
		Name         string `json:"name"`
		ConfigSource struct {
			Provider string `json:"provider"`
		} `json:"config_source"`
	} `json:"items"`
}

// ListPipelineDefinitions returns a project's pipeline definitions, keyed by
// project UUID. Readable with a personal API token (verified).
func (c *Client) ListPipelineDefinitions(ctx context.Context, projectID string) ([]PipelineDefinition, error) {
	if projectID == "" {
		return nil, ErrPipelineProjectIDRequired
	}

	var wire pipelineDefinitionsResponse
	path := fmt.Sprintf(pipelineDefinitionsPathFmt, url.PathEscape(projectID))
	if err := c.do(ctx, http.MethodGet, path, nil, &wire); err != nil {
		return nil, err
	}

	out := make([]PipelineDefinition, 0, len(wire.Items))
	for _, item := range wire.Items {
		out = append(out, PipelineDefinition{
			ID:                   item.ID,
			Name:                 item.Name,
			ConfigSourceProvider: item.ConfigSource.Provider,
		})
	}
	return out, nil
}

// PipelineConfig is the config a pipeline actually ran.
type PipelineConfig struct {
	// Source is the config as submitted -- for an unversioned run, this
	// should be byte-identical to what was sent. When it is not, the inline
	// config was ignored and the repository's own config ran instead.
	Source string `json:"source"`

	// Compiled is the config after orb expansion and parameter
	// substitution. Carried because it is in the same response, and not
	// used for the comparison: compilation legitimately rewrites the
	// document, so only Source can answer "did our bytes run".
	Compiled string `json:"compiled"`
}

// pipelineConfigResponse is the JSON response body of
// GET /api/v2/pipeline/{id}/config. Field names verified live.
type pipelineConfigResponse struct {
	Source   string `json:"source"`
	Compiled string `json:"compiled"`
}

// GetPipelineConfig returns the config a pipeline ran.
//
// ## Why this exists: it is the only way to catch a silently ignored config
//
// `/pipeline/run` on a classic OAuth project accepts `config.content`, answers
// 201, and runs the repository's config anyway (see ConfigRoute). Nothing in
// the trigger response distinguishes that from success. This endpoint does:
// `source` is the config the pipeline actually ran, so comparing it with what
// was submitted turns an undetectable wrong-green into a detectable one.
//
// Routing is the primary defence and this is the check that the routing was
// right. Both are kept, because the routing rests on behaviour that could
// change under us and this does not.
//
// Read-only, and *not* a scope-boundary violation: it reads back the request
// this editor itself just made, which is a fact about our own submission
// rather than an observation of how the run is getting on. Nothing here
// reports status, and nothing polls.
func (c *Client) GetPipelineConfig(ctx context.Context, pipelineID string) (*PipelineConfig, error) {
	if pipelineID == "" {
		return nil, ErrPipelineIDRequired
	}

	var wire pipelineConfigResponse
	path := fmt.Sprintf(pipelineConfigPathFmt, url.PathEscape(pipelineID))
	if err := c.do(ctx, http.MethodGet, path, nil, &wire); err != nil {
		return nil, err
	}
	return &PipelineConfig{Source: wire.Source, Compiled: wire.Compiled}, nil
}

// OrgSettings is the subset of an organization's settings that decides
// whether this editor may offer a run at all.
type OrgSettings struct {
	// UnversionedConfig reports whether the *organization* permits
	// triggering pipelines with a config supplied out-of-band.
	//
	// This is the binding gate, and it is not the same flag as
	// ProjectSettings.UnversionedConfig — CircleCI's own documentation says
	// the organization setting defaults to Off and *overrides* the project
	// setting, and the live API bears that out: on the project that issue
	// #194 was filed against, the project flag is `true` while the
	// organization flag is `false`, and the trigger is refused. A caller
	// that reads only the project flag will tell the user a run is
	// available and then watch it fail. See issue #194.
	UnversionedConfig bool `json:"unversionedConfig"`
}

// Pipeline is what CircleCI returns when a pipeline has been created.
//
// Four fields, and deliberately no fifth. `State` is carried verbatim and
// never interpreted: by design, observation of a running pipeline lives on
// the other side of this program's boundary, so this type exists to
// *address* a pipeline in the web UI (Number is what the URL wants), not to
// describe how it is getting on.
type Pipeline struct {
	ID        string    `json:"id"`
	Number    int64     `json:"number"`
	State     string    `json:"state"`
	CreatedAt time.Time `json:"createdAt"`
}

// TriggerPipelineWithConfigRequest names a one-shot run of a config that is
// not in the repository.
type TriggerPipelineWithConfigRequest struct {
	// ProjectSlug is "<vcs>/<org>/<repo>".
	ProjectSlug string

	// Branch is the branch whose checkout the jobs run against. The config
	// on that branch is ignored in favour of ConfigYAML; everything else
	// about the run — the commit, the environment variables, the contexts,
	// the OIDC claims — is the branch's.
	Branch string

	// ConfigYAML is the config to run. Required: see
	// ErrPipelineConfigRequired.
	ConfigYAML string

	// Parameters overrides the config's declared pipeline parameters.
	//
	// It cannot supply a *missing* one, because a missing one cannot exist:
	// CircleCI's schema requires every top-level `parameters:` entry to
	// declare a `default`, verified against compile-config-with-defaults,
	// which answers `[#/parameters/target] required key [default] not
	// found`. So a config that "needs a parameter nobody provided" fails
	// compilation before it could ever be triggered.
	//
	// A parameter the config does *not* declare is a different matter and is
	// rejected: CircleCI's own docs warn that triggering with an undeclared
	// parameter yields an error response, "such as `Project not found`".
	Parameters map[string]any

	// DefinitionID is the pipeline definition to run. Required by
	// TriggerPipelineRunWithConfig; unused by TriggerPipelineWithConfig,
	// because the legacy endpoint has no such concept.
	DefinitionID string
}

// triggerPipelineWireRequest is the JSON body of
// POST /api/v2/project/{slug}/pipeline.
//
// `branch` and `config` are omitempty and `parameters` is a nil-able map so
// that this client never sends a key it has no value for. That matters more
// than tidiness for `config`: an empty `config` string is not "no custom
// config", it is a custom config that is empty, and the two must not be the
// same request.
type triggerPipelineWireRequest struct {
	Branch     string         `json:"branch,omitempty"`
	Config     string         `json:"config,omitempty"`
	Parameters map[string]any `json:"parameters,omitempty"`
}

// triggerPipelineWireResponse is the JSON response body of a successful
// trigger. Field names verified against CircleCI's published OpenAPI
// document for this endpoint, whose response schema *is* documented even
// though the `config` request field is not.
type triggerPipelineWireResponse struct {
	ID        string    `json:"id"`
	Number    int64     `json:"number"`
	State     string    `json:"state"`
	CreatedAt time.Time `json:"created_at"`
}

// orgSettingsV3Response is the JSON response body of
// GET /api/v3/orgs/{id}/settings, in the same data/attributes envelope
// projectSettingsV3Response uses.
type orgSettingsV3Response struct {
	Data struct {
		Attributes struct {
			EnableUnversionedConfig bool `json:"enable_unversioned_config"`
		} `json:"attributes"`
	} `json:"data"`
}

// Requests this client declines to make, rather than failures it reports.
// Each of these would produce a well-formed HTTP request with a meaning
// nobody asked for: no slug addresses a different endpoint, no branch runs
// against the default branch, and no config triggers an ordinary pipeline
// from the repository — which is the one outcome this method must never
// produce by accident.
var (
	// ErrPipelineProjectSlugRequired is returned when ProjectSlug is empty.
	ErrPipelineProjectSlugRequired = errors.New("circleci: triggering a pipeline requires a project slug")

	// ErrPipelineBranchRequired is returned when Branch is empty. CircleCI
	// would default to the project's default branch, which is the last
	// place an unreviewed config should land silently.
	ErrPipelineBranchRequired = errors.New("circleci: triggering a pipeline requires a branch")

	// ErrPipelineConfigRequired is returned when ConfigYAML is empty.
	ErrPipelineConfigRequired = errors.New("circleci: triggering a pipeline with an unversioned config requires the config")

	// ErrOrgIDRequired is returned by GetOrgSettings when orgID is empty.
	ErrOrgIDRequired = errors.New("circleci: fetching organization settings requires an organization ID")

	// ErrPipelineProjectIDRequired is returned by ListPipelineDefinitions
	// when projectID is empty.
	ErrPipelineProjectIDRequired = errors.New("circleci: listing pipeline definitions requires a project ID")

	// ErrPipelineIDRequired is returned by GetPipelineConfig when pipelineID
	// is empty.
	ErrPipelineIDRequired = errors.New("circleci: fetching a pipeline's config requires a pipeline ID")

	// ErrPipelineDefinitionRequired is returned by TriggerPipelineRunWithConfig
	// when DefinitionID is empty. The endpoint would accept the request
	// without one and choose a definition itself -- possibly the one that
	// drops the config, which is the outcome this whole route exists to
	// avoid.
	ErrPipelineDefinitionRequired = errors.New("circleci: running a pipeline with an unversioned config requires a pipeline definition ID")
)

// triggerPipelineRunWireRequest is the JSON body of
// POST /api/v2/project/{vcs}/{org}/{repo}/pipeline/run.
//
// ## Provenance, and what was and was not observed
//
// The shape is the CircleCI CLI's own, read from
// `internal/apiclient/pipeline_definition.go:TriggerPipelineRun` at
// CircleCI-Public/circleci-cli@8256776 -- `definition_id`, a `config` object
// carrying `branch`/`tag`, a `checkout` object carrying `branch`/`tag`, and
// `parameters`.
//
// The CLI does **not** send `config.content`; it has no flag that could. That
// field's existence was established directly against the live API instead, and
// this is the whole of the evidence for it:
//
//	POST .../pipeline/run {"config":{"content":12345,...}}
//	  -> 400 {"message":"Field 'config.content' should be 'string', but was 'number'."}
//	POST .../pipeline/run {"config":{"totally_not_a_field":"x",...}}
//	  -> 400 {"message":"Unexpected field 'config.totally_not_a_field'."}
//
// The second probe is what makes the first one mean something: this endpoint
// rejects unknown fields, so a type complaint about `config.content` is proof
// the field is in its schema, as a string. Neither probe created a pipeline.
//
// What is **not** established: that the field is *honoured*. That cannot be
// tested without a real run, which is why ConfigRoute exists and why
// GetPipelineConfig checks afterwards.
type triggerPipelineRunWireRequest struct {
	DefinitionID string `json:"definition_id"`
	Config       struct {
		Branch string `json:"branch,omitempty"`
		// Content is the inline config. Nested here, *not* top-level --
		// the legacy endpoint's field is a top-level `config` string and
		// the two are not interchangeable.
		Content string `json:"content,omitempty"`
	} `json:"config"`
	Checkout struct {
		Branch string `json:"branch,omitempty"`
	} `json:"checkout"`
	Parameters map[string]any `json:"parameters,omitempty"`
}

// TriggerPipelineRunWithConfig starts one pipeline via the newer
// `/pipeline/run` endpoint, supplying req.ConfigYAML as `config.content`.
//
// Use this only for projects ConfigRouteFor routed to ConfigRoutePipelineRun.
// On a classic GitHub OAuth project this endpoint accepts the config and
// silently runs the repository's own instead; TriggerPipelineWithConfig is the
// route for those.
//
// `config.branch` and `checkout.branch` are both set to req.Branch, matching
// what the CLI does (`--branch sets both the config fetch branch and the
// checkout branch`). Worth stating because an earlier report described a CLI
// that hardcoded a `cli-run` config branch, producing a mismatch between the
// two; no such string has ever existed in the CLI's history
// (`git log --all -S"cli-run"` is empty), and the current code sets both from
// one flag. So there is no mismatch to work around here.
func (c *Client) TriggerPipelineRunWithConfig(ctx context.Context, req TriggerPipelineWithConfigRequest) (*Pipeline, error) {
	switch {
	case req.ProjectSlug == "":
		return nil, ErrPipelineProjectSlugRequired
	case req.Branch == "":
		return nil, ErrPipelineBranchRequired
	case req.ConfigYAML == "":
		return nil, ErrPipelineConfigRequired
	case req.DefinitionID == "":
		return nil, ErrPipelineDefinitionRequired
	}

	path := fmt.Sprintf(pipelineRunPathFmt, escapeSlug(req.ProjectSlug))

	var wireReq triggerPipelineRunWireRequest
	wireReq.DefinitionID = req.DefinitionID
	wireReq.Config.Branch = req.Branch
	wireReq.Config.Content = req.ConfigYAML
	wireReq.Checkout.Branch = req.Branch
	wireReq.Parameters = req.Parameters

	var wire triggerPipelineWireResponse
	if err := c.do(ctx, http.MethodPost, path, wireReq, &wire); err != nil {
		return nil, err
	}

	return &Pipeline{
		ID:        wire.ID,
		Number:    wire.Number,
		State:     wire.State,
		CreatedAt: wire.CreatedAt,
	}, nil
}

// GetOrgSettings returns the organization's settings, keyed by organization
// *UUID*.
//
// Readable with a personal API token, and — verified — readable for any
// organization whose UUID the caller knows, membership or not. So a failure
// here is a real failure rather than an expected permissions wall, and
// callers should report "we could not determine whether this is available"
// rather than assuming either answer. That distinction is the whole of this
// call's contribution to honest degradation.
func (c *Client) GetOrgSettings(ctx context.Context, orgID string) (*OrgSettings, error) {
	if orgID == "" {
		return nil, ErrOrgIDRequired
	}

	var wire orgSettingsV3Response
	path := fmt.Sprintf(orgSettingsV3PathFmt, url.PathEscape(orgID))
	if err := c.do(ctx, http.MethodGet, path, nil, &wire); err != nil {
		return nil, err
	}

	return &OrgSettings{
		UnversionedConfig: wire.Data.Attributes.EnableUnversionedConfig,
	}, nil
}

// TriggerPipelineWithConfig starts one pipeline on req.Branch using
// req.ConfigYAML in place of the config committed to that branch, and
// returns the created pipeline.
//
// ## Why this method has no sibling that omits the config
//
// The endpoint it posts to is CircleCI's ordinary "trigger a pipeline"
// endpoint: drop the `config` field and it builds whatever is on the branch.
// This package deliberately offers no way to do that. Running the config in
// front of you is authoring feedback and has been in this editor's scope
// since day one; re-running the committed config is an operational act on a
// project, which this editor hands off to the web UI instead. Requiring
// ConfigYAML is that boundary expressed as a type, in the same way
// projectMetadataClient names no write methods — the difference being that
// here the wrong call would spend money rather than merely exceed scope.
//
// ## A nil error means a pipeline exists, not that anything succeeded
//
// Same split as CompileConfig and DecidePolicy. A created pipeline can go on
// to fail at config compilation, fail a config policy, or fail its first job.
// This method's business finishes at "CircleCI accepted this and gave it a
// number"; everything after that belongs to the web UI.
//
// A 403 is the interesting failure and callers must not report it as a
// generic refusal: it is what the API answers when the organization has not
// opted in to unversioned config. Read GetOrgSettings and
// GetProjectSettings *first* so the user is told that before being offered a
// button, rather than after pressing one.
func (c *Client) TriggerPipelineWithConfig(ctx context.Context, req TriggerPipelineWithConfigRequest) (*Pipeline, error) {
	switch {
	case req.ProjectSlug == "":
		return nil, ErrPipelineProjectSlugRequired
	case req.Branch == "":
		return nil, ErrPipelineBranchRequired
	case req.ConfigYAML == "":
		return nil, ErrPipelineConfigRequired
	}

	path := fmt.Sprintf(triggerPipelinePathFmt, escapeSlug(req.ProjectSlug))

	wireReq := triggerPipelineWireRequest{
		Branch:     req.Branch,
		Config:     req.ConfigYAML,
		Parameters: req.Parameters,
	}

	var wire triggerPipelineWireResponse
	if err := c.do(ctx, http.MethodPost, path, wireReq, &wire); err != nil {
		return nil, err
	}

	return &Pipeline{
		ID:        wire.ID,
		Number:    wire.Number,
		State:     wire.State,
		CreatedAt: wire.CreatedAt,
	}, nil
}
