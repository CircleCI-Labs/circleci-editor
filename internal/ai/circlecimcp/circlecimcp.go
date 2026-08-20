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

// Package circlecimcp is the policy layer for issue #11: which tools of
// CircleCI's own hosted MCP server this app will let the assistant call
// directly, and which it must never be given at all.
//
// # Why this is a separate package from internal/ai/anthropic
//
// internal/ai/anthropic's package doc is explicit that it has "no opinion
// about which MCP server a caller configures" -- it is a thin, generic
// translation of ai.MCPServer into Anthropic's wire format, and stays that
// way on purpose so a second provider costs a new package, not a rewrite.
// The policy question this package answers -- *which of CircleCI's tools
// may this app hand to a model at all* -- is not generic; it is specific
// knowledge about one server's tools and what each one does, and it has to
// live somewhere that is not "wherever the request happens to be built", or
// it will drift the moment either changes without the other.
//
// # The read/write split is the feature, not a detail
//
// CircleCI's hosted MCP server exposes tools that act -- cancelling a
// workflow, rerunning one, kicking off a usage export -- alongside tools
// that only read. Running a pipeline or rerunning a job costs money and is
// visible to a whole organisation; this editor already treats triggering a
// pipeline as deliberately awkward in proportion (see internal/host/run.go),
// and an assistant that could reach a write tool on its own initiative would
// route straight around that. So:
//
//   - Read tools may be handed to the assistant directly. Worst case is a
//     wrong answer the user can check against the CircleCI web UI.
//   - Write tools must never be reachable through this path at all, until a
//     future "the assistant proposes, the user confirms" flow exists to gate
//     them the same way a config edit already is (see actionSchemaPrompt in
//     internal/host/ai.go) -- issue #11 tracks that follow-up. This package
//     draws the read/write line; it does not build that flow.
//
// # Deny-by-default, and why that is the one property that matters
//
// AllowedTools returns a hardcoded allowlist, not "everything the server's
// own tools/list response claims is safe". Two reasons:
//
//  1. A tool CircleCI adds to the server after this file was last updated
//     must start out gated, not exposed because nobody noticed it arrive.
//     An allowlist gates the unknown by construction -- IsReadOnly returns
//     false for any name that is not in toolClassifications, with no third
//     "not sure yet, allow it" outcome available to return.
//  2. The MCP tools/list response for every tool below already carries the
//     spec's own readOnlyHint/destructiveHint annotations (verified live
//     2026-08-20 against https://mcp.circleci.com/v1/mcp, see the per-tool
//     comments), and they agree with the classification below on every
//     tool. That agreement is corroborating evidence this classification is
//     right, not the mechanism enforcing it -- trusting the server's own
//     hint at request time would mean a compromised or simply updated
//     server could mark a new destructive tool readOnlyHint:true and this
//     app would believe it. The list below is reviewed by a human each time
//     it changes; the wire never is. `task mcp:check-tools` is that review's
//     tripwire: it diffs this file against a live tools/list and fails
//     when the two disagree, so drift is a command's exit code away from
//     being noticed instead of resting on someone remembering to look.
//
// # How the list actually stops a model from calling a gated tool
//
// AllowedTools feeds ai.MCPServer.AllowedTools, which internal/ai/anthropic
// turns into the MCP connector's own denylist-by-default mechanism
// (default_config.enabled=false plus one configs entry per allowed tool --
// see that package's Complete). Anthropic's own documentation names this
// exact pattern for this exact purpose: "Denylisting write or destructive
// tools is recommended when building read-only assistants, or when you want
// a human confirmation step before state changes" (MCP connector docs,
// checked 2026-08-07 against the current mcp-client-2025-11-20 connector).
// A tool that is not enabled is never offered to the model as something it
// can call, so this is enforced before the model produces a single token of
// output for this turn -- nothing the model says in its reply can put a
// disabled tool back on the table, because the tool list a model sees is
// fixed before the model runs at all.
//
// # The server this targets
//
// https://mcp.circleci.com/v1/mcp -- CircleCI's own hosted remote MCP
// server (as opposed to CircleCI-Public/mcp-server-circleci, the
// self-hosted npx package with a different, larger tool surface and
// different tool names; this app never runs anything locally to reach
// either). Verified live most recently 2026-08-20 with a raw JSON-RPC
// tools/list call -- no initialize handshake required -- authenticated via
// the `Circle-Token` header, the same CIRCLE_TOKEN this app's other
// CircleCI-backed features already read from the CLI plugin environment
// (see internal/host/env.go), so no separate credential or sign-in flow is
// needed to reach it. `task mcp:check-tools` runs the identical call; see
// its Taskfile.yml entry for why it is a manual, human-run target rather
// than something CI or `task check` runs on every commit.
package circlecimcp

import "sort"

// ServerName is the ai.MCPServer.Name this app sends for CircleCI's hosted
// MCP server -- the connector's own mcp_servers[].name /
// tools[].mcp_toolset.mcp_server_name correlation key. Distinct from
// "circleci-docs" (internal/host/ai.go's docs-grounding slot): the two
// servers are unrelated, BYO-configured differently (this one needs no
// user-supplied URL or token -- it rides the CLI plugin's own CIRCLE_TOKEN),
// and a single Anthropic request may attach both at once.
const ServerName = "circleci"

// URL is CircleCI's hosted MCP server endpoint. See the package doc for how
// this was verified.
const URL = "https://mcp.circleci.com/v1/mcp"

// Classification says what a tool call actually does to the world.
type Classification string

const (
	// ClassRead means the tool only ever reads state -- it cannot trigger,
	// cancel, rerun, approve, or otherwise change anything on CircleCI or
	// bill the organisation for compute. Eligible for AllowedTools.
	ClassRead Classification = "read"
	// ClassWrite means the tool changes state, costs money, starts an
	// asynchronous side-effecting process, or is not affirmatively
	// documented by the server as read-only. Never eligible for
	// AllowedTools, regardless of how useful it would be -- see the
	// package doc's read/write split.
	ClassWrite Classification = "write"
)

// toolClassifications is the single source of truth for this package. It
// classifies all 24 tools CircleCI's hosted MCP server currently advertises
// -- not a subset picked because they seemed relevant -- which is what
// makes this map a complete mirror of the server's own tools/list response.
// That completeness is exactly what makes `task mcp:check-tools` meaningful:
// with every tool accounted for, a name that shows up in a live tools/list
// but not here is unambiguous evidence of an upstream addition nobody has
// reviewed yet, rather than something this file simply never bothered to
// track. A tool absent from this map -- whether never seen or removed
// below on purpose -- is handled by IsReadOnly exactly like an explicit
// ClassWrite entry: gated. There is no way to add a tool to AllowedTools
// without adding it here first, by hand, which is the point.
//
// Verified live 2026-08-20 with an authenticated tools/list call against
// https://mcp.circleci.com/v1/mcp: the server advertised exactly these 24
// tools, and the readOnlyHint/destructiveHint annotation quoted per tool
// below is copied from that response. This update replaced a map that had
// silently drifted from the server: three tools had been renamed upstream
// (list_workflows -> list_run_workflows, list_jobs -> list_workflow_jobs,
// list_artifacts -> list_job_artifacts) and a fourth, hello, had been
// removed outright with no replacement. Naming a tool that no longer
// exists in AllowedTools does not error -- internal/ai/anthropic's
// mcpToolset only ever writes a Configs entry for a name it is given, so a
// stale name just enables nothing -- so the drift produced no error
// anywhere; the only symptom was the assistant being structurally unable
// to list a run's workflows, a workflow's jobs, or a job's artifacts,
// discovered only by comparing this file against a fresh tools/list by
// hand. No write tool below (cancel_workflow, rerun_workflow,
// download_usage_data, rollback_deploy_component) was ever called against
// the live server while establishing this list -- their classification
// rests on their description and the server's own annotations, never on
// having exercised their effect.
var toolClassifications = map[string]Classification{
	// The pipeline chain: list_runs -> get_run -> list_run_workflows ->
	// get_workflow -> list_workflow_jobs -> get_job. Each id feeds the
	// next tool; entering mid-chain with an id already in hand is normal.

	// Lists runs for a project or the caller's own runs. Server
	// annotation: readOnlyHint=true.
	"list_runs": ClassRead,
	// Fetches one run's phase/outcome/VCS details by UUID. Server
	// annotation: readOnlyHint=true.
	"get_run": ClassRead,
	// Lists the workflows belonging to a run. Renamed from list_workflows
	// upstream (see this map's doc comment) -- this is the current name.
	// Server annotation: readOnlyHint=true.
	"list_run_workflows": ClassRead,
	// Fetches one workflow's name/phase/outcome by UUID. Server
	// annotation: readOnlyHint=true.
	"get_workflow": ClassRead,
	// Lists the jobs belonging to a workflow. Renamed from list_jobs
	// upstream (see this map's doc comment) -- this is the current name.
	// Server annotation: readOnlyHint=true.
	"list_workflow_jobs": ClassRead,
	// Fetches one job's phase/outcome/per-step detail by UUID, including
	// each step's exit code -- the signal for which step failed. Server
	// annotation: readOnlyHint=true.
	"get_job": ClassRead,

	// Job diagnostics: five tools that each take a job id and answer a
	// different question about it. get_job above is the cheap first stop;
	// these go deeper once it names a failed step.

	// Fetches a job's step output -- the tool that answers "why did this
	// build fail", this feature's whole motivating question. Server
	// annotation: readOnlyHint=true.
	"get_job_logs": ClassRead,
	// Lists a job's test results, filtered to failures by default --
	// far cheaper than get_job_logs when a failed step ran tests. Server
	// annotation: readOnlyHint=true.
	"list_job_tests": ClassRead,
	// Lists a job's persisted artifacts (paths and download URLs).
	// Renamed from list_artifacts upstream (see this map's doc comment)
	// -- this is the current name. Server annotation: readOnlyHint=true.
	"list_job_artifacts": ClassRead,
	// Reports a job's actual CPU/memory usage against its resource
	// class's limits -- the signal for an OOM kill or an oversized
	// instance. Server annotation: readOnlyHint=true.
	"get_job_resource_usage": ClassRead,

	// Orbs, config, and the caller's own identity.

	// Fetches a registry orb's metadata and published version history.
	// Server annotation: readOnlyHint=true.
	"get_orb": ClassRead,
	// Fetches the YAML source of a specific orb version. Server
	// annotation: readOnlyHint=true.
	"get_orb_source": ClassRead,
	// Compiles a config (the `circleci config validate` equivalent) and
	// reports whether it is valid, without running anything. Server
	// annotation: readOnlyHint=true.
	"validate_config": ClassRead,
	// Fetches the authenticated user's own profile. Server annotation:
	// readOnlyHint=true.
	"get_me": ClassRead,

	// Deploys: a separate subsystem keyed on projects and orgs rather
	// than pipeline ids. list_deployments answers "what shipped, and
	// when" directly; the other four chain the way the pipeline tools
	// do -- list_deploy_components/list_deploy_environments feed
	// get_deploy_component/get_deploy_environment and
	// list_deploy_component_versions.

	// Lists a project's recent deployments newest-first. Server
	// annotation: readOnlyHint=true.
	"list_deployments": ClassRead,
	// Lists a project's deployable units (services, applications,
	// libraries). Server annotation: readOnlyHint=true.
	"list_deploy_components": ClassRead,
	// Lists an org's named deploy targets (e.g. production, staging).
	// Server annotation: readOnlyHint=true.
	"list_deploy_environments": ClassRead,
	// Lists a deploy component's version history, newest-first. Server
	// annotation: readOnlyHint=true.
	"list_deploy_component_versions": ClassRead,
	// Fetches a single deploy component by UUID. Server annotation:
	// readOnlyHint=true.
	"get_deploy_component": ClassRead,
	// Fetches a single deploy environment by UUID. Server annotation:
	// readOnlyHint=true.
	"get_deploy_environment": ClassRead,

	// Cancels a running workflow. Costs nothing further but stops work an
	// organisation is already paying for and is visible to everyone
	// watching that pipeline -- exactly the "acts, and is visible to a
	// whole organisation" case issue #11 names explicitly. Server
	// annotation: readOnlyHint=false, destructiveHint=true,
	// idempotentHint=true.
	"cancel_workflow": ClassWrite,
	// Reruns a workflow -- new compute spend, a new workflow record, and
	// (issue #11's other named example) visible org-wide. Server
	// annotation: destructiveHint=false, but critically
	// readOnlyHint=false: the server itself does not claim this is safe
	// to treat as a read.
	"rerun_workflow": ClassWrite,
	// Gated on the server's own annotation, and on nothing else.
	//
	// Every read tool above carries readOnlyHint=true. This one carries
	// readOnlyHint=false and destructiveHint=false (verified against
	// https://mcp.circleci.com/v1/mcp's own tools/list, 2026-08-20 --
	// an earlier draft of this comment said the annotation was absent
	// rather than explicitly false, which understated the case: the
	// server does not merely decline to call this a read, it says it is
	// not one). CircleCI declining to call its own tool a read is the
	// whole justification -- this package's rule is that anything not
	// annotated read-only is gated, and inventing a different reason to
	// reach the same answer would just be a reason that could turn out to
	// be wrong.
	//
	// It is worth being precise about what it is *not*, because an
	// earlier version of this comment was not. It does not run a
	// pipeline, spend build credits, or create anything visible to the
	// organisation as a build. Its own description: a two-phase
	// asynchronous export -- phase one returns an export_id, phase two
	// polls until CircleCI has prepared the data and then returns
	// pre-signed download URLs. CircleCI does that preparation in the
	// background. So it is closer to a read than cancel_workflow or
	// rerun_workflow are, and it is still not annotated as one.
	"download_usage_data": ClassWrite,
	// New since this map was last reviewed, and gated for the most
	// direct reason this package has: its own description opens with
	// "DANGEROUS -- redeploys production software". It rolls a deployed
	// component back to an earlier version -- a real deploy, dispatched
	// as a pipeline run or a release-agent command, that changes what is
	// actually running in an environment such as production. Server
	// annotation: readOnlyHint=false, destructiveHint=true. Unlike
	// download_usage_data there is no case to be made that this is
	// "closer to a read than it looks" -- everything about it, the
	// server's annotation and its own description alike, says the
	// opposite. Until this file was updated to classify all 24 tools it
	// was excluded only by omission, the same way any tool this package
	// has never seen is excluded; naming it here as ClassWrite records,
	// on purpose, that this package has seen it and gated it deliberately.
	"rollback_deploy_component": ClassWrite,
}

// IsReadOnly reports whether tool may be exposed to the assistant directly,
// with no user confirmation step. Deny-by-default: a name this package has
// never classified returns false, identically to an explicit ClassWrite
// entry -- there is no third state in which an unrecognised tool is let
// through. See the package doc for why that has to be true regardless of
// what the server itself claims about a tool at request time.
func IsReadOnly(tool string) bool {
	return toolClassifications[tool] == ClassRead
}

// Classify returns tool's recorded classification and whether this package
// has ever recorded one at all. The second return distinguishes "this is
// explicitly a write tool" from "this package has simply never seen this
// name" -- both gate identically in IsReadOnly, but a caller building a
// diagnostic (or this package's own tests) may care which one actually
// happened.
func Classify(tool string) (Classification, bool) {
	c, ok := toolClassifications[tool]
	return c, ok
}

// AllowedTools returns every tool classified ClassRead, sorted for a
// deterministic wire encoding (see internal/ai/anthropic.Client.Complete,
// which iterates this slice to build the connector's configs map). The
// returned slice is a fresh copy on every call: callers -- today, only
// internal/host/ai.go's loadCircleCIMCPConfig -- must not be able to hand a
// caller-mutated slice back into this package's own idea of what is
// allowed.
func AllowedTools() []string {
	out := make([]string, 0, len(toolClassifications))
	for name, class := range toolClassifications {
		if class == ClassRead {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// AllClassifiedTools returns every tool name this package has ever
// classified, read and write alike, sorted for deterministic output. Unlike
// AllowedTools it is not part of the request-shaping path -- nothing in
// internal/host or internal/ai/anthropic calls it. Its one consumer is
// cmd/check-tools (see Taskfile.yml's mcp:check-tools), which diffs this
// against a live tools/list to find tools this package classifies that the
// server no longer advertises. AllowedTools alone can't show that side of
// the drift: a write tool the server removed would never have appeared in
// AllowedTools to begin with, so a diff against AllowedTools would miss it
// silently -- which is exactly the shape a stale write-tool entry (harmless
// today, but a false sense of having reviewed something upstream already
// dropped) would take.
func AllClassifiedTools() []string {
	out := make([]string, 0, len(toolClassifications))
	for name := range toolClassifications {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}
