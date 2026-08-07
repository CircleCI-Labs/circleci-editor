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

package host_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/mcpauth"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

// Deliberately invalid credentials, chosen to be recognisable so tests can
// assert they never reach an HTTP response body. Never a real token.
const (
	oauthSentinelAccess  = "invalid-mcp-access-token-must-never-reach-the-browser"
	oauthSentinelRefresh = "invalid-mcp-refresh-token-must-never-reach-the-browser"
	oauthSentinelSecret  = "invalid-mcp-client-secret-must-never-reach-the-browser"
)

// fakeMCPAuthServer is a TLS authorization server plus the MCP resource it
// guards, standing in for circleci.mcp.kapa.ai. TLS rather than plain HTTP
// because internal/ai/mcpauth refuses every non-https endpoint, and a test
// seam that bypassed that check would be testing a code path production
// never takes.
type fakeMCPAuthServer struct {
	ts *httptest.Server

	mu               sync.Mutex
	tokenRequests    []url.Values
	omitRefreshToken bool
	accessTokenTTL   int
	// nextAccessToken lets a refresh be distinguished from the original
	// exchange by the value it returns.
	nextAccessToken string
	tokenError      string
}

func newFakeMCPAuthServer(t *testing.T, configure func(*fakeMCPAuthServer)) *fakeMCPAuthServer {
	t.Helper()
	f := &fakeMCPAuthServer{accessTokenTTL: 3600, nextAccessToken: oauthSentinelAccess}
	if configure != nil {
		configure(f)
	}

	mux := http.NewServeMux()
	f.ts = httptest.NewTLSServer(mux)
	t.Cleanup(f.ts.Close)

	mux.HandleFunc("/.well-known/oauth-protected-resource", func(w http.ResponseWriter, _ *http.Request) {
		writeOAuthTestJSON(w, http.StatusOK, map[string]any{
			"resource":              f.ts.URL + "/",
			"authorization_servers": []string{f.ts.URL + "/auth/public"},
			"scopes_supported":      []string{"openid"},
		})
	})
	mux.HandleFunc("/.well-known/oauth-authorization-server/auth/public", func(w http.ResponseWriter, _ *http.Request) {
		writeOAuthTestJSON(w, http.StatusOK, map[string]any{
			"issuer":                           f.ts.URL + "/auth/public",
			"authorization_endpoint":           f.ts.URL + "/auth/public/authorize",
			"token_endpoint":                   f.ts.URL + "/auth/public/token",
			"registration_endpoint":            f.ts.URL + "/auth/public/register",
			"scopes_supported":                 []string{"openid"},
			"grant_types_supported":            []string{"authorization_code", "refresh_token"},
			"code_challenge_methods_supported": []string{"S256"},
		})
	})
	mux.HandleFunc("/auth/public/register", func(w http.ResponseWriter, _ *http.Request) {
		writeOAuthTestJSON(w, http.StatusCreated, map[string]any{
			"client_id":     "invalid-client-id-for-tests",
			"client_secret": oauthSentinelSecret,
		})
	})
	mux.HandleFunc("/auth/public/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		f.tokenRequests = append(f.tokenRequests, r.PostForm)
		tokenError, omitRefresh, ttl, access := f.tokenError, f.omitRefreshToken, f.accessTokenTTL, f.nextAccessToken
		f.mu.Unlock()

		if tokenError != "" {
			writeOAuthTestJSON(w, http.StatusBadRequest, map[string]any{
				"error": tokenError,
				// Deliberately quotes back what was sent, which is exactly
				// what must not resurface anywhere.
				"error_description": "rejected " + r.PostForm.Get("refresh_token") + r.PostForm.Get("client_secret"),
			})
			return
		}
		doc := map[string]any{"access_token": access, "token_type": "Bearer", "scope": "openid"}
		if !omitRefresh {
			doc["refresh_token"] = oauthSentinelRefresh
		}
		if ttl > 0 {
			doc["expires_in"] = ttl
		}
		writeOAuthTestJSON(w, http.StatusOK, doc)
	})

	return f
}

func (f *fakeMCPAuthServer) client() *mcpauth.Client {
	return &mcpauth.Client{HTTPClient: f.ts.Client()}
}

func (f *fakeMCPAuthServer) tokenRequestCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.tokenRequests)
}

func (f *fakeMCPAuthServer) lastTokenRequest() url.Values {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.tokenRequests) == 0 {
		return nil
	}
	return f.tokenRequests[len(f.tokenRequests)-1]
}

func writeOAuthTestJSON(w http.ResponseWriter, status int, doc map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(doc)
}

// newMCPOAuthTestServer builds a host server whose OAuth client trusts the
// fake authorization server.
func newMCPOAuthTestServer(t *testing.T, store *fakeKeyStore, providers ai.Registry, f *fakeMCPAuthServer) *httptest.Server {
	t.Helper()
	// See newAITestServer's own doc comment (ai_test.go): issue #11 makes
	// gotReq.MCPServers's length depend on the ambient CIRCLE_TOKEN unless
	// cleared first.
	clearCircleEnv(t)
	srv, err := host.New(host.Options{
		WorkDir:       t.TempDir(),
		Version:       "test-version",
		AIStore:       store,
		AIProviders:   providers,
		MCPAuthClient: f.client(),
	})
	assert.NilError(t, err)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// completeOAuthFlow drives the whole interactive sign-in the way a browser
// would: POST start, read the authorization URL, then GET the loopback
// redirect with the code and the state the host itself chose.
func completeOAuthFlow(t *testing.T, ts *httptest.Server, resourceURL string) (startBody string) {
	t.Helper()

	status, body := doAIRequest(t, ts, http.MethodPost, "/api/ai/mcp/oauth/start",
		[]byte(fmt.Sprintf(`{"url":%q}`, resourceURL)))
	assert.Equal(t, status, http.StatusOK, "start failed: %s", body)

	var start struct {
		State            string `json:"state"`
		AuthorizationURL string `json:"authorizationUrl"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &start))
	assert.Equal(t, start.State, "pending")
	assert.Assert(t, start.AuthorizationURL != "", "no authorization url returned")

	authURL, err := url.Parse(start.AuthorizationURL)
	assert.NilError(t, err)
	q := authURL.Query()
	// PKCE and state must both be present -- this is the request the browser
	// is actually sent, so asserting here proves the real flow uses them.
	assert.Equal(t, q.Get("code_challenge_method"), "S256")
	assert.Assert(t, q.Get("code_challenge") != "")
	assert.Assert(t, q.Get("state") != "")

	redirect, err := url.Parse(q.Get("redirect_uri"))
	assert.NilError(t, err)
	assert.Equal(t, redirect.Hostname(), "127.0.0.1")

	callback := fmt.Sprintf("%s?code=invalid-test-code&state=%s", q.Get("redirect_uri"), url.QueryEscape(q.Get("state")))
	resp, err := http.Get(callback) //nolint:noctx // short-lived loopback request in a test
	assert.NilError(t, err)
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	assert.Equal(t, resp.StatusCode, http.StatusOK)

	return body
}

// awaitOAuthState polls GET /api/ai/mcp/oauth until state matches, since the
// exchange happens on a background goroutine.
func awaitOAuthState(t *testing.T, ts *httptest.Server, want string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var body string
	for time.Now().Before(deadline) {
		var status int
		status, body = doAIRequest(t, ts, http.MethodGet, "/api/ai/mcp/oauth", nil)
		assert.Equal(t, status, http.StatusOK)
		var got struct {
			State string `json:"state"`
		}
		assert.NilError(t, json.Unmarshal([]byte(body), &got))
		if got.State == want {
			return body
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("oauth flow never reached state %q; last status was %s", want, body)
	return ""
}

func TestServer_AIMCPOAuth_Get_NothingStoredReportsIdle(t *testing.T) {
	f := newFakeMCPAuthServer(t, nil)
	ts := newMCPOAuthTestServer(t, newFakeKeyStore(), ai.Registry{}, f)

	status, body := doAIRequest(t, ts, http.MethodGet, "/api/ai/mcp/oauth", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, strings.TrimSpace(body), `{"state":"idle","authorized":false}`)
}

// The whole flow, end to end: discovery, dynamic client registration, the
// browser round trip, the token exchange, and the stored credential.
func TestServer_AIMCPOAuth_Start_CompletesTheFlowAndStoresACredential(t *testing.T) {
	f := newFakeMCPAuthServer(t, nil)
	store := newFakeKeyStore()
	ts := newMCPOAuthTestServer(t, store, ai.Registry{}, f)

	startBody := completeOAuthFlow(t, ts, f.ts.URL)
	statusBody := awaitOAuthState(t, ts, "authorized")

	var got struct {
		Authorized bool   `json:"authorized"`
		Resource   string `json:"resource"`
		Message    string `json:"message"`
		Token      struct {
			HasRefreshToken bool   `json:"hasRefreshToken"`
			ExpiresAt       string `json:"expiresAt"`
			LifetimeSeconds int    `json:"lifetimeSeconds"`
		} `json:"token"`
	}
	assert.NilError(t, json.Unmarshal([]byte(statusBody), &got))
	assert.Equal(t, got.Authorized, true)
	assert.Equal(t, got.Resource, f.ts.URL+"/")
	assert.Equal(t, got.Token.HasRefreshToken, true)
	assert.Assert(t, got.Token.ExpiresAt != "")
	assert.Assert(t, got.Token.LifetimeSeconds > 3000)
	// A server that did issue a refresh token has nothing to warn about.
	assert.Equal(t, got.Message, "")

	// PKCE actually reached the token endpoint.
	form := f.lastTokenRequest()
	assert.Equal(t, form.Get("grant_type"), "authorization_code")
	assert.Assert(t, form.Get("code_verifier") != "", "no PKCE verifier was sent")

	// The credential is in the keystore, under the AI keystore, and the
	// sign-in also recorded the MCP URL so grounding turns on immediately.
	stored, ok, err := store.Get(context.Background(), "mcp-docs-oauth")
	assert.NilError(t, err)
	assert.Assert(t, ok, "no credential was stored")
	cred, parsed := mcpauth.ParseCredential(stored)
	assert.Assert(t, parsed)
	assert.Equal(t, cred.Token.AccessToken.Reveal(), oauthSentinelAccess)
	assert.Equal(t, cred.Token.RefreshToken.Reveal(), oauthSentinelRefresh)

	urlStored, ok, err := store.Get(context.Background(), "mcp-docs-url")
	assert.NilError(t, err)
	assert.Assert(t, ok)
	assert.Equal(t, urlStored.Reveal(), f.ts.URL)

	// The same rule applies to this credential: nothing the browser received
	// carries any part of it.
	for _, body := range []string{startBody, statusBody} {
		for _, leaked := range []string{oauthSentinelAccess, oauthSentinelRefresh, oauthSentinelSecret} {
			assert.Assert(t, !strings.Contains(body, leaked),
				"an HTTP response leaked a credential: %s", body)
		}
	}
}

// The scenario the research could not rule out, and the one the feature was
// most at risk from. It must be reported at the moment it becomes knowable,
// not discovered later as an unexplained re-prompt.
func TestServer_AIMCPOAuth_Start_NoRefreshTokenIsReportedHonestly(t *testing.T) {
	f := newFakeMCPAuthServer(t, func(f *fakeMCPAuthServer) { f.omitRefreshToken = true })
	ts := newMCPOAuthTestServer(t, newFakeKeyStore(), ai.Registry{}, f)

	completeOAuthFlow(t, ts, f.ts.URL)
	body := awaitOAuthState(t, ts, "authorized")

	var got struct {
		Message string `json:"message"`
		Token   struct {
			HasRefreshToken bool `json:"hasRefreshToken"`
		} `json:"token"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Token.HasRefreshToken, false)
	assert.Assert(t, strings.Contains(got.Message, "no refresh token"),
		"the missing refresh token must be stated plainly, got %q", got.Message)
}

// A server with no dynamic client registration is the one way this approach
// is structurally impossible rather than merely failing, so it gets a
// message that says so instead of a generic error.
func TestServer_AIMCPOAuth_Start_NoDynamicRegistrationSaysSo(t *testing.T) {
	ts0 := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/oauth-protected-resource":
			writeOAuthTestJSON(w, http.StatusOK, map[string]any{
				"resource":              "https://docs.example.test/",
				"authorization_servers": []string{"https://" + r.Host + "/auth"},
			})
		case "/.well-known/oauth-authorization-server/auth":
			writeOAuthTestJSON(w, http.StatusOK, map[string]any{
				"issuer":                 "https://" + r.Host + "/auth",
				"authorization_endpoint": "https://" + r.Host + "/auth/authorize",
				"token_endpoint":         "https://" + r.Host + "/auth/token",
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(ts0.Close)

	srv, err := host.New(host.Options{
		WorkDir:       t.TempDir(),
		AIStore:       newFakeKeyStore(),
		AIProviders:   ai.Registry{},
		MCPAuthClient: &mcpauth.Client{HTTPClient: ts0.Client()},
	})
	assert.NilError(t, err)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	status, body := doAIRequest(t, ts, http.MethodPost, "/api/ai/mcp/oauth/start",
		[]byte(fmt.Sprintf(`{"url":%q}`, ts0.URL)))
	assert.Equal(t, status, http.StatusBadGateway)
	assert.Assert(t, strings.Contains(body, "no dynamic client registration"), body)
	assert.Assert(t, strings.Contains(body, "set manually"),
		"the message should point at the still-working fallback: %s", body)
}

func TestServer_AIMCPOAuth_Start_RequiresAnHTTPSURL(t *testing.T) {
	f := newFakeMCPAuthServer(t, nil)
	ts := newMCPOAuthTestServer(t, newFakeKeyStore(), ai.Registry{}, f)

	status, body := doAIRequest(t, ts, http.MethodPost, "/api/ai/mcp/oauth/start",
		[]byte(`{"url":"http://docs.example.test/"}`))
	assert.Equal(t, status, http.StatusBadRequest)
	assert.Assert(t, strings.Contains(body, "https://"), body)
}

func TestServer_AIMCPOAuth_Start_NoURLConfiguredIsAClearError(t *testing.T) {
	f := newFakeMCPAuthServer(t, nil)
	ts := newMCPOAuthTestServer(t, newFakeKeyStore(), ai.Registry{}, f)

	status, body := doAIRequest(t, ts, http.MethodPost, "/api/ai/mcp/oauth/start", []byte(`{}`))
	assert.Equal(t, status, http.StatusBadRequest)
	assert.Assert(t, strings.Contains(body, "no MCP server URL configured"), body)
}

func TestServer_AIMCPOAuth_Delete_RemovesTheStoredCredential(t *testing.T) {
	f := newFakeMCPAuthServer(t, nil)
	store := newFakeKeyStore()
	ts := newMCPOAuthTestServer(t, store, ai.Registry{}, f)

	completeOAuthFlow(t, ts, f.ts.URL)
	awaitOAuthState(t, ts, "authorized")

	status, body := doAIRequest(t, ts, http.MethodDelete, "/api/ai/mcp/oauth", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, strings.TrimSpace(body), `{"state":"idle","authorized":false}`)

	_, ok, err := store.Get(context.Background(), "mcp-docs-oauth")
	assert.NilError(t, err)
	assert.Assert(t, !ok, "the credential should be gone")
}

func TestServer_AIMCPOAuth_WrongMethod(t *testing.T) {
	f := newFakeMCPAuthServer(t, nil)
	ts := newMCPOAuthTestServer(t, newFakeKeyStore(), ai.Registry{}, f)

	status, _ := doAIRequest(t, ts, http.MethodPut, "/api/ai/mcp/oauth", []byte(`{}`))
	assert.Equal(t, status, http.StatusMethodNotAllowed)

	status, _ = doAIRequest(t, ts, http.MethodGet, "/api/ai/mcp/oauth/start", nil)
	assert.Equal(t, status, http.StatusMethodNotAllowed)
}

// newGroundingChatProvider records what the chat handler actually attached,
// so a test can assert on the token that reached the provider without that
// token ever leaving the process.
func newGroundingChatProvider(captured *ai.CompleteRequest) ai.Registry {
	return ai.Registry{"fake": &fakeProvider{
		name: "fake", label: "Fake", model: "fake-model",
		complete: func(_ context.Context, _ secret.String, _ string, req ai.CompleteRequest) (ai.CompleteResult, error) {
			*captured = req
			return ai.CompleteResult{Content: "ok", Model: "fake-model"}, nil
		},
	}}
}

func postGroundingChat(t *testing.T, ts *httptest.Server) (int, string) {
	t.Helper()
	return doAIRequest(t, ts, http.MethodPost, "/api/ai/chat",
		[]byte(`{"provider":"fake","messages":[{"role":"user","content":"how do caches work?"}]}`))
}

func TestServer_AIChat_OAuthCredential_IsAttachedAsTheMCPToken(t *testing.T) {
	f := newFakeMCPAuthServer(t, nil)
	store := newFakeKeyStore()
	var captured ai.CompleteRequest
	ts := newMCPOAuthTestServer(t, store, newGroundingChatProvider(&captured), f)

	assert.NilError(t, store.Set(context.Background(), "fake", secret.New("invalid-provider-key")))
	completeOAuthFlow(t, ts, f.ts.URL)
	awaitOAuthState(t, ts, "authorized")

	status, body := postGroundingChat(t, ts)
	assert.Equal(t, status, http.StatusOK)

	assert.Equal(t, len(captured.MCPServers), 1)
	assert.Equal(t, captured.MCPServers[0].Token.Reveal(), oauthSentinelAccess)
	assert.Equal(t, captured.MCPServers[0].URL, f.ts.URL)
	assert.Assert(t, strings.Contains(captured.System, "documentation search tool"),
		"the grounding prompt should be present when grounded")

	var got struct {
		Grounded        bool   `json:"grounded"`
		GroundingReason string `json:"groundingReason"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Grounded, true)
	assert.Equal(t, got.GroundingReason, "")

	// The token reached the provider but never the browser.
	assert.Assert(t, !strings.Contains(body, oauthSentinelAccess), "chat response leaked the MCP token: %s", body)
}

// The transparent-refresh path: an expired access token must be swapped for a
// fresh one without the user noticing, and the rotated credential written
// back so the next request does not refresh again.
func TestServer_AIChat_ExpiredOAuthCredential_IsRefreshedTransparently(t *testing.T) {
	f := newFakeMCPAuthServer(t, nil)
	store := newFakeKeyStore()
	var captured ai.CompleteRequest
	ts := newMCPOAuthTestServer(t, store, newGroundingChatProvider(&captured), f)

	assert.NilError(t, store.Set(context.Background(), "fake", secret.New("invalid-provider-key")))
	completeOAuthFlow(t, ts, f.ts.URL)
	awaitOAuthState(t, ts, "authorized")
	exchangeCount := f.tokenRequestCount()

	// Age the stored credential past its expiry, and make the server hand
	// back a distinguishable token on the refresh.
	expireStoredCredential(t, store)
	f.mu.Lock()
	f.nextAccessToken = "invalid-refreshed-access-token"
	f.mu.Unlock()

	status, body := postGroundingChat(t, ts)
	assert.Equal(t, status, http.StatusOK)

	assert.Equal(t, f.tokenRequestCount(), exchangeCount+1, "expected exactly one refresh")
	assert.Equal(t, f.lastTokenRequest().Get("grant_type"), "refresh_token")
	assert.Equal(t, len(captured.MCPServers), 1)
	assert.Equal(t, captured.MCPServers[0].Token.Reveal(), "invalid-refreshed-access-token")

	var got struct {
		Grounded bool `json:"grounded"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Grounded, true)

	// The rotated credential was persisted, so a second chat refreshes no
	// further -- the difference between "transparent refresh" and "a token
	// request on every single message".
	_, _ = postGroundingChat(t, ts)
	assert.Equal(t, f.tokenRequestCount(), exchangeCount+1, "the refreshed token should have been stored")
}

// The dangerous case: the user believes grounding is on, and it isn't. It
// must be stated on the wire and in the prompt, and the request must still
// succeed.
func TestServer_AIChat_UnrenewableOAuthCredential_DegradesHonestlyWithoutBlocking(t *testing.T) {
	f := newFakeMCPAuthServer(t, nil)
	store := newFakeKeyStore()
	var captured ai.CompleteRequest
	ts := newMCPOAuthTestServer(t, store, newGroundingChatProvider(&captured), f)

	assert.NilError(t, store.Set(context.Background(), "fake", secret.New("invalid-provider-key")))
	completeOAuthFlow(t, ts, f.ts.URL)
	awaitOAuthState(t, ts, "authorized")

	expireStoredCredential(t, store)
	f.mu.Lock()
	f.tokenError = "invalid_grant"
	f.mu.Unlock()

	status, body := postGroundingChat(t, ts)
	// Still a successful reply: issue #103's "never block".
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Available       bool   `json:"available"`
		Content         string `json:"content"`
		Grounded        bool   `json:"grounded"`
		GroundingReason string `json:"groundingReason"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, true)
	assert.Equal(t, got.Content, "ok")
	assert.Equal(t, got.Grounded, false)
	assert.Assert(t, strings.Contains(got.GroundingReason, "sign in again"),
		"the reason must tell the user what to do, got %q", got.GroundingReason)

	// No MCP server was attached, and the model was told not to imply its
	// answer was sourced.
	assert.Equal(t, len(captured.MCPServers), 0)
	assert.Assert(t, strings.Contains(captured.System, "without docs grounding"),
		"the degraded prompt should be present")
	assert.Assert(t, !strings.Contains(captured.System, "prefer searching before answering"),
		"the grounded prompt must not also be present")

	// The rejected-refresh error quoted our secrets back at us; none of it
	// may reach the browser.
	for _, leaked := range []string{oauthSentinelRefresh, oauthSentinelSecret} {
		assert.Assert(t, !strings.Contains(body, leaked), "chat response leaked a credential: %s", body)
	}
}

// Nothing configured at all stays exactly as it was before this feature: no
// MCP server, no grounding prompt, grounded=false, and no reason -- "you
// never set this up" is not a per-reply warning.
func TestServer_AIChat_NoOAuthCredential_ReportsUngroundedWithoutAReason(t *testing.T) {
	f := newFakeMCPAuthServer(t, nil)
	store := newFakeKeyStore()
	var captured ai.CompleteRequest
	ts := newMCPOAuthTestServer(t, store, newGroundingChatProvider(&captured), f)

	assert.NilError(t, store.Set(context.Background(), "fake", secret.New("invalid-provider-key")))

	status, body := postGroundingChat(t, ts)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Grounded        bool   `json:"grounded"`
		GroundingReason string `json:"groundingReason"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Grounded, false)
	assert.Equal(t, got.GroundingReason, "")
	assert.Equal(t, len(captured.MCPServers), 0)
	assert.Assert(t, !strings.Contains(captured.System, "documentation search tool"))
	assert.Assert(t, !strings.Contains(captured.System, "without docs grounding"))
}

// Re-pointing the MCP URL at a different server must not hand that server a
// token minted for the first one.
func TestServer_AIChat_OAuthCredentialForADifferentServer_IsNotPresented(t *testing.T) {
	f := newFakeMCPAuthServer(t, nil)
	store := newFakeKeyStore()
	var captured ai.CompleteRequest
	ts := newMCPOAuthTestServer(t, store, newGroundingChatProvider(&captured), f)

	assert.NilError(t, store.Set(context.Background(), "fake", secret.New("invalid-provider-key")))
	completeOAuthFlow(t, ts, f.ts.URL)
	awaitOAuthState(t, ts, "authorized")

	// The user re-points the URL elsewhere without signing in again.
	assert.NilError(t, store.Set(context.Background(), "mcp-docs-url",
		secret.New("https://some-other-docs-server.example.test/")))

	status, body := postGroundingChat(t, ts)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, len(captured.MCPServers), 0, "the credential must not be sent to a different server")

	var got struct {
		Grounded        bool   `json:"grounded"`
		GroundingReason string `json:"groundingReason"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Grounded, false)
	assert.Assert(t, strings.Contains(got.GroundingReason, "different server URL"), got.GroundingReason)
}

// The canonical `resource` the authorization server reports carries a trailing
// slash the user never typed, so the mismatch check must not reject the very
// credential it just stored -- the regression that a naive equality check
// produces, and the reason sameMCPResource exists.
func TestServer_AIChat_OAuthCredential_TolerAtesATrailingSlashDifference(t *testing.T) {
	f := newFakeMCPAuthServer(t, nil)
	store := newFakeKeyStore()
	var captured ai.CompleteRequest
	ts := newMCPOAuthTestServer(t, store, newGroundingChatProvider(&captured), f)

	assert.NilError(t, store.Set(context.Background(), "fake", secret.New("invalid-provider-key")))
	completeOAuthFlow(t, ts, f.ts.URL)
	awaitOAuthState(t, ts, "authorized")

	// The stored credential's resource has the slash; the saved URL does not.
	cred, ok := mcpauth.ParseCredential(mustGet(t, store, "mcp-docs-oauth"))
	assert.Assert(t, ok)
	assert.Equal(t, cred.Resource, f.ts.URL+"/")
	assert.Equal(t, mustGet(t, store, "mcp-docs-url").Reveal(), f.ts.URL)

	status, _ := postGroundingChat(t, ts)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, len(captured.MCPServers), 1, "a trailing-slash difference must not disable grounding")
}

func mustGet(t *testing.T, store *fakeKeyStore, key string) secret.String {
	t.Helper()
	got, ok, err := store.Get(context.Background(), key)
	assert.NilError(t, err)
	assert.Assert(t, ok, "expected %q to be stored", key)
	return got
}

// A manually pasted token keeps working exactly as it did before the OAuth
// flow existed -- the pre-existing BYO path must not regress.
func TestServer_AIChat_ManualTokenStillWorksWithNoOAuthCredential(t *testing.T) {
	f := newFakeMCPAuthServer(t, nil)
	store := newFakeKeyStore()
	var captured ai.CompleteRequest
	ts := newMCPOAuthTestServer(t, store, newGroundingChatProvider(&captured), f)

	ctx := context.Background()
	assert.NilError(t, store.Set(ctx, "fake", secret.New("invalid-provider-key")))
	assert.NilError(t, store.Set(ctx, "mcp-docs-url", secret.New("https://docs.example.test/")))
	assert.NilError(t, store.Set(ctx, "mcp-docs-token", secret.New("invalid-manual-token")))

	status, body := postGroundingChat(t, ts)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, len(captured.MCPServers), 1)
	assert.Equal(t, captured.MCPServers[0].Token.Reveal(), "invalid-manual-token")
	assert.Assert(t, !strings.Contains(body, "invalid-manual-token"))
}

// expireStoredCredential rewrites the stored credential with an expiry in the
// past, which is how these tests simulate the passage of an hour without
// sleeping or injecting a clock.
func expireStoredCredential(t *testing.T, store *fakeKeyStore) {
	t.Helper()
	ctx := context.Background()
	stored, ok, err := store.Get(ctx, "mcp-docs-oauth")
	assert.NilError(t, err)
	assert.Assert(t, ok)

	cred, parsed := mcpauth.ParseCredential(stored)
	assert.Assert(t, parsed)
	cred.Token.Expiry = time.Now().Add(-time.Hour)

	blob, err := cred.Marshal()
	assert.NilError(t, err)
	assert.NilError(t, store.Set(ctx, "mcp-docs-oauth", blob))
}

// TestServer_AIMCPOAuth_StatusIsRaceFreeWhileAFlowSettles pins the fix for a
// data race that reached main and was caught only by CI's macOS runner under
// `-race`: mcpOAuthStatus copied the *pointer* to the in-flight flow under
// mcpOAuthMu, released the lock, and then read `flow.state`/`flow.message` --
// the exact fields `settle` writes from the callback goroutine while holding
// that same mutex.
//
// The original failure was intermittent by nature. It passed on Linux and
// Windows in the very run macOS failed, and 25 local `-race` runs of the test
// that caught it did not reproduce it at all -- which is precisely why it
// shipped. So this test does not rely on losing a race by luck: it polls the
// status endpoint from several goroutines *across* the window in which the
// flow settles, which is the concurrent shape the production code actually has
// (the SPA polls GET /api/ai/mcp/oauth while the user completes sign-in in
// another tab).
//
// It asserts nothing about the responses beyond their being served: the race
// detector is the assertion.
func TestServer_AIMCPOAuth_StatusIsRaceFreeWhileAFlowSettles(t *testing.T) {
	f := newFakeMCPAuthServer(t, nil)
	ts := newMCPOAuthTestServer(t, newFakeKeyStore(), ai.Registry{}, f)

	var wg sync.WaitGroup
	stop := make(chan struct{})
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				resp, err := http.Get(ts.URL + "/api/ai/mcp/oauth")
				if err == nil {
					_, _ = io.Copy(io.Discard, resp.Body)
					_ = resp.Body.Close()
				}
			}
		}()
	}

	// Runs the whole flow -- start, authorization, callback -- while the
	// readers above are in flight, so the settle happens under concurrent
	// reads rather than in isolation.
	completeOAuthFlow(t, ts, f.ts.URL)
	_ = awaitOAuthState(t, ts, "authorized")

	close(stop)
	wg.Wait()
}
