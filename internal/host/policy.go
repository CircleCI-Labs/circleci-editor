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
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
)

// policyDecisionTimeout bounds one POST /api/policy/decide, covering every
// upstream call it can make -- resolving the org slug to a UUID, compiling
// the config for the "_compiled_" key (issue #25), and the decision itself
// -- including the circleci client's own retries on each. Compiling can be
// the slowest of the three (see validateTimeout, which bounds it alone at
// 20s for /api/validate), so this is sized with headroom above a simple sum
// of the individual timeouts rather than matching one of them.
const policyDecisionTimeout = 45 * time.Second

// policyRequest is the JSON shape accepted by POST /api/policy/decide.
type policyRequest struct {
	Contents *string `json:"contents"`
}

// policyViolationItem is one rule that fired, with the policy's own words.
type policyViolationItem struct {
	Rule   string `json:"rule"`
	Reason string `json:"reason"`
}

// policyResponse is the JSON shape returned by POST /api/policy/decide.
//
// It follows the house "degradable endpoint" convention established by
// validateResponse — available + reason, at HTTP 200 — but the honesty
// requirement here is stronger than anywhere else in this API, because the
// thing being reported is a security control. Three states must stay
// distinguishable, and two of them must never be confused:
//
//   - Available=true: the policy engine answered. Status is one of PASS,
//     SOFT_FAIL, HARD_FAIL or ERROR, and EnabledRules says what was actually
//     evaluated. A PASS with an empty EnabledRules means the org has no
//     enabled rules in this context — the client must say that rather than
//     "your config satisfies your policies".
//   - Available=false at HTTP 200: no decision was reached, and retrying
//     will not change that until something else changes (no token, no
//     organization, an org whose plan does not include config policies, a
//     config the engine could not parse, or a status this editor cannot
//     interpret). Reason says which. This is *not* a pass.
//   - HTTP 502 with the standard error envelope: no decision was reached for
//     a reason that may well be transient (a rejected token, rate limiting,
//     a CircleCI server error, a timeout, an unreachable network).
//
// A client that renders either of the last two as "no violations" is broken.
// See web/src/state/policyStore.ts, which keeps them as separate states, and
// web/src/panes/yaml/PolicyStrip.tsx, which words them differently.
type policyResponse struct {
	Available bool   `json:"available"`
	Source    string `json:"source"`
	Reason    string `json:"reason,omitempty"`

	// Status is the engine's verdict, verbatim.
	Status string `json:"status,omitempty"`

	// EnabledRules is every rule that was evaluated, fired or not. Load
	// bearing: without it a verdict cannot be acted on, and a PASS cannot
	// be told apart from "there are no policies".
	EnabledRules []string `json:"enabledRules,omitempty"`

	HardFailures []policyViolationItem `json:"hardFailures,omitempty"`
	SoftFailures []policyViolationItem `json:"softFailures,omitempty"`

	// DecisionReason is the engine's own explanation, which some ERROR
	// decisions carry. Distinct from Reason, which is *this host* saying
	// why it has no decision at all.
	DecisionReason string `json:"decisionReason,omitempty"`

	// OrgSlug and PolicyContext say whose policies were consulted and
	// which bundle, so a surprising verdict can be traced to the right
	// org.
	OrgSlug       string `json:"orgSlug,omitempty"`
	PolicyContext string `json:"policyContext,omitempty"`

	// MetadataSent names the `data.meta` keys this host was able to supply
	// (dotted, e.g. "vcs.branch"). Empty means none were available, and
	// the client is expected to say so: a rule scoped to a project or a
	// branch does not fire without them, so its silence here is not
	// evidence that it would be silent on CircleCI.
	MetadataSent []string `json:"metadataSent,omitempty"`

	// CompiledConfigIncluded reports whether the decision above was made
	// against the same document CircleCI itself evaluates at
	// pipeline-trigger time -- source plus a "_compiled_" key holding the
	// config after 2.1->2.0 compilation (issue #25) -- or against the
	// source alone. Deliberately not `omitempty`: `false` is exactly the
	// case this field exists to report, and it must be sent as loudly as
	// `true` rather than being indistinguishable from a client that never
	// asked. A rule written against `input._compiled_` may not have fired
	// when this is false, even though Status above is a real verdict.
	CompiledConfigIncluded bool `json:"compiledConfigIncluded"`

	// CompiledConfigReason says why the compiled form was left out --
	// compilation failed, the config does not compile, or the two
	// documents could not be merged. Populated only when
	// CompiledConfigIncluded is false.
	CompiledConfigReason string `json:"compiledConfigReason,omitempty"`
}

// policyOwnerResolver caches the one mapping this endpoint needs that cannot
// come from the environment: an org slug to the organization UUID the policy
// endpoints are keyed by.
//
// Cached for the process's lifetime rather than on a TTL, and only on
// success: a slug's UUID does not change under a running editor, and a
// failure that is cached is a failure the user cannot retry out of.
type policyOwnerResolver struct {
	mu    sync.Mutex
	byKey map[string]string
}

func newPolicyOwnerResolver() *policyOwnerResolver {
	return &policyOwnerResolver{byKey: map[string]string{}}
}

func (r *policyOwnerResolver) get(slug string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	id, ok := r.byKey[slug]
	return id, ok
}

func (r *policyOwnerResolver) put(slug, id string) {
	if slug == "" || id == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.byKey[slug] = id
}

// handlePolicyDecide serves POST /api/policy/decide: it submits the given
// config to CircleCI's config-policy decision endpoint for the organization
// that owns this project, and reports the decision.
//
// Read-only, deliberately and permanently. `circleci policy push` and its
// siblings create, edit and delete policy bundles; this editor implements
// none of them, and policyDecider names no method that could.
//
// This is the one place in this program that sends config contents to
// CircleCI for anything other than compilation -- and, since issue #25,
// it compiles the config too, for the same reason /api/validate does and
// disclosed the same way: not a new outbound flow, the same one this
// editor's own docs page already names ("What leaves your machine" in
// internal/guides/editor/using-this-editor.adoc). That is stated in the UI
// (PolicyStrip) too, and the check only runs when the user asks for it —
// never on a keystroke.
//
// The compile step exists so the decision endpoint can be asked with the
// same document CircleCI itself asks its policies with: source config plus
// a "_compiled_" key holding the config after 2.1->2.0 compilation. Before
// issue #25 this handler sent the source alone, which is exactly wrong for
// a policy written against `input._compiled_` -- the key is simply absent
// rather than failing, so such a policy could PASS here and HARD_FAIL for
// real. Compilation failing, or the config not compiling, degrades this
// check to source-only rather than cancelling it, and CompiledConfigReason
// says so -- see policyResponse.CompiledConfigIncluded's own doc comment
// for why that degradation must never be silent.
func (s *Server) handlePolicyDecide(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	defer func() { _ = r.Body.Close() }()

	var req policyRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "malformed request body")
		return
	}
	if req.Contents == nil {
		writeError(w, http.StatusBadRequest, "missing required field: contents")
		return
	}

	if !s.env.HasToken() || s.policyClient == nil {
		writePolicyUnavailable(w, "no CircleCI API token available; a policy check needs a token")
		return
	}
	if strings.TrimSpace(*req.Contents) == "" {
		writePolicyUnavailable(w, "this file is empty, so there is nothing to evaluate against your policies")
		return
	}

	orgSlug := s.env.OrgSlug()
	if orgSlug == "" {
		writePolicyUnavailable(w, "which organization owns this project could not be determined, "+
			"and config policies belong to an organization")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), policyDecisionTimeout)
	defer cancel()

	ownerID, outcome := s.resolvePolicyOwner(ctx, orgSlug)
	if !outcome.succeeded {
		if outcome.retryable {
			writeError(w, http.StatusBadGateway, outcome.reason)
			return
		}
		writePolicyUnavailable(w, outcome.reason)
		return
	}

	metadata, metadataSent := s.policyMetadata()

	// Compiled in this project's own org context, the same as the decision
	// itself is about to be: private orbs and org-scoped contexts resolve
	// the same way here as they would if this config were actually
	// triggered, rather than compiling "as if anonymous" the way
	// /api/validate must (it runs before an org is known at all -- see its
	// own OwnerID comment).
	configForDecision, compiledIncluded, compiledUnavailableReason := s.buildPolicyInput(ctx, *req.Contents, ownerID)

	decision, err := s.policyClient.DecidePolicy(ctx, circleci.PolicyDecisionRequest{
		OwnerID:       ownerID,
		PolicyContext: circleci.DefaultPolicyContext,
		ConfigYAML:    configForDecision,
		Metadata:      metadata,
	})
	if err != nil {
		// The action names no org and quotes no config: the request line
		// and status code are the whole of what is useful, and the rest is
		// exactly what must not be written down. See logUpstreamFailure's
		// rule, which this follows.
		logPolicyUpstreamFailure("evaluate this config against the organization's config policies", err)

		switch {
		case circleci.IsForbidden(err):
			// The endpoint answers 403 both when the org's plan does not
			// include config policies and when the token cannot see the
			// org. This host cannot tell which without reading the
			// response body, which it will not do — so it says both
			// rather than picking one.
			writePolicyUnavailable(w, "CircleCI refused this request (HTTP 403). Config policies are a Scale-plan "+
				"feature, and reading them also needs a token with access to this organization — this editor "+
				"cannot tell which of the two applies")
		case circleci.IsBadRequest(err):
			writePolicyUnavailable(w, "CircleCI could not read this config as policy input (HTTP 400). "+
				"The policy engine parses the file itself, so a config it cannot parse is never evaluated")
		default:
			writeError(w, http.StatusBadGateway,
				"could not check this config against your organization's policies: "+describeUpstreamError(err))
		}
		return
	}

	if !decision.Status.Known() {
		// A status this build does not model cannot be rendered as a
		// verdict. Saying so is the only safe answer: mapping an
		// unrecognised status onto the nearest familiar one is how a
		// future blocking state would be shown as a pass.
		writePolicyUnavailable(w, "CircleCI returned a policy status this editor does not recognise "+
			"("+sanitizeStatusForDisplay(string(decision.Status))+"), so it cannot be shown as a verdict")
		return
	}

	writeJSON(w, http.StatusOK, policyResponse{
		Available:              true,
		Source:                 "api",
		Status:                 string(decision.Status),
		EnabledRules:           decision.EnabledRules,
		HardFailures:           toPolicyViolationItems(decision.HardFailures),
		SoftFailures:           toPolicyViolationItems(decision.SoftFailures),
		DecisionReason:         decision.Reason,
		OrgSlug:                orgSlug,
		PolicyContext:          circleci.DefaultPolicyContext,
		MetadataSent:           metadataSent,
		CompiledConfigIncluded: compiledIncluded,
		CompiledConfigReason:   compiledUnavailableReason,
	})
}

// buildPolicyInput compiles contents in ownerID's org context and, when that
// succeeds, merges the result into contents under a "_compiled_" key via
// circleci.MergePolicyInput -- the document to send as the decision
// endpoint's `input`, matching what CircleCI's own evaluator sees at
// pipeline-trigger time (issue #25).
//
// Never fails outright: a config that cannot be compiled, does not compile,
// or (surprisingly) cannot be merged after compiling successfully all
// degrade to returning contents unchanged, with a reason explaining which.
// A policy check that could not include the compiled form is still a policy
// check -- CompiledConfigReason's own doc comment is why silently returning
// the source-only document is exactly what this must not do.
func (s *Server) buildPolicyInput(ctx context.Context, contents, ownerID string) (input string, compiledIncluded bool, reason string) {
	result, err := s.compiler.CompileConfig(ctx, circleci.CompileRequest{
		ConfigYAML: contents,
		OwnerID:    ownerID,
	})
	if err != nil {
		logPolicyUpstreamFailure("compile this config for the policy check's _compiled_ input", err)
		return contents, false, "this config could not be compiled (" + describeUpstreamError(err) + ")"
	}
	if !result.Valid {
		return contents, false, "this config did not compile, so there is no compiled form to include"
	}

	merged, err := circleci.MergePolicyInput(contents, result.OutputYAML)
	if err != nil {
		// Compiling a config CircleCI itself just called valid should never
		// leave either document unparseable to this host's own YAML
		// decoder -- if it somehow does, that is a fact worth a log line,
		// not a reason to fail the whole check.
		//nolint:gosec // G706: the interpolated value passes through sanitizeForLog, which replaces every control character (newlines included) and bounds the length, so it cannot forge a log line; gosec's taint analysis does not recognise the sanitizer. Same false positive logPolicyUpstreamFailure already carries a nolint for.
		log.Printf("policy: could not merge compiled config into policy input: %s", sanitizeForLog(err.Error()))
		return contents, false, "the compiled config could not be merged into the policy input"
	}
	return merged, true, ""
}

// policyOwnerOutcome is why resolving the organization UUID did or did not
// work. retryable separates "this will not work until something changes"
// (answered at HTTP 200 as available:false) from "try again" (answered as
// HTTP 502), which is the same split the decision call itself uses.
type policyOwnerOutcome struct {
	succeeded bool
	retryable bool
	reason    string
}

// resolvePolicyOwner turns the "<vcs>/<org>" slug this host assembled from
// its environment into the organization UUID the policy endpoints are keyed
// by — the same two-step `circleci policy decide --org <slug>` performs.
//
// A successful lookup is remembered for the life of the process; a failed
// one never is.
func (s *Server) resolvePolicyOwner(ctx context.Context, orgSlug string) (string, policyOwnerOutcome) {
	id, err := s.resolveOwnerID(ctx, orgSlug)
	if err == nil {
		return id, policyOwnerOutcome{succeeded: true}
	}

	if errors.Is(err, errOrganizationHasNoID) {
		return "", policyOwnerOutcome{reason: "CircleCI's record for " + orgSlug +
			" carries no organization id, and the config-policy API is addressed by id"}
	}

	// Deliberately does not name the org: the slug is useful to the
	// user (who can see it in the app bar already) but adds nothing to
	// a log line, and this endpoint's logging budget is the status
	// code and the request line.
	logPolicyUpstreamFailure("look up the organization that owns this project", err)

	switch {
	case circleci.IsNotFound(err):
		return "", policyOwnerOutcome{reason: "CircleCI has no organization matching " + orgSlug +
			" (HTTP 404), so there are no policies to check against. " +
			"This host builds that name from the environment the CircleCI CLI passed it"}
	case circleci.IsForbidden(err):
		return "", policyOwnerOutcome{reason: "this token does not have permission to read the organization " +
			orgSlug + " (HTTP 403), so its policies cannot be consulted"}
	default:
		return "", policyOwnerOutcome{
			retryable: true,
			reason:    "could not look up this project's organization on CircleCI: " + describeUpstreamError(err),
		}
	}
}

// errOrganizationHasNoID reports that CircleCI answered with an organization
// record carrying no id. Distinguished from a transport or status failure
// because there is nothing to retry and nothing upstream to blame: the lookup
// worked, the answer just cannot key an id-addressed API.
var errOrganizationHasNoID = errors.New("host: organization record carries no id")

// resolveOwnerID turns the "<vcs>/<org>" slug this host assembled from its
// environment into the organization UUID CircleCI's id-addressed APIs are
// keyed by — the same two-step `circleci policy decide --org <slug>` and
// `circleci config validate --org <slug>` both perform.
//
// Deliberately free of any one caller's vocabulary. Config policies were the
// first feature to need an org UUID, so this lookup used to live inside
// resolvePolicyOwner along with policy-specific prose; config compilation
// needs the identical lookup (see compileOwnerID), and duplicating it would
// have meant two caches and two round trips for one fact. Callers map the
// error to whatever their own surface should say.
//
// A successful lookup is remembered for the life of the process; a failed one
// never is.
func (s *Server) resolveOwnerID(ctx context.Context, orgSlug string) (string, error) {
	if cached, ok := s.policyOwners.get(orgSlug); ok {
		return cached, nil
	}

	org, err := s.policyClient.GetOrganization(ctx, orgSlug)
	if err != nil {
		return "", err
	}
	if org.ID == "" {
		return "", errOrganizationHasNoID
	}

	s.policyOwners.put(orgSlug, org.ID)
	return org.ID, nil
}

// policyMetadata builds the `data.meta` document policies can branch on,
// from what the CLI plugin environment actually told this host, plus the
// dotted names of whatever went in.
//
// Only facts are sent. A policy scoped to one project or one branch does not
// fire without these, so inventing a plausible value would change a verdict
// on a guess — and omitting one silently would let its rule's silence read as
// compliance. Hence the second return value, which the UI states.
func (s *Server) policyMetadata() (map[string]any, []string) {
	metadata := map[string]any{}
	var sent []string

	if s.env.ProjectID != "" {
		metadata["project_id"] = s.env.ProjectID
		sent = append(sent, "project_id")
	}
	if s.env.Branch != "" {
		metadata["vcs"] = map[string]any{"branch": s.env.Branch}
		sent = append(sent, "vcs.branch")
	}

	if len(metadata) == 0 {
		return nil, nil
	}
	return metadata, sent
}

// writePolicyUnavailable answers "no decision was reached, and this is why",
// at HTTP 200. Every caller's reason is a complete sentence fragment the UI
// appends to its own "couldn't check" wording.
func writePolicyUnavailable(w http.ResponseWriter, reason string) {
	writeJSON(w, http.StatusOK, policyResponse{
		Available: false,
		Source:    "unavailable",
		Reason:    reason,
	})
}

func toPolicyViolationItems(violations []circleci.PolicyViolation) []policyViolationItem {
	if len(violations) == 0 {
		return nil
	}
	items := make([]policyViolationItem, len(violations))
	for i, v := range violations {
		items[i] = policyViolationItem{Rule: v.Rule, Reason: v.Reason}
	}
	return items
}

// sanitizeStatusForDisplay bounds and de-controls an unrecognised status
// before it is quoted back to the browser. It is upstream text, and the one
// place this endpoint echoes any, so it gets the same treatment log lines
// get.
func sanitizeStatusForDisplay(status string) string {
	cleaned := sanitizeForLog(status)
	if len(cleaned) > 40 {
		cleaned = cleaned[:40] + "…"
	}
	if cleaned == "" {
		return `""`
	}
	return `"` + cleaned + `"`
}

// logPolicyUpstreamFailure is logUpstreamFailure's counterpart for this
// endpoint: one line on stderr, carrying only the class of failure and, for
// a status failure, the code and request line. Never the response body,
// never the decision, never an org identifier, never a token.
func logPolicyUpstreamFailure(action string, err error) {
	//nolint:gosec // G706: both interpolated values pass through sanitizeForLog, which replaces every control character (newlines included) and bounds the length, so neither can forge a log line; gosec's taint analysis does not recognise the sanitizer.
	log.Printf("policy: failed to %s: %s",
		sanitizeForLog(action), sanitizeForLog(upstreamErrorLogDetail(err)))
}
