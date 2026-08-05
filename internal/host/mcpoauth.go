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
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai/mcpauth"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
)

// mcpDocsOAuthKey is the keystore id the OAuth credential for the docs MCP
// server is stored under -- alongside mcpDocsURLKey/mcpDocsTokenKey and the
// provider keys, in the same store, protected the same way (OS keychain,
// else a 0600 file). See mcpauth.Credential's doc comment for why this one
// id holds a JSON document while the BYO URL/token pair is two ids: nothing
// in this value is ever displayed, and its fields are useless unless they
// move together.
const mcpDocsOAuthKey = "mcp-docs-oauth" //nolint:gosec // a keystore id (like "anthropic"), never a credential value.

// oauthClientName is what this app calls itself in dynamic client
// registration. It shows up on the authorization server's own consent
// screen, so it names the tool a user is actually looking at.
const oauthClientName = "CircleCI Config Editor"

// oauthFlowTimeout bounds one interactive sign-in: how long the loopback
// listener stays open waiting for the browser to come back. Long enough for
// a real Google or GitHub sign-in including a 2FA prompt, short enough that
// an abandoned flow does not leave a listener open for the rest of the
// session.
const oauthFlowTimeout = 5 * time.Minute

// oauthSetupTimeout bounds the non-interactive half of the flow -- the two
// discovery fetches plus dynamic client registration -- which all happen
// before the user is sent anywhere and should be fast or not at all.
const oauthSetupTimeout = 30 * time.Second

// oauthFlowState is the lifecycle a sign-in goes through, reported verbatim
// to the SPA so the UI never has to infer progress from the absence of
// something.
type oauthFlowState string

// The four states a sign-in can be in.
const (
	// oauthIdle: no flow has been started in this process.
	oauthIdle oauthFlowState = "idle"
	// oauthPending: the browser has been sent to the authorization server
	// and the loopback listener is waiting.
	oauthPending oauthFlowState = "pending"
	// oauthAuthorized: a credential was obtained and stored.
	oauthAuthorized oauthFlowState = "authorized"
	// oauthFailed: the flow ended without a credential. Message says why,
	// in terms a user can act on.
	oauthFailed oauthFlowState = "failed"
)

// mcpOAuthFlow is the one in-flight sign-in this server tracks.
//
// Deliberately in memory and deliberately singular. In memory because
// everything in it except the outcome is short-lived and secret -- above all
// the PKCE verifier, which must not outlive the flow and must never be
// written anywhere. Singular because two concurrent sign-ins to the same
// server have no use case and every extra one is another loopback port open
// at the same time; starting a second flow cancels the first (see
// startMCPOAuth), which is both simpler and the behaviour a user pressing
// "Connect" twice expects.
type mcpOAuthFlow struct {
	state   oauthFlowState
	message string
	cancel  context.CancelFunc
	// loopback is retained so a superseding flow can shut the old listener
	// down rather than leaking it until its own timeout.
	loopback *mcpauth.Loopback
	// releaseHold ends this flow's clientTracker hold -- the thing that
	// stops a last-client exit from killing the host in the middle of an
	// interactive sign-in (issue #177). It matters most in exactly the
	// arrangement the SPA uses: startMcpOAuth sends the user to the identity
	// provider in a *separate* tab, so the editor's own heartbeat normally
	// stays open throughout and the hold changes nothing. But "normally" is
	// not "always" -- a popup blocker, a copied link pasted over the
	// editor's own tab, a user who tidies the editor away while signing in
	// -- and one missed heartbeat during a Google or GitHub 2FA prompt would
	// otherwise kill the host mid-sign-in, which is a worse bug than the one
	// #177 fixes. Nil once settled; see settle.
	releaseHold func()
}

// settle records a flow's terminal state and releases its hold exactly once,
// so the host becomes eligible to exit again the moment the sign-in is no
// longer in progress. Callers must hold mcpOAuthMu.
func (f *mcpOAuthFlow) settle(state oauthFlowState, message string) {
	f.state = state
	f.message = message
	if f.releaseHold != nil {
		f.releaseHold()
		f.releaseHold = nil
	}
}

// mcpOAuthStatusResponse is served by GET /api/ai/mcp/oauth and returned by
// POST /api/ai/mcp/oauth/start.
//
// Note what is absent: any field capable of holding a token. The SPA learns
// that a credential exists, when it expires, and whether it can be renewed
// without another sign-in -- never the credential itself, exactly as for
// the provider key.
type mcpOAuthStatusResponse struct {
	// State is the in-process flow state (see oauthFlowState). Distinct
	// from Authorized: a stored credential from a previous run of the app
	// means Authorized is true while State is still "idle".
	State   oauthFlowState `json:"state"`
	Message string         `json:"message,omitempty"`
	// Authorized reports whether a usable stored credential exists.
	Authorized bool `json:"authorized"`
	// Resource is the MCP endpoint the stored credential belongs to.
	Resource string `json:"resource,omitempty"`
	// Token describes the stored credential's durability without exposing
	// it. HasRefreshToken false is the honest signal that this session will
	// need another interactive sign-in when it expires -- the single fact
	// about Kapa's OAuth path that could not be established by research
	// (see issue #103), so the app reports what the server
	// actually did rather than what it was hoped to do.
	Token *mcpauth.TokenInfo `json:"token,omitempty"`
	// AuthorizationURL is where the browser must go to sign in. Present
	// only in the response to a start request.
	//
	// Handing this to page JavaScript is safe and is why the host does not
	// try to open it itself: it carries a client id, a state value, and a
	// PKCE *challenge*, none of which is a bearer credential. The verifier
	// -- the one value that would let a third party redeem a stolen code --
	// stays in this process. The alternative, teaching
	// internal/host/browser.go to shell out to `open` with a remote https
	// URL, would mean loosening validateLocalURL, which exists precisely to
	// make that impossible; a link the user's already-open browser follows
	// needs no such hole.
	AuthorizationURL string `json:"authorizationUrl,omitempty"`
}

// handleAIMCPOAuth serves GET and DELETE /api/ai/mcp/oauth.
func (s *Server) handleAIMCPOAuth(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleAIMCPOAuthGet(w, r)
	case http.MethodDelete:
		s.handleAIMCPOAuthDelete(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleAIMCPOAuthGet(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, s.mcpOAuthStatus(ctx))
}

// mcpOAuthStatus assembles the current status from the in-memory flow plus
// whatever is stored. A keystore read failure degrades to "not authorized"
// rather than erroring, for the same reason loadMCPConfig does: AI-specific
// storage trouble must never be what breaks a status request.
func (s *Server) mcpOAuthStatus(ctx context.Context) mcpOAuthStatusResponse {
	// The flow's *fields* are read under the lock, not just the pointer to
	// it. Copying the pointer and releasing the lock first -- which is what
	// this did -- guards the wrong thing: `settle` writes `state` and
	// `message` on that same live flow from the callback goroutine, so a
	// status poll landing while a sign-in completes was a genuine data race,
	// caught by `-race` on macOS (it passed on Linux and Windows in the same
	// run, which is what an intermittent race looks like).
	//
	// Note the contrast with cancelMCPOAuthFlow below, which *is* safe to
	// touch its flow after unlocking: it sets s.mcpOAuth = nil under the lock
	// first, so the flow is detached and nothing else can reach it. This
	// function deliberately leaves the flow in place, so it has no such
	// guarantee and must read while holding the lock.
	//
	// Only the two values are copied out, rather than holding the lock across
	// the rest of this function: loadMCPOAuthCredential below reads the
	// keystore, and holding a mutex across that I/O would serialise every
	// status request behind a disk or keychain access.
	resp := mcpOAuthStatusResponse{State: oauthIdle}
	s.mcpOAuthMu.Lock()
	if s.mcpOAuth != nil {
		resp.State = s.mcpOAuth.state
		resp.Message = s.mcpOAuth.message
	}
	s.mcpOAuthMu.Unlock()

	if cred, ok := s.loadMCPOAuthCredential(ctx); ok {
		info := cred.Info()
		resp.Authorized = true
		resp.Resource = cred.Resource
		resp.Token = &info
	}
	return resp
}

func (s *Server) handleAIMCPOAuthDelete(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	s.cancelMCPOAuthFlow()

	if err := s.aiStore.Delete(ctx, mcpDocsOAuthKey); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to remove the stored MCP sign-in")
		return
	}
	writeJSON(w, http.StatusOK, mcpOAuthStatusResponse{State: oauthIdle})
}

// aiMCPOAuthStartRequest is the body of POST /api/ai/mcp/oauth/start. URL is
// optional: empty means "use the MCP server URL already configured", so the
// common case is a button with no form behind it.
type aiMCPOAuthStartRequest struct {
	URL string `json:"url"`
}

// handleAIMCPOAuthStart serves POST /api/ai/mcp/oauth/start: discover, register
// dynamically, and hand back the URL the browser must visit.
//
// The interactive half runs in the background (see awaitMCPOAuthCallback) so
// this request returns as soon as there is a URL to open, rather than being
// an HTTP request held open for up to five minutes while a human types a
// password.
func (s *Server) handleAIMCPOAuthStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	defer func() { _ = r.Body.Close() }()

	var req aiMCPOAuthStartRequest
	// An absent body is fine -- "sign in to whatever is already configured" is
	// the intended default, and an empty body decodes to io.EOF, which is
	// therefore not an error here. A body that was sent but is malformed is,
	// so only a syntax error is rejected. A body that decodes fine but has
	// data after the JSON value is rejected the same way decodeJSONBody's own
	// doc comment explains -- inlined here, rather than calling that helper,
	// because this is the one handler in the package that must still accept
	// io.EOF (no body at all) as success.
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(&req); err != nil {
		var syntaxErr *json.SyntaxError
		if errors.As(err, &syntaxErr) {
			writeError(w, http.StatusBadRequest, "malformed request body")
			return
		}
	} else if dec.More() {
		writeError(w, http.StatusBadRequest, "malformed request body")
		return
	}

	setupCtx, cancelSetup := context.WithTimeout(r.Context(), oauthSetupTimeout)
	defer cancelSetup()

	resourceURL := strings.TrimSpace(req.URL)
	if resourceURL == "" {
		stored, _, configured, err := s.loadMCPConfigForDisplay(setupCtx)
		if err == nil && configured {
			resourceURL = stored
		}
	}
	if resourceURL == "" {
		writeError(w, http.StatusBadRequest, "no MCP server URL configured; set one first, or send a url field")
		return
	}
	if !strings.HasPrefix(resourceURL, "https://") {
		writeError(w, http.StatusBadRequest, "url must start with https://")
		return
	}

	status, err := s.startMCPOAuth(setupCtx, resourceURL)
	if err != nil {
		// err here is always one of mcpauth's own errors, which are written
		// never to contain credential material (see mcpauth.tokenError) --
		// so it is safe to show, and showing it is the difference between
		// "sign-in failed" and "this server offers no dynamic client
		// registration, so this app cannot sign in to it at all".
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// startMCPOAuth performs the non-interactive setup and starts the background
// wait. Returns the status (including the authorization URL) to send back.
func (s *Server) startMCPOAuth(ctx context.Context, resourceURL string) (mcpOAuthStatusResponse, error) {
	// Any previous flow is superseded -- see mcpOAuthFlow's doc comment.
	s.cancelMCPOAuthFlow()

	client := s.mcpAuthClient()

	resourceMeta, err := client.DiscoverResource(ctx, resourceURL)
	if err != nil {
		return mcpOAuthStatusResponse{}, err
	}
	serverMeta, err := client.DiscoverServer(ctx, resourceMeta.AuthorizationServer)
	if err != nil {
		return mcpOAuthStatusResponse{}, err
	}
	if serverMeta.RegistrationEndpoint == "" {
		// Worth its own message: this is the one way the whole approach can
		// be structurally impossible rather than merely failing, and a user
		// should not be left guessing. There is no client id an
		// open-source build could ship instead.
		return mcpOAuthStatusResponse{}, errors.New(
			"this MCP server's authorization server offers no dynamic client registration, " +
				"so this app cannot register itself; a pre-issued token can still be set manually")
	}

	// The listener must exist before registration, because registration has
	// to name the exact redirect URI including its ephemeral port.
	loopback, err := mcpauth.Listen()
	if err != nil {
		return mcpOAuthStatusResponse{}, err
	}

	cred, err := client.Register(ctx, serverMeta.RegistrationEndpoint, serverMeta.Issuer, oauthClientName, loopback.RedirectURI(), resourceMeta.ScopesSupported)
	if err != nil {
		_ = loopback.Close()
		return mcpOAuthStatusResponse{}, err
	}

	pkce, err := mcpauth.NewPKCE()
	if err != nil {
		_ = loopback.Close()
		return mcpOAuthStatusResponse{}, err
	}
	state, err := mcpauth.NewState()
	if err != nil {
		_ = loopback.Close()
		return mcpOAuthStatusResponse{}, err
	}

	authURL, err := mcpauth.AuthorizeURL(mcpauth.AuthorizeRequest{
		Server:      serverMeta,
		ClientID:    cred.ID,
		RedirectURI: loopback.RedirectURI(),
		State:       state,
		Challenge:   pkce.Challenge,
		Scopes:      resourceMeta.ScopesSupported,
		Resource:    resourceMeta.Resource,
	})
	if err != nil {
		_ = loopback.Close()
		return mcpOAuthStatusResponse{}, err
	}

	// The background wait is deliberately rooted in the *server's* shutdown
	// context, not the HTTP request's: the request returns immediately, so
	// tying the wait to it would cancel the flow before the user has even
	// seen the sign-in page.
	base := s.shutdownContext()
	flowCtx, cancel := context.WithCancel(base)

	s.mcpOAuthMu.Lock()
	s.mcpOAuth = &mcpOAuthFlow{
		state:    oauthPending,
		cancel:   cancel,
		loopback: loopback,
		// Taken here, at the last point that can still fail cheaply, and
		// released by settle or cancelMCPOAuthFlow. See the field's comment.
		releaseHold: s.clients.hold(),
	}
	s.mcpOAuthMu.Unlock()

	go s.awaitMCPOAuthCallback(flowCtx, awaitParams{
		loopback:    loopback,
		client:      client,
		serverMeta:  serverMeta,
		clientCred:  cred,
		pkce:        pkce,
		state:       state,
		resource:    resourceMeta.Resource,
		resourceURL: resourceURL,
	})

	return mcpOAuthStatusResponse{State: oauthPending, AuthorizationURL: authURL}, nil
}

// awaitParams groups what the background wait needs. A struct rather than
// eight positional arguments, two of which are secrets that must not be
// transposed.
type awaitParams struct {
	loopback   *mcpauth.Loopback
	client     *mcpauth.Client
	serverMeta mcpauth.ServerMetadata
	clientCred mcpauth.ClientCredentials
	pkce       mcpauth.PKCE
	state      string
	resource   string
	// resourceURL is what the user configured, stored into the BYO MCP slot
	// on success so a completed sign-in is immediately usable without the
	// user also having to save the URL by hand.
	resourceURL string
}

// awaitMCPOAuthCallback blocks on the loopback callback, exchanges the code,
// and stores the credential. Runs on its own goroutine; every exit path
// closes the listener and records a state the SPA can poll.
func (s *Server) awaitMCPOAuthCallback(ctx context.Context, p awaitParams) {
	defer func() { _ = p.loopback.Close() }()

	code, err := p.loopback.Wait(ctx, p.state, oauthFlowTimeout)
	if err != nil {
		s.failMCPOAuthFlow(describeOAuthFailure(err))
		return
	}

	exchangeCtx, cancel := context.WithTimeout(ctx, oauthSetupTimeout)
	defer cancel()

	tok, err := p.client.Exchange(exchangeCtx, p.serverMeta, p.clientCred, code, p.pkce.Verifier, p.resource)
	if err != nil {
		s.failMCPOAuthFlow(describeOAuthFailure(err))
		return
	}

	cred := mcpauth.Credential{
		Resource: p.resource,
		Server:   p.serverMeta,
		Client:   p.clientCred,
		Token:    tok,
	}
	if err := s.storeMCPOAuthCredential(exchangeCtx, cred); err != nil {
		s.failMCPOAuthFlow("signed in, but the credential could not be stored")
		return
	}

	// Persist the URL into the BYO slot so loadMCPConfig picks it up. A
	// failure here is not fatal to the sign-in -- the credential is already
	// stored -- but it does mean grounding stays off, so it is reported.
	if err := s.aiStore.Set(exchangeCtx, mcpDocsURLKey, secret.New(p.resourceURL)); err != nil {
		s.failMCPOAuthFlow("signed in, but the MCP server URL could not be stored")
		return
	}

	message := ""
	if !tok.RefreshToken.IsSet() {
		// The honest-degradation case, stated at the moment it becomes
		// knowable rather than discovered later as a mystery re-prompt.
		message = "signed in, but this server issued no refresh token, so you will need to sign in again when the session expires"
	}
	s.finishMCPOAuthFlow(message)
}

// describeOAuthFailure maps a flow error to a message safe and useful to
// show. Uses mcpauth's typed errors rather than string matching so a wording
// change upstream cannot silently turn "sign in again" into a generic
// failure.
func describeOAuthFailure(err error) string {
	switch {
	case errors.Is(err, mcpauth.ErrCallbackTimeout):
		return "sign-in timed out; no response came back from the browser"
	case errors.Is(err, mcpauth.ErrAuthorizationDenied):
		return "sign-in was declined at the identity provider"
	case errors.Is(err, context.Canceled):
		return "sign-in was cancelled"
	}
	var invalidClient *mcpauth.InvalidClientError
	if errors.As(err, &invalidClient) {
		return "the MCP server rejected this app's registration; try signing in again"
	}
	var invalidGrant *mcpauth.InvalidGrantError
	if errors.As(err, &invalidGrant) {
		return "the MCP server rejected the sign-in; try again"
	}
	// mcpauth's errors are constructed never to contain credential material
	// (see mcpauth.tokenError's doc comment on why error_description is
	// deliberately dropped), so passing one through is safe.
	return err.Error()
}

func (s *Server) failMCPOAuthFlow(message string) {
	s.mcpOAuthMu.Lock()
	defer s.mcpOAuthMu.Unlock()
	if s.mcpOAuth == nil {
		return
	}
	s.mcpOAuth.settle(oauthFailed, message)
}

func (s *Server) finishMCPOAuthFlow(message string) {
	s.mcpOAuthMu.Lock()
	defer s.mcpOAuthMu.Unlock()
	if s.mcpOAuth == nil {
		return
	}
	s.mcpOAuth.settle(oauthAuthorized, message)
}

// cancelMCPOAuthFlow stops any in-flight flow and closes its listener.
func (s *Server) cancelMCPOAuthFlow() {
	s.mcpOAuthMu.Lock()
	flow := s.mcpOAuth
	s.mcpOAuth = nil
	s.mcpOAuthMu.Unlock()

	if flow == nil {
		return
	}
	if flow.cancel != nil {
		flow.cancel()
	}
	if flow.loopback != nil {
		_ = flow.loopback.Close()
	}
	// A cancelled flow is no longer in progress, so it must stop holding the
	// host open (issue #177). Safe outside mcpOAuthMu: the flow has already
	// been detached from the server above, so nothing else can reach it, and
	// hold's release is idempotent regardless.
	if flow.releaseHold != nil {
		flow.releaseHold()
		flow.releaseHold = nil
	}
}

// mcpAuthClient builds the mcpauth client, honouring the test override.
func (s *Server) mcpAuthClient() *mcpauth.Client {
	if s.mcpAuthOverride != nil {
		return s.mcpAuthOverride
	}
	return &mcpauth.Client{UserAgent: "circleci-editor/" + s.opts.Version}
}

// storeMCPOAuthCredential writes cred to the keystore.
func (s *Server) storeMCPOAuthCredential(ctx context.Context, cred mcpauth.Credential) error {
	blob, err := cred.Marshal()
	if err != nil {
		return err
	}
	return s.aiStore.Set(ctx, mcpDocsOAuthKey, blob)
}

// loadMCPOAuthCredential reads the stored credential. A storage failure or a
// blob this build cannot parse both report ok=false -- see
// mcpauth.ParseCredential on why "no credential" and "an unusable one" get
// the same answer.
func (s *Server) loadMCPOAuthCredential(ctx context.Context) (mcpauth.Credential, bool) {
	stored, ok, err := s.aiStore.Get(ctx, mcpDocsOAuthKey)
	if err != nil || !ok {
		return mcpauth.Credential{}, false
	}
	return mcpauth.ParseCredential(stored)
}

// mcpOAuthToken returns a currently-valid access token for resourceURL,
// refreshing it transparently and writing the result back when the server
// rotated it.
//
// reason is non-empty exactly when a credential exists but could not be
// used, and says why in words fit to show a user -- because this is the
// dangerous case: the user believes docs grounding is on, and an answer that
// quietly stopped being sourced is worse than one that was never sourced.
// See handleAIChat, which puts it on the wire, and issue #103's
// "degrade honestly and never block".
func (s *Server) mcpOAuthToken(ctx context.Context, resourceURL string) (token secret.String, reason string) {
	cred, ok := s.loadMCPOAuthCredential(ctx)
	if !ok {
		return secret.String{}, ""
	}

	// Re-pointing the MCP server URL without signing in again must not result
	// in a token minted for one server being presented to another. The
	// comparison happens here rather than inside EnsureFresh because only this
	// layer knows both spellings: cred.Resource is the *canonical* identifier
	// the authorization server reported (RFC 9728's `resource`, which for the
	// live CircleCI docs server carries a trailing slash nobody typed), while
	// resourceURL is whatever the user actually saved. Comparing them raw would
	// reject every legitimate credential.
	if cred.Resource != "" && !sameMCPResource(cred.Resource, resourceURL) {
		return secret.String{}, describeRefreshFailure(mcpauth.ErrResourceMismatch)
	}

	// Resource is passed empty deliberately: the check above is the stricter
	// one, and re-doing it inside EnsureFresh against the un-normalised URL
	// would undo it.
	fresh, changed, err := s.mcpAuthClient().EnsureFresh(ctx, cred, "")
	if err != nil {
		return secret.String{}, describeRefreshFailure(err)
	}
	if changed {
		if storeErr := s.storeMCPOAuthCredential(ctx, fresh); storeErr != nil {
			// The refreshed token is still usable for this request; only the
			// *next* one loses out. Grounding this request is the right
			// call, and the log line (never the token) records the trouble.
			// Deliberately no %v of storeErr: a keystore error can quote the
			// value it failed to write. The condition is what matters.
			//
			// Debug-level (issue #216): this request succeeded, the next one
			// self-heals by refreshing again, and there is nothing for the
			// user to do -- which is exactly the shape of line that should
			// not be in a default-verbosity terminal.
			s.debugf("ai: refreshed the docs MCP credential but could not store it; the next request will refresh again")
		}
	}
	return fresh.Token.AccessToken, ""
}

// sameMCPResource reports whether two spellings of an MCP endpoint refer to
// the same server, ignoring a trailing slash.
//
// Only a trailing slash: no scheme coercion, no case folding of the path, no
// default-port normalisation. A loose comparison here would be a way to slip a
// credential to a server it was not issued for, which is exactly what the
// caller is trying to prevent -- so the one difference that is provably benign
// (and that the live server actually produces) is tolerated and nothing else
// is.
func sameMCPResource(a, b string) bool {
	return strings.TrimSuffix(a, "/") == strings.TrimSuffix(b, "/")
}

// describeRefreshFailure explains why a stored credential could not be
// renewed, distinguishing "you must sign in again" from "this was
// transient" -- the distinction issue #103 cares about, since telling a
// user to re-authenticate every time a network blip occurs is how the
// repeated-prompt failure mode gets reinvented.
func describeRefreshFailure(err error) string {
	switch {
	case errors.Is(err, mcpauth.ErrNoRefreshToken):
		return "the docs MCP sign-in expired and the server issued no refresh token; sign in again to restore docs grounding"
	case errors.Is(err, mcpauth.ErrResourceMismatch):
		return "the stored docs MCP sign-in belongs to a different server URL; sign in again to restore docs grounding"
	}
	var invalidGrant *mcpauth.InvalidGrantError
	if errors.As(err, &invalidGrant) {
		return "the docs MCP sign-in is no longer accepted; sign in again to restore docs grounding"
	}
	var invalidClient *mcpauth.InvalidClientError
	if errors.As(err, &invalidClient) {
		return "the docs MCP server no longer recognises this app's registration; sign in again to restore docs grounding"
	}
	return "could not renew the docs MCP sign-in just now; answering without docs grounding"
}

// shutdownContext returns the context a background flow should live under:
// the one Run was given, so Ctrl-C ends a pending sign-in, falling back to
// Background for a server built by a test that never called Run.
func (s *Server) shutdownContext() context.Context {
	if s.shutdownCtx != nil {
		return s.shutdownCtx
	}
	return context.Background()
}
