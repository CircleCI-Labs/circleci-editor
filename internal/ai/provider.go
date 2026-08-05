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

// Package ai defines the provider-agnostic seam the AI pane (issue #92) is
// built on, plus the Registry that lets internal/host address a provider by
// its short id ("anthropic") without importing any specific provider
// package directly.
//
// Nothing in this package, or in internal/host's handlers built on it,
// knows Anthropic's request/response shape, model names, or API quirks --
// those live entirely in internal/ai/anthropic (and any future sibling
// provider package). That separation is the point: issue #92 asks for
// "Anthropic first, but the seam must not assume one vendor", and a second
// provider should cost a new package implementing Provider plus one
// Registry entry, never a change to internal/host/ai.go or any React
// component.
package ai

import (
	"context"
	"fmt"
	"sort"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
)

// Role identifies which side of the conversation a Message came from.
// Deliberately just the two roles every provider's chat-completions API
// needs to distinguish; a system prompt is passed separately (see
// CompleteRequest.System) since providers treat it structurally
// differently (a dedicated field for Anthropic, a message role for others),
// and callers should never have to know that.
type Role string

// The two roles every provider's chat-completions API needs to distinguish.
const (
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
)

// Message is one turn of a conversation, in the provider-agnostic shape
// every Provider.Complete implementation is responsible for translating
// into its own wire format.
type Message struct {
	Role    Role
	Content string
}

// CompleteRequest is everything a Provider needs to produce one assistant
// reply. System carries the assembled repo-aware context (see
// internal/host/ai.go's buildSystemPrompt) as well as instructions for how
// to propose a config change -- it is built entirely from the currently
// open config file and the frontend's own parsed state, never from walking
// the filesystem, so "never send the whole repo silently" is an invariant
// of how this struct gets constructed, not something Provider
// implementations have to enforce.
type CompleteRequest struct {
	System    string
	Messages  []Message
	MaxTokens int
	// MCPServers optionally attaches one or more remote MCP (Model Context
	// Protocol) servers to this request -- issue #111's answer to "can we
	// ground answers in CircleCI's docs": on a provider that supports it
	// (see internal/ai/anthropic), the provider's own backend calls the
	// server's tools directly and returns results inline, so this is a
	// request-shape addition, never a new subsystem this codebase has to
	// run or proxy. Empty (the default) reproduces today's behaviour
	// exactly -- no field is sent, no tool is available, nothing about a
	// reply changes. See internal/host/ai.go for where a configured server
	// comes from (BYO, same keystore as the provider key itself).
	MCPServers []MCPServer
}

// MCPServer configures one remote MCP server for CompleteRequest.MCPServers.
// Like the provider API key, URL and Token are bring-your-own: nothing in
// this codebase ships a default value for either, and internal/host/ai.go
// never invents one.
type MCPServer struct {
	// Name is a short identifier for this server, unique within one
	// request's MCPServers -- passed through as the connector's
	// mcp_servers[].name and referenced by exactly one matching
	// tools[].mcp_toolset.mcp_server_name entry.
	Name string
	// URL is the server's remote endpoint. Anthropic's MCP connector
	// requires an https:// URL reachable over Streamable HTTP or SSE; a
	// local stdio server cannot be attached this way (see the Anthropic
	// provider's own doc comment).
	URL string
	// Token is the bearer/OAuth token to authenticate with URL, if the
	// server requires one. The zero value (unset) is valid -- some MCP
	// servers require no auth at all.
	Token secret.String
}

// Source is one link a provider found while answering a request, surfaced
// separately from Content so a caller can render "where did this come
// from" without depending on the model having remembered to write a
// Markdown link into its own reply. Only ever populated when MCPServers was
// non-empty and the model actually called a tool; a request with no MCP
// servers configured always gets back an empty slice.
type Source struct {
	URL string
}

// CompleteResult is a provider's reply, normalised across providers.
// Usage fields are best-effort (zero when a provider doesn't report them)
// and exist only for the "how much did this cost" transparency issue #92
// asks for -- nothing in this codebase bills against them.
type CompleteResult struct {
	Content      string
	Model        string
	InputTokens  int
	OutputTokens int
	Sources      []Source
}

// Provider is one AI backend. Every exported method must be safe to call
// with an already-validated key; Provider implementations are never
// responsible for storing, discovering, or redacting the key -- that is
// internal/ai/keystore and internal/ai/secret's job respectively.
type Provider interface {
	// Name is this provider's stable id, e.g. "anthropic" -- used as the
	// keystore's provider key, the API's own "provider" field, and never
	// shown to a component as anything other than an opaque string (no
	// hardcoded model names or vendor assumptions in web/src/panes/ai).
	Name() string
	// Label is a short human-readable name for display, e.g. "Anthropic".
	Label() string
	// DefaultModel returns the model identifier used when the caller
	// (internal/host) does not override it. Living here, not in any
	// component, is what "no hardcoded model names in components" means in
	// practice: a component only ever displays whatever string the host
	// reports back over /api/ai/status.
	DefaultModel() string
	// Complete sends req to this provider, authenticating with key, using
	// model (typically DefaultModel(), but overridable e.g. via an
	// operator's environment for testing a newer model without a code
	// change).
	Complete(ctx context.Context, key secret.String, model string, req CompleteRequest) (CompleteResult, error)
}

// AuthError is returned by Provider.Complete when the provider's API
// rejected the given key (e.g. HTTP 401/403). internal/host's handler maps
// this to a 502 with a message that never repeats the key itself.
type AuthError struct {
	Provider string
}

func (e *AuthError) Error() string {
	return fmt.Sprintf("ai: %s rejected the configured API key", e.Provider)
}

// Registry maps a provider id to its Provider implementation.
type Registry map[string]Provider

// Get returns the Provider registered under id, or ok=false if none is.
func (r Registry) Get(id string) (Provider, bool) {
	p, ok := r[id]
	return p, ok
}

// Providers returns every registered Provider in a stable order (by id),
// for listing endpoints where result order should never depend on Go's
// randomised map iteration.
func (r Registry) Providers() []Provider {
	ids := make([]string, 0, len(r))
	for id := range r {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	out := make([]Provider, 0, len(ids))
	for _, id := range ids {
		out = append(out, r[id])
	}
	return out
}
