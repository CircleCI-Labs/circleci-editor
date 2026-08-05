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

// Package anthropic implements ai.Provider against Anthropic's Messages
// API (https://docs.anthropic.com/en/api/messages), the first (issue #92's
// "Anthropic first") of what is meant to be several interchangeable
// provider packages -- see internal/ai's package doc for why none of this
// vendor-specific request/response shape is allowed to leak past this
// package's own exported Provider.
//
// No Anthropic SDK dependency: the Messages API is a single small JSON
// endpoint, and a hand-rolled client keeps this codebase's "own a thin HTTP
// client instead of depending on a heavier SDK" convention (see
// internal/circleci) consistent across both API integrations it has.
//
// Docs grounding (issue #111/#103) is implemented as exactly that: a
// request-shape addition, not a new subsystem. When
// ai.CompleteRequest.MCPServers is non-empty, Complete attaches Anthropic's
// MCP connector -- beta header mcpBetaHeader, an mcp_servers entry per
// server, and a matching mcp_toolset entry in tools -- and Anthropic's own
// backend calls the remote server's tools directly, returning results
// inline in the same response as mcp_tool_use/mcp_tool_result content
// blocks (verified against the live connector docs). This
// package never opens a connection to an MCP server itself: there is no MCP
// client here, only JSON this provider already knew how to build.
package anthropic

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
)

const (
	// providerName is this provider's stable id -- see ai.Provider.Name.
	providerName = "anthropic"

	// defaultBaseURL is Anthropic's public API host. Overridable via
	// Options.BaseURL, which exists solely so tests can point Client at an
	// httptest.Server instead of the real API.
	defaultBaseURL = "https://api.anthropic.com"

	// messagesPath is the Messages API endpoint this provider speaks.
	messagesPath = "/v1/messages"

	// apiVersion is the required "anthropic-version" header value, pinned
	// so a future API revision can't silently change this provider's
	// request/response shape out from under it.
	apiVersion = "2023-06-01"

	// defaultModel is used when the caller doesn't override it. Kept as
	// exactly one named constant in exactly one place, so upgrading it is a
	// one-line change here and never a change to any component (issue #92:
	// "do not hardcode model names in components").
	//
	// Sonnet rather than Opus: this pane answers questions about a config
	// file and proposes small, schema-constrained edits, which is well
	// within Sonnet's range, and the user is paying for their own inference
	// (issue #92 again) -- defaulting to the most expensive model would be
	// spending someone else's money by default. Anyone who wants Opus can
	// override the model through the provider seam.
	defaultModel = "claude-sonnet-5"

	// defaultMaxTokens bounds a single reply when the caller doesn't set
	// CompleteRequest.MaxTokens, both as a sane default and as a cost
	// guardrail -- issue #92 is explicit that inference cost is the user's,
	// so this provider never lets an unset MaxTokens mean "unbounded".
	defaultMaxTokens = 1024

	// requestTimeout bounds a single Complete call. Generous relative to
	// internal/circleci's 20s validate timeout because a chat reply is
	// naturally slower than a config-compile call, but still finite: a
	// hung provider request must not hang the pane forever.
	requestTimeout = 60 * time.Second

	// maxResponseBodyBytes caps how much of a response body this client
	// reads, mirroring internal/circleci's own limit for the same reason:
	// guarding against an excessively large or malicious response.
	maxResponseBodyBytes = 10 << 20 // 10 MiB

	// mcpBetaHeader is the anthropic-beta header value gating the MCP
	// connector (see the package doc). Sent only when
	// ai.CompleteRequest.MCPServers is non-empty -- a request with no MCP
	// servers configured sends exactly the same headers and body it always
	// has, which is what "no MCP access must leave the assistant exactly as
	// capable as it is today" (issue #103) means at the wire level.
	//
	// Pinned to the *current* connector version as of this writing
	// (verified against platform.claude.com/docs/en/agents-and-tools/
	// mcp-connector on 2026-07-28); the prior mcp-client-2025-04-04 header
	// is documented as deprecated. Bump this constant, not a caller, if
	// Anthropic ships a newer version.
	mcpBetaHeader = "mcp-client-2025-11-20"

	// mcpToolsetType and mcpServerURLType are the two literal "type"
	// discriminators the MCP connector's wire format uses. Named constants
	// rather than inline strings so the two places they're compared/set
	// can't silently drift.
	mcpToolsetType   = "mcp_toolset"
	mcpServerURLType = "url"

	// maxExtractedSources caps how many Source entries Complete will pull
	// out of a response's mcp_tool_result blocks (see extractSources). A
	// docs-search tool call can return many chunks; this exists purely to
	// keep the "Sources" list a short, glanceable footer rather than a wall
	// of links, the same design goal issue #78's docsLinks.ts states for
	// its own affordance.
	maxExtractedSources = 5
)

// Options configures a Client.
type Options struct {
	// BaseURL overrides defaultBaseURL. Tests only; production callers
	// should leave it empty.
	BaseURL string
	// HTTPClient overrides the default *http.Client. Tests only.
	HTTPClient *http.Client
}

// Client implements ai.Provider against Anthropic's Messages API.
type Client struct {
	baseURL    string
	httpClient *http.Client
}

// New constructs a Client.
func New(opts Options) *Client {
	baseURL := opts.BaseURL
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	return &Client{baseURL: baseURL, httpClient: httpClient}
}

// Name implements ai.Provider.
func (c *Client) Name() string { return providerName }

// Label implements ai.Provider.
func (c *Client) Label() string { return "Anthropic" }

// DefaultModel implements ai.Provider.
func (c *Client) DefaultModel() string { return defaultModel }

// wireMessage is one entry of the Messages API's "messages" array.
type wireMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// wireRequest is the Messages API's request body. Only the fields this
// provider actually sets are modelled -- streaming and general tool use are
// deliberately out of scope (see the package doc and issue #92's own
// "streaming and tool-use loops can follow"); MCPServers/Tools are the one
// exception, added for issue #111/#103's docs-grounding request-shape
// change and left empty (omitted entirely, via omitempty) on every request
// that doesn't configure an MCP server.
type wireRequest struct {
	Model      string           `json:"model"`
	System     string           `json:"system,omitempty"`
	Messages   []wireMessage    `json:"messages"`
	MaxTokens  int              `json:"max_tokens"`
	MCPServers []wireMCPServer  `json:"mcp_servers,omitempty"`
	Tools      []wireMCPToolset `json:"tools,omitempty"`
}

// wireMCPServer is one entry of wireRequest.MCPServers -- the MCP
// connector's server-definition shape. AuthorizationToken is omitted
// entirely (not sent as an empty string) for a server that needs no auth,
// matching the MCP spec's own "auth is optional" stance.
type wireMCPServer struct {
	Type               string `json:"type"`
	URL                string `json:"url"`
	Name               string `json:"name"`
	AuthorizationToken string `json:"authorization_token,omitempty"`
}

// wireMCPToolset is one entry of wireRequest.Tools -- the MCP connector's
// toolset shape. This provider only ever emits the simplest form (enable
// every tool the named server advertises); DefaultConfig/Configs-style
// allow/deny-listing is real API surface but not something any caller of
// this package has needed yet, so it is left unmodelled rather than
// speculatively wired.
type wireMCPToolset struct {
	Type          string `json:"type"`
	MCPServerName string `json:"mcp_server_name"`
}

// wireContentBlock is one entry of a successful response's "content"
// array. Anthropic's Messages API can return multiple block types (text,
// tool_use, mcp_tool_use, mcp_tool_result, ...); this provider only ever
// asks for and reads plain text replies plus, when MCP servers are
// configured, the source links buried in an mcp_tool_result's own nested
// Content -- every other block type is simply skipped (see Complete and
// extractSources).
type wireContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
	// Content is populated only on an "mcp_tool_result" block -- the tool
	// call's own result payload, one level down from this block's own Text
	// (which mcp_tool_result never sets).
	Content []wireContentBlock `json:"content,omitempty"`
}

type wireUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

type wireResponse struct {
	Content []wireContentBlock `json:"content"`
	Model   string             `json:"model"`
	Usage   wireUsage          `json:"usage"`
}

// wireError is the body Anthropic's API returns for a non-2xx response.
type wireError struct {
	Type  string `json:"type"`
	Error struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

// Complete implements ai.Provider.
func (c *Client) Complete(ctx context.Context, key secret.String, model string, req ai.CompleteRequest) (ai.CompleteResult, error) {
	if !key.IsSet() {
		return ai.CompleteResult{}, fmt.Errorf("anthropic: no API key provided")
	}
	if model == "" {
		model = c.DefaultModel()
	}
	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = defaultMaxTokens
	}

	wireReq := wireRequest{
		Model:     model,
		System:    req.System,
		MaxTokens: maxTokens,
		Messages:  make([]wireMessage, len(req.Messages)),
	}
	for i, m := range req.Messages {
		wireReq.Messages[i] = wireMessage{Role: string(m.Role), Content: m.Content}
	}
	for _, server := range req.MCPServers {
		wireReq.MCPServers = append(wireReq.MCPServers, wireMCPServer{
			Type:               mcpServerURLType,
			URL:                server.URL,
			Name:               server.Name,
			AuthorizationToken: server.Token.Reveal(), // justified the same way key.Reveal() below is: this becomes a field of the one outgoing HTTPS request this provider builds, and nowhere else.
		})
		wireReq.Tools = append(wireReq.Tools, wireMCPToolset{Type: mcpToolsetType, MCPServerName: server.Name})
	}

	body, err := json.Marshal(wireReq)
	if err != nil {
		return ai.CompleteResult{}, fmt.Errorf("anthropic: marshal request: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+messagesPath, bytes.NewReader(body))
	if err != nil {
		return ai.CompleteResult{}, fmt.Errorf("anthropic: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("anthropic-version", apiVersion)
	// x-api-key, never "Authorization: Bearer" -- the header Anthropic's
	// Messages API documents. key.Reveal() (and server.Token.Reveal() above,
	// for an MCP server's own auth) are the only justified Reveal() call
	// sites in this package: this request is the only place either raw
	// value is allowed to exist outside the keystore.
	httpReq.Header.Set("x-api-key", key.Reveal())
	if len(wireReq.MCPServers) > 0 {
		// Sent only when a caller actually configured an MCP server --
		// see mcpBetaHeader's own doc comment for why this must never be
		// sent unconditionally.
		httpReq.Header.Set("anthropic-beta", mcpBetaHeader)
	}

	resp, err := c.httpClient.Do(httpReq) //nolint:bodyclose,gosec // closed just below; c.baseURL is either the defaultBaseURL constant or a test-only Options.BaseURL override, and messagesPath is a package constant -- neither comes from request input, so this is not the SSRF gosec's taint analysis assumes.
	if err != nil {
		return ai.CompleteResult{}, fmt.Errorf("anthropic: request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBodyBytes+1))
	if err != nil {
		return ai.CompleteResult{}, fmt.Errorf("anthropic: read response: %w", err)
	}
	if len(respBody) > maxResponseBodyBytes {
		return ai.CompleteResult{}, fmt.Errorf("anthropic: response exceeds %d bytes", maxResponseBodyBytes)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return ai.CompleteResult{}, &ai.AuthError{Provider: providerName}
		}
		return ai.CompleteResult{}, fmt.Errorf("anthropic: %s: %s", resp.Status, describeError(respBody))
	}

	var wireResp wireResponse
	if err := json.Unmarshal(respBody, &wireResp); err != nil {
		return ai.CompleteResult{}, fmt.Errorf("anthropic: decode response: %w", err)
	}

	var text bytes.Buffer
	for _, block := range wireResp.Content {
		if block.Type == "text" {
			text.WriteString(block.Text)
		}
	}

	return ai.CompleteResult{
		Content:      text.String(),
		Model:        wireResp.Model,
		InputTokens:  wireResp.Usage.InputTokens,
		OutputTokens: wireResp.Usage.OutputTokens,
		Sources:      extractSources(wireResp.Content),
	}, nil
}

// sourceURLPattern matches an http(s) URL inside an mcp_tool_result block's
// text, whether it's a bare URL or the target of a Markdown link. Trailing
// punctuation and Markdown/closing-paren delimiters are excluded from the
// character class itself (rather than trimmed afterwards) so a URL that
// happens to end a sentence -- "... see https://circleci.com/docs/x." --
// doesn't pick up the full stop.
var sourceURLPattern = regexp.MustCompile(`https?://[^\s()<>"'\x60]+[^\s()<>"'\x60.,;:!?]`)

// extractSources pulls source links out of every mcp_tool_result block in
// content, deduplicating and capping at maxExtractedSources. This is
// best-effort by construction, not a structured field the MCP spec
// guarantees: an MCP tool result's "content" is itself a list of ordinary
// content blocks (typically {"type": "text", "text": "..."}), and a
// docs-search server like Kapa's is documented to return a source URL
// embedded in that text (as a Markdown link or a bare URL) alongside the
// chunk's own prose, not as a separate structured field the Messages API
// schema exposes. Some of this remains unverified without a live server to
// test against.
//
// Deliberately unfiltered by domain: this provider has no opinion about
// which MCP server a caller configures (see ai.MCPServer's own doc
// comment), so it does not special-case circleci.com here -- a caller
// that only ever configures a CircleCI docs server gets only CircleCI docs
// links out of this, and a caller pointed at something else gets whatever
// that server returns. internal/host/ai.go is where this app's own policy
// choices about which MCP servers to offer live, not this package.
func extractSources(content []wireContentBlock) []ai.Source {
	var sources []ai.Source
	seen := make(map[string]bool)
	for _, block := range content {
		if block.Type != "mcp_tool_result" {
			continue
		}
		for _, inner := range block.Content {
			for _, url := range sourceURLPattern.FindAllString(inner.Text, -1) {
				if seen[url] {
					continue
				}
				seen[url] = true
				sources = append(sources, ai.Source{URL: url})
				if len(sources) >= maxExtractedSources {
					return sources
				}
			}
		}
	}
	return sources
}

// describeError extracts a human-readable message from an error response
// body, falling back to a truncated raw body if it doesn't match the API's
// documented error shape.
func describeError(body []byte) string {
	var wireErr wireError
	if err := json.Unmarshal(body, &wireErr); err == nil && wireErr.Error.Message != "" {
		return wireErr.Error.Message
	}
	const maxRawErrorLen = 500
	if len(body) > maxRawErrorLen {
		return string(body[:maxRawErrorLen]) + "..."
	}
	return string(body)
}

// Ensure Client satisfies ai.Provider at compile time.
var _ ai.Provider = (*Client)(nil)
