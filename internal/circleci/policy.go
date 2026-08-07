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
	"strings"

	"gopkg.in/yaml.v3"
)

// The config-policy endpoints, read off the CircleCI CLI rather than guessed.
//
// `circleci policy decide --input <file> --org <slug>` makes exactly two
// requests, verified by running it under --debug against a real org on
// 2026-07-29:
//
//	GET  /api/v2/organization/gh/CircleCI-Labs
//	POST /api/v2/owner/<owner-uuid>/context/config/decision
//
// i.e. the decision endpoint is keyed by the organization's *UUID*, and a
// slug has to be resolved to one first. Both accept a personal API token in
// the Circle-Token header (see this package's policy_test.go and issue #215
// for the probe: the same POST without the header answers 401).
const (
	// organizationPathFormat takes a "<vcs>/<org>" slug. Segments are
	// escaped by the caller, not by fmt.
	organizationPathFormat = "/api/v2/organization/%s"

	// policyDecisionPathFormat takes the owner UUID and the policy context.
	policyDecisionPathFormat = "/api/v2/owner/%s/context/%s/decision"
)

// DefaultPolicyContext is the policy context `circleci policy decide` uses
// when --policy-context is not given. An org can hold several bundles, one
// per context; "config" is the one that governs pipeline configs.
const DefaultPolicyContext = "config"

// PolicyStatus is the verdict the policy engine returns for a config.
//
// This is a *separate axis* from config validity: a config that compiles
// perfectly can HARD_FAIL, and a config that does not compile at all never
// reaches a policy at all. Callers must not collapse the two.
type PolicyStatus string

const (
	// PolicyStatusPass means every enabled rule was satisfied.
	PolicyStatusPass PolicyStatus = "PASS"

	// PolicyStatusSoftFail means at least one rule flagged the config but
	// none of the failing rules block a pipeline. It is a real third
	// state and must render as neither pass nor fail.
	PolicyStatusSoftFail PolicyStatus = "SOFT_FAIL"

	// PolicyStatusHardFail means at least one blocking rule failed: on
	// CircleCI itself, a pipeline with this config would be refused.
	PolicyStatusHardFail PolicyStatus = "HARD_FAIL"

	// PolicyStatusError means the engine could not reach a verdict — a
	// policy that failed to evaluate, for instance. It is emphatically not
	// a pass.
	PolicyStatusError PolicyStatus = "ERROR"
)

// Known reports whether s is one of the four statuses this client
// understands. An unknown status must be surfaced as "we could not
// interpret the answer" rather than mapped onto the nearest familiar one —
// silently reading a future SOFT_BLOCK as a pass is exactly the false
// all-clear this feature must never produce.
func (s PolicyStatus) Known() bool {
	switch s {
	case PolicyStatusPass, PolicyStatusSoftFail, PolicyStatusHardFail, PolicyStatusError:
		return true
	default:
		return false
	}
}

// PolicyViolation is one rule that fired, with the reason the policy itself
// printed. Reason is policy-author prose: it is shown verbatim and never
// reworded, and it is the only thing that makes a verdict actionable.
type PolicyViolation struct {
	// Rule is the Rego rule name, e.g. "use_official_docker_image".
	Rule string `json:"rule"`

	// Reason is the policy's own message.
	Reason string `json:"reason"`
}

// PolicyDecision is the decision the engine returned.
//
// Note what is *not* here. The CLI's `policy decide --json` help lists
// "violations" and "metadata" among the response fields; the decision
// endpoint returns neither (verified against the live API on 2026-07-29 for
// PASS, SOFT_FAIL and HARD_FAIL responses — the wire fields are status,
// enabled_rules, hard_failures and soft_failures, and the CLI binary
// contains no `json:"violations"` tag). "Violations" is the umbrella term
// for the two failure lists, not a third one, so this type does not invent a
// field that would always be empty.
type PolicyDecision struct {
	// Status is the verdict. Always populated by a successful call, but
	// check Known() before interpreting it.
	Status PolicyStatus

	// EnabledRules names every rule that was evaluated, whether or not it
	// fired. Empty means the org's bundle for this context contains no
	// enabled rules — which is why "PASS with no enabled rules" must not
	// be reported as "this config satisfies your policies".
	EnabledRules []string

	// HardFailures are the blocking violations, SoftFailures the
	// non-blocking ones. A HARD_FAIL decision can carry both.
	HardFailures []PolicyViolation
	SoftFailures []PolicyViolation

	// Reason is the engine's own explanation, populated for some ERROR
	// decisions.
	Reason string
}

// PolicyDecisionRequest is the input to DecidePolicy.
type PolicyDecisionRequest struct {
	// OwnerID is the organization's UUID. Required: the decision endpoint
	// is keyed by it, and DecidePolicy refuses rather than building a URL
	// with an empty path segment.
	OwnerID string

	// PolicyContext selects which of the org's bundles to evaluate
	// against. Defaults to DefaultPolicyContext when empty.
	PolicyContext string

	// ConfigYAML is the document sent verbatim as `input`.
	//
	// Historically this was always the user's source config exactly as
	// written, and nothing else: CircleCI's own trigger-time evaluation
	// additionally injects a "_compiled_" key holding the config after
	// 2.1->2.0 compilation, and a policy written against
	// `input._compiled_` (which the docs' own expanded-value examples
	// require) saw only the source here -- a false PASS on a config that
	// would HARD_FAIL for real, which is the one failure mode this feature
	// exists to rule out. Synthesising that key from nothing was rejected
	// for the opposite reason: composing a YAML document this editor
	// invented and posting it as though CircleCI's own compiler had
	// produced it (#215).
	//
	// Issue #25 resolves both without contradicting either. The caller
	// (handlePolicyDecide) compiles the config itself -- the same call
	// /api/validate already makes -- and uses MergePolicyInput to place
	// that real compiled result where CircleCI's own evaluator puts it, so
	// ConfigYAML may now already carry a genuine "_compiled_" key built
	// from CircleCI's own answer, not a guess at one. This field still
	// never invents anything: when compilation is unavailable the caller
	// passes the bare source through unchanged, exactly as before, and
	// must say so rather than let that decision look identical to one that
	// did see the compiled form.
	ConfigYAML string

	// Metadata populates the `data.meta` document policies can branch on
	// (project_id, vcs.branch, and so on). It materially changes the
	// verdict — a rule scoped to one project simply does not fire without
	// it — so callers should send what they actually know and say what
	// they sent.
	Metadata map[string]any
}

// policyDecisionWireRequest is the JSON request body for the decision
// endpoint. `input` carries the config as a string (the endpoint parses it
// itself); a request without it is rejected 400 "input: cannot be blank".
type policyDecisionWireRequest struct {
	Input    string         `json:"input"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// policyDecisionWireResponse is the JSON response body of the decision
// endpoint. Every field but status is omitted when empty, so a PASS against
// an empty bundle is the single-field body `{"status":"PASS"}`.
type policyDecisionWireResponse struct {
	Status       string            `json:"status"`
	EnabledRules []string          `json:"enabled_rules"`
	HardFailures []PolicyViolation `json:"hard_failures"`
	SoftFailures []PolicyViolation `json:"soft_failures"`
	Reason       string            `json:"reason"`
}

// Organization is the minimum a caller needs to address an org by UUID after
// starting from a slug.
type Organization struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Slug    string `json:"slug"`
	VCSType string `json:"vcsType"`
}

// organizationWireResponse is the JSON response body of
// GET /api/v2/organization/<slug>.
type organizationWireResponse struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Slug    string `json:"slug"`
	VCSType string `json:"vcs_type"`
}

// ErrPolicyOwnerRequired is returned by DecidePolicy when OwnerID is empty.
// Not a request that fails upstream — a request this client declines to
// make, because "/api/v2/owner//context/config/decision" would be a
// different endpoint entirely.
var ErrPolicyOwnerRequired = errors.New("circleci: policy decision requires an organization ID")

// ErrOrganizationSlugRequired is returned by GetOrganization when slug is
// empty, for the same reason.
var ErrOrganizationSlugRequired = errors.New("circleci: organization lookup requires a slug")

// GetOrganization resolves a "<vcs>/<org>" slug (or an org UUID, which this
// endpoint also accepts) to the organization record, whose ID is what the
// policy endpoints are keyed by.
//
// This is the same lookup `circleci policy decide --org <slug>` performs
// before making a decision. A 404 means the slug names no organization this
// token can see, which is a fact about the slug rather than about the
// network — see IsNotFound.
func (c *Client) GetOrganization(ctx context.Context, slug string) (*Organization, error) {
	if slug == "" {
		return nil, ErrOrganizationSlugRequired
	}

	// The slug is two path segments ("gh/acme"), so its separator must
	// survive escaping while everything else in it does not.
	path := fmt.Sprintf(organizationPathFormat, escapePathSegments(slug))

	var wire organizationWireResponse
	if err := c.do(ctx, http.MethodGet, path, nil, &wire); err != nil {
		return nil, err
	}
	return &Organization{
		ID:      wire.ID,
		Name:    wire.Name,
		Slug:    wire.Slug,
		VCSType: wire.VCSType,
	}, nil
}

// DecidePolicy evaluates req.ConfigYAML against the organization's policy
// bundle and returns the engine's decision.
//
// Read-only by construction: this package deliberately implements no
// counterpart to `circleci policy push` (creating, editing or deleting a
// bundle), so no caller in this program can reach one.
//
// Like CompileConfig, the Go error and the verdict are different things. A
// nil error means the engine answered; the answer may perfectly well be
// HARD_FAIL. A non-nil error means no verdict was reached at all — a
// transport failure, a rejected token, a 403 (config policies are a
// Scale-plan feature and the endpoint answers 403 when the org's plan does
// not include them), a 400 (the input was not parseable as a config), or a
// malformed response. Callers must never render an error as a pass.
func (c *Client) DecidePolicy(ctx context.Context, req PolicyDecisionRequest) (*PolicyDecision, error) {
	if req.OwnerID == "" {
		return nil, ErrPolicyOwnerRequired
	}
	policyContext := req.PolicyContext
	if policyContext == "" {
		policyContext = DefaultPolicyContext
	}

	path := fmt.Sprintf(policyDecisionPathFormat,
		url.PathEscape(req.OwnerID), url.PathEscape(policyContext))

	wireReq := policyDecisionWireRequest{
		Input:    req.ConfigYAML,
		Metadata: req.Metadata,
	}

	var wire policyDecisionWireResponse
	if err := c.do(ctx, http.MethodPost, path, wireReq, &wire); err != nil {
		return nil, err
	}

	return &PolicyDecision{
		Status:       PolicyStatus(wire.Status),
		EnabledRules: wire.EnabledRules,
		HardFailures: wire.HardFailures,
		SoftFailures: wire.SoftFailures,
		Reason:       wire.Reason,
	}, nil
}

// MergePolicyInput builds the document CircleCI's own policy engine
// evaluates at pipeline-trigger time: sourceYAML's own top-level keys, plus
// a "_compiled_" key holding compiledYAML parsed into the same nested
// object CircleCI's own compiled config produces.
//
// The shape is not a guess. `circleci policy eval --help` documents it
// directly ("the source config is made available to policies with its
// compiled form nested under a "_compiled_" key"), and running it live on
// 2026-08-07 against a config with a reusable executor confirmed it: the
// resulting input._compiled_.jobs carried the executor already inlined
// (resource_class on the job itself, no top-level "executors" key at all),
// exactly the shape this package's vendored docs assume in their own
// input._compiled_.jobs examples
// (config-policy-management-overview.adoc). A key with a nearly-right name
// but the wrong shape under it -- a raw compiled-YAML string, say, instead
// of a parsed document -- would be the same false-PASS bug with more
// steps, so this was checked against the real evaluator rather than
// inferred from the docs' prose alone.
//
// This is not the fabrication DecidePolicy's ConfigYAML doc comment
// describes issue #215 rejecting: MergePolicyInput never invents a
// compiled config. Callers must supply compiledYAML from CircleCI's own
// CompileConfig response for this exact sourceYAML; this function only
// places what CircleCI's compiler already returned where CircleCI's own
// evaluator would put it.
func MergePolicyInput(sourceYAML, compiledYAML string) (string, error) {
	var source map[string]any
	if err := yaml.Unmarshal([]byte(sourceYAML), &source); err != nil {
		return "", fmt.Errorf("circleci: parse source config for policy input: %w", err)
	}
	var compiled map[string]any
	if err := yaml.Unmarshal([]byte(compiledYAML), &compiled); err != nil {
		return "", fmt.Errorf("circleci: parse compiled config for policy input: %w", err)
	}
	if source == nil {
		source = map[string]any{}
	}

	// CircleCI's own trigger-time input does the same single-key
	// assignment, not a deep merge: whatever a source config happens to
	// hold under a literal "_compiled_" key already (nobody writes one) is
	// superseded, exactly as it would be for real.
	source["_compiled_"] = compiled

	merged, err := yaml.Marshal(source)
	if err != nil {
		return "", fmt.Errorf("circleci: render merged policy input: %w", err)
	}
	return string(merged), nil
}

// escapePathSegments escapes each "/"-separated segment of s individually,
// so a two-segment slug ("gh/acme") stays two segments while anything
// unusual inside a segment is encoded rather than changing the shape of the
// URL. The segment count is preserved exactly, empty segments included: a
// caller's malformed slug must produce a request that fails, not a request
// against a different endpoint.
func escapePathSegments(s string) string {
	segments := strings.Split(s, "/")
	for i, segment := range segments {
		segments[i] = url.PathEscape(segment)
	}
	return strings.Join(segments, "/")
}
