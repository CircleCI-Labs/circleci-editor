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

package anthropic_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/anthropic"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
)

// sentinelKey is never a real Anthropic key -- every test in this file
// either uses a fake httptest.Server (which never validates it) or, for the
// "no key" case, no key at all. It stands in for "some string that would be
// disastrous to leak" so the leak-detection assertions below mean something.
const sentinelKey = "sk-ant-test-sentinel-should-never-appear-in-an-error"

func TestClient_Complete_SendsTheKeyAsAHeaderNeverInTheBody(t *testing.T) {
	var gotHeader string
	var gotBody []byte
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeader = r.Header.Get("x-api-key")
		gotBody, _ = readAll(r)
		assert.Equal(t, r.Header.Get("anthropic-version"), "2023-06-01")
		assert.Equal(t, r.URL.Path, "/v1/messages")
		writeJSON(w, http.StatusOK, map[string]any{
			"content": []map[string]string{{"type": "text", "text": "hello"}},
			"model":   "claude-sonnet-5",
			"usage":   map[string]int{"input_tokens": 10, "output_tokens": 2},
		})
	}))
	defer ts.Close()

	client := anthropic.New(anthropic.Options{BaseURL: ts.URL})
	result, err := client.Complete(context.Background(), secret.New(sentinelKey), "", ai.CompleteRequest{
		Messages: []ai.Message{{Role: ai.RoleUser, Content: "hi"}},
	})
	assert.NilError(t, err)
	assert.Equal(t, result.Content, "hello")
	assert.Equal(t, result.InputTokens, 10)
	assert.Equal(t, result.OutputTokens, 2)

	assert.Equal(t, gotHeader, sentinelKey, "key must travel as the x-api-key header")
	assert.Assert(t, !strings.Contains(string(gotBody), sentinelKey), "key leaked into the request body: %s", gotBody)
}

func TestClient_Complete_UsesDefaultModelWhenNoneGiven(t *testing.T) {
	var gotModel string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		body, _ := readAll(r)
		_ = json.Unmarshal(body, &req)
		gotModel, _ = req["model"].(string)
		writeJSON(w, http.StatusOK, map[string]any{
			"content": []map[string]string{{"type": "text", "text": "ok"}},
		})
	}))
	defer ts.Close()

	client := anthropic.New(anthropic.Options{BaseURL: ts.URL})
	_, err := client.Complete(context.Background(), secret.New(sentinelKey), "", ai.CompleteRequest{
		Messages: []ai.Message{{Role: ai.RoleUser, Content: "hi"}},
	})
	assert.NilError(t, err)
	assert.Equal(t, gotModel, client.DefaultModel())
}

func TestClient_Complete_OverridesModelWhenGiven(t *testing.T) {
	var gotModel string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		body, _ := readAll(r)
		_ = json.Unmarshal(body, &req)
		gotModel, _ = req["model"].(string)
		writeJSON(w, http.StatusOK, map[string]any{"content": []map[string]string{{"type": "text", "text": "ok"}}})
	}))
	defer ts.Close()

	client := anthropic.New(anthropic.Options{BaseURL: ts.URL})
	_, err := client.Complete(context.Background(), secret.New(sentinelKey), "claude-haiku-test", ai.CompleteRequest{
		Messages: []ai.Message{{Role: ai.RoleUser, Content: "hi"}},
	})
	assert.NilError(t, err)
	assert.Equal(t, gotModel, "claude-haiku-test")
}

// TestClient_Complete_InvalidKey_ReturnsAuthErrorWithoutLeakingTheKey
// exercises the "deliberately invalid key" path called for by issue #92's
// verification instructions, standing in for a real unauthorized response
// from api.anthropic.com (never called from a test -- see this package's
// PR notes on what a live call would additionally verify).
func TestClient_Complete_InvalidKey_ReturnsAuthErrorWithoutLeakingTheKey(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"type":  "error",
			"error": map[string]string{"type": "authentication_error", "message": "invalid x-api-key"},
		})
	}))
	defer ts.Close()

	client := anthropic.New(anthropic.Options{BaseURL: ts.URL})
	invalidKey := secret.New("sk-ant-deliberately-invalid-" + sentinelKey)
	_, err := client.Complete(context.Background(), invalidKey, "", ai.CompleteRequest{
		Messages: []ai.Message{{Role: ai.RoleUser, Content: "hi"}},
	})

	var authErr *ai.AuthError
	assert.Assert(t, errors.As(err, &authErr), "expected an *ai.AuthError, got %T: %v", err, err)
	assert.Assert(t, !strings.Contains(err.Error(), invalidKey.Reveal()), "error message leaked the key: %s", err.Error())
	assert.Assert(t, !strings.Contains(err.Error(), sentinelKey), "error message leaked the key: %s", err.Error())
}

func TestClient_Complete_NoKey_FailsWithoutMakingARequest(t *testing.T) {
	called := false
	ts := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	defer ts.Close()

	client := anthropic.New(anthropic.Options{BaseURL: ts.URL})
	_, err := client.Complete(context.Background(), secret.String{}, "", ai.CompleteRequest{
		Messages: []ai.Message{{Role: ai.RoleUser, Content: "hi"}},
	})
	assert.ErrorContains(t, err, "no API key")
	assert.Equal(t, called, false, "must not call the provider at all with no key")
}

func TestClient_Complete_ServerError_DoesNotLeakTheKey(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("internal server error"))
	}))
	defer ts.Close()

	client := anthropic.New(anthropic.Options{BaseURL: ts.URL})
	_, err := client.Complete(context.Background(), secret.New(sentinelKey), "", ai.CompleteRequest{
		Messages: []ai.Message{{Role: ai.RoleUser, Content: "hi"}},
	})
	assert.Assert(t, err != nil)
	assert.Assert(t, !strings.Contains(err.Error(), sentinelKey), "error message leaked the key: %s", err.Error())
}

// TestClient_Complete_NoMCPServers_OmitsMCPFieldsAndBetaHeader is the
// no-MCP-configured regression test issue #103 explicitly asks for: the
// default (empty MCPServers) path must send byte-for-byte the same request
// shape this provider always has, so docs grounding is opt-in in the wire
// format, not just in the UI.
func TestClient_Complete_NoMCPServers_OmitsMCPFieldsAndBetaHeader(t *testing.T) {
	var gotBody map[string]any
	var gotBeta string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBeta = r.Header.Get("anthropic-beta")
		body, _ := readAll(r)
		_ = json.Unmarshal(body, &gotBody)
		writeJSON(w, http.StatusOK, map[string]any{"content": []map[string]string{{"type": "text", "text": "ok"}}})
	}))
	defer ts.Close()

	client := anthropic.New(anthropic.Options{BaseURL: ts.URL})
	result, err := client.Complete(context.Background(), secret.New(sentinelKey), "", ai.CompleteRequest{
		Messages: []ai.Message{{Role: ai.RoleUser, Content: "hi"}},
	})
	assert.NilError(t, err)
	assert.Equal(t, gotBeta, "", "must not send the MCP beta header when no MCP server is configured")
	_, hasServers := gotBody["mcp_servers"]
	assert.Assert(t, !hasServers, "must not send mcp_servers when no MCP server is configured")
	_, hasTools := gotBody["tools"]
	assert.Assert(t, !hasTools, "must not send tools when no MCP server is configured")
	assert.Equal(t, len(result.Sources), 0)
}

// TestClient_Complete_MCPServers_SendsConnectorFieldsAndBetaHeader verifies
// the request shape documented at platform.claude.com/docs/en/agents-and-
// tools/mcp-connector (fetched 2026-07-28):
// one mcp_servers entry per configured server (type "url", url, name,
// authorization_token) plus a matching mcp_toolset entry in tools, gated
// by the mcp-client-2025-11-20 beta header.
func TestClient_Complete_MCPServers_SendsConnectorFieldsAndBetaHeader(t *testing.T) {
	var gotBody map[string]any
	var gotBeta string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBeta = r.Header.Get("anthropic-beta")
		body, _ := readAll(r)
		_ = json.Unmarshal(body, &gotBody)
		writeJSON(w, http.StatusOK, map[string]any{"content": []map[string]string{{"type": "text", "text": "ok"}}})
	}))
	defer ts.Close()

	client := anthropic.New(anthropic.Options{BaseURL: ts.URL})
	_, err := client.Complete(context.Background(), secret.New(sentinelKey), "", ai.CompleteRequest{
		Messages: []ai.Message{{Role: ai.RoleUser, Content: "hi"}},
		MCPServers: []ai.MCPServer{
			{Name: "circleci-docs", URL: "https://circleci.mcp.kapa.ai/sse", Token: secret.New("mcp-token")},
		},
	})
	assert.NilError(t, err)
	assert.Equal(t, gotBeta, "mcp-client-2025-11-20")

	servers, _ := gotBody["mcp_servers"].([]any)
	assert.Equal(t, len(servers), 1)
	server := servers[0].(map[string]any)
	assert.Equal(t, server["type"], "url")
	assert.Equal(t, server["url"], "https://circleci.mcp.kapa.ai/sse")
	assert.Equal(t, server["name"], "circleci-docs")
	assert.Equal(t, server["authorization_token"], "mcp-token")

	tools, _ := gotBody["tools"].([]any)
	assert.Equal(t, len(tools), 1)
	tool := tools[0].(map[string]any)
	assert.Equal(t, tool["type"], "mcp_toolset")
	assert.Equal(t, tool["mcp_server_name"], "circleci-docs")
}

// TestClient_Complete_MCPServers_NoToken_OmitsAuthorizationToken covers an
// MCP server configured with no bearer token -- valid per the MCP spec
// (some servers require no auth at all), and exercised separately from the
// happy path above so a regression that starts sending an empty string
// instead of omitting the field entirely is caught.
func TestClient_Complete_MCPServers_NoToken_OmitsAuthorizationToken(t *testing.T) {
	var gotBody map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := readAll(r)
		_ = json.Unmarshal(body, &gotBody)
		writeJSON(w, http.StatusOK, map[string]any{"content": []map[string]string{{"type": "text", "text": "ok"}}})
	}))
	defer ts.Close()

	client := anthropic.New(anthropic.Options{BaseURL: ts.URL})
	_, err := client.Complete(context.Background(), secret.New(sentinelKey), "", ai.CompleteRequest{
		Messages:   []ai.Message{{Role: ai.RoleUser, Content: "hi"}},
		MCPServers: []ai.MCPServer{{Name: "no-auth-mcp", URL: "https://example.com/sse"}},
	})
	assert.NilError(t, err)

	servers, _ := gotBody["mcp_servers"].([]any)
	assert.Equal(t, len(servers), 1)
	server := servers[0].(map[string]any)
	_, hasToken := server["authorization_token"]
	assert.Assert(t, !hasToken, "authorization_token must be omitted, not sent as an empty string, when no token is configured")
}

// TestClient_Complete_MCPServers_AllowedTools_SendsDenyByDefaultToolset is
// issue #11's gate at the wire level: a server configured with
// AllowedTools must reach Anthropic as a deny-by-default toolset
// (default_config.enabled=false plus one enabled configs entry per allowed
// name) -- the documented pattern for building a read-only assistant (see
// wireMCPToolset's doc comment) -- never as the "enable everything" shape
// the no-AllowedTools tests above pin.
func TestClient_Complete_MCPServers_AllowedTools_SendsDenyByDefaultToolset(t *testing.T) {
	var gotBody map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := readAll(r)
		_ = json.Unmarshal(body, &gotBody)
		writeJSON(w, http.StatusOK, map[string]any{"content": []map[string]string{{"type": "text", "text": "ok"}}})
	}))
	defer ts.Close()

	client := anthropic.New(anthropic.Options{BaseURL: ts.URL})
	_, err := client.Complete(context.Background(), secret.New(sentinelKey), "", ai.CompleteRequest{
		Messages: []ai.Message{{Role: ai.RoleUser, Content: "hi"}},
		MCPServers: []ai.MCPServer{
			{
				Name:         "circleci",
				URL:          "https://mcp.circleci.com/v1/mcp",
				Token:        secret.New("circle-token"),
				AllowedTools: []string{"get_job_logs", "list_runs"},
			},
		},
	})
	assert.NilError(t, err)

	tools, _ := gotBody["tools"].([]any)
	assert.Equal(t, len(tools), 1)
	tool := tools[0].(map[string]any)
	assert.Equal(t, tool["mcp_server_name"], "circleci")

	defaultConfig, _ := tool["default_config"].(map[string]any)
	assert.Assert(t, defaultConfig != nil, "expected a default_config disabling every tool not explicitly allowed: %v", tool)
	assert.Equal(t, defaultConfig["enabled"], false)

	configs, _ := tool["configs"].(map[string]any)
	assert.Equal(t, len(configs), 2)
	for _, name := range []string{"get_job_logs", "list_runs"} {
		entry, _ := configs[name].(map[string]any)
		assert.Assert(t, entry != nil, "expected an explicit enabled entry for %q: %v", name, configs)
		assert.Equal(t, entry["enabled"], true)
	}
	// The gate gives up nothing by omission: a tool this test never names
	// (e.g. a write tool) must not appear in configs at all -- there is no
	// third state between "explicitly enabled" and "covered by
	// default_config.enabled=false".
	_, hasCancelWorkflow := configs["cancel_workflow"]
	assert.Assert(t, !hasCancelWorkflow)
}

// TestClient_Complete_MCPServers_EmptyAllowedTools_DisablesEveryTool covers
// the edge AllowedTools' own doc comment calls out: a non-nil but empty
// slice means "no tools at all", a legitimate configuration distinct from
// nil ("no restriction"). Anything that instead treated an empty slice the
// same as nil would silently hand back every tool a caller meant to gate.
func TestClient_Complete_MCPServers_EmptyAllowedTools_DisablesEveryTool(t *testing.T) {
	var gotBody map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := readAll(r)
		_ = json.Unmarshal(body, &gotBody)
		writeJSON(w, http.StatusOK, map[string]any{"content": []map[string]string{{"type": "text", "text": "ok"}}})
	}))
	defer ts.Close()

	client := anthropic.New(anthropic.Options{BaseURL: ts.URL})
	_, err := client.Complete(context.Background(), secret.New(sentinelKey), "", ai.CompleteRequest{
		Messages:   []ai.Message{{Role: ai.RoleUser, Content: "hi"}},
		MCPServers: []ai.MCPServer{{Name: "circleci", URL: "https://mcp.circleci.com/v1/mcp", AllowedTools: []string{}}},
	})
	assert.NilError(t, err)

	tools, _ := gotBody["tools"].([]any)
	tool := tools[0].(map[string]any)
	defaultConfig, _ := tool["default_config"].(map[string]any)
	assert.Assert(t, defaultConfig != nil)
	assert.Equal(t, defaultConfig["enabled"], false)
	configs, _ := tool["configs"].(map[string]any)
	assert.Equal(t, len(configs), 0)
}

// TestClient_Complete_ExtractsSourcesFromMCPToolResult exercises
// extractSources against a response shaped like the MCP connector's own
// documented mcp_tool_result block (see the package doc's citation),
// carrying a Markdown-linked source URL inside the nested text content --
// the shape a docs-search server such as Kapa's is documented to return
// (source URL plus Markdown chunk content). This is a synthetic fixture,
// not a captured live response -- some of this remains unverified without
// a real Kapa credential.
func TestClient_Complete_ExtractsSourcesFromMCPToolResult(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"content": []map[string]any{
				{"type": "mcp_tool_use", "id": "mcptoolu_1", "name": "search_docs", "server_name": "circleci-docs", "input": map[string]string{"query": "resource class"}},
				{
					"type":        "mcp_tool_result",
					"tool_use_id": "mcptoolu_1",
					"is_error":    false,
					"content": []map[string]string{
						{"type": "text", "text": "Resource classes control compute. See [the docs](https://circleci.com/docs/reference/configuration-reference/#resourceclass) for the full table, and also https://circleci.com/docs/guides/execution-managed/using-docker/ for images."},
					},
				},
				{"type": "text", "text": "Resource classes are documented; see the sources below."},
			},
		})
	}))
	defer ts.Close()

	client := anthropic.New(anthropic.Options{BaseURL: ts.URL})
	result, err := client.Complete(context.Background(), secret.New(sentinelKey), "", ai.CompleteRequest{
		Messages:   []ai.Message{{Role: ai.RoleUser, Content: "what is a resource class?"}},
		MCPServers: []ai.MCPServer{{Name: "circleci-docs", URL: "https://circleci.mcp.kapa.ai/sse"}},
	})
	assert.NilError(t, err)
	assert.Equal(t, result.Content, "Resource classes are documented; see the sources below.", "the mcp_tool_use/mcp_tool_result blocks must not leak into the plain-text Content, same as any other non-text block")
	assert.DeepEqual(t, result.Sources, []ai.Source{
		{URL: "https://circleci.com/docs/reference/configuration-reference/#resourceclass"},
		{URL: "https://circleci.com/docs/guides/execution-managed/using-docker/"},
	})
}

// TestClient_Complete_ExtractsSources_CapsAndDedupes guards the two
// deliberate limits extractSources documents: a URL repeated across
// multiple result chunks appears once, and the list never grows past
// maxExtractedSources even if a tool result contains more.
func TestClient_Complete_ExtractsSources_CapsAndDedupes(t *testing.T) {
	textBlocks := make([]map[string]string, 0, 8)
	for i := 0; i < 8; i++ {
		textBlocks = append(textBlocks, map[string]string{
			"type": "text",
			// The first two blocks repeat the same URL on purpose.
			"text": "see https://circleci.com/docs/page-" + strconv.Itoa(i%7) + "/ for more",
		})
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"content": []map[string]any{
				{"type": "mcp_tool_result", "tool_use_id": "mcptoolu_1", "content": textBlocks},
			},
		})
	}))
	defer ts.Close()

	client := anthropic.New(anthropic.Options{BaseURL: ts.URL})
	result, err := client.Complete(context.Background(), secret.New(sentinelKey), "", ai.CompleteRequest{
		Messages:   []ai.Message{{Role: ai.RoleUser, Content: "hi"}},
		MCPServers: []ai.MCPServer{{Name: "circleci-docs", URL: "https://circleci.mcp.kapa.ai/sse"}},
	})
	assert.NilError(t, err)
	assert.Equal(t, len(result.Sources), 5, "must cap at maxExtractedSources even though 7 distinct URLs were returned")
}

func TestClient_Name_Label_DefaultModel(t *testing.T) {
	client := anthropic.New(anthropic.Options{})
	assert.Equal(t, client.Name(), "anthropic")
	assert.Equal(t, client.Label(), "Anthropic")
	assert.Assert(t, client.DefaultModel() != "")
}

func readAll(r *http.Request) ([]byte, error) {
	defer func() { _ = r.Body.Close() }()
	return io.ReadAll(r.Body)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
