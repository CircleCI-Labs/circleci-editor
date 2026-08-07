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
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/anthropic"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/circlecimcp"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/keystore"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
	"github.com/CircleCI-Labs/circleci-editor/internal/guides"
)

// chatTimeout bounds a single POST /api/ai/chat call. Generous relative to
// /api/validate's 20s because a chat reply is naturally slower, but still
// finite -- a hung provider call must not hang the pane forever (see
// internal/ai/anthropic's own, shorter requestTimeout: this is the outer
// bound across the whole handler, that is the bound on the one HTTP call
// it makes).
const chatTimeout = 75 * time.Second

// maxChatMessages bounds how many turns of conversation a single request
// may replay to the provider -- a client bug or a runaway loop must not be
// able to turn one browser tab into an unbounded, unbounded-cost stream of
// provider tokens.
const maxChatMessages = 200

// aiProviderStatusPayload is one entry of GET /api/ai/status's "providers".
type aiProviderStatusPayload struct {
	ID         string `json:"id"`
	Label      string `json:"label"`
	Configured bool   `json:"configured"`
	// Model is the model this provider will use if invoked right now.
	// Surfacing it here -- rather than the component ever naming a model --
	// is what "no hardcoded model names in components" (issue #92) means in
	// practice.
	Model string `json:"model"`
	// Source is keystore.KeySource ("environment", "store", or "none"):
	// where the key in effect right now, if any, actually comes from. Added
	// for issue #7 -- before this field existed, Configured alone could not
	// distinguish "a key is stored" from "an environment variable is
	// supplying one", which is exactly the distinction the pane needs to
	// decide whether its Remove button would do anything.
	Source string `json:"source"`
	// EnvVar names the environment variable checked for this provider (see
	// keystore.KeyEnvVar), populated whether or not it is actually set --
	// the pane needs the name to explain *why* a key is shadowed, and the
	// name is not a secret, so there is no reason to withhold it in the
	// common case.
	EnvVar string `json:"envVar"`
	// StoredKeyShadowed is true exactly when a stored key exists but
	// Source is "environment": the environment variable is currently
	// overriding it. This is the one state in which the pane's Remove
	// button is still a legitimate action -- there really is something in
	// the store to delete -- but must not be presented as "the key is now
	// gone", because EnvVar will still supply one afterwards. See issue #7.
	StoredKeyShadowed bool `json:"storedKeyShadowed"`
}

// providerStatusPayload builds one provider's status entry from a
// keystore.Lookup, the single source of truth both this endpoint and
// aiKeyResponse (below) render from -- so "what /api/ai/status just said"
// and "what PUT/DELETE /api/ai/key just said" can never disagree about the
// same provider, which is what let issue #7 happen in the first place
// (DELETE's response was built from nothing but the delete call's own
// success, never from what was actually left in effect afterwards).
func providerStatusPayload(lookup keystore.Lookup) (configured bool, source string, envVar string, storedKeyShadowed bool) {
	return lookup.Source != keystore.SourceNone,
		string(lookup.Source),
		lookup.EnvVar,
		lookup.Source == keystore.SourceEnv && lookup.Stored
}

// aiStoragePayload describes where keys are persisted, so the UI can tell a
// user exactly where their key lives and how to remove it by hand if they
// ever want to bypass this app entirely.
type aiStoragePayload struct {
	Backend  string `json:"backend"`
	Location string `json:"location"`
}

// aiCircleCIStatusPayload is GET /api/ai/status's report on CircleCI's own
// hosted MCP server (issue #11) -- read-only tools (pipeline/workflow/job
// status, logs, artifacts, test results) the assistant may call directly.
//
// There is no BYO configuration step here the way there is for the docs
// server (aiMCPStatusResponse): this server needs no URL or token from the
// user at all, because it authenticates with the same CIRCLE_TOKEN the CLI
// plugin already injects for every other CircleCI-backed feature (see
// internal/host/env.go's Environment.Token and, e.g., runAvailability's
// identical "no token" degradation). So the only fact worth reporting is
// whether that token exists in this process right now, and Reason names it
// plainly when it does not -- the honest-degradation rule this app applies
// everywhere else: a pane that cannot tell whether CircleCI tools are
// available must never render as though they simply have none.
type aiCircleCIStatusPayload struct {
	Available bool `json:"available"`
	// Reason is set only when Available is false, naming why -- today
	// always "no CircleCI API token available in this environment", the
	// one state this host can actually distinguish (see the type doc).
	Reason string `json:"reason,omitempty"`
}

// circleCIMCPStatus reports whether s.env carries a CircleCI API token,
// which is the only precondition this host can check without making a
// network call of its own -- it never probes mcp.circleci.com to answer
// this, for the same reason loadMCPConfig never pings the docs server: an
// extra request on this app's own critical path buys no honesty this
// process didn't already have for free by reading its own environment.
// Whether the *remote* server is currently reachable is instead something
// the assistant's own reply reports, turn by turn, the same way any
// tool-use failure would surface in a model's own text -- see
// circleCIToolsPrompt.
func (s *Server) circleCIMCPStatus() aiCircleCIStatusPayload {
	if !s.env.HasToken() {
		return aiCircleCIStatusPayload{Reason: circleCINoTokenReason}
	}
	return aiCircleCIStatusPayload{Available: true}
}

// circleCINoTokenReason is the one reason /api/ai/status and /api/ai/chat
// ever give for CircleCI's MCP tools being unavailable -- named once so the
// two call sites (circleCIMCPStatus and handleAIChat) cannot drift to
// slightly different wording for the identical fact.
const circleCINoTokenReason = "no CircleCI API token available in this environment" //nolint:gosec // this is a human-readable status message, not a credential -- gosec's G101 pattern-matches the word "token" in a string constant's name and value, the same false positive mcpDocsTokenKey is already annotated for above.

// aiStatusResponse is the JSON shape returned by GET /api/ai/status. Unlike
// /api/meta and /api/validate, there is no single "available" flag here --
// availability is per-provider (Configured), because "is the AI pane usable
// at all" depends on which provider, if any, has a key stored.
type aiStatusResponse struct {
	Providers []aiProviderStatusPayload `json:"providers"`
	Storage   aiStoragePayload          `json:"storage"`
	// CircleCI reports this app's read-only CircleCI MCP tools (issue #11),
	// independent of every provider above: it needs no API key of its own,
	// only the CLI plugin's own CIRCLE_TOKEN.
	CircleCI aiCircleCIStatusPayload `json:"circleCI"`
}

// handleAIStatus serves GET /api/ai/status: which providers this build
// knows about, whether each has a key configured (never the key itself),
// which model each would use, and where keys are stored.
func (s *Server) handleAIStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	providers := make([]aiProviderStatusPayload, 0, len(s.aiProviders))
	for _, p := range s.aiProviders.Providers() {
		// keystore.LookupKey degrades a store read failure to Stored=false
		// on its own (see its doc comment) -- the same "not configured"
		// degradation this handler always had, just now computed in one
		// place shared with the CLI's `ai status` instead of duplicated
		// here as a bare bool.
		lookup := keystore.LookupKey(ctx, s.aiStore, p.Name())
		configured, source, envVar, shadowed := providerStatusPayload(lookup)
		providers = append(providers, aiProviderStatusPayload{
			ID:                p.Name(),
			Label:             p.Label(),
			Configured:        configured,
			Model:             p.DefaultModel(),
			Source:            source,
			EnvVar:            envVar,
			StoredKeyShadowed: shadowed,
		})
	}

	writeJSON(w, http.StatusOK, aiStatusResponse{
		Providers: providers,
		Storage: aiStoragePayload{
			Backend:  string(s.aiStore.Backend()),
			Location: s.aiStore.Location(),
		},
		CircleCI: s.circleCIMCPStatus(),
	})
}

// aiKeyPutRequest is the JSON body accepted by PUT /api/ai/key.
type aiKeyPutRequest struct {
	Provider string `json:"provider"`
	Key      string `json:"key"`
}

// aiKeyResponse is returned by both PUT and DELETE /api/ai/key. It never
// contains the key itself -- only whether one is now configured -- by
// construction: there is no field here capable of holding it.
//
// Source/EnvVar/StoredKeyShadowed exist for the same reason they were added
// to aiProviderStatusPayload (issue #7): Configured alone cannot tell the
// pane whether the DELETE it just sent actually changed anything. Before
// this, DELETE unconditionally reported Configured=false -- true of the
// store, but not of what is in effect when an environment variable is
// shadowing it, which is precisely how a "Remove" click could report
// success while a key stayed usable.
type aiKeyResponse struct {
	Provider          string           `json:"provider"`
	Configured        bool             `json:"configured"`
	Storage           aiStoragePayload `json:"storage"`
	Source            string           `json:"source"`
	EnvVar            string           `json:"envVar"`
	StoredKeyShadowed bool             `json:"storedKeyShadowed"`
}

// handleAIKey serves PUT and DELETE /api/ai/key: storing or removing one
// provider's API key. The key is never echoed back in either response (see
// aiKeyResponse) and never logged -- s.aiStore.Set/Delete receive it
// wrapped in secret.String the moment it's decoded off the wire, and this
// handler never calls Reveal.
func (s *Server) handleAIKey(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPut:
		s.handleAIKeyPut(w, r)
	case http.MethodDelete:
		s.handleAIKeyDelete(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleAIKeyPut(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	defer func() { _ = r.Body.Close() }()

	var req aiKeyPutRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "malformed request body")
		return
	}
	if req.Provider == "" {
		writeError(w, http.StatusBadRequest, "missing required field: provider")
		return
	}
	if _, ok := s.aiProviders.Get(req.Provider); !ok {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("unknown provider %q", req.Provider))
		return
	}
	if strings.TrimSpace(req.Key) == "" {
		writeError(w, http.StatusBadRequest, "missing required field: key")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := s.aiStore.Set(ctx, req.Provider, secret.New(req.Key)); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to store the API key")
		return
	}

	// Read back through LookupKey rather than assuming Configured=true: if
	// CIRCLECI_EDITOR_AI_KEY_<PROVIDER> is already set, the key that was just stored is
	// shadowed from the moment it lands, and the response must say so
	// instead of implying it is now the key in effect (see aiKeyResponse's
	// doc comment).
	lookup := keystore.LookupKey(ctx, s.aiStore, req.Provider)
	configured, source, envVar, shadowed := providerStatusPayload(lookup)
	writeJSON(w, http.StatusOK, aiKeyResponse{
		Provider:          req.Provider,
		Configured:        configured,
		Storage:           aiStoragePayload{Backend: string(s.aiStore.Backend()), Location: s.aiStore.Location()},
		Source:            source,
		EnvVar:            envVar,
		StoredKeyShadowed: shadowed,
	})
}

func (s *Server) handleAIKeyDelete(w http.ResponseWriter, r *http.Request) {
	provider := r.URL.Query().Get("provider")
	if provider == "" {
		writeError(w, http.StatusBadRequest, "missing required query parameter: provider")
		return
	}
	if _, ok := s.aiProviders.Get(provider); !ok {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("unknown provider %q", provider))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := s.aiStore.Delete(ctx, provider); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to remove the API key")
		return
	}

	// This is issue #7's actual fix: Configured used to be hardcoded false
	// here, which is only true of the store this call just emptied. Reading
	// back through LookupKey reports what a key is genuinely still in
	// effect for -- an environment variable does not stop existing because
	// this process deleted a file or a keychain entry -- so a "Remove"
	// click can no longer claim an effect it did not have.
	lookup := keystore.LookupKey(ctx, s.aiStore, provider)
	configured, source, envVar, shadowed := providerStatusPayload(lookup)
	writeJSON(w, http.StatusOK, aiKeyResponse{
		Provider:          provider,
		Configured:        configured,
		Storage:           aiStoragePayload{Backend: string(s.aiStore.Backend()), Location: s.aiStore.Location()},
		Source:            source,
		EnvVar:            envVar,
		StoredKeyShadowed: shadowed,
	})
}

// aiChatMessage is one entry of aiChatRequest.Messages.
type aiChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// lastUserMessage returns the latest user turn in messages -- the
// "question" half of what guides.SelectPassages grounds on (issue #22's
// "relevant to the question and the open config"). Falls back to the very
// last message when none is explicitly role "user" (a malformed or
// test-constructed request): grounding on the most recent thing said is
// closer to right than grounding on nothing merely because the shape is
// unusual, and SelectPassages already degrades to zero passages on its own
// when nothing in whatever string it's given matches anything.
func lastUserMessage(messages []aiChatMessage) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == string(ai.RoleUser) {
			return messages[i].Content
		}
	}
	if len(messages) > 0 {
		return messages[len(messages)-1].Content
	}
	return ""
}

// mcpDocsURLKey and mcpDocsTokenKey are the keystore.Store ids under which
// this app's single, optional docs-grounding MCP server (issue #103's Kapa
// docs server, or any other remote MCP server BYO-pointed here) is stored
// -- alongside provider keys, in the same store, protected the same way
// (OS keychain, else a 0600 file). Two separate entries rather
// than one JSON blob: URL is not a secret (it's shown back to the user by
// GET /api/ai/mcp, same as a provider's storage location already is), so
// bundling it with Token into one keystore.Store value would mean either
// revealing the token every time the UI just wants to redisplay the URL, or
// growing keystore.Store's interface to know about structured values --
// neither is worth it for two related strings. Neither id ever appears in
// GET /api/ai/status's providers list: this configures a *tool* a chat
// request can use, not a chat backend of its own.
const (
	mcpDocsURLKey   = "mcp-docs-url"
	mcpDocsTokenKey = "mcp-docs-token" //nolint:gosec // this is a keystore.Store *key name* (like "anthropic" for the provider key), never a credential value -- the actual token is always wrapped in secret.String before it touches this constant.
)

// mcpServerName is the fixed ai.MCPServer.Name this app sends for its one
// configurable MCP slot. There is exactly one slot (see the package doc on
// why this app doesn't offer a general multi-server manager yet), so there
// is no user-facing "name" to collect -- this is purely the connector's own
// mcp_servers[].name / tools[].mcp_toolset.mcp_server_name correlation key.
const mcpServerName = "circleci-docs"

// aiMCPStatusResponse is served by GET, PUT and DELETE /api/ai/mcp. It
// never echoes Token -- only whether one is set (HasToken) -- following
// the exact "never echo the secret back" convention aiKeyResponse already
// established for provider keys. URL is not a secret and is safe to
// return: it's the address of a server, not a credential, and showing it
// back is what lets the settings UI redisplay "currently pointed at X"
// without the browser having to remember it itself.
type aiMCPStatusResponse struct {
	Configured bool   `json:"configured"`
	URL        string `json:"url,omitempty"`
	HasToken   bool   `json:"hasToken"`
}

// handleAIMCP serves GET, PUT and DELETE /api/ai/mcp: reading, setting, and
// clearing this app's one optional docs-grounding MCP server configuration.
// See internal/ai.MCPServer and internal/ai/anthropic's package doc for
// where this ends up (a request-shape addition to the next /api/ai/chat
// call, never a connection this host opens itself).
func (s *Server) handleAIMCP(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleAIMCPGet(w, r)
	case http.MethodPut:
		s.handleAIMCPPut(w, r)
	case http.MethodDelete:
		s.handleAIMCPDelete(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleAIMCPGet(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	url, hasToken, configured, err := s.loadMCPConfigForDisplay(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read the stored MCP server configuration")
		return
	}
	writeJSON(w, http.StatusOK, aiMCPStatusResponse{Configured: configured, URL: url, HasToken: hasToken})
}

// aiMCPPutRequest is the JSON body accepted by PUT /api/ai/mcp. Token is
// optional per the MCP spec's own "auth is optional" stance (see
// ai.MCPServer's doc comment) -- an empty Token on a PUT clears any
// previously stored token rather than leaving it untouched, so "configure
// with no token" and "remove the token I previously set" are the same,
// discoverable action rather than two different code paths.
type aiMCPPutRequest struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

func (s *Server) handleAIMCPPut(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	defer func() { _ = r.Body.Close() }()

	var req aiMCPPutRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "malformed request body")
		return
	}
	req.URL = strings.TrimSpace(req.URL)
	if req.URL == "" {
		writeError(w, http.StatusBadRequest, "missing required field: url")
		return
	}
	if !strings.HasPrefix(req.URL, "https://") {
		// Matches the MCP connector's own requirement (see
		// internal/ai/anthropic's package doc and the connector docs it
		// cites): Anthropic's API rejects anything else, so failing here is
		// a clearer, faster error than letting the provider reject it on
		// the next chat request.
		writeError(w, http.StatusBadRequest, "url must start with https://")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := s.aiStore.Set(ctx, mcpDocsURLKey, secret.New(req.URL)); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to store the MCP server URL")
		return
	}
	// See aiMCPPutRequest's doc comment: an empty Token deliberately clears
	// any previously stored one rather than leaving it untouched.
	var tokenErr error
	if req.Token == "" {
		tokenErr = s.aiStore.Delete(ctx, mcpDocsTokenKey)
	} else {
		tokenErr = s.aiStore.Set(ctx, mcpDocsTokenKey, secret.New(req.Token))
	}
	if tokenErr != nil {
		writeError(w, http.StatusInternalServerError, "failed to store the MCP server token")
		return
	}

	writeJSON(w, http.StatusOK, aiMCPStatusResponse{Configured: true, URL: req.URL, HasToken: req.Token != ""})
}

func (s *Server) handleAIMCPDelete(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	urlErr := s.aiStore.Delete(ctx, mcpDocsURLKey)
	tokenErr := s.aiStore.Delete(ctx, mcpDocsTokenKey)
	if urlErr != nil || tokenErr != nil {
		writeError(w, http.StatusInternalServerError, "failed to remove the MCP server configuration")
		return
	}

	writeJSON(w, http.StatusOK, aiMCPStatusResponse{})
}

// loadMCPConfigForDisplay is handleAIMCPGet's own read path: like
// handleAIStatus's keystore read, a storage failure degrades to "not
// configured" is the wrong call here (unlike handleAIChat's loadMCPConfig,
// getting this wrong doesn't risk sending a stale/wrong config to the
// provider) -- so this one does propagate the error, distinctly from
// loadMCPConfig below.
func (s *Server) loadMCPConfigForDisplay(ctx context.Context) (url string, hasToken bool, configured bool, err error) {
	urlSecret, ok, err := s.aiStore.Get(ctx, mcpDocsURLKey)
	if err != nil {
		return "", false, false, err
	}
	if !ok || !urlSecret.IsSet() {
		return "", false, false, nil
	}
	tokenSecret, _, err := s.aiStore.Get(ctx, mcpDocsTokenKey)
	if err != nil {
		return "", false, false, err
	}
	// urlSecret.Reveal() here is justified the same way internal/ai/secret's
	// doc comment justifies its one other call site: URL is not a secret
	// (see aiMCPStatusResponse's own doc comment) and this is the value's
	// designated, documented display path.
	return urlSecret.Reveal(), tokenSecret.IsSet(), true, nil
}

// loadMCPConfig is handleAIChat's read path: the MCP server this app should
// attach to the next provider request, if any. Unlike
// loadMCPConfigForDisplay, a storage error here degrades to "not
// configured" (configured=false, err=nil) rather than propagating -- this
// is issue #103's "no MCP access must leave the assistant exactly as
// capable as it is today" invariant applied to the host's own storage
// layer, not just to the provider's network call: a flaky keychain must
// never turn "answer without docs grounding" into "the chat request fails
// outright".
// reason, when non-empty, explains why an MCP server that *is* configured
// could not be used for this request -- an expired OAuth sign-in that could
// not be renewed being the case that matters (see mcpOAuthToken). It is
// deliberately empty in the nothing-configured case: "you never set this up"
// is not a degradation to report on every reply, whereas "the docs grounding
// you configured is silently off right now" absolutely is. handleAIChat puts
// it on the wire; see aiChatResponse.GroundingReason.
func (s *Server) loadMCPConfig(ctx context.Context) (server ai.MCPServer, configured bool, reason string) {
	urlSecret, ok, err := s.aiStore.Get(ctx, mcpDocsURLKey)
	if err != nil || !ok || !urlSecret.IsSet() {
		return ai.MCPServer{}, false, ""
	}
	// urlSecret.Reveal() here is justified the same way key.Reveal() is
	// justified a few lines below in handleAIChat: this value crosses into
	// ai.CompleteRequest.MCPServers, which anthropic.Client.Complete sends
	// on to Anthropic's API as the mcp_servers[].url field, and is never
	// logged or echoed back to a response from this function.
	serverURL := urlSecret.Reveal()

	// An OAuth credential, when one exists, wins over a manually pasted
	// token: it is the one this app can keep fresh by itself (issue #103),
	// and a stale hand-pasted token sitting alongside it should not be what
	// gets sent. mcpOAuthToken returns an unset token with no reason when no
	// credential is stored at all, which falls through to the manual token
	// below -- so the pre-existing BYO path is untouched for anyone using it.
	oauthToken, reason := s.mcpOAuthToken(ctx, serverURL)
	if reason != "" {
		// Configured, but not usable right now. Report *why*, and send no
		// MCP server -- never a token known to be rejected.
		return ai.MCPServer{}, false, reason
	}
	if oauthToken.IsSet() {
		return ai.MCPServer{Name: mcpServerName, URL: serverURL, Token: oauthToken}, true, ""
	}

	tokenSecret, _, err := s.aiStore.Get(ctx, mcpDocsTokenKey)
	if err != nil {
		return ai.MCPServer{}, false, ""
	}
	return ai.MCPServer{Name: mcpServerName, URL: serverURL, Token: tokenSecret}, true, ""
}

// loadCircleCIMCPConfig is handleAIChat's read path for issue #11's second
// MCP server -- CircleCI's own hosted one, read tools only. Unlike
// loadMCPConfig there is no keystore to read at all: this server is never
// BYO-configured, it rides s.env.Token exactly the way runAvailability and
// buildCircleCIClients already do for this app's other CircleCI-backed
// features, and configured is simply whether that token exists (see
// circleCIMCPStatus, which reports the identical fact to the settings
// pane before any chat request is ever sent).
//
// AllowedTools always comes from circlecimcp.AllowedTools() -- never from
// anything in ctx, ai.CompleteRequest, or a previous reply -- which is what
// makes this app's read/write gate a *request-shaping* decision made
// entirely on this host, before the model runs at all, rather than a
// policy the model could talk its way around. See circlecimcp's package
// doc for the mechanism this feeds.
func (s *Server) loadCircleCIMCPConfig() (server ai.MCPServer, configured bool) {
	if !s.env.HasToken() {
		return ai.MCPServer{}, false
	}
	return ai.MCPServer{
		Name: circlecimcp.ServerName,
		URL:  circlecimcp.URL,
		// secret.New here is justified the same way every other Reveal/wrap
		// site in this file is: s.env.Token is already held in memory for
		// this process's whole lifetime (LoadEnvironment reads it once at
		// startup), and wrapping it is what stops it becoming a plain string
		// again anywhere past this point.
		Token:        secret.New(s.env.Token),
		AllowedTools: circlecimcp.AllowedTools(),
	}, true
}

// aiChatContextFile is one other file from the same `.circleci` directory
// (issue #102), sent as read-only context alongside the open config.
// Deliberately has no analogue to ConfigText's validation/job/workflow
// metadata: those are derived facts about the *open* document specifically
// (see aiChatContext's own doc comment), and computing them for every
// sibling file would suggest they're equally actionable, when they are
// not -- see actionSchemaPrompt's addition confining every action to
// ConfigPath.
type aiChatContextFile struct {
	Path string `json:"path"`
	Text string `json:"text"`
}

// aiChatSkippedFile is one file the frontend's directory-context assembler
// found in the `.circleci` listing but chose not to send -- either because
// including it would have exceeded the token budget, or because the host
// itself omitted its contents (see configFileEntry.Omitted). Named in the
// system prompt precisely so the model never has to guess whether a file
// it can't see was forgotten or deliberately left out.
type aiChatSkippedFile struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// aiChatPolicyViolation is one config-policy rule that fired against the
// open config, exactly as the frontend's `PolicyStrip` shows it (issue #247
// item 6). Rule and Reason are CircleCI's own words, forwarded verbatim --
// this host never rewords or summarises them, for the same reason it never
// rewords a compile error.
//
// Rule text is org configuration and may name internal services, teams or
// standards, so this is a *second* outbound flow beyond posting the config
// for evaluation: sending it on to a user-supplied AI provider. That is
// disclosed in this editor's own docs page ("What the AI pane sends" in
// internal/guides/editor/using-this-editor.adoc), exactly as the config
// itself already is.
type aiChatPolicyViolation struct {
	Rule     string `json:"rule"`
	Reason   string `json:"reason"`
	Blocking bool   `json:"blocking"`
}

// aiChatContext is the repo-aware context the frontend assembles from its
// own already-loaded state (the open config's text and path, the job/
// workflow names the DAG pane already parsed, and the current validation
// result) and sends alongside a chat request. The host never independently
// reads the filesystem to build this -- it only ever sees what the frontend
// already had open, which is what makes "never send the whole repo
// silently" true by construction rather than by a size check.
//
// OtherFiles/SkippedFiles (issue #102) extend that same invariant to the
// rest of the `.circleci` directory: the frontend fetches every sibling
// file itself (GET /api/config-files?contents=1), applies its own token
// budget, and hands the result here as plain read-only text -- the host
// still never reads the filesystem on the AI pane's behalf, it only ever
// forwards what the browser already fetched and decided to include.
//
// PolicyViolations (issue #247) follows the exact same shape as
// ValidationErrors: the frontend has already decided which violations are
// current and non-stale (see policyStore.ts's `currentPolicyContext`), and
// this host only ever forwards what it was handed.
type aiChatContext struct {
	ConfigPath       string                  `json:"configPath"`
	ConfigText       string                  `json:"configText"`
	JobNames         []string                `json:"jobNames"`
	WorkflowNames    []string                `json:"workflowNames"`
	ValidationErrors []string                `json:"validationErrors"`
	OtherFiles       []aiChatContextFile     `json:"otherFiles"`
	SkippedFiles     []aiChatSkippedFile     `json:"skippedFiles"`
	PolicyViolations []aiChatPolicyViolation `json:"policyViolations"`
}

// aiChatRequest is the JSON body accepted by POST /api/ai/chat.
type aiChatRequest struct {
	Provider string          `json:"provider"`
	Messages []aiChatMessage `json:"messages"`
	Context  aiChatContext   `json:"context"`
}

// aiUsagePayload reports a best-effort token count for the completed
// request, purely for the cost transparency issue #92 asks for.
type aiUsagePayload struct {
	InputTokens  int `json:"inputTokens"`
	OutputTokens int `json:"outputTokens"`
}

// aiChatSource is one citation in an aiChatResponse: the URL to open, plus
// the human title the host resolved for it from the vendored docs snapshot
// when it could (issue #156 -- the owner's "it'd be nice to display that a
// little bit nicer").
//
// Title is omitted rather than filled with the URL when nothing could be
// resolved, so the frontend can tell "this is the page's real title" from
// "nobody knows what this page is called" and label the row accordingly
// instead of showing a truncated URL twice.
type aiChatSource struct {
	URL   string `json:"url"`
	Title string `json:"title,omitempty"`
}

// aiChatResponse is the JSON shape returned by POST /api/ai/chat.
//
// Available follows the same convention as validateResponse.Available (see
// internal/host/validate.go): false means the request could not be
// attempted at all -- here, because the requested provider has no key
// configured -- which must never be presented as "the assistant has
// nothing to say". A provider-side auth or transport failure is instead
// reported as an HTTP error response, exactly like /api/validate.
type aiChatResponse struct {
	Available bool           `json:"available"`
	Reason    string         `json:"reason,omitempty"`
	Content   string         `json:"content,omitempty"`
	Model     string         `json:"model,omitempty"`
	Usage     aiUsagePayload `json:"usage,omitempty"`
	// Sources lists links worth showing under the reply, rendered by the
	// frontend as a "Sources" footer independent of whatever the model's
	// own reply text says -- issue #103's "citations in replies" without
	// depending on the model remembering to write a Markdown link. Two
	// origins, concatenated, grounding-selected ones first:
	//
	//   - The vendored documentation this host itself selected and placed
	//     in the system prompt (issue #22, see selectGroundingPassages) --
	//     certain to have been shown to the model, the same certainty
	//     web/src/lib/ai/deterministicSources.ts's app-attached rows carry
	//     for a diagnostic. Present whether or not any MCP server is
	//     configured, because selection needs neither a credential nor a
	//     network call.
	//   - Whatever the provider's own MCP tool calls turned up (see
	//     ai.CompleteResult.Sources), when a docs-grounding MCP server is
	//     configured and the model chose to use it.
	//
	// Every entry has been through guides.CitationResolver (issue #156): an
	// image asset is either remapped to the page that shows it or dropped, a
	// non-page asset is dropped, duplicates are collapsed (so a grounding
	// selection the provider also cited is never listed twice), and a title
	// is attached when the vendored AsciiDoc could resolve one offline.
	Sources []aiChatSource `json:"sources,omitempty"`
	// Grounded reports whether a docs-grounding MCP server was actually
	// attached to this request. Issue #103 requires the assistant to *say*
	// when it is answering without docs backing, and the app saying it is
	// strictly more reliable than asking the model to remember to: a badge
	// rendered from this flag cannot be forgotten mid-reply, cannot be
	// hallucinated, and cannot be argued with. Always false when no MCP
	// server is configured -- which is the honest answer for every build
	// before this one too.
	Grounded bool `json:"grounded"`
	// GroundingReason is set only in the case worth being loud about: a docs
	// server *is* configured but could not be used for this reply (an
	// expired OAuth sign-in with no refresh token, a revoked credential, a
	// server that has stopped recognising this app's registration). The
	// dangerous state is the user believing grounding is on while answers
	// have quietly gone back to being recalled, so this is deliberately not
	// collapsed into Grounded=false.
	GroundingReason string `json:"groundingReason,omitempty"`
	// CircleCIAvailable reports whether this reply had CircleCI's own
	// read-only MCP tools available (issue #11) -- independent of Grounded,
	// which is about the unrelated docs-grounding server. False means no
	// CircleCI API token was available in this environment; CircleCIReason
	// names that plainly rather than letting a "why couldn't it check my
	// pipeline" question go unanswered.
	CircleCIAvailable bool `json:"circleCIAvailable"`
	// CircleCIReason is set whenever CircleCIAvailable is false -- unlike
	// GroundingReason, there is no "configured but broken" state to reserve
	// this for (see circleCIMCPStatus): this server is either usable or it
	// is not, so its absence is always worth naming.
	CircleCIReason string `json:"circleCIReason,omitempty"`
}

// handleAIChat serves POST /api/ai/chat: it builds a system prompt from the
// submitted repo-aware context (see aiChatContext and buildSystemPrompt),
// sends it plus the conversation so far to the requested provider using
// that provider's stored key, and returns the assistant's reply verbatim.
//
// The reply may contain a fenced ```action code block proposing a config
// change (see buildSystemPrompt for the schema the system prompt asks the
// model to follow); this handler does not parse, validate, or act on it in
// any way -- that entire responsibility belongs to the frontend's
// lib/ai/actions.ts, which maps a proposed action onto a real
// configMutations.ts function and shows the user a diff to approve before
// anything is written. The host is a dumb proxy for the chat text; it never
// mutates the config on the model's behalf.
func (s *Server) handleAIChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	defer func() { _ = r.Body.Close() }()

	var req aiChatRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "malformed request body")
		return
	}
	if req.Provider == "" {
		writeError(w, http.StatusBadRequest, "missing required field: provider")
		return
	}
	provider, ok := s.aiProviders.Get(req.Provider)
	if !ok {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("unknown provider %q", req.Provider))
		return
	}
	if len(req.Messages) == 0 {
		writeError(w, http.StatusBadRequest, "missing required field: messages")
		return
	}
	if len(req.Messages) > maxChatMessages {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("too many messages (max %d)", maxChatMessages))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), chatTimeout)
	defer cancel()

	key, configured, err := s.aiStore.Get(ctx, req.Provider)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read the stored API key")
		return
	}
	if !configured {
		writeJSON(w, http.StatusOK, aiChatResponse{
			Available: false,
			Reason:    fmt.Sprintf("no API key configured for %s; add one in the AI pane's settings first", provider.Label()),
		})
		return
	}

	messages := make([]ai.Message, len(req.Messages))
	for i, m := range req.Messages {
		role := ai.RoleUser
		if m.Role == string(ai.RoleAssistant) {
			role = ai.RoleAssistant
		}
		messages[i] = ai.Message{Role: role, Content: m.Content}
	}

	// See loadMCPConfig's own doc comment for why a storage failure here
	// degrades to "not configured" rather than failing this request.
	mcpServer, mcpConfigured, groundingReason := s.loadMCPConfig(ctx)
	var mcpServers []ai.MCPServer
	if mcpConfigured {
		mcpServers = append(mcpServers, mcpServer)
	}
	// Issue #11's server: attached alongside (never instead of) the docs
	// server above -- Anthropic's connector supports multiple mcp_servers
	// entries in one request, and internal/ai/anthropic already loops over
	// every entry in MCPServers to build one wireMCPServer/wireMCPToolset
	// pair each, so this needed no change there. See loadCircleCIMCPConfig
	// for why "configured" here is a plain token check, not a reason worth
	// carrying through to the reply the way groundingReason is.
	circleCIServer, circleCIConfigured := s.loadCircleCIMCPConfig()
	if circleCIConfigured {
		mcpServers = append(mcpServers, circleCIServer)
	}

	// Issue #22: the vendored docs snapshot this host already has parsed in
	// memory for the Reference pane and for citations() below is grounding
	// this app can add to every request, MCP or not -- it needs no
	// credential and no network, so unlike mcpServer above it is never
	// "configured" or "unavailable", only ever "matched something" or
	// "didn't". See guides.SelectPassages for the selection policy.
	passages, groundingProvenance := s.selectGroundingPassages(lastUserMessage(req.Messages), req.Context.ConfigText)

	result, err := provider.Complete(ctx, key, provider.DefaultModel(), ai.CompleteRequest{
		System: buildSystemPrompt(systemPromptInput{
			ctx:               req.Context,
			mcpConfigured:     mcpConfigured,
			groundingDegraded: groundingReason != "",
			passages:          passages,
			provenance:        groundingProvenance,
			circleCIAvailable: circleCIConfigured,
			projectSlug:       s.env.ProjectSlug(),
		}),
		Messages:   messages,
		MCPServers: mcpServers,
	})
	if err != nil {
		var authErr *ai.AuthError
		if errors.As(err, &authErr) {
			writeError(w, http.StatusBadGateway, fmt.Sprintf("%s rejected the configured API key", provider.Label()))
			return
		}
		writeError(w, http.StatusBadGateway, fmt.Sprintf("failed to reach %s", provider.Label()))
		return
	}

	groundingURLs := make([]string, len(passages))
	for i, p := range passages {
		groundingURLs[i] = p.URL
	}

	circleCIReason := ""
	if !circleCIConfigured {
		circleCIReason = circleCINoTokenReason
	}
	writeJSON(w, http.StatusOK, aiChatResponse{
		Available:         true,
		Content:           result.Content,
		Model:             result.Model,
		Usage:             aiUsagePayload{InputTokens: result.InputTokens, OutputTokens: result.OutputTokens},
		Sources:           s.citations(groundingURLs, result.Sources),
		Grounded:          mcpConfigured,
		GroundingReason:   groundingReason,
		CircleCIAvailable: circleCIConfigured,
		CircleCIReason:    circleCIReason,
	})
}

// selectGroundingPassages is issue #22's selection step: the vendored
// documentation worth showing the model for this turn, drawn from the exact
// s.guides the Reference pane and citations() below already read -- no
// separate fetch, no separate cache. Degrades the same way citations() does
// when there is no usable snapshot (nil guides, or one whose embedded copy
// somehow failed to parse): zero passages, never a failed chat request over
// a feature that is supposed to need nothing but memory already resident in
// this process.
func (s *Server) selectGroundingPassages(question, configText string) ([]guides.Passage, guides.Provenance) {
	if s.guides == nil {
		return nil, guides.Provenance{}
	}
	parsed, provenance, err := s.guides.Guides()
	if err != nil || len(parsed) == 0 {
		return nil, provenance
	}
	return guides.SelectPassages(parsed, question, configText), provenance
}

// citations resolves raw source URLs into the citations the pane shows:
// image assets remapped to the page that shows them, other assets dropped,
// duplicates collapsed, and titles taken from the vendored docs snapshot
// where it has one (issue #156). See guides.CitationResolver for the policy
// and for why none of this fetches anything.
//
// groundingURLs are this host's own selection (issue #22, see
// selectGroundingPassages) -- passages actually placed in the system prompt,
// so they are certain to be relevant in the same sense
// web/src/lib/ai/deterministicSources.ts's app-attached rows are certain,
// as opposed to sources merely retrieved by a model's own tool call. They
// are listed first for that reason. Normalize's own deduplication means a
// grounding URL the provider also happened to cite (sources) is never
// listed twice.
//
// Built per request rather than cached on the Server: the guide set can be
// replaced under us by the cache's background refresh (see guides.Cache), and
// indexing twenty-two already-parsed pages is trivial next to the provider
// call that just completed. A host with no guides cache, or one whose
// snapshot failed to parse, still gets the asset filtering and
// deduplication -- just with no titles to add.
func (s *Server) citations(groundingURLs []string, sources []ai.Source) []aiChatSource {
	var parsed []guides.Guide
	if s.guides != nil {
		if gs, _, err := s.guides.Guides(); err == nil {
			parsed = gs
		}
	}

	urls := make([]string, 0, len(groundingURLs)+len(sources))
	urls = append(urls, groundingURLs...)
	for _, source := range sources {
		urls = append(urls, source.URL)
	}

	resolved := guides.NewCitationResolver(parsed).Normalize(urls)
	if len(resolved) == 0 {
		return nil
	}
	out := make([]aiChatSource, 0, len(resolved))
	for _, citation := range resolved {
		out = append(out, aiChatSource{URL: citation.URL, Title: citation.Title})
	}
	return out
}

// actionSchemaPrompt documents, for the model, the only vocabulary it may
// use to propose a config change. It must stay in sync with the action
// union `lib/ai/actions.ts` on the frontend actually knows how to apply --
// see that file's own comment. Deliberately a small, curated set of the
// highest-value configMutations.ts operations rather than "emit arbitrary
// AST edits": every one of these maps to exactly one existing, already-
// tested mutation function, so a proposed action can never do anything a
// human using the visual editor couldn't already do by hand, and it always
// flows through the same surgical-AST-mutation path (issue #92's central
// constraint) -- never raw YAML text.
const actionSchemaPrompt = `When the user asks you to change the config, do not write or describe YAML directly. Instead end your reply with exactly one fenced code block, tagged "action", containing a single JSON object describing the change. The application will show the user a diff of the exact edit before anything is written -- it will never apply your action silently. If you are not proposing a change, do not include an action block at all.

The action's "type" must be one of:
  addJob            {"name": string, "image"?: string, "workflowName"?: string}
  addWorkflow       {"name": string}
  addStep           {"job": string, "step": string | object, "index"?: number}
  addWorkflowJobEntry {"workflow": string, "job": string, "requires"?: string[], "alias"?: string}
  addRequire        {"workflow": string, "target": string, "source": string}
  addOrb            {"alias": string, "ref": string}
  renameJob         {"from": string, "to": string}
  deleteJob         {"name": string}

Only propose one action per reply. Prefer asking a clarifying question over guessing a job or workflow name that isn't in the context below. Every action above applies only to the currently open file (see "Open config file" below) -- if the user asks you to change any other file (one of the read-only files below, or one you don't have the contents of at all), say plainly that you can't edit it because it isn't the open file, and suggest opening it in the editor first. Never emit an action intended for any file other than the open one.`

// mcpGroundingPrompt is appended to the system prompt only when
// loadMCPConfig found a configured docs server -- so the default prompt
// (mcpConfigured=false) stays byte-for-byte what it always has been; this
// is the request-shape change's other half of "no MCP access must leave
// the assistant exactly as capable as it is today" (issue #103): the
// *unconfigured* default must be provably unchanged, not just "should
// still work".
//
// Two things this deliberately asks for: search before answering from
// memory on CircleCI-specific factual questions (the whole point --
// issue #111's "getting reliable information... versus relying on trained
// knowledge"), and never treat a search result as license to skip the
// action protocol above -- docs grounding improves answers, it does not
// earn the model write access.
const mcpGroundingPrompt = `You also have access to a documentation search tool connected to CircleCI's official docs. When the user asks how CircleCI itself behaves -- what a key means, how a feature works, what is or isn't valid -- prefer searching before answering from memory, since your training data may be stale or wrong about details that have since changed. If you answer without searching (because the question isn't about CircleCI's docs, or the tool didn't return anything useful), say so plainly rather than implying the answer is sourced. You do not need to write source links yourself -- any the search tool returns are shown to the user automatically below your reply. A search result is informational only: it never changes what you're allowed to propose -- config changes still go through the action protocol above, never a raw edit justified by something you read.`

// mcpGroundingUnavailablePrompt is appended only in the case that did not
// exist before issue #103's OAuth flow: a docs server is configured, so the
// user has every reason to believe answers are sourced, but the credential
// could not be used for this request. The model is told to be explicit about
// that, which is belt-and-braces alongside aiChatResponse.GroundingReason --
// the UI badge is the reliable signal, this is what stops the reply text
// itself from *reading* as though it were sourced.
//
// Note this is a strictly new branch: when nothing is configured at all
// (mcpConfigured=false, degraded=false) the prompt stays byte-for-byte what
// it has always been, which is the invariant
// TestServer_AIChat_NoMCPConfigured_OmitsMCPServersAndGroundingPrompt pins.
const mcpGroundingUnavailablePrompt = `A documentation search tool connected to CircleCI's official docs is configured for this editor, but it is unavailable for this reply -- the sign-in to it has expired or been rejected. You are therefore answering from training data alone, which may be stale. When the user asks how CircleCI itself behaves, say plainly that you are answering without docs grounding and that they can restore it by signing in again from the AI pane's settings. Do not imply any part of your answer is sourced.`

// circleCIToolsPrompt is appended only when loadCircleCIMCPConfig attached
// issue #11's CircleCI server -- so the unconfigured default (no
// CIRCLE_TOKEN, the common case outside a `circleci editor` invocation with
// one) stays byte-for-byte what it always has been, the same invariant
// mcpGroundingPrompt already keeps for the docs server.
//
// Every tool named here is read-only by construction (see
// internal/ai/circlecimcp) -- the paragraph still spells that out, because
// the second half of it is doing real work: it tells the model there is no
// action protocol for triggering, cancelling, or rerunning anything, full
// stop, rather than leaving it to infer that from a tool simply not being
// in its list. A model that is never told "you cannot do this, direct the
// user to the Run button" might otherwise describe *itself* performing an
// action it merely described the *user* being able to take, which reads to
// a user as the assistant claiming an ability it does not have -- exactly
// the failure mode issue #11's read/write split exists to prevent, stated
// in the one place available to prevent it before a write-tool proposal
// flow exists to make the "propose, user confirms" half real (tracked as
// this issue's own follow-up).
const circleCIToolsPrompt = `You also have read-only tools connected to CircleCI itself: you can check the status of pipeline runs and workflows, read a job's steps and logs, list its test results and artifacts, and look up the authenticated user's own recent runs. Use these when the user asks about a specific run, workflow, or job failure, or "why did my build fail" -- prefer checking with a tool over guessing from the config alone. You have no tool to trigger a pipeline, cancel a workflow, rerun a job, or change anything on CircleCI, and no action-block vocabulary for any of that either -- if asked, say plainly that you cannot do it and that they can do it themselves from this editor's own explicit Run controls (never imply you took an action you did not take, and never suggest they ask you again a different way).`

// groundingPreamble introduces the "Documentation context" section
// buildSystemPrompt appends only when guides.SelectPassages actually found
// something for this turn (issue #22). It states three things a passage's
// own prose cannot say about itself: that this text is CircleCI's own
// documentation rather than the user's repository -- so it is never
// confused with the file-contents disclosure aiChatContext's own doc
// comment describes -- that a citation must quote one of the URLs given
// rather than invent one (the same rule actionSchemaPrompt states for a
// proposed edit: never fabricate something that looks like it came from
// this app), and that a vendored snapshot only refreshes on a TTL, so its
// stated age (appended by groundingContext) is something to defer to
// rather than assume away.
const groundingPreamble = `Documentation context: excerpts from this editor's own vendored copy of CircleCI's official documentation, selected because they relate to your question or to keys already used in the open config below. This is CircleCI's documentation, not the user's repository. When your answer relies on one of these excerpts, you may cite its "Source" URL verbatim as a Markdown link -- never invent a documentation URL that is not listed here.`

// groundingContext renders passages (already selected and budgeted by
// guides.SelectPassages) into the system-prompt block groundingPreamble
// introduces, dated by snapshotAgeNotice. Returns "" when passages is empty
// so buildSystemPrompt can omit the section entirely rather than printing an
// empty one -- the same "no field, not an empty field" convention
// aiChatResponse.Sources already follows on the way out.
func groundingContext(passages []guides.Passage, prov guides.Provenance) string {
	if len(passages) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(groundingPreamble)
	b.WriteString(" ")
	b.WriteString(snapshotAgeNotice(prov))
	b.WriteString("\n\n")
	for _, p := range passages {
		if p.SectionTitle != "" {
			fmt.Fprintf(&b, "### %s -- %s\n", p.GuideTitle, p.SectionTitle)
		} else {
			fmt.Fprintf(&b, "### %s\n", p.GuideTitle)
		}
		b.WriteString(p.Text)
		fmt.Fprintf(&b, "\nSource: %s\n\n", p.URL)
	}
	return b.String()
}

// snapshotAgeNotice states what this process can actually verify about the
// documentation above's own age -- mirroring
// web/src/panes/docs/GuideView.tsx's ProvenanceFooter, which for the
// identical reason never claims a vendored page is "current": this host
// cannot know whether upstream has changed since prov.Commit was pinned,
// only how long it has been since the last check for that. Issue #22 asks
// specifically that a stale snapshot be able to say so rather than
// presenting vendored prose as current unconditionally -- prov.Stale() is
// the exact threshold guides.Cache itself refreshes on (see that method's
// doc comment), so this can never disagree with what actually governs
// whether a background refresh is overdue.
func snapshotAgeNotice(prov guides.Provenance) string {
	if prov.CommittedAt.IsZero() {
		return "(This snapshot's own vendoring date is unavailable, so its age cannot be stated.)"
	}
	dated := fmt.Sprintf("This snapshot was vendored from %s, pinned to a commit dated %s.", prov.Repo, prov.CommittedAt.Format("2006-01-02"))
	if prov.Stale() {
		return dated + " It has not been checked against upstream in over a week (see the Reference pane's Guides tab), so treat it as the best available copy rather than necessarily current -- CircleCI may have published changes since."
	}
	return dated
}

// systemPromptInput bundles buildSystemPrompt's inputs. Introduced with
// issue #11's two additions (circleCIAvailable, projectSlug) purely to
// avoid a seven-positional-argument signature; every field keeps exactly
// the meaning it had as a bare parameter before this struct existed.
type systemPromptInput struct {
	ctx               aiChatContext
	mcpConfigured     bool
	groundingDegraded bool
	passages          []guides.Passage
	provenance        guides.Provenance
	// circleCIAvailable mirrors handleAIChat's own circleCIConfigured --
	// whether issue #11's read-only CircleCI MCP server was attached to
	// this request.
	circleCIAvailable bool
	// projectSlug is s.env.ProjectSlug() -- the "<vcs>/<org>/<repo>" this
	// checkout claims to belong to, from the CLI plugin's own injected
	// environment variables (no network call). Named to the model only
	// when circleCIAvailable, since it exists solely to save the user
	// typing it as the project argument to list_runs -- there is no other
	// reason for this string to reach a prompt.
	projectSlug string
}

// buildSystemPrompt assembles the system prompt sent with every chat
// request: the assistant's role, the action-proposal protocol
// (actionSchemaPrompt), one of the two MCP docs-grounding paragraphs when
// relevant, issue #11's CircleCI-tools paragraph when relevant, the
// vendored-documentation context this host selected on its own (issue #22,
// see groundingContext), and the repo-aware context the frontend supplied.
// Everything from in.ctx comes only from the config file already open in
// the editor (see aiChatContext's doc comment) -- this function never reads
// the filesystem itself, and in.passages/in.provenance come only from this
// process's own already-parsed guides snapshot (see
// selectGroundingPassages) -- neither is a second place this function
// reaches out for something new.
//
// in.mcpConfigured and in.groundingDegraded are mutually exclusive by
// construction: loadMCPConfig returns a non-empty reason only when it is
// also returning configured=false. in.passages is independent of both: it
// can be non-empty whether or not any MCP server is configured at all,
// which is the point of issue #22 -- this grounding needs neither.
func buildSystemPrompt(in systemPromptInput) string {
	ctx := in.ctx
	var b strings.Builder
	b.WriteString("You are an assistant embedded in the CircleCI Config Editor, a local tool for editing a single .circleci/config.yml file. Help the user understand and improve the CircleCI configuration currently open in their editor.\n\n")
	b.WriteString(actionSchemaPrompt)
	b.WriteString("\n\n")
	if in.mcpConfigured {
		b.WriteString(mcpGroundingPrompt)
		b.WriteString("\n\n")
	} else if in.groundingDegraded {
		b.WriteString(mcpGroundingUnavailablePrompt)
		b.WriteString("\n\n")
	}
	if in.circleCIAvailable {
		b.WriteString(circleCIToolsPrompt)
		if in.projectSlug != "" {
			fmt.Fprintf(&b, " This repository's CircleCI project is %s.", in.projectSlug)
		}
		b.WriteString("\n\n")
	}
	if docs := groundingContext(in.passages, in.provenance); docs != "" {
		b.WriteString(docs)
		b.WriteString("\n")
	}

	if ctx.ConfigPath != "" {
		fmt.Fprintf(&b, "Open config file: %s\n\n", ctx.ConfigPath)
	}
	if len(ctx.JobNames) > 0 {
		fmt.Fprintf(&b, "Jobs defined: %s\n", strings.Join(ctx.JobNames, ", "))
	}
	if len(ctx.WorkflowNames) > 0 {
		fmt.Fprintf(&b, "Workflows defined: %s\n", strings.Join(ctx.WorkflowNames, ", "))
	}
	if len(ctx.ValidationErrors) > 0 {
		b.WriteString("Current validation errors:\n")
		for _, e := range ctx.ValidationErrors {
			fmt.Fprintf(&b, "- %s\n", e)
		}
	}
	// Issue #247 item 6: a config-policy violation is a different axis from
	// a validation error (a config can compile perfectly and still be
	// refused), so it gets its own section rather than being folded into
	// the one above -- the same axis this editor's own UI never merges.
	if len(ctx.PolicyViolations) > 0 {
		b.WriteString("Current config-policy violations (from your organization's own policy rules, not a compile error):\n")
		for _, v := range ctx.PolicyViolations {
			blocking := "non-blocking"
			if v.Blocking {
				blocking = "blocking -- would refuse a pipeline on CircleCI"
			}
			fmt.Fprintf(&b, "- %s (%s): %s\n", v.Rule, blocking, v.Reason)
		}
	}
	if ctx.ConfigText != "" {
		b.WriteString("\nCurrent contents of the open config file:\n```yaml\n")
		b.WriteString(ctx.ConfigText)
		b.WriteString("\n```\n")
	}

	// Issue #102: every other file the frontend found in the same
	// `.circleci` directory and decided (within its own token budget) to
	// include, as plain read-only text -- never anything this handler went
	// and fetched itself. See aiChatContext's doc comment.
	if len(ctx.OtherFiles) > 0 {
		b.WriteString("\nOther files in this directory (read-only context -- you may answer questions about them, but you cannot propose an action against any of them; only the open config file above can be edited):\n")
		for _, f := range ctx.OtherFiles {
			fmt.Fprintf(&b, "\n--- %s ---\n```yaml\n%s\n```\n", f.Path, f.Text)
		}
	}
	if len(ctx.SkippedFiles) > 0 {
		b.WriteString("\nFiles found in this directory but not sent (token budget):\n")
		for _, f := range ctx.SkippedFiles {
			fmt.Fprintf(&b, "- %s (%s)\n", f.Path, f.Reason)
		}
	}

	return b.String()
}

// aiStoreFromEnv constructs the keystore.Store used by production servers.
// Extracted from New (server.go) purely so it can carry this comment: a
// failure here (e.g. HOME unresolvable) must never prevent the editor from
// starting, since the AI pane is optional and everything else -- editing,
// validation, the DAG -- must keep working with no AI store at all. Callers
// treat a nil, error-returning Store as "AI pane degrades to unconfigured"
// by wrapping it in unavailableAIStore.
func aiStoreFromEnv(logf func(string, ...any)) keystore.Store {
	store, err := keystore.Open()
	if err != nil {
		logf("ai: failed to open key store, AI pane will report every provider as unconfigured: %v", err)
		// Still wrapped for the environment override (which keystore.Open
		// would have applied): a key supplied through CIRCLECI_EDITOR_AI_KEY_<PROVIDER>
		// needs no store at all, so an unusable store must not turn a
		// perfectly good environment-supplied key into "unconfigured" -- and
		// must not make the pane disagree with what `ai status` reports.
		return keystore.WithEnvOverride(unavailableAIStore{err: err})
	}
	return store
}

// DefaultAIProviders returns the provider registry a production server (and
// the `ai` CLI commands in cmd/circleci-editor, which must validate
// provider ids against exactly the same set) uses when the caller supplies
// none. Exported for that second caller: two independently-built registries
// would be one release away from the CLI knowing about a provider the editor
// doesn't, or vice versa.
func DefaultAIProviders() ai.Registry {
	anthropicClient := anthropic.New(anthropic.Options{})
	return ai.Registry{anthropicClient.Name(): anthropicClient}
}

// unavailableAIStore is a keystore.Store that reports every provider as
// permanently unconfigured -- used only when keystore.Open itself failed
// (see aiStoreFromEnv), so /api/ai/status and friends still return a
// well-formed response instead of the server failing to start.
type unavailableAIStore struct{ err error }

func (u unavailableAIStore) Get(context.Context, string) (secret.String, bool, error) {
	return secret.String{}, false, nil
}
func (u unavailableAIStore) Set(context.Context, string, secret.String) error {
	return u.err
}
func (u unavailableAIStore) Delete(context.Context, string) error { return nil }
func (u unavailableAIStore) Backend() keystore.Backend            { return keystore.BackendFile }
func (u unavailableAIStore) Location() string                     { return "unavailable: " + u.err.Error() }
