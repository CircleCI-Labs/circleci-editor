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
//     2026-08-07 against https://mcp.circleci.com/v1/mcp, see the per-tool
//     comments), and they agree with the classification below on every
//     tool. That agreement is corroborating evidence this classification is
//     right, not the mechanism enforcing it -- trusting the server's own
//     hint at request time would mean a compromised or simply updated
//     server could mark a new destructive tool readOnlyHint:true and this
//     app would believe it. The list below is reviewed by a human each time
//     it changes; the wire never is.
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
// either). Verified live 2026-08-07 with a raw MCP initialize + tools/list
// call authenticated by a personal API token as an `Authorization: Bearer`
// header -- the same CIRCLE_TOKEN this app's other CircleCI-backed features
// already read from the CLI plugin environment (see internal/host/env.go),
// so no separate credential or sign-in flow is needed to reach it.
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

// toolClassifications is the single source of truth for this package: every
// tool this app has ever seen CircleCI's hosted MCP server advertise, and
// what it does. A tool absent from this map entirely -- one the server adds
// after this file is next updated -- is handled by IsReadOnly exactly like
// an explicit ClassWrite entry: gated. There is no way to add a tool to
// AllowedTools without adding it here first, by hand, which is the point.
//
// Observed live 2026-08-07 three independent ways that agree on every name
// and every classification: (1) an authenticated tools/list call against
// https://mcp.circleci.com/v1/mcp using a real CIRCLE_TOKEN as an
// Authorization: Bearer header, whose response's own MCP
// readOnlyHint/destructiveHint annotations are quoted below per tool; (2)
// CircleCI's own published documentation
// (circleci.com/docs/guides/toolkit/circleci-mcp-overview/), which lists
// the identical thirteen tools with identical descriptions; (3) calling the
// read tools live (hello, list_runs, get_run, list_workflows) against a
// real, already-authenticated session and inspecting the actual responses.
// No write tool (cancel_workflow, rerun_workflow, download_usage_data) was
// ever called against the live server while establishing this list --
// their classification here rests on their description and the server's
// own annotations, never on having exercised their effect.
var toolClassifications = map[string]Classification{
	// "Verify connectivity to the CircleCI MCP server." No input, no
	// state read beyond the caller's own identity. Server annotation:
	// readOnlyHint=true.
	"hello": ClassRead,
	// Lists runs for a project or the caller's own runs. Server
	// annotation: readOnlyHint=true.
	"list_runs": ClassRead,
	// Fetches one run's phase/outcome/VCS details by UUID. Server
	// annotation: readOnlyHint=true.
	"get_run": ClassRead,
	// Lists the workflows belonging to a run. Server annotation:
	// readOnlyHint=true.
	"list_workflows": ClassRead,
	// Fetches one workflow's name/phase/outcome by UUID. Server
	// annotation: readOnlyHint=true.
	"get_workflow": ClassRead,
	// Lists the jobs belonging to a workflow. Server annotation:
	// readOnlyHint=true.
	"list_jobs": ClassRead,
	// Fetches one job's phase/outcome/per-step detail by UUID. Server
	// annotation: readOnlyHint=true.
	"get_job": ClassRead,
	// Fetches a job's step output -- the tool that answers "why did this
	// build fail", this feature's whole motivating question. Server
	// annotation: readOnlyHint=true.
	"get_job_logs": ClassRead,
	// Lists a job's persisted artifacts (paths and download URLs). Server
	// annotation: readOnlyHint=true.
	"list_artifacts": ClassRead,
	// Lists a job's test results. Server annotation: readOnlyHint=true.
	"list_job_tests": ClassRead,

	// Cancels a running workflow. Costs nothing further but stops work an
	// organisation is already paying for and is visible to everyone
	// watching that pipeline -- exactly the "acts, and is visible to a
	// whole organisation" case issue #11 names explicitly. Server
	// annotation: destructiveHint=true, idempotentHint=true; no
	// readOnlyHint.
	"cancel_workflow": ClassWrite,
	// Reruns a workflow -- new compute spend, a new workflow record, and
	// (issue #11's other named example) visible org-wide. Server
	// annotation: destructiveHint=false, but critically still no
	// readOnlyHint=true: the server itself does not claim this is safe to
	// treat as a read.
	"rerun_workflow": ClassWrite,
	// A two-phase tool: phase one *starts* an asynchronous usage-data
	// export job scoped to a whole billing organisation before anything
	// can be downloaded. That is a side effect -- a job created, storage
	// consumed, an export quota spent -- not a state read, even though it
	// is not "destructive" in the sense cancelling or rerunning a
	// workflow is. Server annotation: destructiveHint=false, and (like
	// rerun_workflow) no readOnlyHint=true. Gated out of the same
	// caution the package doc describes: something that starts a
	// process is not a read merely because it is not destructive.
	"download_usage_data": ClassWrite,
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
