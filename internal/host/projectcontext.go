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

package host

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
)

const (
	// projectContextTimeout bounds a single GET /api/project-context call,
	// which makes up to four upstream requests (project, settings,
	// contexts, project variables), each of which the circleci client may
	// itself retry.
	projectContextTimeout = 25 * time.Second

	// contextVariablesTimeout bounds a single
	// GET /api/project-context/variables call (two upstream requests:
	// variables and restrictions).
	contextVariablesTimeout = 20 * time.Second

	// projectContextCacheTTL is how long a *fully successful* fetched
	// project-context summary or per-context variable listing is reused.
	// A response carrying warnings is not cached at all — see
	// handleProjectContext.
	//
	// Short on purpose. Unlike the orb registry, this data is small, cheap
	// to refetch, and — crucially — edited *elsewhere*: someone adds a
	// context in the CircleCI web UI and expects the editor to catch up
	// without a restart. The TTL exists only to stop the palette
	// re-requesting the same context every time the user clicks back and
	// forth in the master/detail view (the same rationale as
	// orbSourceCache), not to avoid the network.
	projectContextCacheTTL = 60 * time.Second
)

// Context usability values reported by contextVariablesResponse.Usability.
// This is deliberately a tri-state-plus rather than a boolean: whether a
// context is usable by *this* project is knowable for project restrictions
// and genuinely not knowable for group restrictions, and flattening "I
// cannot tell" into "no" would make the palette lie.
const (
	// usabilityUnrestricted means the context has no restrictions: every
	// project in the organization may use it.
	usabilityUnrestricted = "unrestricted"

	// usabilityAllowed means the context is project-restricted and this
	// project is among the allowed projects.
	usabilityAllowed = "allowed"

	// usabilityOtherProjects means the context is project-restricted and
	// this project is not among the allowed projects — adding it to this
	// config would fail at run time.
	usabilityOtherProjects = "other-projects-only"

	// usabilityUnknown means the context carries restrictions this host
	// cannot evaluate (an org group, whose membership is not visible here),
	// or that we could not determine this project's own ID to compare
	// against.
	usabilityUnknown = "unknown"
)

// projectPayload is the JSON shape of projectContextResponse.Project.
//
// Slug, OrganizationSlug and VCSProvider are CircleCI's own values, not this
// host's guesses, and that is the point of issue #182: the slug comes back in
// canonical short form (`gh/example-org/flaky-todo-list`) even when the request
// asked with the long one, so once this payload exists it -- not the injected
// environment -- decides what the project is called and how it is addressed.
type projectPayload struct {
	Name             string `json:"name"`
	Slug             string `json:"slug"`
	OrganizationName string `json:"organizationName"`
	OrganizationSlug string `json:"organizationSlug"`
	VCSProvider      string `json:"vcsProvider"`
	DefaultBranch    string `json:"defaultBranch"`

	// WebURL deep-links to this project's pipelines in the CircleCI web UI,
	// built from Slug above rather than from CIRCLE_VCS_TYPE (issue #182).
	//
	// Empty means this project has no name-addressed web page: its canonical
	// slug is `circleci/<org-id>/<project-id>`, which is what GitLab and GitHub
	// App projects get. A client must render the identity as plain text in that
	// case and must **not** fall back to metaResponse.ProjectWebURL -- that
	// value is derived from injected environment variables that can still name
	// a VCS type ("github") whose URL shape this project does not use, which is
	// exactly the wrong-path defect issue #182 reports. Absent is authoritative
	// here precisely because the project record is.
	WebURL string `json:"webUrl,omitempty"`

	// SettingsURL deep-links to this project's *settings* page in the CircleCI
	// web UI (issue #248) -- the other half of the link pair the owner asked
	// for: "links to the projects and maybe links to the settings, so people
	// can easily click them and go to the UI to edit things." Built the same
	// way and with the same emptiness contract as WebURL; see
	// Environment.ProjectSettingsWebURLForSlug.
	SettingsURL string `json:"settingsUrl,omitempty"`
}

// projectSettingsPayload is the JSON shape of
// projectContextResponse.Settings.
type projectSettingsPayload struct {
	DynamicConfig       bool `json:"dynamicConfig"`
	UnversionedConfig   bool `json:"unversionedConfig"`
	OSS                 bool `json:"oss"`
	BuildForkPRs        bool `json:"buildForkPrs"`
	PassSecretsToForkPR bool `json:"passSecretsToForkPrs"`
}

// contextSummaryPayload is the JSON shape of one entry in
// projectContextResponse.Contexts. Variables are deliberately not included:
// they are fetched per context, on demand, by
// GET /api/project-context/variables.
type contextSummaryPayload struct {
	ID   string `json:"id"`
	Name string `json:"name"`

	// WebURL deep-links to this context's own settings page in the CircleCI web
	// UI -- the page where a restriction is actually changed, which is the link
	// issue #251 asks for. Built here rather than on the per-context detail
	// response because this is where CircleCI's own organization slug is: the
	// detail endpoint deliberately does not fetch the project record,
	// and inferring the organization there when the record is one response away
	// is the order-dependence effectiveProjectID's doc comment argues against.
	//
	// Empty means no link can be built (no organization slug resolved, or a
	// non-public API host whose web UI this code cannot address). A client must
	// render the context's name as plain text then -- see Environment.ContextWebURL.
	WebURL string `json:"webUrl,omitempty"`
}

// projectVariablePayload is the JSON shape of one entry in
// projectContextResponse.ProjectVariables. Name-only, by design — see
// circleci.ProjectVariable.
type projectVariablePayload struct {
	Name string `json:"name"`
}

// Warning kinds reported by warningPayload.Kind: which of the parts this
// endpoint aggregates failed. A client keys presentation off these rather
// than off matching on prose — the inspector's context combobox (issue #152)
// must know specifically that *the context list* is incomplete before it
// dares call a typed name unrecognised, and the top bar (issue #149) must
// know specifically that *the project lookup* failed before it says so.
const (
	warningKindProject          = "project"
	warningKindSettings         = "settings"
	warningKindOrganization     = "organization"
	warningKindContexts         = "contexts"
	warningKindProjectVariables = "projectVariables"
	warningKindContextVariables = "contextVariables"
	warningKindRestrictions     = "restrictions"

	// warningKindProjectBinding reports that `.circleci/info.yml` exists and
	// could not be used (issue #198). Its own kind rather than folded into
	// warningKindProject because it is not an upstream failure at all: nothing
	// was asked of CircleCI, the *local* file that decides what to ask is
	// broken, and the fix is in the repository rather than in a token or a
	// network.
	warningKindProjectBinding = "projectBinding"
)

// warningPayload is one partial failure: which part failed, what happened,
// and what the user consequently cannot see.
//
// Structured rather than a bare sentence (which is what issue #105 shipped)
// for the reason issue #150 gives: the owner saw "could not load project
// details, this API request did not succeed" *along* a full list of contexts
// and had no way to tell whether the warning mattered. A flat string cannot
// carry that — Consequences is the field that answers "so what am I missing",
// and Kind is what lets the UI show a degraded-but-working state differently
// from a broken one.
//
// Detail may name an HTTP status code and the slug that was tried. It must
// never carry an upstream response *body*: a contexts or environment-variable
// endpoint can quote secret metadata back at us. See describeUpstreamError.
type warningPayload struct {
	// Kind is one of the warningKind* constants.
	Kind string `json:"kind"`

	// Headline is one short sentence naming what could not be loaded.
	Headline string `json:"headline"`

	// Detail is the diagnosis: the classified reason, with a status code
	// and (for the project lookup) the slug that was tried.
	Detail string `json:"detail,omitempty"`

	// Consequences lists, in plain terms, what is missing from the editor
	// as a result. Empty is allowed but discouraged: a warning a user
	// cannot act on and cannot size up is the defect issue #150 reports.
	Consequences []string `json:"consequences,omitempty"`

	// Suggestions lists what to do about it, when there is anything to
	// suggest. Distinct from Consequences on purpose: one says what you are
	// missing, the other says how to stop missing it, and issue #150's report
	// was of a message that answered neither.
	//
	// Used today only where issue #198 requires it -- a project CircleCI does
	// not recognise -- and populated with the CircleCI CLI's own words rather
	// than this host's. See projectBindingSuggestions.
	Suggestions []string `json:"suggestions,omitempty"`
}

// projectContextResponse is the JSON shape returned by
// GET /api/project-context.
//
// Available follows the same convention as validateResponse.Available and
// orbsSearchResponse.Available: false means "this host cannot answer the
// question at all" (no token, or not run inside a CircleCI-connected
// project), with Reason explaining why, and must never be rendered as "this
// project has no contexts".
//
// Warnings is the partial-failure channel, and is the reason this endpoint
// returns one aggregate rather than four. Listing contexts requires
// organization-level permission that listing project variables does not, so
// a perfectly ordinary token can succeed at some parts and be refused
// others. Each part that failed contributes one human-readable sentence
// here while the rest of the response is still served, rather than the whole
// section collapsing to an error.
type projectContextResponse struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`

	// ProjectSlug is the slug this response is about: CircleCI's canonical one
	// when the project lookup succeeded, and otherwise the normalised slug the
	// lookup was attempted with (issue #182). Either way it is the spelling
	// CircleCI itself would use, so a message naming it -- the palette's
	// "no CircleCI project matches ..." above all -- names the project the way
	// the platform does.
	ProjectSlug string `json:"projectSlug,omitempty"`

	Project  *projectPayload         `json:"project,omitempty"`
	Settings *projectSettingsPayload `json:"settings,omitempty"`

	// Contexts and ProjectVariables are never omitempty: a client indexes
	// them directly, and an absent key is harder to handle than an empty
	// list. An empty list here means "none exist", which is only
	// meaningful because Available is true and no Warning covers it.
	Contexts         []contextSummaryPayload  `json:"contexts"`
	ProjectVariables []projectVariablePayload `json:"projectVariables"`

	Warnings []warningPayload `json:"warnings,omitempty"`
}

// contextVariablePayload is the JSON shape of one entry in
// contextVariablesResponse.Variables.
//
// TruncatedValue is CircleCI's own four-character preview, and is the
// absolute maximum the platform discloses — full context values are not
// retrievable through any API, on purpose. It is named "truncatedValue"
// rather than "value" so that no client can accidentally present it as one.
// Empty means the API returned no preview, which a client must render as
// "no preview" rather than as an empty secret.
type contextVariablePayload struct {
	Name           string `json:"name"`
	TruncatedValue string `json:"truncatedValue"`
}

// Restriction kinds reported by contextRestrictionPayload.Kind. A normalised
// form of circleci.RestrictionType*, plus restrictionKindOther for a type this
// host has never seen — which is a thing to *name*, not to drop.
const (
	restrictionKindProject    = "project"
	restrictionKindGroup      = "group"
	restrictionKindExpression = "expression"
	restrictionKindOther      = "other"
)

// contextRestrictionPayload is one restriction, described rather than
// identified: what kind of thing limits this context, and — where CircleCI told
// us — which one.
//
// ## Why no UUID crosses this boundary
//
// Issue #251's rule is that a restriction which cannot be resolved to a name
// must "say what it is rather than showing an opaque ID", and the cleanest way
// to hold a UI to that is to give it no ID to show. A project or group UUID is
// not secret and not sensitive; it is simply useless to the person reading it,
// and offering it guarantees some future call site renders it as though it were
// an answer. What a config author needs is the project's name, or failing that
// the honest sentence that a name was not available.
//
// The exception proves the rule: an expression restriction's *value* is the
// expression, which is prose about pipeline values and the single most
// informative thing in the whole record. It is carried in full.
type contextRestrictionPayload struct {
	// Kind is one of the restrictionKind* constants.
	Kind string `json:"kind"`

	// Name is CircleCI's own name for the restricted project or group. Empty
	// when the API returned none — which happens for real (see
	// circleci.ContextRestriction), and which a client must render as "a
	// project this editor cannot name" rather than as no restriction at all.
	Name string `json:"name,omitempty"`

	// Expression is the rule, for Kind == restrictionKindExpression: CircleCI's
	// own expression text, e.g. `not (pipeline.config_source starts-with "api")`.
	Expression string `json:"expression,omitempty"`

	// ThisProject marks the one project restriction that names *this* project.
	// Only ever true when the host had an ID to compare against and it matched,
	// so it is a positive assertion and never a guess.
	ThisProject bool `json:"thisProject,omitempty"`

	// RawType is CircleCI's own `restriction_type` when Kind is
	// restrictionKindOther, so a UI can say "a 'foo' restriction" instead of
	// "something". Empty for every recognised kind.
	RawType string `json:"rawType,omitempty"`
}

// contextVariablesResponse is the JSON shape returned by
// GET /api/project-context/variables?contextId=...
type contextVariablesResponse struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`

	ContextID string                   `json:"contextId,omitempty"`
	Variables []contextVariablePayload `json:"variables"`

	// Usability is one of the usability* constants, reporting whether this
	// project may actually use this context.
	Usability string `json:"usability,omitempty"`

	// RestrictionSummary is a short human-readable description of the
	// restrictions behind Usability (e.g. "restricted to 1 group"), or
	// empty when there are none.
	RestrictionSummary string `json:"restrictionSummary,omitempty"`

	// Restrictions describes each restriction individually: the detail behind
	// Usability that issue #251 reports missing. Never omitempty and never nil
	// — an empty array means "the restrictions call succeeded and returned
	// none", which is exactly the statement a client may render as
	// "unrestricted". The absent-key case is the failure case, and it arrives
	// as a warningKindRestrictions warning instead. Those two must not look
	// alike, which is the whole reason this field is not `omitempty`.
	Restrictions []contextRestrictionPayload `json:"restrictions"`

	// ProjectIdentified reports whether this host had a project ID to compare
	// against the project restrictions at all (see effectiveProjectID).
	//
	// Its own field because `unknown` has three causes that must not read
	// identically: restrictions this host cannot evaluate (a group), a
	// restrictions call that failed, and *this* one — restrictions that could
	// have been evaluated against a project we could not identify. Only the last
	// is a question about our own footing rather than about the context, and a
	// user who is told "we could not work out which project this is" can act on
	// it; one told "restricted somehow" cannot.
	ProjectIdentified bool `json:"projectIdentified"`

	Warnings []warningPayload `json:"warnings,omitempty"`
}

// projectContextUnavailable returns the response describing why this host
// cannot serve project metadata, or nil when it can.
//
// The reasons are the halves of the project-wide degrade-honestly invariant: no
// token (the editor was started outside `circleci`, or the CLI had no token to
// inject) and no project slug (the editor is being used on a config that is not
// part of a CircleCI-connected project — a perfectly normal thing to do, and the
// rest of the app works fine).
//
// Issue #198 split the second of those in two. "No source names a project" and
// "a source names a project and this host could not read it" are different
// situations with different fixes, and the constraint is explicit that they must
// not render identically — so a malformed `.circleci/info.yml` gets its own
// Reason, naming the file and the problem, rather than borrowing the calm "this
// is not a CircleCI project" sentence that would be a lie.
func (s *Server) projectContextUnavailable(identity ProjectIdentity) *projectContextResponse {
	if !s.env.HasToken() {
		return &projectContextResponse{
			Available: false,
			Reason: "No CircleCI API token is available, so this host cannot look up " +
				"contexts, environment variable names or project settings. " +
				"Run the editor through the CircleCI CLI (which injects a token) " +
				"to see them.",
			Contexts:         []contextSummaryPayload{},
			ProjectVariables: []projectVariablePayload{},
		}
	}

	if identity.Slug == "" {
		if identity.Binding.Status == ProjectBindingMalformed {
			return &projectContextResponse{
				Available: false,
				Reason: "This checkout records which CircleCI project it belongs to in " +
					identity.Binding.Path + ", and this host could not use that file: " +
					identity.Binding.Problem +
					" Nothing else named a project either, so there is none to look up. " +
					"This is not the same as not being a CircleCI project — everything " +
					"else in the editor works as normal in the meantime.",
				Contexts:         []contextSummaryPayload{},
				ProjectVariables: []projectVariablePayload{},
			}
		}
		return &projectContextResponse{
			Available: false,
			Reason: "This config is not associated with a CircleCI project, so there " +
				"is no project whose contexts, environment variables or settings " +
				"could be listed. Everything else in the editor works as normal.",
			Contexts:         []contextSummaryPayload{},
			ProjectVariables: []projectVariablePayload{},
		}
	}

	return nil
}

// handleProjectContext serves GET /api/project-context: the read-only
// project authoring metadata behind issue #105 — which contexts exist, what
// the project's environment variables are called, and the handful of project
// settings that change how a config behaves.
//
// It is strictly read-only. There is deliberately no write path here: this
// host's scope stops at authoring, verifying and launching configs, and
// project context is surfaced as read-only metadata, never something this
// editor mutates.
func (s *Server) handleProjectContext(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	identity := s.projectIdentity()

	if unavailable := s.projectContextUnavailable(identity); unavailable != nil {
		writeJSON(w, http.StatusOK, *unavailable)
		return
	}

	slug := identity.Slug

	// ?refresh=1 drops both caches, because the palette's single refresh
	// button means "re-read everything": a context added in the web UI
	// changes the list, and a variable added to one changes its detail.
	if r.URL.Query().Get("refresh") == "1" {
		s.projectContextCache.invalidate()
		s.contextVariablesCache.invalidate()
	} else if cached, ok := s.projectContextCache.get(slug); ok {
		writeJSON(w, http.StatusOK, cached)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), projectContextTimeout)
	defer cancel()

	resp := s.fetchProjectContext(ctx, identity)
	// Only a fully successful fetch is cached, exactly as the sibling
	// variables handler already does (issue #150): caching a response that
	// carries warnings made a transient network blip stick for the full
	// minute of projectContextCacheTTL, so the section stayed broken for a
	// user who had already fixed the problem. Refetching costs little —
	// the store behind the palette and the top bar loads once per session
	// and shares that one load between them, so "don't cache failures" is
	// at worst one extra round of requests per reload, not per render.
	if len(resp.Warnings) == 0 {
		s.projectContextCache.set(slug, resp)
	}
	writeJSON(w, http.StatusOK, resp)
}

// fetchProjectContext performs the upstream calls behind
// GET /api/project-context.
//
// Every upstream failure is degraded into a Warning rather than an error
// response: a token that can read the project but not the org's contexts is
// an ordinary situation, and the parts that did work are still worth
// showing. Note that upstream error *bodies* are never forwarded or logged
// — describeUpstreamError classifies them, because an APIError from a
// contexts endpoint can quote secret metadata back at us. The status code
// is not a body, and is both shown and logged (issue #150).
//
// It takes the whole resolved identity rather than a slug because issue #198's
// item 2 is about the fields *beside* the slug: `.circleci/info.yml` records the
// organization and project IDs, an ID survives a repository rename that a slug
// does not, and two of the calls below want an ID anyway. Each place that prefers
// one says so at the point it does.
func (s *Server) fetchProjectContext(ctx context.Context, identity ProjectIdentity) projectContextResponse {
	slug := identity.Slug
	resp := projectContextResponse{
		Available:        true,
		ProjectSlug:      slug,
		Contexts:         []contextSummaryPayload{},
		ProjectVariables: []projectVariablePayload{},
	}

	client := s.projectClient
	if client == nil {
		return projectContextResponse{
			Available:        false,
			Reason:           "This host has no CircleCI API client configured for project metadata.",
			Contexts:         []contextSummaryPayload{},
			ProjectVariables: []projectVariablePayload{},
		}
	}

	// A binding that exists and could not be read, reported before anything is
	// asked of CircleCI. Reaching here at all means some *other* source named a
	// project, so this is a working-but-degraded state rather than the
	// unavailable one projectContextUnavailable already covers -- and it must
	// not be silent, because the identity below is then a guess standing in for
	// the user's own recorded answer.
	if identity.Binding.Status == ProjectBindingMalformed {
		resp.Warnings = append(resp.Warnings, projectBindingWarning(identity))
	}

	// The project record first: it yields the default branch, the
	// organization/project IDs the remaining calls key off, and -- since issue
	// #182 -- the canonical slug every later call, message and link should use
	// in place of the one this host assembled from environment variables.
	project, projectErr := client.GetProject(ctx, slug)
	if projectErr != nil {
		logUpstreamFailure("look up project "+slug, projectErr)
		resp.Warnings = append(resp.Warnings, projectLookupWarning(projectErr, slug, identity))
	} else {
		resp.Project = &projectPayload{
			Name:             project.Name,
			Slug:             project.Slug,
			OrganizationName: project.OrganizationName,
			OrganizationSlug: project.OrganizationSlug,
			VCSProvider:      project.VCSProvider,
			DefaultBranch:    project.DefaultBranch,
			WebURL:           s.env.ProjectWebURLForSlug(canonicalSlug(project, slug)),
			SettingsURL:      s.env.ProjectSettingsWebURLForSlug(canonicalSlug(project, slug)),
		}
	}

	// From here on, CircleCI's own spelling of the slug wins. Nothing about the
	// requested slug was wrong -- the API accepts either spelling -- but the
	// canonical one is what the platform calls this project, so it is what the
	// remaining request, the response and any log line should say.
	slug = canonicalSlug(project, slug)
	resp.ProjectSlug = slug

	// Settings are keyed by project *ID*, which is why issue #198's item 2 lands
	// here first: `GET /api/v3/projects/{id}/settings` wants an ID, and an ID
	// survives the repository rename that made the slug 404 in the first place.
	// So a recorded ID from `.circleci/info.yml` is not merely an optimisation --
	// it is what makes this section answerable at all in the case the whole
	// feature exists for, where the project lookup above returned nothing.
	//
	// Verified against the live API: this call answers 200 for a bare project
	// UUID with no slug involved anywhere.
	if settingsProjectID := settingsProjectID(project, identity); settingsProjectID != "" {
		if settings, settingsErr := client.GetProjectSettings(ctx, settingsProjectID); settingsErr != nil {
			logUpstreamFailure("read settings for project "+slug, settingsErr)
			resp.Warnings = append(resp.Warnings, warningPayload{
				Kind:     warningKindSettings,
				Headline: "This project's settings could not be read.",
				Detail:   capitalizeFirst(describeUpstreamError(settingsErr)) + ".",
				Consequences: []string{
					"Whether dynamic config is enabled, and whether fork pull requests receive secrets, are not shown.",
				},
			})
		} else {
			resp.Settings = &projectSettingsPayload{
				DynamicConfig:       settings.DynamicConfig,
				UnversionedConfig:   settings.UnversionedConfig,
				OSS:                 settings.OSS,
				BuildForkPRs:        settings.BuildForkPRs,
				PassSecretsToForkPR: settings.PassSecretsToForkPR,
			}
		}
	}

	// Contexts are organization-scoped. Prefer the organization ID from the
	// project record (unambiguous); then the ID `.circleci/info.yml` recorded,
	// which is the same kind of key and equally rename-proof (issue #198); then
	// the record's own canonical organization slug; and only then a
	// "<vcs>/<org>" slug, so a permissions gap on one call does not take out the
	// other. The record-over-inference steps are issue #182's rule again: when
	// CircleCI has told us what it calls this organization, that beats what we
	// inferred.
	//
	// Every ID beats every slug here, which is a deliberate reordering: the ID
	// identifies the organization even if it has been renamed, and a renamed
	// organization is the same failure as a renamed repository one level up.
	owner := circleci.ContextOwner{}
	if project != nil {
		owner.ID = project.OrganizationID
	}
	if owner.ID == "" {
		owner.ID = identity.OrganizationID
	}
	if owner.ID == "" && project != nil {
		owner.Slug = project.OrganizationSlug
	}
	if owner.ID == "" && owner.Slug == "" {
		// The identity's own slug, so the organization cannot come from a
		// different source than the project did; it falls back to the injected
		// environment's when the identity has no name-addressed one to give.
		owner.Slug = identity.OrgSlug()
	}
	if owner.ID == "" && owner.Slug == "" {
		owner.Slug = s.env.OrgSlug()
	}

	if owner.ID == "" && owner.Slug == "" {
		resp.Warnings = append(resp.Warnings, warningPayload{
			Kind:     warningKindOrganization,
			Headline: "Which organization owns this project could not be determined.",
			Detail: "The project lookup did not return an organization, and the CircleCI CLI " +
				"injected no organization name for this checkout either.",
			Consequences: []string{contextListMissingConsequence},
		})
	} else if contexts, ctxErr := client.ListContexts(ctx, owner); ctxErr != nil {
		logUpstreamFailure("list contexts for organization "+ownerLabel(owner), ctxErr)
		resp.Warnings = append(resp.Warnings, warningPayload{
			Kind:         warningKindContexts,
			Headline:     "This organization's contexts could not be listed.",
			Detail:       capitalizeFirst(describeUpstreamError(ctxErr)) + ".",
			Consequences: []string{contextListMissingConsequence},
		})
	} else {
		// One slug for every context in the list, resolved once: they all belong
		// to the same organization, and the link is per *context* only in its
		// last path segment.
		orgWebSlug := organizationWebSlug(project, identity, s.env)
		for _, c := range contexts {
			resp.Contexts = append(resp.Contexts, contextSummaryPayload{
				ID:     c.ID,
				Name:   c.Name,
				WebURL: s.env.ContextWebURL(orgWebSlug, c.ID),
			})
		}
	}

	if vars, varsErr := client.ListProjectVariables(ctx, slug); varsErr != nil {
		logUpstreamFailure("list environment variables for project "+slug, varsErr)
		resp.Warnings = append(resp.Warnings, warningPayload{
			Kind:     warningKindProjectVariables,
			Headline: "This project's environment variable names could not be listed.",
			Detail:   capitalizeFirst(describeUpstreamError(varsErr)) + ".",
			Consequences: []string{
				"The Project section lists no environment variables, and their names do not " +
					"complete as $NAME while you type a run command.",
			},
		})
	} else {
		for _, v := range vars {
			resp.ProjectVariables = append(resp.ProjectVariables, projectVariablePayload{Name: v.Name})
		}
	}

	return resp
}

// organizationWebSlug returns the `<vcs>/<org>` slug to address the CircleCI web
// UI's organization pages with — today, one context's settings page (issue #251).
//
// It is deliberately *the same precedence the contexts call above already uses*,
// with the ID steps dropped because a URL needs a slug: CircleCI's own record
// first (when the platform has told us what it calls this organization, that
// beats what we inferred), then the resolved identity's own slug, then the
// injected environment's. Not a new rule, and not a new order; the same one
// spelled for a different shape of answer.
//
// Note what is *not* here: no equivalent of effectiveProjectID's same-source
// invariant, and none is needed. That invariant exists because a project ID from
// one source compared against a slug from another inverts a security answer. A
// link is not an answer — a wrong organization here produces a page about the
// wrong organization, which the user can see is wrong, rather than a quiet
// "allowed" for a context that is not.
func organizationWebSlug(project *circleci.Project, identity ProjectIdentity, env Environment) string {
	if project != nil && project.OrganizationSlug != "" {
		return project.OrganizationSlug
	}
	if slug := identity.OrgSlug(); slug != "" {
		return slug
	}
	return env.OrgSlug()
}

// canonicalSlug returns the project slug CircleCI itself reports, falling back
// to requested when there is no project record (or it carried no slug).
//
// The fallback is not a consolation prize: a 404 is exactly the case with no
// record, and also the case with the most to say (issue #150) -- naming the slug
// that was tried is the whole of what makes that message actionable, and after
// issue #182 it is named in the same spelling CircleCI would use.
//
// What this function must never do is *substitute* a different project. No fuzzy
// matching, no near-miss resolution: the reported checkout's remote was
// `example-org/flakey-todo-list` while the CircleCI project is
// `flaky-todo-list`, and those are different names -- the 404 was correct.
// Quietly resolving one to the other would turn a true, clear message into a
// config that points somewhere its author never named, which is far worse than a
// 404. Issue #172 tracks *suggesting* a near miss, which is the honest form of
// that idea.
func canonicalSlug(project *circleci.Project, requested string) string {
	if project != nil && project.Slug != "" {
		return project.Slug
	}
	return requested
}

// handleProjectContextVariables serves
// GET /api/project-context/variables?contextId=...: the variable names and
// truncated previews held by one context, plus whether this project may
// actually use it.
//
// Split from handleProjectContext deliberately, on the same master/detail
// reasoning as the orb browser: listing the org's contexts is one
// request, whereas fetching every context's variables up front would be one
// request per context for data the user has not asked to see. It also means
// secret *metadata* is only ever fetched for a context the user explicitly
// opened.
func (s *Server) handleProjectContextVariables(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	identity := s.projectIdentity()

	if unavailable := s.projectContextUnavailable(identity); unavailable != nil {
		writeJSON(w, http.StatusOK, contextVariablesResponse{
			Available: false,
			Reason:    unavailable.Reason,
			Variables: []contextVariablePayload{},
		})
		return
	}

	contextID := r.URL.Query().Get("contextId")
	if contextID == "" {
		writeError(w, http.StatusBadRequest, "missing required query parameter: contextId")
		return
	}

	if cached, ok := s.contextVariablesCache.get(contextID); ok {
		writeJSON(w, http.StatusOK, cached)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), contextVariablesTimeout)
	defer cancel()

	resp := s.fetchContextVariables(ctx, contextID, identity)
	// Only a successful fetch is worth caching; caching a failure would
	// make a transient permissions or network blip stick for a minute.
	if len(resp.Warnings) == 0 {
		s.contextVariablesCache.set(contextID, resp)
	}
	writeJSON(w, http.StatusOK, resp)
}

// fetchContextVariables performs the upstream calls behind
// GET /api/project-context/variables.
//
// The identity is needed for one thing only: classifyUsability compares this
// project's ID against a context's project restrictions, and without an ID the
// answer is "unknown" rather than "allowed" or "other projects only". Issue #198
// makes that answerable in a case it previously was not -- an editor launched
// outside the CLI has no CIRCLE_PROJECT_ID at all, while a linked checkout has the
// same ID recorded on disk.
func (s *Server) fetchContextVariables(ctx context.Context, contextID string, identity ProjectIdentity) contextVariablesResponse {
	resp := contextVariablesResponse{
		Available: true,
		ContextID: contextID,
		Variables: []contextVariablePayload{},
		Usability: usabilityUnknown,
		// Nil until the restrictions call answers. It stays nil on failure, so
		// the JSON carries `"restrictions": null` beside the warning rather than
		// an empty array that would read as "there are none" -- the distinction
		// issue #251 makes a hard requirement.
		Restrictions: nil,
	}

	client := s.projectClient
	if client == nil {
		return contextVariablesResponse{
			Available: false,
			Reason:    "This host has no CircleCI API client configured for project metadata.",
			Variables: []contextVariablePayload{},
		}
	}

	if vars, varsErr := client.ListContextVariables(ctx, contextID); varsErr != nil {
		// The context *ID* is an opaque identifier the browser already
		// holds, not secret metadata; the context's *name* deliberately
		// never reaches the log.
		logUpstreamFailure("list variables for context "+contextID, varsErr)
		resp.Warnings = append(resp.Warnings, warningPayload{
			Kind:     warningKindContextVariables,
			Headline: "This context's variables could not be listed.",
			Detail:   capitalizeFirst(describeUpstreamError(varsErr)) + ".",
			Consequences: []string{
				"The variable names this context holds, and CircleCI's previews of them, are not shown.",
			},
		})
	} else {
		for _, v := range vars {
			resp.Variables = append(resp.Variables, contextVariablePayload{
				Name:           v.Name,
				TruncatedValue: v.TruncatedValue,
			})
		}
	}

	projectID := s.effectiveProjectID(identity)
	resp.ProjectIdentified = projectID != ""

	restrictions, restrErr := client.ListContextRestrictions(ctx, contextID)
	if restrErr != nil {
		logUpstreamFailure("list restrictions for context "+contextID, restrErr)
		resp.Warnings = append(resp.Warnings, warningPayload{
			Kind:     warningKindRestrictions,
			Headline: "Whether this context is restricted could not be checked.",
			Detail:   capitalizeFirst(describeUpstreamError(restrErr)) + ".",
			Consequences: []string{
				"Whether this project is allowed to use this context is unknown — adding it may " +
					"compile fine and then fail when the job runs.",
				"This is not the same as the context being unrestricted: nothing here was checked.",
			},
		})
		return resp
	}

	assessment := assessRestrictions(restrictions, projectID)
	resp.Usability = assessment.usability
	resp.RestrictionSummary = assessment.summary
	resp.Restrictions = assessment.details
	return resp
}

// effectiveProjectID is the ID of the project *this identity names*, for
// comparing against a context's project restrictions.
//
// ## The invariant: the ID and the slug must come from the same source
//
// This is not a "best available ID" lookup, and treating it as one is a real
// defect rather than an imprecision. classifyUsability compares this value
// against a context's `restriction_value`s, so an ID belonging to a *different*
// project than the slug does not degrade the answer — it inverts it. A context
// restricted to project A, checked with project B's ID, reports
// "other-projects-only" for a project that is in fact allowed; the mirror case
// reports "allowed" for one that is not, and the editor then compiles a config
// that fails when the job runs. That is precisely the failure the usability
// model exists to prevent, and it would be silent.
//
// So an ID that cannot be shown to describe the same project as the slug is
// discarded, and classifyUsability says `unknown`. **`unknown` is an honest
// answer and a wrong `allowed` is not** — the whole reason that constant is a
// tri-state-plus rather than a boolean.
//
// The order, and what each step is for:
//
//  1. **The recorded ID, when the binding won the slug.** Same source, so the
//     two cannot describe different projects. This is the step that fixes the
//     `--config`-into-another-checkout case: the slug comes from that checkout's
//     `info.yml` while CIRCLE_PROJECT_ID describes the checkout the CLI was
//     started in, and preferring the environment there compared one project's ID
//     against another project's restrictions.
//  2. **Nothing, when the binding won and the environment disagrees.** Reached
//     only when the binding recorded no usable ID (`circleci project link`
//     populates the IDs only when it verified the slug against the API), and
//     CIRCLE_PROJECT_ID is then known to be about the other project — that is
//     exactly what Disagrees reports. Give up rather than guess.
//  3. **CIRCLE_PROJECT_ID, when nothing disagrees.** Either there is no binding
//     at all, or the binding and the environment name the same project — in
//     which case the CLI resolved this value from that same slug
//     (`internal/extension/manifest.go` reads `projectref` first and falls back
//     to an API lookup keyed by the slug), so it is the same project's ID or a
//     better-sourced one.
//
// Every candidate is UUID-guarded, on evidence rather than caution: a project
// restriction's `restriction_value` is a project UUID — verified against the live
// API across every restricted context in a real organization — so an ID in the
// other shape the CLI warns about (`gitremote.ProjectInfo`: "a UUID, or a compact
// base62 ID") can never match one. Passing it anyway would not produce
// `unknown`; it would produce a confident `other-projects-only`.
//
// ## Why not the fetched record's ID, which would be ground truth
//
// It would be ground truth, and it is not available here. GET
// /api/project-context/variables deliberately does not fetch the project record
// — the master/detail split is the reason opening one context costs one or
// two requests rather than three — so using it would mean either an extra
// project lookup per context opened, or caching the record's ID as a side effect
// of the sibling endpoint. The second is the worse of the two: this endpoint's
// answer would then depend on whether /api/project-context ran recently and
// whether its 60-second TTL had lapsed, so the same context would report
// `allowed` or `unknown` depending on request order. A deterministic rule that is
// occasionally silent beats an order-dependent one that is occasionally wrong.
// See settingsProjectID for the sibling that *does* have the record, and does
// prefer it.
func (s *Server) effectiveProjectID(identity ProjectIdentity) string {
	if identity.Source == ProjectIdentityFromBinding && looksLikeUUID(identity.ProjectID) {
		return identity.ProjectID
	}
	if identity.Disagrees() {
		return ""
	}
	if looksLikeUUID(s.env.ProjectID) {
		return s.env.ProjectID
	}
	return ""
}

// settingsProjectID picks the project ID to read settings with: CircleCI's own
// record when the lookup succeeded, and otherwise the one `circleci project link`
// recorded.
//
// The recorded ID is only used when it has the shape of a UUID, and that guard is
// not decoration -- see looksLikeUUID for the observed HTTP 400 it avoids and the
// CLI's own warning that a recorded ID need not be a UUID.
//
// Note the *order*: the record wins when it exists, on the rule that CircleCI's
// own answer supersedes anything this host inferred or read locally.
// The recorded ID's job is to cover the case where there is no record, which is
// exactly the renamed-repository case issue #198 reports.
//
// CIRCLE_PROJECT_ID is deliberately never consulted here, and the asymmetry with
// effectiveProjectID above is the point rather than an oversight: this function
// runs where the record exists or the slug is known to have failed, so the
// environment could only ever contribute an ID from a different anchor. Both
// functions obey the same rule — the ID must describe the project the slug names
// — they just have different sources to obey it with.
func settingsProjectID(project *circleci.Project, identity ProjectIdentity) string {
	if project != nil && project.ID != "" {
		return project.ID
	}
	if looksLikeUUID(identity.ProjectID) {
		return identity.ProjectID
	}
	return ""
}

// restrictionAssessment is everything this host can say about one context's
// restrictions: the four-state answer, a one-line summary of it, and the
// per-restriction detail behind both.
type restrictionAssessment struct {
	usability string
	summary   string
	// details is non-nil whenever the restrictions call succeeded, including
	// when it returned nothing. See contextVariablesResponse.Restrictions.
	details []contextRestrictionPayload
}

// assessRestrictions decides whether a context carrying restrictions can be used
// by the project identified by projectID, and describes each restriction.
//
// The four-state answer is unchanged — this function is what issue
// #105 shipped as classifyUsability, plus the *detail* issue #251 reports
// missing. The states, and why each is what it is:
//   - No restrictions at all: unrestricted, usable by the whole org.
//   - A project restriction naming this project: allowed.
//   - Project restrictions, none naming this project: other-projects-only.
//     This is the case worth surfacing loudly, because adding such a
//     context to this config compiles fine and then fails at run time. It is
//     also *certain*: a project restriction's value is always a project UUID,
//     so "none of them is us" is a fact and not an inference.
//   - Group restrictions only: unknown. Group membership is not visible to
//     this host, so we say so instead of guessing.
//   - Expression restrictions only: unknown as well. The expression is legible
//     (and returned verbatim below) but evaluating it needs the pipeline that
//     does not exist yet — `pipeline.git.branch`, `job.ssh.enabled`,
//     `pipeline.config_source` are all run-time facts.
//   - projectID empty: unknown, because there is nothing to compare against.
//
// What changed beyond the detail: an expression restriction is now *counted and
// described as an expression*. The original version folded every non-project
// type into the group tally, which reached the right four-state answer by the
// right reasoning and then told the user "restricted to 1 group" about a branch
// rule. That is the sort of small confident wrongness that costs trust in the
// states that matter.
func assessRestrictions(restrictions []circleci.ContextRestriction, projectID string) restrictionAssessment {
	details := make([]contextRestrictionPayload, 0, len(restrictions))
	if len(restrictions) == 0 {
		return restrictionAssessment{usability: usabilityUnrestricted, details: details}
	}

	projectCount, groupCount, expressionCount, otherCount := 0, 0, 0, 0
	matchesThisProject := false

	for _, r := range restrictions {
		switch r.Type {
		case circleci.RestrictionTypeProject:
			projectCount++
			thisProject := projectID != "" && r.Value == projectID
			if thisProject {
				matchesThisProject = true
			}
			details = append(details, contextRestrictionPayload{
				Kind:        restrictionKindProject,
				Name:        r.Name,
				ThisProject: thisProject,
			})
		case circleci.RestrictionTypeGroup:
			groupCount++
			details = append(details, contextRestrictionPayload{
				Kind: restrictionKindGroup,
				Name: r.Name,
			})
		case circleci.RestrictionTypeExpression:
			expressionCount++
			details = append(details, contextRestrictionPayload{
				Kind: restrictionKindExpression,
				// The expression, verbatim: it is the only self-describing thing
				// in a restriction record, and paraphrasing a rule someone wrote
				// to protect a secret would be worse than useless.
				Expression: r.Value,
			})
		default:
			// An unrecognised restriction type is a reason to say "unknown", not
			// to ignore the restriction -- and its raw type is worth carrying so
			// the UI can name it rather than gesture at it. `expression` was
			// itself exactly this case until it was observed in the wild.
			otherCount++
			details = append(details, contextRestrictionPayload{
				Kind:    restrictionKindOther,
				Name:    r.Name,
				RawType: r.Type,
			})
		}
	}

	summary := describeRestrictions(projectCount, groupCount, expressionCount, otherCount)

	switch {
	case matchesThisProject:
		return restrictionAssessment{usability: usabilityAllowed, summary: summary, details: details}
	case projectCount > 0 && projectID != "":
		return restrictionAssessment{usability: usabilityOtherProjects, summary: summary, details: details}
	default:
		return restrictionAssessment{usability: usabilityUnknown, summary: summary, details: details}
	}
}

// describeRestrictions renders a short summary such as
// "restricted to 2 projects, 1 group and 1 expression".
//
// Counts and kinds only, deliberately: the names live in the per-restriction
// detail, where they can be rendered as a list rather than crammed into a badge
// caption that has to stay short enough to sit beside a context's name.
func describeRestrictions(projectCount, groupCount, expressionCount, otherCount int) string {
	parts := make([]string, 0, 4)
	if projectCount > 0 {
		parts = append(parts, pluralize(projectCount, "project"))
	}
	if groupCount > 0 {
		parts = append(parts, pluralize(groupCount, "group"))
	}
	if expressionCount > 0 {
		parts = append(parts, pluralize(expressionCount, "expression"))
	}
	if otherCount > 0 {
		parts = append(parts, pluralize(otherCount, "unrecognised restriction"))
	}

	switch len(parts) {
	case 0:
		return ""
	case 1:
		return "restricted to " + parts[0]
	default:
		return "restricted to " +
			strings.Join(parts[:len(parts)-1], ", ") + " and " + parts[len(parts)-1]
	}
}

// pluralize renders "1 project" / "2 projects".
func pluralize(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return strconv.Itoa(n) + " " + noun + "s"
}

// contextListMissingConsequence is the consequence shared by the two ways
// the context list can come back empty for a reason other than "there are
// none". It names the inspector's combobox (issue #152) explicitly, because
// that is the affordance that silently gets worse: with no list, a name typed
// by hand cannot be checked, and the editor must not imply otherwise.
const contextListMissingConsequence = "No contexts are listed, so a context name typed into a job " +
	"cannot be checked against the real list."

// describeUpstreamError maps an upstream CircleCI API error to a short, safe,
// human-readable phrase, naming the HTTP status code where there is one.
//
// It deliberately never includes err.Error() for a status failure.
// circleci.APIError embeds the response body for diagnostics, and the bodies
// these particular endpoints return can quote context and environment
// variable metadata — so forwarding one to the browser (or a log line) would
// be exactly the leak this feature must not create.
//
// What issue #150 changed is the scope of that caution. The original version
// collapsed *everything* that was not 401/403/429 into one fixed sentence,
// which made a 404 (the repository is not set up on CircleCI) look identical
// to a DNS failure and to a timeout — the owner saw "the CircleCI API request
// did not succeed" and reasonably concluded their token was broken. A status
// code is not a body: it is safe to disclose, and it is the single most useful
// fact about the failure. So each distinguishable class now says what it is,
// and the fixed sentence survives only as the genuine "we don't know" case.
func describeUpstreamError(err error) string {
	// Ordered before the status checks: a timeout or a cancellation is not
	// an APIError at all, and reads as one only if you squint.
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "the CircleCI API did not respond before this request's time limit"
	case errors.Is(err, context.Canceled):
		return "the request was cancelled before the CircleCI API responded"
	}

	if status, ok := circleci.StatusCode(err); ok {
		switch {
		case status == http.StatusUnauthorized:
			return "the CircleCI API rejected this token (HTTP 401)"
		case status == http.StatusForbidden:
			return "this token does not have permission (HTTP 403)"
		case status == http.StatusNotFound:
			return "the CircleCI API has no record of it (HTTP 404)"
		case status == http.StatusTooManyRequests:
			return "the CircleCI API rate-limited this request (HTTP 429)"
		case status >= 500:
			return "the CircleCI API reported a server error (HTTP " + strconv.Itoa(status) + ")"
		default:
			return "the CircleCI API returned an unexpected status (HTTP " + strconv.Itoa(status) + ")"
		}
	}

	// Not a status failure: either this host never reached CircleCI, or the
	// reply was unreadable. Both are worth distinguishing from "CircleCI
	// said no", because the fix is somewhere else entirely.
	var netErr net.Error
	if errors.As(err, &netErr) {
		return "this host could not reach the CircleCI API (network error)"
	}

	return "the CircleCI API request did not succeed"
}

// projectLookupWarning builds the warning for a failed GET of the project
// record — the failure behind issue #150, and the one worth its own function.
//
// A 404 here is the common case and had the least useful message. The slug is
// assembled by this host from CIRCLE_VCS_TYPE/CIRCLE_PROJECT_USERNAME/
// CIRCLE_PROJECT_REPONAME, which the user cannot see, so a 404 means "the
// thing I looked up isn't a CircleCI project" and the only way to act on that
// is to be told *what* was looked up. The reported case was a checkout of
// `example-org/flakey-todo-list` where the CircleCI project is
// `flaky-todo-list` — one letter apart, both plausible, and the old wording
// sent the owner hunting through their token instead.
//
// Note what this deliberately does not say: nothing about credentials. 401
// and 403 have their own phrases (and were verified not to be what this case
// produced), so a 404 must not hint at a permissions problem — that hint is
// precisely where the time went.
//
// Issue #198 supplied the cause the original wording could only describe: the
// repository had been *renamed*, `flakey-` to `flaky-`, and GitHub's permanent
// redirect kept the stale remote working invisibly. So the 404 now says where the
// slug came from — which after this issue is one of two places — and carries the
// CLI's own remedy in Suggestions. Note it still never proposes a different
// project: canonicalSlug's rule is unchanged and no near-miss is resolved here.
func projectLookupWarning(err error, slug string, identity ProjectIdentity) warningPayload {
	consequences := []string{
		"This project's default branch and settings are not shown.",
		"Nothing confirms which CircleCI project this config belongs to.",
	}

	if circleci.IsNotFound(err) {
		return warningPayload{
			Kind:     warningKindProject,
			Headline: "No CircleCI project matches " + slug + ".",
			Detail: "The CircleCI API returned HTTP 404 for that project slug. " +
				projectSlugProvenance(identity) +
				" Most often a 404 means this repository has not been set up on CircleCI, " +
				"or that it has been renamed since — a renamed repository keeps working " +
				"over git, because the VCS host redirects the old name, while no longer " +
				"being the name CircleCI knows. Your token is not the problem: a rejected " +
				"token reports itself as such.",
			Consequences: consequences,
			Suggestions:  projectBindingSuggestions(identity.Binding),
		}
	}

	return warningPayload{
		Kind:         warningKindProject,
		Headline:     "This project's details could not be loaded.",
		Detail:       "Looking up " + slug + " failed: " + describeUpstreamError(err) + ".",
		Consequences: consequences,
	}
}

// projectSlugProvenance is one sentence saying where the slug that 404'd came
// from, because "the thing I looked up isn't a CircleCI project" is only
// actionable once you know which of two sources named it — and after issue #198
// there are two.
//
// The disagreement case gets its own sentence, and it is the most diagnostic thing
// this host can say without asking a third party anything: when the recorded
// binding and the CLI-derived environment name different projects, one of them is
// stale, and saying so is what turns "no project matches" into a lead.
func projectSlugProvenance(identity ProjectIdentity) string {
	switch identity.Source {
	case ProjectIdentityFromBinding:
		if identity.Disagrees() {
			return "That slug is what " + identity.Binding.Path + " records for this checkout, " +
				"which is preferred over the CircleCI CLI's own value for this directory (" +
				identity.EnvironmentSlug + ") because a recorded binding survives a repository " +
				"rename and a git remote does not. The two disagreeing means one of them is out " +
				"of date."
		}
		return "That slug is what " + identity.Binding.Path + " records for this checkout, " +
			"written by `circleci project link` rather than by anything you typed here."
	case ProjectIdentityFromEnvironment:
		return "That slug is built from the organization and repository the CircleCI CLI passed " +
			"to this editor, not from anything you typed here, and this checkout records no " +
			"project binding of its own."
	default:
		return ""
	}
}

// projectBindingWarning reports a `.circleci/info.yml` this host could not use,
// while some other source did name a project.
//
// Its own warning, before any upstream call, because the failure is local: the
// file that is supposed to decide which project this is could not be read, so the
// identity in use is the fallback rather than the user's own recorded answer. The
// alternative — quietly using the fallback — is the "silent fallback that looks
// like success" issue #198's constraint rules out.
func projectBindingWarning(identity ProjectIdentity) warningPayload {
	consequences := []string{
		"The project shown is the one the CircleCI CLI named for this directory, not the one this checkout recorded.",
		"A repository renamed since this checkout was cloned will be looked up under its old name, which no longer exists.",
	}
	if identity.Slug != "" {
		consequences[0] = "The project shown is " + identity.Slug +
			", named by the CircleCI CLI for this directory rather than by this checkout's own recorded binding."
	}

	return warningPayload{
		Kind:     warningKindProjectBinding,
		Headline: "This checkout's recorded CircleCI project could not be read.",
		Detail: identity.Binding.Path + " exists and this host could not use it: " +
			identity.Binding.Problem +
			" Nothing was changed — this host never writes that file.",
		Consequences: consequences,
		Suggestions:  projectBindingSuggestions(identity.Binding),
	}
}

// logUpstreamFailure writes one line to the host's stderr for an upstream
// call that failed, because before issue #150 nothing logged these at all:
// the browser got one vague sentence and the terminal the user had right
// there in front of them said nothing whatsoever.
//
// action names what was being attempted, in the imperative ("look up project
// github/acme/web"). What is logged about err is only ever its class and, for
// a status failure, the status code and the request line — never the response
// body (see describeUpstreamError), and never a token, which no error in this
// package carries in the first place.
func logUpstreamFailure(action string, err error) {
	// Both halves are sanitized because both are tainted: action embeds a slug
	// built from injected environment variables, and an error string comes
	// (indirectly) from a remote server. Neither should be able to forge a
	// second log line -- see sanitizeForLog.
	//nolint:gosec // G706: both interpolated values pass through sanitizeForLog, which replaces every control character (newlines included) and bounds the length, so neither can forge a log line; gosec's taint analysis does not recognise the sanitizer.
	log.Printf("project-context: failed to %s: %s",
		sanitizeForLog(action), sanitizeForLog(upstreamErrorLogDetail(err)))
}

// sanitizeForLog renders s safe to write as part of one log line: every ASCII
// control character (newlines above all) becomes a space, and the result is
// bounded.
//
// The threat is log forgery rather than disclosure: a value that reaches this
// log comes from the CLI-injected environment (a project slug) or from a remote
// server's error string, and either could smuggle a newline and thereby invent
// a whole log line that looks like it came from this host. Trimming to a bound
// also keeps a pathological error string from filling a terminal.
func sanitizeForLog(s string) string {
	const maxLoggedRunes = 300

	runes := []rune(s)
	if len(runes) > maxLoggedRunes {
		runes = append(runes[:maxLoggedRunes:maxLoggedRunes], '…')
	}
	for i, r := range runes {
		if r < 0x20 || r == 0x7f {
			runes[i] = ' '
		}
	}
	return string(runes)
}

// upstreamErrorLogDetail renders the loggable part of an upstream error.
//
// For a status failure that is the status code plus the method and path,
// pulled off the *APIError's own fields rather than from Error() — which
// interpolates the response body, the one thing that must not be written to
// a log file. For anything else (a transport error, a timeout, a decode
// failure) the error string itself is the diagnosis and carries no upstream
// body, so it is passed through.
func upstreamErrorLogDetail(err error) string {
	var apiErr *circleci.APIError
	if errors.As(err, &apiErr) {
		detail := "HTTP " + strconv.Itoa(apiErr.StatusCode)
		if apiErr.Method != "" && apiErr.Path != "" {
			detail += " from " + apiErr.Method + " " + apiErr.Path
		}
		return detail + " (response body deliberately not logged)"
	}
	return err.Error()
}

// ownerLabel names a context owner for a log line: its slug when that is
// what was used, and otherwise its organization ID.
func ownerLabel(owner circleci.ContextOwner) string {
	if owner.Slug != "" {
		return owner.Slug
	}
	return "id " + owner.ID
}

// capitalizeFirst upper-cases the first rune of s, so a phrase written to
// read mid-sentence ("the CircleCI API rejected this token") can also open
// warningPayload.Detail as a sentence of its own.
func capitalizeFirst(s string) string {
	if s == "" {
		return s
	}
	r := []rune(s)
	r[0] = unicode.ToUpper(r[0])
	return string(r)
}

// projectContextCache is a tiny TTL cache for project-context responses,
// keyed by project slug or context ID.
//
// Deliberately in-process only, with no disk persistence — unlike
// internal/orbs.Cache, which does persist. Two reasons: the data is small
// enough that a cold start costs one round trip rather than a 6,000-orb
// crawl, and it is secret *metadata* (context and variable names, and
// four-character previews). Writing that to a cache file would put it on
// disk where nothing asked it to go, and would outlive the process that
// fetched it. It stays in memory and dies with the host.
type projectContextCache[T any] struct {
	mu      sync.Mutex
	ttl     time.Duration
	entries map[string]projectContextCacheEntry[T]
}

type projectContextCacheEntry[T any] struct {
	value     T
	expiresAt time.Time
}

// newProjectContextCache constructs a cache whose entries expire after ttl.
func newProjectContextCache[T any](ttl time.Duration) *projectContextCache[T] {
	return &projectContextCache[T]{ttl: ttl, entries: make(map[string]projectContextCacheEntry[T])}
}

func (c *projectContextCache[T]) get(key string) (T, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	entry, ok := c.entries[key]
	if !ok {
		var zero T
		return zero, false
	}
	if time.Now().After(entry.expiresAt) {
		delete(c.entries, key)
		var zero T
		return zero, false
	}
	return entry.value, true
}

func (c *projectContextCache[T]) set(key string, value T) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = projectContextCacheEntry[T]{value: value, expiresAt: time.Now().Add(c.ttl)}
}

// invalidate drops every entry, so the next request refetches. It backs the
// palette's manual refresh, which exists because this data is edited outside
// the editor and a user who has just added a context in the web UI should
// not have to wait out a TTL.
func (c *projectContextCache[T]) invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = make(map[string]projectContextCacheEntry[T])
}
