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
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// API paths for read-only project authoring metadata.
//
// Version straddling here is forced, not chosen.
// Contexts, context environment variables, context restrictions, project
// environment variables and the project record itself exist **only on v2**:
// `/api/v3/contexts` does exist, but it authenticates web sessions rather
// than personal API tokens (it answers "Not authenticated" to a token that
// the v2 equivalent accepts, under both the Circle-Token and
// Authorization: Bearer schemes), so it is unusable from a CLI plugin.
// Project *settings* is the one member of this set with a usable v3
// endpoint, and it is strictly better than its v2 counterpart for our
// purpose: it names `enable_dynamic_config` outright, where v2 only exposes
// the older `advanced.setup_workflows` spelling of the same fact.
const (
	contextsPath                 = "/api/v2/context"
	contextVariablesPathFmt      = "/api/v2/context/%s/environment-variable"
	contextRestrictionsPathFmt   = "/api/v2/context/%s/restrictions"
	projectVariablesPathFmt      = "/api/v2/project/%s/envvar"
	projectPathFmt               = "/api/v2/project/%s"
	projectSettingsV3PathFmt     = "/api/v3/projects/%s/settings"
	maxProjectMetadataPageCount  = 50
	truncatedValuePreviewMaxRune = 8
)

// The `restriction_type` values CircleCI returns for a context restriction.
//
// All three were observed on the live v2 API across 146 contexts of one real
// organization (177 restriction records: 152 group, 51 project, 5 expression).
// A project restriction names one project allowed to use the context; a group
// restriction names an org group whose membership we cannot evaluate from here;
// an expression restriction is a rule over pipeline values, which we can read
// but not evaluate either.
//
// The list is not treated as closed: an unrecognised type must count towards
// "we cannot tell" rather than be dropped. See host.assessRestrictions.
const (
	RestrictionTypeProject    = "project"
	RestrictionTypeGroup      = "group"
	RestrictionTypeExpression = "expression"
)

// Context is one CircleCI context belonging to an organization.
type Context struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}

// ContextVariable is one environment variable held by a context.
//
// It carries the variable's name and CircleCI's own four-character
// TruncatedValue preview — and nothing else, because nothing else exists to
// carry. The CircleCI API does not return context secret values at all, by
// design; `truncated_value` is the entire extent of what the platform will
// disclose. Treat TruncatedValue as a disambiguator between similarly-named
// variables ("is this AWS_ROLE or AWS_ROLE_ARN") and as evidence that a
// context is populated rather than empty — never as the value.
type ContextVariable struct {
	Name string `json:"name"`

	// TruncatedValue is CircleCI's four-character preview of the secret.
	// It is returned by the live v2 API but is *not* described in
	// CircleCI's published OpenAPI document for this endpoint, so it can
	// legitimately be absent; callers must render an empty string as
	// "no preview available" rather than as an empty secret.
	TruncatedValue string `json:"truncatedValue"`
}

// ContextRestriction is one restriction limiting when a context may be used:
// by which projects, by which org groups, or under which pipeline conditions.
//
// ## What these records actually contain (verified live)
//
// Issue #251 asked whether the restrictions this client already fetches are
// merely unsurfaced. They are. Every field below is populated by the live v2
// API, and Name in particular is the answer to "restricted *how*":
//
//	restriction_type   Name holds                    Value holds
//	-----------------  ----------------------------  ----------------------------
//	project            the project's name            the project's UUID
//	                   ("circle-banking-app")        ("788dd296-2fca-…")
//	group              the group's name              the group's UUID, which for
//	                   ("Field Engineering")         a group restriction equals
//	                                                 its own `id` (152/152)
//	expression         "" — always                   the rule itself, in
//	                                                 CircleCI's expression
//	                                                 language:
//	                                                 `pipeline.git.branch == "main"`
//
// Two consequences worth stating, because both shape how a caller must render
// these:
//
//   - **A project restriction's Name can be empty.** One of the 51 project
//     restrictions observed carried `"name": ""` with a perfectly good UUID. So
//     a name is evidence when present and never something to assume — a caller
//     must be able to say *what kind of thing* the restriction names without
//     one, rather than falling back to printing the UUID.
//   - **An expression's Value is prose, not an identifier**, and it is the only
//     human-readable thing in the record. It is a rule over pipeline values, so
//     it holds no secret: `not (pipeline.config_source starts-with "api")`
//     is the whole of what it says.
//
// The API also returns `project_id` on a project restriction, duplicating
// `restriction_value` (equal in all 51 observed). It is deliberately not
// decoded: a second field holding the same UUID is a second thing to keep in
// agreement, and Value already carries it. `context_id` is likewise dropped —
// the caller passed the context ID in to get this list.
type ContextRestriction struct {
	// ID identifies the restriction itself, for the API calls that delete one.
	// This host makes none of those: there is no write path here.
	ID string `json:"id"`

	// Name is CircleCI's own name for what the restriction names: a project
	// name, or a group name. Always empty for an expression restriction, and
	// legitimately empty for a project restriction — see above.
	Name string `json:"name"`

	// Type is one of the RestrictionType* constants, or something new.
	Type string `json:"type"`

	// Value is the restriction's subject: a project UUID, a group UUID, or —
	// for an expression restriction — the expression itself.
	Value string `json:"value"`
}

// ProjectVariable is one project-level environment variable.
//
// Only the name is carried, deliberately. The v2 API returns a field named
// `value`, but it holds a mask ("xxxx" followed by up to the last four
// characters), not the secret — verified against the live API. We drop it at
// this boundary rather than forwarding it, because a field literally called
// "value" arriving in the browser is an invitation for some later caller to
// treat it as one. Project variables are referenced as `$NAME` inside a run
// command, so the name is the whole of what an author needs.
type ProjectVariable struct {
	Name string `json:"name"`
}

// Project is the subset of a CircleCI project record useful while authoring
// a config.
type Project struct {
	ID               string `json:"id"`
	Slug             string `json:"slug"`
	Name             string `json:"name"`
	OrganizationID   string `json:"organizationId"`
	OrganizationName string `json:"organizationName"`
	OrganizationSlug string `json:"organizationSlug"`
	VCSProvider      string `json:"vcsProvider"`
	DefaultBranch    string `json:"defaultBranch"`
}

// ProjectSettings is the subset of a project's settings that changes how a
// config behaves, and so is worth knowing while writing one.
type ProjectSettings struct {
	// DynamicConfig reports whether setup workflows / dynamic config are
	// enabled. A `setup: true` config is only meaningful when this is on.
	DynamicConfig bool `json:"dynamicConfig"`

	// UnversionedConfig reports whether the project accepts a config
	// supplied out-of-band rather than from the repository — which is what
	// this editor's own one-shot run relies on.
	UnversionedConfig bool `json:"unversionedConfig"`

	// OSS reports whether the project is public/open source.
	OSS bool `json:"oss"`

	// BuildForkPRs and PassSecretsToForkPRs together decide whether a
	// context or project variable is even present in a fork's build, which
	// is a live authoring concern rather than an operational one.
	BuildForkPRs        bool `json:"buildForkPrs"`
	PassSecretsToForkPR bool `json:"passSecretsToForkPrs"`
}

// ContextOwner identifies the organization whose contexts to list. Exactly
// one of ID or Slug must be set; ID is preferred, being unambiguous.
//
// Slug takes the form "<vcs>/<org>". Both the short VCS spelling CircleCI's
// docs use ("gh/acme") and the long spelling the CLI injects into a plugin's
// environment as CIRCLE_VCS_TYPE ("github/acme") are accepted by the API —
// verified against both.
type ContextOwner struct {
	ID   string
	Slug string
}

// queryValues renders o as the query parameters GET /api/v2/context expects.
func (o ContextOwner) queryValues() (url.Values, error) {
	v := url.Values{}
	switch {
	case o.ID != "":
		v.Set("owner-id", o.ID)
	case o.Slug != "":
		v.Set("owner-slug", o.Slug)
	default:
		return nil, fmt.Errorf("circleci: listing contexts requires an owner ID or slug")
	}
	return v, nil
}

// contextsResponse is the JSON response body from GET /api/v2/context.
type contextsResponse struct {
	Items []struct {
		ID        string    `json:"id"`
		Name      string    `json:"name"`
		CreatedAt time.Time `json:"created_at"`
	} `json:"items"`
	NextPageToken string `json:"next_page_token"`
}

// ListContexts returns every context visible to the caller for owner,
// following the API's page-token pagination to completion.
//
// Contexts are organization-scoped: this is "the contexts the org has", not
// yet "the contexts this project may use". Use ListContextRestrictions to
// narrow that per context.
func (c *Client) ListContexts(ctx context.Context, owner ContextOwner) ([]Context, error) {
	query, err := owner.queryValues()
	if err != nil {
		return nil, err
	}

	var all []Context
	pageToken := ""

	for page := 0; page < maxProjectMetadataPageCount; page++ {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}

		q := url.Values{}
		for k, vs := range query {
			q[k] = vs
		}
		if pageToken != "" {
			q.Set("page-token", pageToken)
		}

		var wire contextsResponse
		if doErr := c.do(ctx, http.MethodGet, contextsPath+"?"+q.Encode(), nil, &wire); doErr != nil {
			return nil, doErr
		}

		for _, it := range wire.Items {
			all = append(all, Context{ID: it.ID, Name: it.Name, CreatedAt: it.CreatedAt})
		}

		if wire.NextPageToken == "" {
			return all, nil
		}
		pageToken = wire.NextPageToken
	}

	return nil, fmt.Errorf("circleci: exceeded %d pages listing contexts", maxProjectMetadataPageCount)
}

// contextVariablesResponse is the JSON response body from
// GET /api/v2/context/{id}/environment-variable.
type contextVariablesResponse struct {
	Items []struct {
		Variable       string `json:"variable"`
		TruncatedValue string `json:"truncated_value"`
	} `json:"items"`
	NextPageToken string `json:"next_page_token"`
}

// ListContextVariables returns the variables held by one context: names,
// plus CircleCI's four-character truncated preview of each value.
//
// There is no call, on any API version, that returns the full values. See
// ContextVariable before adding one.
func (c *Client) ListContextVariables(ctx context.Context, contextID string) ([]ContextVariable, error) {
	if contextID == "" {
		return nil, fmt.Errorf("circleci: listing context variables requires a context ID")
	}

	basePath := fmt.Sprintf(contextVariablesPathFmt, url.PathEscape(contextID))

	var all []ContextVariable
	pageToken := ""

	for page := 0; page < maxProjectMetadataPageCount; page++ {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}

		path := basePath
		if pageToken != "" {
			path += "?" + url.Values{"page-token": []string{pageToken}}.Encode()
		}

		var wire contextVariablesResponse
		if doErr := c.do(ctx, http.MethodGet, path, nil, &wire); doErr != nil {
			return nil, doErr
		}

		for _, it := range wire.Items {
			all = append(all, ContextVariable{
				Name:           it.Variable,
				TruncatedValue: truncatePreview(it.TruncatedValue),
			})
		}

		if wire.NextPageToken == "" {
			return all, nil
		}
		pageToken = wire.NextPageToken
	}

	return nil, fmt.Errorf("circleci: exceeded %d pages listing context variables", maxProjectMetadataPageCount)
}

// truncatePreview defends the "preview, not value" invariant at the one
// place every preview passes through: however many characters the API
// chooses to send (four, today), no more than
// truncatedValuePreviewMaxRune ever leave this package. If CircleCI were to
// widen `truncated_value` — or return a full secret in it by mistake — this
// clamp means the editor still cannot become a way to read one.
func truncatePreview(s string) string {
	runes := []rune(s)
	if len(runes) <= truncatedValuePreviewMaxRune {
		return s
	}
	return string(runes[:truncatedValuePreviewMaxRune])
}

// contextRestrictionsResponse is the JSON response body from
// GET /api/v2/context/{id}/restrictions.
//
// The live response also carries `context_id` on every item and `project_id` on
// a project restriction; neither is decoded, and ContextRestriction's own doc
// comment says why. This endpoint returns no `next_page_token` — restrictions
// are not paginated.
type contextRestrictionsResponse struct {
	Items []struct {
		ID               string `json:"id"`
		Name             string `json:"name"`
		RestrictionType  string `json:"restriction_type"`
		RestrictionValue string `json:"restriction_value"`
	} `json:"items"`
}

// ListContextRestrictions returns the restrictions attached to one context.
// An empty result means the context is unrestricted — usable by every
// project in the organization.
//
// An *error* means nothing of the sort, and a caller must not let the two look
// alike: "there are no restrictions" and "we could not find out" differ by
// exactly the red pipeline this data exists to prevent. See
// host.fetchContextVariables, which turns a failure here into its own warning
// rather than an empty list.
func (c *Client) ListContextRestrictions(ctx context.Context, contextID string) ([]ContextRestriction, error) {
	if contextID == "" {
		return nil, fmt.Errorf("circleci: listing context restrictions requires a context ID")
	}

	var wire contextRestrictionsResponse
	path := fmt.Sprintf(contextRestrictionsPathFmt, url.PathEscape(contextID))
	if err := c.do(ctx, http.MethodGet, path, nil, &wire); err != nil {
		return nil, err
	}

	out := make([]ContextRestriction, 0, len(wire.Items))
	for _, it := range wire.Items {
		out = append(out, ContextRestriction{
			ID:    it.ID,
			Name:  it.Name,
			Type:  it.RestrictionType,
			Value: it.RestrictionValue,
		})
	}
	return out, nil
}

// projectVariablesResponse is the JSON response body from
// GET /api/v2/project/{slug}/envvar.
//
// The API also returns a "value" field holding a mask rather than the
// secret; it is deliberately not decoded here. See ProjectVariable.
type projectVariablesResponse struct {
	Items []struct {
		Name string `json:"name"`
	} `json:"items"`
	NextPageToken string `json:"next_page_token"`
}

// ListProjectVariables returns the names of the project's environment
// variables. Values are never returned — see ProjectVariable for why the
// API's masked `value` field is dropped rather than forwarded.
func (c *Client) ListProjectVariables(ctx context.Context, projectSlug string) ([]ProjectVariable, error) {
	if projectSlug == "" {
		return nil, fmt.Errorf("circleci: listing project variables requires a project slug")
	}

	basePath := fmt.Sprintf(projectVariablesPathFmt, escapeSlug(projectSlug))

	var all []ProjectVariable
	pageToken := ""

	for page := 0; page < maxProjectMetadataPageCount; page++ {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}

		path := basePath
		if pageToken != "" {
			path += "?" + url.Values{"page-token": []string{pageToken}}.Encode()
		}

		var wire projectVariablesResponse
		if doErr := c.do(ctx, http.MethodGet, path, nil, &wire); doErr != nil {
			return nil, doErr
		}

		for _, it := range wire.Items {
			all = append(all, ProjectVariable{Name: it.Name})
		}

		if wire.NextPageToken == "" {
			return all, nil
		}
		pageToken = wire.NextPageToken
	}

	return nil, fmt.Errorf("circleci: exceeded %d pages listing project variables", maxProjectMetadataPageCount)
}

// projectResponse is the JSON response body from
// GET /api/v2/project/{slug}.
type projectResponse struct {
	ID               string `json:"id"`
	Slug             string `json:"slug"`
	Name             string `json:"name"`
	OrganizationID   string `json:"organization_id"`
	OrganizationName string `json:"organization_name"`
	OrganizationSlug string `json:"organization_slug"`
	VCSInfo          struct {
		Provider      string `json:"provider"`
		DefaultBranch string `json:"default_branch"`
	} `json:"vcs_info"`
}

// GetProject returns the project record for projectSlug
// ("<vcs>/<org>/<repo>").
//
// v2 only. The v3 equivalent (`GET /api/v3/projects/{id}`) exists and is
// reachable with a personal API token, but returns only the project's name
// and org reference — it carries neither the default branch nor the
// organization ID this package needs, so it would be a strictly worse call
// to make.
func (c *Client) GetProject(ctx context.Context, projectSlug string) (*Project, error) {
	if projectSlug == "" {
		return nil, fmt.Errorf("circleci: fetching a project requires a project slug")
	}

	var wire projectResponse
	path := fmt.Sprintf(projectPathFmt, escapeSlug(projectSlug))
	if err := c.do(ctx, http.MethodGet, path, nil, &wire); err != nil {
		return nil, err
	}

	return &Project{
		ID:               wire.ID,
		Slug:             wire.Slug,
		Name:             wire.Name,
		OrganizationID:   wire.OrganizationID,
		OrganizationName: wire.OrganizationName,
		OrganizationSlug: wire.OrganizationSlug,
		VCSProvider:      wire.VCSInfo.Provider,
		DefaultBranch:    wire.VCSInfo.DefaultBranch,
	}, nil
}

// projectSettingsV3Response is the JSON response body from
// GET /api/v3/projects/{id}/settings, which follows the JSON:API-ish
// data/attributes envelope the rest of v3 uses.
type projectSettingsV3Response struct {
	Data struct {
		Attributes struct {
			EnableDynamicConfig     bool `json:"enable_dynamic_config"`
			EnableUnversionedConfig bool `json:"enable_unversioned_config"`
			IsOSS                   bool `json:"is_oss"`
			EnableBuildingForkPRs   bool `json:"enable_building_fork_prs"`
			CanPassSecretsToForkPRs bool `json:"can_pass_secrets_to_fork_pr_jobs"`
		} `json:"attributes"`
	} `json:"data"`
}

// GetProjectSettings returns the project's settings, keyed by project *ID*
// (not slug) — use GetProject first to resolve one.
//
// This is the one endpoint in this file with a usable v3 version, and v3 is
// the better call on the merits as well as by this project's general
// preference for v3 wherever the API surface allows it: it names
// `enable_dynamic_config` directly, whereas v2's
// `/api/v2/project/{vcs}/{org}/{repo}/settings` expresses the same fact as
// `advanced.setup_workflows` and has no equivalent of
// `enable_unversioned_config` at all.
func (c *Client) GetProjectSettings(ctx context.Context, projectID string) (*ProjectSettings, error) {
	if projectID == "" {
		return nil, fmt.Errorf("circleci: fetching project settings requires a project ID")
	}

	var wire projectSettingsV3Response
	path := fmt.Sprintf(projectSettingsV3PathFmt, url.PathEscape(projectID))
	if err := c.do(ctx, http.MethodGet, path, nil, &wire); err != nil {
		return nil, err
	}

	attrs := wire.Data.Attributes
	return &ProjectSettings{
		DynamicConfig:       attrs.EnableDynamicConfig,
		UnversionedConfig:   attrs.EnableUnversionedConfig,
		OSS:                 attrs.IsOSS,
		BuildForkPRs:        attrs.EnableBuildingForkPRs,
		PassSecretsToForkPR: attrs.CanPassSecretsToForkPRs,
	}, nil
}

// escapeSlug percent-escapes each segment of a "<vcs>/<org>/<repo>" project
// slug while leaving the separating slashes intact, since the API expects
// the slug to occupy three path segments rather than one escaped segment.
func escapeSlug(slug string) string {
	parts := strings.Split(slug, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return strings.Join(parts, "/")
}
