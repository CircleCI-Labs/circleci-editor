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
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
)

// Timeouts for the two halves of this feature. The trigger gets the longer
// budget because it is the request nobody wants to retry blindly: a client
// that gives up early on a POST that may already have created a pipeline
// cannot tell "it did not happen" from "I stopped listening".
const (
	runAvailabilityTimeout = 20 * time.Second
	runTriggerTimeout      = 30 * time.Second
)

// Availability states for a one-shot unversioned run.
//
// Six, and the count is the point. Issue #194's degradation requirement is
// that "unversioned config is disabled for this project" and "we could not
// determine whether it is available" must not look alike, and the honest way
// to guarantee that is to never compute one from the other's absence. Each
// state below is *asserted* by something this host actually read.
const (
	// RunAvailabilityAvailable means both gates are on, there is a token,
	// and a project and branch are known. A run can be offered.
	RunAvailabilityAvailable = "available"

	// RunAvailabilityOrgDisabled means the organization has not opted in.
	// The common case, and the one the issue's premise missed: the
	// organization setting defaults to Off and overrides the project's.
	RunAvailabilityOrgDisabled = "organization-disabled"

	// RunAvailabilityProjectDisabled means the organization has opted in
	// and this project has opted out.
	RunAvailabilityProjectDisabled = "project-disabled"

	// RunAvailabilityNoToken means there is no CIRCLE_TOKEN, so nothing
	// could be asked and nothing could be triggered.
	RunAvailabilityNoToken = "no-token"

	// RunAvailabilityNoProject means this host does not know which CircleCI
	// project this checkout is, so there is nowhere to run.
	RunAvailabilityNoProject = "no-project"

	// RunAvailabilityUnknown means a lookup failed. Emphatically not
	// "disabled": the user may well be able to run, and the honest thing is
	// to say the question could not be answered.
	RunAvailabilityUnknown = "unknown"

	// RunAvailabilityUnroutable means both gates are on, but this host cannot
	// establish which trigger endpoint would *honour* an inline config for
	// this project.
	//
	// Its own state rather than a flavour of "unknown", because it is the one
	// refusal that exists to prevent a wrong *success*. On a classic GitHub
	// OAuth project, the newer `/pipeline/run` endpoint accepts an inline
	// config, answers 201, and runs the committed config instead -- so
	// guessing the route can produce a green run that attests to a config
	// nobody tested. Silent-ignore is undetectable before the money is spent,
	// so uncertainty about the route has to mean "no". See
	// circleci.ConfigRoute.
	RunAvailabilityUnroutable = "unroutable"
)

// runAvailabilityResponse is the JSON shape returned by
// GET /api/run/availability.
//
// It is a *precondition* report, not a run report. Everything in it is
// answerable before anything has ever run, which is what keeps it on the
// authoring side of this editor's scope rather than drifting into run
// observation.
type runAvailabilityResponse struct {
	// Status is one of the six constants above. A client must switch on it
	// exhaustively; there is no boolean to collapse it into.
	Status string `json:"status"`

	// Reason is this host's own prose for Status, rendered verbatim. Always
	// present, including when Status is "available", because the user is
	// entitled to know what is about to happen before it does.
	Reason string `json:"reason"`

	// ProjectSlug and Branch name exactly what a run would target. They are
	// here so the confirmation can quote them rather than re-derive them:
	// the browser must never be the thing that decides where a build runs.
	ProjectSlug string `json:"projectSlug,omitempty"`
	Branch      string `json:"branch,omitempty"`

	// BranchSource says where Branch came from -- "checkout" for the working
	// tree's own HEAD, "environment" for CIRCLE_BRANCH -- on the same
	// reasoning as metaResponse.BranchSource (issue #214).
	BranchSource string `json:"branchSource,omitempty"`

	// DefaultBranch is the project's default branch, when known, so the
	// client can require a stronger confirmation for it. Empty is not
	// "this is not the default branch"; it is "we do not know", and a
	// client that treats it as the former is broken.
	DefaultBranch string `json:"defaultBranch,omitempty"`

	// DynamicConfig reports the project's dynamic-config setting.
	//
	// A caveat rather than a gate, deliberately. CircleCI's documentation
	// says unversioned config "is disabled for projects that use dynamic
	// configuration", but that could not be verified: on a project with
	// dynamic config enabled *and* the organization opted in, the
	// custom-config authorization check passed, so any such exclusion is
	// enforced somewhere this host cannot observe without spending money.
	// Blocking on an unverified sentence would deny a run that may work;
	// staying silent would surprise someone whose run dies for a reason we
	// had read about. So it is reported and the client warns.
	DynamicConfig bool `json:"dynamicConfig,omitempty"`

	// ConfigRoute names which endpoint would carry the inline config --
	// "legacy", "pipeline-run", or "unknown". Surfaced because the two are
	// not interchangeable and a support question about a surprising run
	// starts with which one was used.
	ConfigRoute string `json:"configRoute,omitempty"`

	// IdentitySource says where ProjectSlug came from -- "binding" for
	// `.circleci/info.yml`, "environment" for the CLI-injected slug.
	IdentitySource string `json:"identitySource,omitempty"`

	// EnvironmentSlug is what the injected environment claimed, carried even
	// when the binding won, so a disagreement can be *shown* rather than
	// silently resolved.
	EnvironmentSlug string `json:"environmentSlug,omitempty"`

	// IdentityDisagrees reports that `.circleci/info.yml` and the injected
	// environment name different projects.
	//
	// Not a refusal, and not a resolution either. This endpoint follows the
	// same precedence every other surface uses rather than inventing a
	// second one; what would be wrong is for the one surface that spends
	// money to be the only one that quietly picked a side. The confirmation
	// names both.
	IdentityDisagrees bool `json:"identityDisagrees,omitempty"`

	// definitionID is the pipeline definition `/pipeline/run` requires.
	// Unexported: it never crosses to the browser, because nothing there has
	// any business choosing which definition a run uses.
	definitionID string `json:"-"`
}

// runRequest is the JSON shape accepted by POST /api/run.
//
// Branch is required and is *not* defaulted here. The client is given the
// branch by GET /api/run/availability and must send it back, so that the
// branch a user saw in a confirmation dialog is provably the branch that was
// triggered. A host that helpfully filled in a missing branch would make the
// confirmation a decoration.
type runRequest struct {
	Contents *string `json:"contents"`
	Branch   *string `json:"branch"`

	// Parameters overrides the config's declared pipeline parameters. Every
	// declared pipeline parameter has a default (CircleCI's schema requires
	// one), so this is never needed to make a config runnable -- only to
	// choose a different path through one.
	Parameters map[string]any `json:"parameters,omitempty"`
}

// runResponse is the JSON shape returned by POST /api/run.
//
// ## What is deliberately absent
//
// Any notion of how the run is getting on. No status, no polling token, no
// job list, no duration. This editor's scope boundary, Amendment 2 (#191),
// draws the line at what this product *renders*, and a field this host
// returns is a field some future pane will render. `State` is the one
// borderline case and it is here for a single reason given below.
//
// The whole intended use of this response is: say a pipeline exists, and give
// the user a link to CircleCI. Diagnosis of a failure goes through the
// assistant, which Amendment 2 explicitly permits to consult run data --
// via CircleCI's own MCP server, which is a mature observation product this
// one has no business reimplementing.
type runResponse struct {
	// Triggered is true only when CircleCI created a pipeline. False with
	// HTTP 200 means the run was refused for a settled reason in Reason --
	// the same "degradable endpoint" convention validateResponse and
	// policyResponse use, and for the same reason: a refusal is not an
	// error, and it is not a run either.
	Triggered bool   `json:"triggered"`
	Reason    string `json:"reason,omitempty"`

	// Status carries the availability state when Triggered is false, so a
	// client can render a refusal with the same six-way vocabulary it
	// already switches on rather than parsing Reason.
	Status string `json:"status,omitempty"`

	PipelineID     string `json:"pipelineId,omitempty"`
	PipelineNumber int64  `json:"pipelineNumber,omitempty"`

	// State is CircleCI's word for the new pipeline, verbatim and
	// uninterpreted. Present because "created" and "errored" are
	// distinguishable at creation time and a pipeline that was born errored
	// should not be announced as though it were running. Never polled for,
	// never refreshed: this is the value at the instant of creation and the
	// client says so.
	State string `json:"state,omitempty"`

	// WebURL deep-links the pipeline in the CircleCI web UI. Empty when the
	// project's VCS type is not name-addressed (see
	// nameAddressedVCSSegments) -- a client must then render the pipeline
	// number as plain text rather than a link that cannot work, exactly as
	// this host does everywhere else.
	WebURL string `json:"webUrl,omitempty"`

	// ProjectSlug and Branch echo what was actually triggered. The echo is
	// the point: it is the record of what happened, and it lets a client
	// prove the run went where the confirmation said it would.
	ProjectSlug string `json:"projectSlug,omitempty"`
	Branch      string `json:"branch,omitempty"`

	// ConfigRoute names the endpoint that carried the config.
	ConfigRoute string `json:"configRoute,omitempty"`

	// ConfigVerified reports whether this host confirmed, by reading the
	// pipeline's own config back, that the pipeline is running the config
	// that was submitted.
	//
	// Three values, and the middle one is why this field exists:
	//
	//   - "confirmed": the pipeline's `source` matches what was sent, byte
	//     for byte. The run really is testing the editor's config.
	//   - "mismatch": the pipeline is running something else. The inline
	//     config was ignored -- the wrong-green case -- and the client must
	//     say so loudly rather than report a successful test.
	//   - "unverified": the check could not be completed. Not a failure and
	//     not a pass; the client says the run started and that this editor
	//     could not confirm which config it picked up.
	ConfigVerified string `json:"configVerified,omitempty"`
}

// Config-verification verdicts. See runResponse.ConfigVerified.
const (
	ConfigVerifiedConfirmed  = "confirmed"
	ConfigVerifiedMismatch   = "mismatch"
	ConfigVerifiedUnverified = "unverified"
)

// handleRunAvailability serves GET /api/run/availability: whether a one-shot
// unversioned run can be offered for this project, and what it would target.
//
// Answered on every request rather than cached. The two settings it reads are
// changed in the CircleCI web UI, and "I just turned that on" is exactly when
// someone reloads.
func (s *Server) handleRunAvailability(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), runAvailabilityTimeout)
	defer cancel()

	writeJSON(w, http.StatusOK, s.runAvailability(ctx))
}

// handleRun serves POST /api/run: it triggers one pipeline on CircleCI using
// the config in the request body instead of the config committed to the
// branch.
//
// ## This is the only endpoint in this program that spends the user's money
//
// Three properties follow from that, and none of them are negotiable.
//
//  1. **It is never a side effect.** Nothing in this host calls it; it exists
//     solely to serve an explicit user action. There is no autosave analogue,
//     no debounce, no "run on save". Compare handleValidate, which the editor
//     calls freely, and handlePolicyDecide, which it calls only on request --
//     this is one step stricter than the latter.
//  2. **It re-checks availability itself, immediately before triggering.**
//     The browser has already been told whether a run is possible, and that
//     answer is not trusted: it is a value in a tab that may have been open
//     for an hour, and the cost of acting on a stale one is a pipeline nobody
//     wanted. The client's `branch` is likewise echoed back rather than
//     defaulted (see runRequest).
//  3. **It refuses a config that does not compile.** A config CircleCI cannot
//     compile cannot do anything useful when run, and the run would still
//     appear in the team's dashboard. CircleCI's own VS Code extension makes
//     the same check in the same order before its trigger, which is some
//     comfort that this is the intended shape rather than our invention.
func (s *Server) handleRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	defer func() { _ = r.Body.Close() }()

	var req runRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "malformed request body")
		return
	}
	if req.Contents == nil {
		writeError(w, http.StatusBadRequest, "missing required field: contents")
		return
	}
	if req.Branch == nil {
		writeError(w, http.StatusBadRequest, "missing required field: branch")
		return
	}

	contents := *req.Contents
	branch := strings.TrimSpace(*req.Branch)
	if branch == "" {
		writeError(w, http.StatusBadRequest, "missing required field: branch")
		return
	}
	if strings.TrimSpace(contents) == "" {
		writeRunRefused(w, RunAvailabilityUnknown,
			"this file is empty, so there is nothing to run")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), runTriggerTimeout)
	defer cancel()

	// Re-checked here rather than trusted from the client. See the doc
	// comment: property 2.
	availability := s.runAvailability(ctx)
	if availability.Status != RunAvailabilityAvailable {
		writeRunRefused(w, availability.Status, availability.Reason)
		return
	}

	// The branch is the client's, and it must be the one the user was shown.
	// A mismatch means the availability the confirmation was built from is
	// not the availability being acted on, so nothing is triggered.
	if branch != availability.Branch {
		writeRunRefused(w, RunAvailabilityUnknown, fmt.Sprintf(
			"this editor would now run against %q, not the %q it offered when you asked. "+
				"Nothing was triggered; reload so the branch you confirm is the branch that runs",
			availability.Branch, branch))
		return
	}

	if refusal, ok := s.runCompileGate(ctx, contents); !ok {
		writeRunRefused(w, RunAvailabilityUnknown, refusal)
		return
	}

	// Routed, never guessed. availability.ConfigRoute is "legacy" or
	// "pipeline-run" by this point -- an unroutable project was refused above.
	triggerReq := circleci.TriggerPipelineWithConfigRequest{
		ProjectSlug:  availability.ProjectSlug,
		Branch:       availability.Branch,
		ConfigYAML:   contents,
		Parameters:   req.Parameters,
		DefinitionID: availability.definitionID,
	}

	trigger := s.runClient.TriggerPipelineWithConfig
	if circleci.ConfigRoute(availability.ConfigRoute) == circleci.ConfigRoutePipelineRun {
		trigger = s.runClient.TriggerPipelineRunWithConfig
	}

	pipeline, err := trigger(ctx, triggerReq)
	if err != nil {
		// Names neither the project nor the branch and quotes no config:
		// the same logging budget every other upstream call in this package
		// keeps.
		logRunUpstreamFailure("trigger a pipeline with the config in the editor", err)

		switch {
		case circleci.IsForbidden(err):
			// The gates were both on a moment ago, so this is either a
			// change since, or a permission this host cannot see (the
			// per-user, per-project and per-branch checks CircleCI applies
			// to these runs as it would to a VCS trigger).
			writeRunRefused(w, RunAvailabilityUnknown,
				"CircleCI refused to run this config (HTTP 403). Unversioned config was enabled for this "+
					"project and organization when this editor last looked, so either that changed, or your "+
					"account does not have permission to start a build on this branch. No pipeline was created")
		case circleci.IsNotFound(err):
			writeRunRefused(w, RunAvailabilityNoProject, "CircleCI has no project matching "+
				availability.ProjectSlug+" (HTTP 404), so there is nowhere to run this config. "+
				"No pipeline was created")
		case circleci.IsBadRequest(err):
			// The branch is the overwhelmingly likely cause: this is what
			// the live API answers for a branch that does not exist on the
			// remote, which is easy to produce with a local-only branch.
			writeRunRefused(w, RunAvailabilityUnknown, "CircleCI rejected this run (HTTP 400). "+
				"The most common cause is that the branch "+availability.Branch+" does not exist on the "+
				"remote yet — a run needs a branch CircleCI can check out, even though the config comes "+
				"from this editor. No pipeline was created")
		default:
			writeError(w, http.StatusBadGateway,
				"could not start a run on CircleCI: "+describeUpstreamError(err)+
					". This editor cannot tell whether a pipeline was created; check CircleCI before retrying")
		}
		return
	}

	// A 2xx whose body this host cannot read is still a pipeline somebody is
	// paying for. It is reported as one, with the part we could not establish
	// named -- never as a failure (which would imply nothing happened) and
	// never with a deep link built from a missing number (which would 404 and
	// look like the run vanished). The success path's response fields are
	// taken from CircleCI's OpenAPI document and the CLI, and were never
	// observed live, so this is the branch that has to be right.
	if pipeline == nil || pipeline.Number <= 0 {
		writeJSON(w, http.StatusOK, runResponse{
			Triggered:      true,
			PipelineID:     safePipelineID(pipeline),
			State:          safePipelineState(pipeline),
			ProjectSlug:    availability.ProjectSlug,
			Branch:         availability.Branch,
			ConfigRoute:    availability.ConfigRoute,
			ConfigVerified: ConfigVerifiedUnverified,
			Reason: "CircleCI accepted this run, but this host could not read which pipeline it " +
				"created, so there is no link to offer. A pipeline was almost certainly started — " +
				"look for it on the branch " + availability.Branch + " in the CircleCI dashboard",
		})
		return
	}

	verified := s.verifyRanConfig(ctx, pipeline.ID, contents)

	resp := runResponse{
		Triggered:      true,
		PipelineID:     pipeline.ID,
		PipelineNumber: pipeline.Number,
		State:          pipeline.State,
		WebURL:         s.env.PipelineWebURL(availability.ProjectSlug, pipeline.Number),
		ProjectSlug:    availability.ProjectSlug,
		Branch:         availability.Branch,
		ConfigRoute:    availability.ConfigRoute,
		ConfigVerified: verified,
	}
	switch verified {
	case ConfigVerifiedMismatch:
		resp.Reason = "CircleCI started this pipeline but it is not running the config from this " +
			"editor — the config you see was ignored and the one committed to " + availability.Branch +
			" ran instead. Whatever this pipeline reports says nothing about your changes"
	case ConfigVerifiedUnverified:
		resp.Reason = "this host could not read the pipeline's config back, so it cannot confirm the " +
			"run picked up your edits rather than the config committed to the branch"
	}
	writeJSON(w, http.StatusOK, resp)
}

// safePipelineID and safePipelineState read a possibly-nil pipeline without
// asserting anything about a response this host could not parse.
func safePipelineID(p *circleci.Pipeline) string {
	if p == nil {
		return ""
	}
	return p.ID
}

func safePipelineState(p *circleci.Pipeline) string {
	if p == nil {
		return ""
	}
	return p.State
}

// verifyRanConfig reads the new pipeline's own config back and reports whether
// it is the config that was submitted.
//
// ## Why this is worth a second request
//
// The failure this catches is the only one in this feature that is *invisible*:
// on some project types a trigger accepts an inline config, answers 201, and
// runs the repository's config instead. Routing (circleci.ConfigRoute) is the
// primary defence, but it rests on server behaviour that could change under us,
// and the cost of it being wrong is a green pipeline attesting to a config
// nobody tested. This check does not rest on that behaviour at all: it compares
// bytes.
//
// A comparison that cannot be made returns ConfigVerifiedUnverified, never
// "confirmed". The config is stored asynchronously with the pipeline, so a
// freshly created pipeline may legitimately have nothing to read yet -- which is
// exactly why "could not check" has to be its own answer rather than being
// folded into either verdict.
func (s *Server) verifyRanConfig(ctx context.Context, pipelineID, submitted string) string {
	if pipelineID == "" {
		return ConfigVerifiedUnverified
	}

	config, err := s.runClient.GetPipelineConfig(ctx, pipelineID)
	if err != nil {
		logRunUpstreamFailure("read back the config the new pipeline is running", err)
		return ConfigVerifiedUnverified
	}
	if config == nil || strings.TrimSpace(config.Source) == "" {
		return ConfigVerifiedUnverified
	}

	// Trailing-whitespace insensitive, and nothing looser. Anything cleverer
	// (normalising YAML, comparing parsed documents) would start forgiving the
	// difference this exists to find.
	if strings.TrimRight(config.Source, " \t\r\n") == strings.TrimRight(submitted, " \t\r\n") {
		return ConfigVerifiedConfirmed
	}
	return ConfigVerifiedMismatch
}

// runAvailability answers "could a run be offered, and against what".
//
// Every state it can return is asserted from something read, never inferred
// from a missing value. The one ordering that matters: the organization gate
// is reported before the project gate, because the organization's setting
// overrides the project's, so "your project allows this but your organization
// does not" is the true and useful sentence — and reporting the project's
// `false` first would send someone to the wrong settings page.
func (s *Server) runAvailability(ctx context.Context) runAvailabilityResponse {
	branch, branchSource := s.runBranch()

	// The same resolution every other surface uses: `.circleci/info.yml`
	// first, the CLI-injected environment second. Deliberately `s.projectIdentity()`
	// rather than a private precedence of its own -- a button that spends money
	// must not be the one surface in this app naming a different project from the
	// rest of it.
	identity := s.projectIdentity()
	slug := identity.Slug

	resp := runAvailabilityResponse{
		ProjectSlug:  slug,
		Branch:       branch,
		BranchSource: branchSource,
		// Carried, not resolved away. When the binding and the environment name
		// different projects the run still goes to the binding's project --
		// that is the precedence every surface uses and this endpoint does
		// not get to differ from it -- but the user is told, because "which
		// project is this about to build" is the one question a confirmation
		// must not leave ambiguous.
		IdentitySource:    identity.Source,
		EnvironmentSlug:   identity.EnvironmentSlug,
		IdentityDisagrees: identity.Disagrees(),
	}

	switch {
	case !s.env.HasToken() || s.runClient == nil:
		resp.Status = RunAvailabilityNoToken
		resp.Reason = "no CircleCI API token available. Running a config needs a token, because the run " +
			"happens on CircleCI"
		return resp
	case slug == "":
		resp.Status = RunAvailabilityNoProject
		resp.Reason = "which CircleCI project this checkout belongs to could not be determined, and a run " +
			"has to happen somewhere"
		return resp
	case branch == "":
		resp.Status = RunAvailabilityNoProject
		resp.Reason = "which branch to run against could not be determined. A run needs a branch: the " +
			"config comes from this editor, but the code it builds comes from the branch"
		return resp
	}

	project, err := s.runClient.GetProject(ctx, slug)
	if err != nil {
		logRunUpstreamFailure("look up this project on CircleCI", err)
		if circleci.IsNotFound(err) {
			resp.Status = RunAvailabilityNoProject
			resp.Reason = "CircleCI has no project matching " + slug + " (HTTP 404), so there is nowhere " +
				"to run this config"
			return resp
		}
		resp.Status = RunAvailabilityUnknown
		resp.Reason = "whether this config can be run without committing it could not be determined: " +
			describeUpstreamError(err)
		return resp
	}

	// CircleCI's own spelling of the slug supersedes ours the moment it
	// arrives, and it is what the run and the deep link both use.
	if project.Slug != "" {
		resp.ProjectSlug = project.Slug
	}
	resp.DefaultBranch = project.DefaultBranch

	if project.OrganizationID == "" {
		resp.Status = RunAvailabilityUnknown
		resp.Reason = "CircleCI's record for " + resp.ProjectSlug + " carries no organization id, and " +
			"whether unversioned config is allowed is an organization setting"
		return resp
	}

	orgSettings, err := s.runClient.GetOrgSettings(ctx, project.OrganizationID)
	if err != nil {
		logRunUpstreamFailure("read the organization's unversioned-config setting", err)
		resp.Status = RunAvailabilityUnknown
		resp.Reason = "whether this organization allows running an uncommitted config could not be " +
			"determined: " + describeUpstreamError(err)
		return resp
	}
	if !orgSettings.UnversionedConfig {
		resp.Status = RunAvailabilityOrgDisabled
		resp.Reason = "the organization " + describeOrgForRun(project) + " has not turned on \"Trigger " +
			"pipelines with unversioned config\", so CircleCI will refuse to run a config that is not " +
			"committed. It is off by default, only an organization admin can turn it on, and it overrides " +
			"the project's own setting — so a project that permits this still cannot use it until the " +
			"organization does"
		return resp
	}

	// Keyed by the same ID projectcontext.go uses, via the same helper, so this
	// endpoint cannot drift into a third precedence. The same invariant applies
	// with full force here: the ID and the slug must come from the same source,
	// because an ID describing a *different* project would not degrade this
	// answer, it would invert it -- reading another project's
	// `enable_unversioned_config` and then offering, or refusing, a run on the
	// strength of it. settingsProjectID prefers CircleCI's own record, which is
	// what we have and what wins everywhere else.
	settingsID := settingsProjectID(project, identity)
	if settingsID == "" {
		resp.Status = RunAvailabilityUnknown
		resp.Reason = "this project's CircleCI ID could not be established from the same source as its " +
			"slug, and both the unversioned-config setting and the pipeline definitions are keyed by ID. " +
			"Reading another project's settings to answer this would be worse than not answering"
		return resp
	}

	projectSettings, err := s.runClient.GetProjectSettings(ctx, settingsID)
	if err != nil {
		logRunUpstreamFailure("read the project's unversioned-config setting", err)
		resp.Status = RunAvailabilityUnknown
		resp.Reason = "whether this project allows running an uncommitted config could not be determined: " +
			describeUpstreamError(err)
		return resp
	}
	resp.DynamicConfig = projectSettings.DynamicConfig
	if !projectSettings.UnversionedConfig {
		resp.Status = RunAvailabilityProjectDisabled
		resp.Reason = "the project " + resp.ProjectSlug + " has turned off \"Trigger pipelines with " +
			"unversioned config\". The organization allows it, so this is a per-project opt-out that can " +
			"be reversed in the project's settings"
		return resp
	}

	// Both gates are on. The last question is the one that decides whether a
	// run would *test what the user thinks it tests*: which endpoint honours an
	// inline config for this project. Answered from the project's pipeline
	// definitions, and a refusal when it cannot be answered -- see
	// RunAvailabilityUnroutable.
	definitions, err := s.runClient.ListPipelineDefinitions(ctx, settingsID)
	if err != nil {
		logRunUpstreamFailure("list this project's pipeline definitions", err)
		resp.Status = RunAvailabilityUnknown
		resp.Reason = "which of CircleCI's two trigger endpoints would accept an uncommitted config for " +
			"this project could not be determined: " + describeUpstreamError(err) +
			". This editor will not guess, because guessing wrong starts a pipeline that runs the " +
			"committed config while reporting that it ran yours"
		return resp
	}

	route, definitionID := circleci.ConfigRouteFor(definitions)
	resp.ConfigRoute = string(route)
	resp.definitionID = definitionID
	if route == circleci.ConfigRouteUnknown {
		resp.Status = RunAvailabilityUnroutable
		resp.Reason = describeUnroutable(definitions)
		return resp
	}

	resp.Status = RunAvailabilityAvailable
	resp.Reason = "this config can be run on CircleCI without committing it. The run happens on " +
		resp.ProjectSlug + ", against the branch " + branch + ", using the config from this editor " +
		"instead of the one committed there. It costs credits and your team can see it in the CircleCI " +
		"dashboard like any other pipeline"
	return resp
}

// describeUnroutable says why a project with both gates on still cannot be run
// against, naming what was actually found rather than shrugging.
//
// Each branch is a real, observed state: several live standalone projects
// answer `{"items":[]}` for their definitions, and `github_server` and the
// Bitbucket providers exist without having been tested here.
func describeUnroutable(definitions []circleci.PipelineDefinition) string {
	const why = ". This editor will not guess: on some project types the newer endpoint accepts an " +
		"uncommitted config, reports success, and runs the config committed to the branch instead — " +
		"so a wrong guess produces a pipeline that passes without ever testing your changes"

	switch {
	case len(definitions) == 0:
		return "CircleCI reports no pipeline definitions for this project, so there is no way to tell " +
			"which trigger endpoint would accept an uncommitted config" + why
	case len(definitions) > 1:
		return fmt.Sprintf("this project has %d pipeline definitions, and which one a run would use "+
			"cannot be determined from here", len(definitions)) + why
	default:
		provider := definitions[0].ConfigSourceProvider
		if provider == "" {
			provider = "an unnamed provider"
		} else {
			provider = strconv.Quote(provider)
		}
		return "this project's config comes from " + sanitizeForLog(provider) +
			", which this editor has not verified can accept an uncommitted config" + why
	}
}

// runBranch is the branch a run would target, and where that came from.
//
// The same precedence handleMeta uses (issue #214): the checkout's own HEAD
// beats CIRCLE_BRANCH, because the working tree is what the user is looking
// at. The stakes are higher here than in the app bar — this value decides
// where a build runs — which is why BranchSource travels with it all the way
// into the confirmation.
func (s *Server) runBranch() (string, string) {
	if git := LoadGitInfo(s.gitAnchorDir()); git.Branch != "" {
		return git.Branch, "checkout"
	}
	if s.env.Branch != "" {
		return s.env.Branch, "environment"
	}
	return "", ""
}

// runCompileGate refuses to spend money on a config CircleCI cannot compile.
//
// Returns ok=false with the refusal prose. A compile that could not be
// *performed* does not block the run: the gate exists to catch a config that
// is definitely broken, and turning "we could not reach CircleCI to check"
// into "you may not run" would be a worse failure than letting a run through
// that CircleCI will reject in a moment anyway.
func (s *Server) runCompileGate(ctx context.Context, contents string) (string, bool) {
	if s.compiler == nil {
		return "", true
	}

	// The organization matters more here than anywhere else this compiles.
	// Without it, private and URL orbs do not resolve (issue #67), so a
	// perfectly runnable config fails this gate and the user is refused a run
	// CircleCI would have accepted -- a false refusal, which is the one
	// outcome a gate must not produce.
	ownerID, ownerCaveat := s.compileOwnerID(ctx)

	result, err := s.compiler.CompileConfig(ctx, circleci.CompileRequest{
		ConfigYAML: contents,
		OwnerID:    ownerID,
	})
	if err != nil {
		logRunUpstreamFailure("check that this config compiles before running it", err)
		return "", true
	}
	if result.Valid {
		return "", true
	}

	refusal := "this config does not compile, so running it would create a pipeline that fails immediately " +
		"and still shows up in your team's dashboard. Fix the validation errors first — nothing was " +
		"triggered"

	// Still a refusal, not a pass. The gate guards real money, and a compile
	// failure is the best evidence available that spending it is pointless;
	// waving that through whenever an organization happens to be unresolvable
	// would disable the gate precisely for the setups least able to check
	// anything. But the refusal says what it could not account for, so a user
	// looking at an error about a private or URL orb can tell the difference
	// between their config being wrong and this host lacking the context to
	// judge it.
	if ownerCaveat != "" {
		refusal += ". " + ownerCaveat
	}

	return refusal, false
}

// describeOrgForRun names the organization in the way most likely to match
// what the user sees in the CircleCI settings UI they are about to be sent
// to: its name when there is one, its slug otherwise.
func describeOrgForRun(project *circleci.Project) string {
	if project.OrganizationName != "" {
		return project.OrganizationName
	}
	if project.OrganizationSlug != "" {
		return project.OrganizationSlug
	}
	return "that owns this project"
}

// writeRunRefused answers "no run happened, and this is why", at HTTP 200.
//
// The status travels with the reason so a client renders a refusal from the
// same six-state vocabulary it already has, rather than by matching on prose.
func writeRunRefused(w http.ResponseWriter, status, reason string) {
	writeJSON(w, http.StatusOK, runResponse{
		Triggered: false,
		Status:    status,
		Reason:    reason,
	})
}

// logRunUpstreamFailure is logUpstreamFailure's counterpart for this
// endpoint: one line on stderr carrying the class of failure and, for a
// status failure, the code and request line. Never the response body, never
// the config, never a branch or project identifier, never a token.
func logRunUpstreamFailure(action string, err error) {
	//nolint:gosec // G706: both interpolated values pass through sanitizeForLog, which replaces every control character (newlines included) and bounds the length, so neither can forge a log line; gosec's taint analysis does not recognise the sanitizer.
	log.Printf("run: failed to %s: %s",
		sanitizeForLog(action), sanitizeForLog(upstreamErrorLogDetail(err)))
}
