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

// Package mcpauth is a minimal OAuth 2.1 client for remote MCP servers that
// authenticate with a bearer token -- issue #103's Kapa/CircleCI docs server
// being the one this repo actually points at, but nothing here names it.
//
// # Why this package exists at all
//
// Anthropic's MCP connector takes an `authorization_token` the *caller* must
// obtain and refresh itself (see internal/ai/anthropic's package doc;
// Anthropic's own documentation is explicit about that). So a
// docs-grounding MCP server behind OAuth needs exactly three things this
// package provides and nothing more: discover where to authenticate, get a
// token, and swap an expiring token for a fresh one.
//
// # Why not golang.org/x/oauth2
//
// Three of the four steps here are not OAuth 2.0 core at all -- they are the
// MCP authorization profile's discovery chain (RFC 9728 protected-resource
// metadata, RFC 8414 authorization-server metadata) plus RFC 7591 dynamic
// client registration -- none of which x/oauth2 implements. What would be
// left to reuse is the authorization-code exchange, which is one form POST.
// Adding a dependency to save one form POST, in a repo whose keystore
// deliberately shells out to `security`/`secret-tool` rather than vendor a
// keychain client, would be the wrong trade.
//
// # What is verified about the flow this implements
//
// Every endpoint shape below was probed live against
// `circleci.mcp.kapa.ai` on 2026-07-28 (discovery documents, a real dynamic
// client registration returning HTTP 201, the loopback redirect URI being
// accepted and echoed back on the consent screen). One thing could *not*
// be verified without a human completing an interactive Google/GitHub
// sign-in, and this package is
// written to report it honestly rather than assume it: whether the token
// response actually contains a refresh token, and what the access token's
// lifetime is. Token.RefreshToken and Token.ExpiresIn carry whatever the
// server really sent, TokenInfo exposes that as non-secret facts a UI can
// state plainly, and nothing here pretends a session is durable when the
// server did not give us the means to make it one.
//
// # Security posture
//
//   - Every discovered endpoint must be https. A metadata document that
//     points anywhere else is rejected, not followed.
//   - **Credentials only ever go to the authorization server's own host.**
//     Discovery documents arrive over the network and name the endpoints this
//     client POSTs a client secret, an authorization code, and a refresh token
//     to -- so a tampered document would otherwise be a
//     credential-exfiltration primitive. `token_endpoint` and
//     `registration_endpoint` are therefore required to be https *and* on the
//     same host as the issuer, checked both at discovery
//     (validateServerMetadata) and again immediately before each
//     credential-bearing request (requireIssuerHost), so a metadata value that
//     never went through discovery -- say, from a tampered keystore blob --
//     cannot redirect one either. RFC 8414 §3.3's issuer match is enforced
//     too, and cross-host redirects are refused
//     (refuseCrossHostRedirect) so a 302 cannot walk around any of it.
//   - PKCE (S256) is mandatory on this side regardless of what a server
//     advertises, and the verifier never leaves the host process.
//   - Tokens are secret.String end to end -- including in the structs
//     responses are *decoded into*, so a credential is never a printable
//     string even briefly. An accidental %v, %#v or json.Marshal of anything
//     holding one emits [REDACTED]. The single exception is persistedSecret
//     (credential.go), whose entire purpose is the keystore round trip and
//     which still redacts on every print path.
//   - Errors never carry token, code, or verifier material -- see
//     tokenError, which deliberately reconstructs a message from the
//     server's OAuth error *code* only.
package mcpauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
)

// requestTimeout bounds each individual HTTP call this package makes
// (discovery, registration, token exchange, refresh). Short on purpose:
// these are all small JSON round trips to an authorization server, and a
// hung one must never be what stalls a chat request that would otherwise
// have degraded cleanly to "answering without docs grounding".
const requestTimeout = 15 * time.Second

// maxResponseBytes caps every response body this package reads. Discovery
// documents and token responses are a few hundred bytes; anything
// remotely near this cap is a misbehaving or hostile endpoint, and reading
// it unbounded into memory is the bug worth not having.
const maxResponseBytes = 1 << 20 // 1 MiB

// refreshSkew is how long before an access token's stated expiry it is
// treated as already expired. Covers clock skew plus the time the token
// spends in flight to the inference provider, which then makes its *own*
// server-side call to the MCP server with it -- so the token has to still
// be valid rather later than the moment we read it out of the keystore.
const refreshSkew = 2 * time.Minute

// ErrNoRefreshToken is returned by Client.Refresh when the stored
// credential has no refresh token to present. It is a distinct, named
// error because it is the one failure mode that is *not* transient: it
// means the server never issued one, and the only fix is for the user to
// authenticate again interactively. Callers must surface that difference
// rather than retrying forever -- the whole point of issue #103's "do not
// build something that appears to work and then prompts endlessly".
var ErrNoRefreshToken = errors.New("mcpauth: no refresh token stored")

// Client performs the OAuth steps. The zero value is usable; HTTPClient
// defaults to a fresh http.Client with requestTimeout.
type Client struct {
	// HTTPClient, when non-nil, is used for every request. Tests set this
	// to a client pointed at an httptest server; production leaves it nil.
	HTTPClient *http.Client
	// UserAgent is sent on every request. Empty uses Go's default.
	UserAgent string
}

func (c *Client) httpClient() *http.Client {
	if c.HTTPClient != nil {
		// A caller-supplied client (tests) keeps its own redirect policy. The
		// same-host rule in validateServerMetadata is enforced by this package
		// either way, so the substantive guarantee never depends on the
		// transport a caller injected.
		return c.HTTPClient
	}
	return &http.Client{Timeout: requestTimeout, CheckRedirect: refuseCrossHostRedirect}
}

// maxRedirects bounds a redirect chain. Lower than Go's default of 10 because
// every request this package makes is either to a well-known metadata path or
// to an endpoint a metadata document just named, and none of those has a
// legitimate reason to bounce more than once or twice.
const maxRedirects = 3

// refuseCrossHostRedirect is the redirect policy for every request this
// package makes.
//
// validateServerMetadata pins the token and registration endpoints to the
// authorization server's own host -- but a redirect walks straight around that
// check. A 302 from `token_endpoint` to an attacker-controlled host would have
// this client re-POST the form, client secret and authorization code or refresh
// token included, to wherever it pointed. Go's default policy follows
// cross-host redirects happily, so it has to be replaced rather than trusted.
//
// Same-host redirects are still allowed, since a trailing-slash normalisation
// is ordinary and harmless. Anything that changes host is refused, as is an
// over-long chain.
func refuseCrossHostRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= maxRedirects {
		return fmt.Errorf("mcpauth: stopped after %d redirects", maxRedirects)
	}
	previous := via[len(via)-1]
	if !sameHost(req.URL, previous.URL) {
		// Names only the hosts, never the URL: a redirect target's query string
		// could carry anything, and this error is user-visible.
		return fmt.Errorf("mcpauth: refusing a redirect from %q to a different host %q",
			previous.URL.Host, req.URL.Host)
	}
	return nil
}

// ResourceMetadata is the subset of RFC 9728 OAuth 2.0 Protected Resource
// Metadata this package needs: which authorization server guards a given
// MCP endpoint, and which scopes it will accept.
type ResourceMetadata struct {
	// Resource is the canonical resource identifier the authorization
	// server expects in an RFC 8707 `resource` parameter -- not
	// necessarily byte-identical to the URL we asked about (the live
	// CircleCI docs server, for instance, reports a trailing slash we did
	// not send).
	Resource string
	// AuthorizationServer is the first entry of the document's
	// `authorization_servers` array. Only the first is used: this package
	// does not offer the user a choice of identity provider, and picking
	// arbitrarily among several would make which one a token came from
	// unpredictable.
	AuthorizationServer string
	// ScopesSupported is the document's `scopes_supported`, passed through
	// to the authorization request. Empty means "send no scope", which is
	// valid.
	ScopesSupported []string
}

type wireResourceMetadata struct {
	Resource             string   `json:"resource"`
	AuthorizationServers []string `json:"authorization_servers"`
	ScopesSupported      []string `json:"scopes_supported"`
}

// ServerMetadata is the subset of RFC 8414 OAuth 2.0 Authorization Server
// Metadata this package needs.
type ServerMetadata struct {
	Issuer                string
	AuthorizationEndpoint string
	TokenEndpoint         string
	// RegistrationEndpoint is RFC 7591 dynamic client registration. Empty
	// means the server has no self-service registration, which for this
	// app's purposes means the flow cannot start at all: there is no
	// pre-registered client id an OSS tool could ship (#103).
	RegistrationEndpoint string
	ScopesSupported      []string
	GrantTypesSupported  []string
	// CodeChallengeMethodsSupported is recorded but not gated on: this
	// package always sends S256 whether or not a server advertises it,
	// because sending PKCE to a server that ignores it is harmless and
	// omitting it because a server forgot to advertise it is not.
	CodeChallengeMethodsSupported []string
}

// SupportsRefreshTokenGrant reports whether the server advertises the
// refresh_token grant. Advertised support is necessary but not sufficient
// for a durable session -- a server can advertise the grant and still
// decline to issue a refresh token -- so this is used to explain a
// situation to the user, never to assume one.
func (m ServerMetadata) SupportsRefreshTokenGrant() bool {
	for _, g := range m.GrantTypesSupported {
		if g == "refresh_token" {
			return true
		}
	}
	return false
}

type wireServerMetadata struct {
	Issuer                        string   `json:"issuer"`
	AuthorizationEndpoint         string   `json:"authorization_endpoint"`
	TokenEndpoint                 string   `json:"token_endpoint"`
	RegistrationEndpoint          string   `json:"registration_endpoint"`
	ScopesSupported               []string `json:"scopes_supported"`
	GrantTypesSupported           []string `json:"grant_types_supported"`
	CodeChallengeMethodsSupported []string `json:"code_challenge_methods_supported"`
}

// ClientCredentials is what RFC 7591 dynamic client registration handed
// back. Secret is a secret.String even though a "public client" registered
// this way is not meaningfully confidential: it is a credential the
// authorization server will accept, so it is stored and printed under the
// same rules as everything else in internal/ai/secret.
type ClientCredentials struct {
	ID     string
	Secret secret.String
	// RedirectURI is the exact value registered, which the token exchange
	// must repeat verbatim (RFC 6749 §4.1.3). Kept alongside the
	// credential so a refresh months later cannot drift from it.
	RedirectURI string
	// SecretExpiresAt is the RFC 7591 `client_secret_expires_at` (Unix
	// seconds), or 0 for "never expires". Note RFC 7591 §3.2.1 makes this
	// field REQUIRED whenever a client secret is issued, and the live
	// CircleCI docs authorization server omits it -- so 0 here can mean
	// either "the server said never" or "the server did not say". Callers
	// must therefore treat an `invalid_client` error on refresh as
	// "re-register", not as an unrecoverable failure.
	SecretExpiresAt int64
}

// Fields that hold credentials are declared as secret.String, not string:
// they are secrets from the instant they are parsed, there is no window in
// which they exist as a printable value, and an accidental %v or json.Marshal
// of this struct emits "[REDACTED]" rather than the credential. This is what
// gosec's G117 is asking for, and it is right to ask.
type wireClientCredentials struct {
	ClientID              string        `json:"client_id"`
	ClientSecret          secret.String `json:"client_secret"`
	ClientSecretExpiresAt int64         `json:"client_secret_expires_at"`
}

// Token is an authorization server's token response.
type Token struct {
	AccessToken  secret.String
	RefreshToken secret.String
	TokenType    string
	// Expiry is when AccessToken stops being accepted, derived from the
	// response's `expires_in`. The zero value means the server did not say,
	// which this package reports as "unknown" rather than guessing a
	// lifetime -- guessing is how a token gets used past its expiry and the
	// user sees an unexplained failure.
	Expiry time.Time
	Scope  string
}

// Expired reports whether Expiry has passed (or is within refreshSkew).
// A zero Expiry -- the server declined to state a lifetime -- is reported
// as not expired: with nothing to go on, the only honest behaviour is to
// try the token and let the server reject it, rather than to pre-emptively
// throw away a credential that may well still work.
func (t Token) Expired() bool {
	if t.Expiry.IsZero() {
		return false
	}
	return time.Now().Add(refreshSkew).After(t.Expiry)
}

// TokenInfo is the non-secret description of a stored token: exactly the
// facts a settings UI needs to tell the truth about the session's
// durability, and no field capable of holding credential material. This is
// the type that answers "will I have to sign in again?" -- see this
// package's doc comment on why that question could not be answered by
// research alone.
type TokenInfo struct {
	// HasRefreshToken is the load-bearing one. False means every expiry
	// forces a fresh interactive sign-in, and the UI must say so.
	HasRefreshToken bool `json:"hasRefreshToken"`
	// ExpiresAt is RFC 3339, or empty when the server stated no lifetime.
	ExpiresAt string `json:"expiresAt,omitempty"`
	// LifetimeSeconds is the originally granted `expires_in`, 0 if unstated.
	LifetimeSeconds int    `json:"lifetimeSeconds,omitempty"`
	Scope           string `json:"scope,omitempty"`
}

// As wireClientCredentials: the two token fields are secret.String so that a
// decoded token response is never a printable string, not even briefly.
type wireToken struct {
	AccessToken  secret.String `json:"access_token"`
	RefreshToken secret.String `json:"refresh_token"`
	TokenType    string        `json:"token_type"`
	ExpiresIn    int           `json:"expires_in"`
	Scope        string        `json:"scope"`
}

// wireTokenError is an RFC 6749 §5.2 error response. Only Error (the
// machine-readable code) is ever propagated into a Go error message --
// see tokenError.
type wireTokenError struct {
	Error string `json:"error"`
}

// DiscoverResource fetches RFC 9728 protected-resource metadata for
// resourceURL, which must be an https URL (the MCP endpoint itself).
//
// Verified live: `GET https://circleci.mcp.kapa.ai/.well-known/oauth-protected-resource`
// returns exactly this document. Note the well-known segment goes after the
// host and before any path (RFC 9728 §3.1), which is *not* the same rule as
// naive path concatenation -- a server mounted at /mcp advertises at
// /.well-known/oauth-protected-resource/mcp, so both spellings are tried.
func (c *Client) DiscoverResource(ctx context.Context, resourceURL string) (ResourceMetadata, error) {
	parsed, err := parseHTTPSURL(resourceURL)
	if err != nil {
		return ResourceMetadata{}, fmt.Errorf("mcpauth: resource url: %w", err)
	}

	var lastErr error
	for _, candidate := range wellKnownCandidates(parsed, "oauth-protected-resource") {
		var doc wireResourceMetadata
		if err := c.getJSON(ctx, candidate, &doc); err != nil {
			lastErr = err
			continue
		}
		if len(doc.AuthorizationServers) == 0 {
			lastErr = errors.New("mcpauth: protected resource metadata lists no authorization_servers")
			continue
		}
		issuer := doc.AuthorizationServers[0]
		if _, err := parseHTTPSURL(issuer); err != nil {
			return ResourceMetadata{}, fmt.Errorf("mcpauth: authorization_servers[0]: %w", err)
		}
		resource := doc.Resource
		if resource == "" {
			resource = parsed.String()
		}
		return ResourceMetadata{
			Resource:            resource,
			AuthorizationServer: issuer,
			ScopesSupported:     doc.ScopesSupported,
		}, nil
	}
	if lastErr == nil {
		lastErr = errors.New("mcpauth: no protected resource metadata found")
	}
	return ResourceMetadata{}, lastErr
}

// DiscoverServer fetches RFC 8414 authorization-server metadata for issuer.
//
// Three URL spellings are tried, in the order RFC 8414 §3.1 and OpenID
// Discovery actually prescribe, because they differ in a way that trips
// people up: the well-known segment is *inserted between host and path*,
// not appended. For issuer `https://mcp.kapa.ai/auth/public` the correct
// URL is `https://mcp.kapa.ai/.well-known/oauth-authorization-server/auth/public`
// -- verified live 2026-07-28; the appended spelling returns 404 there. The
// appended form is still tried last because plenty of servers only
// implement that one.
func (c *Client) DiscoverServer(ctx context.Context, issuer string) (ServerMetadata, error) {
	parsed, err := parseHTTPSURL(issuer)
	if err != nil {
		return ServerMetadata{}, fmt.Errorf("mcpauth: issuer: %w", err)
	}

	candidates := wellKnownCandidates(parsed, "oauth-authorization-server")
	candidates = append(candidates, wellKnownCandidates(parsed, "openid-configuration")...)

	var lastErr error
	for _, candidate := range candidates {
		var doc wireServerMetadata
		if err := c.getJSON(ctx, candidate, &doc); err != nil {
			lastErr = err
			continue
		}
		// wireServerMetadata and ServerMetadata are deliberately
		// field-identical (the wire type exists only to carry the JSON tags),
		// so a direct conversion is both legal and self-checking: adding a
		// field to one and not the other becomes a compile error rather than a
		// silently dropped value.
		meta := ServerMetadata(doc)
		if err := validateServerMetadata(meta, parsed); err != nil {
			lastErr = err
			continue
		}
		return meta, nil
	}
	if lastErr == nil {
		lastErr = errors.New("mcpauth: no authorization server metadata found")
	}
	return ServerMetadata{}, lastErr
}

// validateServerMetadata rejects a metadata document that would send this
// client's credentials somewhere it did not intend.
//
// # Why this is a security boundary, not a sanity check
//
// Every endpoint here arrives *from the network*: they are fields of a
// document fetched over HTTPS from a host derived, in turn, from a
// user-supplied MCP server URL. The client then POSTs a client secret, an
// authorization code, and later a refresh token to whatever `token_endpoint`
// says. So a tampered or substituted discovery document is a
// credential-exfiltration primitive unless it is constrained -- this is
// exactly what gosec's G704 (SSRF) is pointing at, and it is a real finding
// rather than a false positive.
//
// Because BYO-MCP means the *resource* host is user-supplied by design,
// outbound requests to arbitrary hosts cannot be eliminated. What can be
// eliminated is the discrepancy an attacker needs. Two rules do that:
//
//  1. **Every endpoint must be https.** A metadata document that names
//     http://, or a non-URL, is rejected rather than fetched.
//  2. **Every endpoint must live on the same host as the issuer** that
//     discovery was actually performed against. The credentials can then only
//     ever go to the host we already chose to trust by asking it for metadata
//     -- naming a third-party host in the response achieves nothing.
//
// Plus RFC 8414 §3.3's own requirement, which is the same defence from the
// spec's side: the document's `issuer` must equal the issuer requested. A
// document that claims to speak for someone else is rejected.
//
// **Verified against the real server** (2026-07-28,
// `https://mcp.kapa.ai/.well-known/oauth-authorization-server/auth/public`):
// the issuer is `https://mcp.kapa.ai/auth/public` and the authorization,
// token, and registration endpoints are all on `mcp.kapa.ai` -- so rule 2
// holds for the server this feature exists for, and no exception is needed.
//
// Note what is deliberately *not* compared: the protected resource's own host.
// The live CircleCI docs server is `circleci.mcp.kapa.ai` while its
// authorization server is `mcp.kapa.ai`, which is both normal and fine -- a
// resource server delegating to a separate AS is the ordinary OAuth
// arrangement. Only the AS's own endpoints are pinned to the AS.
func validateServerMetadata(m ServerMetadata, requestedIssuer *url.URL) error {
	// RFC 8414 §3.3: the issuer in the document must match the one asked for.
	// Compared exactly, not loosely: this value is an identifier, and the spec
	// requires it be byte-identical to the requested issuer.
	if m.Issuer != "" && m.Issuer != requestedIssuer.String() {
		return fmt.Errorf(
			"mcpauth: authorization server metadata declares issuer %q but was fetched for %q",
			m.Issuer, requestedIssuer.String())
	}

	for _, endpoint := range []struct {
		name  string
		value string
		// required endpoints must be present; registration is optional.
		required bool
	}{
		{"authorization_endpoint", m.AuthorizationEndpoint, true},
		{"token_endpoint", m.TokenEndpoint, true},
		{"registration_endpoint", m.RegistrationEndpoint, false},
	} {
		if endpoint.value == "" {
			if endpoint.required {
				return fmt.Errorf("mcpauth: %s: empty url", endpoint.name)
			}
			continue
		}
		parsed, err := parseHTTPSURL(endpoint.value)
		if err != nil {
			return fmt.Errorf("mcpauth: %s: %w", endpoint.name, err)
		}
		if !sameHost(parsed, requestedIssuer) {
			return fmt.Errorf(
				"mcpauth: refusing %s on host %q: it must be on the same host as the authorization server %q",
				endpoint.name, parsed.Host, requestedIssuer.Host)
		}
	}
	return nil
}

// requireIssuerHost re-checks, immediately before a credential-bearing
// request, that endpoint is https and on the same host as issuer.
//
// This duplicates validateServerMetadata on purpose. That function guards the
// *discovery* path, but a ServerMetadata can reach a request without passing
// through it -- most importantly via ParseCredential, which rebuilds one from a
// stored keystore blob. If that blob were tampered with (the file backend is
// 0600, not immutable), a rewritten `tokenEndpoint` would otherwise send a
// refresh token wherever it named. Checking at the point of use makes the
// invariant hold however the metadata arrived, rather than only when it came
// from a fetch this process performed.
func requireIssuerHost(name, endpoint, issuer string) error {
	parsed, err := parseHTTPSURL(endpoint)
	if err != nil {
		return fmt.Errorf("mcpauth: %s: %w", name, err)
	}
	// An empty issuer means the metadata never recorded one. Rejected rather
	// than waved through: without an issuer there is nothing to pin against,
	// and "no constraint" is not an acceptable default for a request that
	// carries a client secret.
	issuerURL, err := parseHTTPSURL(issuer)
	if err != nil {
		return fmt.Errorf("mcpauth: cannot verify %s without a valid issuer: %w", name, err)
	}
	if !sameHost(parsed, issuerURL) {
		return fmt.Errorf(
			"mcpauth: refusing to send credentials to %s on host %q: it must be on the same host as the authorization server %q",
			name, parsed.Host, issuerURL.Host)
	}
	return nil
}

// sameHost compares two URLs' hosts case-insensitively, including the port.
//
// Host and not just Hostname: a different port is a different service, and
// there is no reason a token endpoint would need one the issuer did not
// advertise. Compared as a whole string rather than resolved: this must not
// depend on DNS, since a resolver is one of the things an attacker in this
// threat model may control.
func sameHost(a, b *url.URL) bool {
	return strings.EqualFold(a.Host, b.Host)
}

// Register performs RFC 7591 dynamic client registration.
//
// Verified live 2026-07-28 against
// `POST https://mcp.kapa.ai/auth/public/register`: an anonymous,
// unauthenticated request naming a `http://127.0.0.1:<ephemeral>/...`
// redirect URI is accepted with HTTP 201 and a client id plus secret. That
// is the single fact that makes this feature possible for an OSS tool at
// all: no pre-registered client id has to be shipped, and none could be.
//
// redirectURI must be a loopback http URL -- an OAuth client that registers
// any other kind of redirect from this process would be registering
// somewhere it cannot receive, and the check exists so a future caller
// cannot quietly redirect the flow off-box.
func (c *Client) Register(ctx context.Context, registrationEndpoint, issuer, clientName, redirectURI string, scopes []string) (ClientCredentials, error) {
	if registrationEndpoint == "" {
		return ClientCredentials{}, errors.New("mcpauth: authorization server offers no dynamic client registration")
	}
	// Pinned to the issuer's host before anything is sent -- see
	// requireIssuerHost. Registration is credential-bearing in the other
	// direction: the response contains a client secret, so a substituted host
	// could hand us one it controls and then observe every later exchange.
	if err := requireIssuerHost("registration_endpoint", registrationEndpoint, issuer); err != nil {
		return ClientCredentials{}, err
	}
	if err := validateLoopbackRedirect(redirectURI); err != nil {
		return ClientCredentials{}, err
	}

	body := map[string]any{
		"client_name":                clientName,
		"redirect_uris":              []string{redirectURI},
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": "client_secret_post",
	}
	if len(scopes) > 0 {
		body["scope"] = strings.Join(scopes, " ")
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return ClientCredentials{}, fmt.Errorf("mcpauth: encode registration request: %w", err)
	}

	req, err := c.newRequest(ctx, http.MethodPost, registrationEndpoint, strings.NewReader(string(encoded)))
	if err != nil {
		return ClientCredentials{}, err
	}
	req.Header.Set("Content-Type", "application/json")

	var doc wireClientCredentials
	if err := c.doJSON(req, &doc, http.StatusOK, http.StatusCreated); err != nil {
		return ClientCredentials{}, fmt.Errorf("mcpauth: dynamic client registration: %w", err)
	}
	if doc.ClientID == "" {
		return ClientCredentials{}, errors.New("mcpauth: dynamic client registration returned no client_id")
	}
	return ClientCredentials{
		ID:              doc.ClientID,
		Secret:          doc.ClientSecret,
		RedirectURI:     redirectURI,
		SecretExpiresAt: doc.ClientSecretExpiresAt,
	}, nil
}

// AuthorizeRequest is everything AuthorizeURL needs. Every field is
// non-secret and safe to hand to the browser (and therefore, since the
// browser here is the app's own SPA, to page JavaScript) -- deliberately
// so: the code verifier, which is the one value that must not leak, is
// *not* in this struct. See PKCE.
type AuthorizeRequest struct {
	Server      ServerMetadata
	ClientID    string
	RedirectURI string
	State       string
	// Challenge is the S256 code challenge (PKCE.Challenge).
	Challenge string
	Scopes    []string
	// Resource is the RFC 8707 resource indicator -- the MCP endpoint the
	// resulting token should be audience-bound to. Sending it is what stops
	// a token minted for one MCP server being replayable at another.
	// Verified live 2026-07-28: the CircleCI docs authorization server
	// accepts the parameter (renders its consent screen normally with it
	// present).
	Resource string
}

// AuthorizeURL builds the URL the user's browser must visit to sign in.
func AuthorizeURL(req AuthorizeRequest) (string, error) {
	endpoint, err := parseHTTPSURL(req.Server.AuthorizationEndpoint)
	if err != nil {
		return "", fmt.Errorf("mcpauth: authorization_endpoint: %w", err)
	}
	if req.ClientID == "" || req.State == "" || req.Challenge == "" {
		return "", errors.New("mcpauth: authorize request missing client id, state, or code challenge")
	}
	if err := validateLoopbackRedirect(req.RedirectURI); err != nil {
		return "", err
	}

	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", req.ClientID)
	q.Set("redirect_uri", req.RedirectURI)
	q.Set("state", req.State)
	q.Set("code_challenge", req.Challenge)
	q.Set("code_challenge_method", "S256")
	if len(req.Scopes) > 0 {
		q.Set("scope", strings.Join(req.Scopes, " "))
	}
	if req.Resource != "" {
		q.Set("resource", req.Resource)
	}
	endpoint.RawQuery = q.Encode()
	return endpoint.String(), nil
}

// Exchange trades an authorization code for a token (RFC 6749 §4.1.3 plus
// RFC 7636's code_verifier and RFC 8707's resource).
func (c *Client) Exchange(ctx context.Context, server ServerMetadata, cred ClientCredentials, code secret.String, verifier secret.String, resource string) (Token, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	// Reveal() here and below is this package's designated crossing point:
	// these values become fields of the one outgoing HTTPS form body whose
	// entire purpose is to carry them, and are never logged, returned, or
	// stored unwrapped.
	form.Set("code", code.Reveal())
	form.Set("redirect_uri", cred.RedirectURI)
	form.Set("code_verifier", verifier.Reveal())
	if resource != "" {
		form.Set("resource", resource)
	}
	return c.token(ctx, server, cred, form)
}

// Refresh trades a refresh token for a new access token. Returns
// ErrNoRefreshToken -- distinctly, so a caller can tell "try again later"
// from "the user must sign in again" -- when there is nothing to present.
//
// Per RFC 6749 §6 a server may or may not rotate the refresh token; when it
// does not return a new one, the caller must keep the old one. Callers get
// that right by using StoredCredential.WithToken rather than overwriting
// fields themselves.
func (c *Client) Refresh(ctx context.Context, server ServerMetadata, cred ClientCredentials, refreshToken secret.String) (Token, error) {
	if !refreshToken.IsSet() {
		return Token{}, ErrNoRefreshToken
	}
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", refreshToken.Reveal())
	if len(server.ScopesSupported) > 0 {
		form.Set("scope", strings.Join(server.ScopesSupported, " "))
	}
	return c.token(ctx, server, cred, form)
}

// token posts form to the token endpoint with client authentication and
// decodes the response.
func (c *Client) token(ctx context.Context, server ServerMetadata, cred ClientCredentials, form url.Values) (Token, error) {
	// The security boundary for every credential-bearing request: the token
	// endpoint must be https and on the authorization server's own host, checked
	// here rather than only at discovery time (see requireIssuerHost).
	if err := requireIssuerHost("token_endpoint", server.TokenEndpoint, server.Issuer); err != nil {
		return Token{}, err
	}
	form.Set("client_id", cred.ID)
	if cred.Secret.IsSet() {
		// client_secret_post, which is what Register asks for and what the
		// live server advertises first in
		// token_endpoint_auth_methods_supported.
		form.Set("client_secret", cred.Secret.Reveal())
	}

	req, err := c.newRequest(ctx, http.MethodPost, server.TokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return Token{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	var doc wireToken
	if err := c.doJSON(req, &doc, http.StatusOK); err != nil {
		return Token{}, err
	}
	if !doc.AccessToken.IsSet() {
		return Token{}, errors.New("mcpauth: token response contained no access_token")
	}

	tok := Token{
		AccessToken:  doc.AccessToken,
		RefreshToken: doc.RefreshToken,
		TokenType:    doc.TokenType,
		Scope:        doc.Scope,
	}
	if doc.ExpiresIn > 0 {
		tok.Expiry = time.Now().Add(time.Duration(doc.ExpiresIn) * time.Second)
	}
	return tok, nil
}

// InvalidClientError reports that the authorization server rejected our
// registered client (OAuth `invalid_client`). Named because it has a
// specific remedy: re-register dynamically and try again. This matters
// concretely here -- the live CircleCI docs authorization server omits
// RFC 7591's REQUIRED `client_secret_expires_at`, so there is no way to
// know in advance when a registration stops working, and reacting to the
// error is the only available strategy.
type InvalidClientError struct{}

func (*InvalidClientError) Error() string {
	return "mcpauth: the authorization server rejected the stored client registration"
}

// InvalidGrantError reports that the authorization server rejected the code
// or refresh token (OAuth `invalid_grant`). Its remedy is a fresh
// interactive sign-in.
type InvalidGrantError struct{}

func (*InvalidGrantError) Error() string {
	return "mcpauth: the authorization server rejected the stored authorization; sign in again"
}

// tokenError turns an OAuth error response into a Go error, deliberately
// using only the machine-readable `error` code and never
// `error_description`.
//
// Two reasons, both load-bearing. First, `error_description` is free text
// written by the remote server and it is the field most likely to quote
// back part of what we sent -- which, at the token endpoint, is a code, a
// verifier, or a refresh token. Echoing it into an error that then gets
// logged or shown in the UI is exactly the "leaked via the error message"
// failure this repo's rules call out. Second, an unbounded remote string
// in a local error message is a log-injection surface for free. The code
// alone is enough to act on.
func tokenError(status int, body []byte) error {
	var doc wireTokenError
	_ = json.Unmarshal(body, &doc)
	switch doc.Error {
	case "invalid_client", "unauthorized_client":
		return &InvalidClientError{}
	case "invalid_grant":
		return &InvalidGrantError{}
	}
	if code := sanitizeErrorCode(doc.Error); code != "" {
		return fmt.Errorf("mcpauth: authorization server returned HTTP %d (%s)", status, code)
	}
	return fmt.Errorf("mcpauth: authorization server returned HTTP %d", status)
}

// sanitizeErrorCode reduces a remote `error` value to the RFC 6749 §5.2
// character set (%x20-21 / %x23-5B / %x5D-7E, minus quote and backslash) and
// a short length, so nothing a remote server writes can smuggle control
// characters, newlines, or unbounded text into a local error string.
func sanitizeErrorCode(code string) string {
	const maxLen = 48
	var b strings.Builder
	for _, r := range code {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' || r == '.' {
			b.WriteRune(r)
		}
		if b.Len() >= maxLen {
			break
		}
	}
	return b.String()
}

// PKCE is a generated RFC 7636 verifier/challenge pair. Verifier is the
// secret half and must never leave the host process; Challenge is safe to
// put in a URL.
type PKCE struct {
	Verifier  secret.String
	Challenge string
}

// NewPKCE generates a fresh S256 PKCE pair from crypto/rand.
func NewPKCE() (PKCE, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return PKCE{}, fmt.Errorf("mcpauth: generate code verifier: %w", err)
	}
	verifier := base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(verifier))
	return PKCE{
		Verifier:  secret.New(verifier),
		Challenge: base64.RawURLEncoding.EncodeToString(sum[:]),
	}, nil
}

// NewState generates an unguessable RFC 6749 §10.12 state value. 32 bytes
// of crypto/rand, not a counter or a timestamp: this value is the only
// thing standing between the loopback callback and any other local process
// that can also reach 127.0.0.1.
func NewState() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("mcpauth: generate state: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// parseHTTPSURL parses raw and requires it to be an absolute https URL with
// a host. Used on every endpoint this package is told about by a remote
// document, so that "the metadata said http://" or "the metadata said
// file://" is a rejection rather than a request.
func parseHTTPSURL(raw string) (*url.URL, error) {
	if raw == "" {
		return nil, errors.New("empty url")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("parse %q: %w", raw, err)
	}
	if parsed.Scheme != "https" {
		return nil, fmt.Errorf("refusing non-https url %q", raw)
	}
	if parsed.Host == "" {
		return nil, fmt.Errorf("url %q has no host", raw)
	}
	return parsed, nil
}

// validateLoopbackRedirect requires uri to be an http URL on 127.0.0.1 or
// [::1] -- RFC 8252 §7.3's native-app redirect. Notably it rejects the name
// "localhost", which RFC 8252 §8.3 also advises against: a name resolves
// through the resolver, and a poisoned or creatively configured resolver is
// a way for a redirect this process believes is local to arrive somewhere
// else. A literal address cannot be redefined.
func validateLoopbackRedirect(uri string) error {
	parsed, err := url.Parse(uri)
	if err != nil {
		return fmt.Errorf("mcpauth: parse redirect uri: %w", err)
	}
	if parsed.Scheme != "http" {
		return fmt.Errorf("mcpauth: redirect uri must be http on loopback, got scheme %q", parsed.Scheme)
	}
	switch parsed.Hostname() {
	case "127.0.0.1", "::1":
		return nil
	default:
		return fmt.Errorf("mcpauth: redirect uri host %q is not a loopback literal", parsed.Hostname())
	}
}

// wellKnownCandidates returns the RFC 8414 §3.1 / RFC 9728 §3.1 URL
// spellings for a well-known document, in the order they should be tried:
// the segment inserted between host and path first (the spec's own rule),
// then appended to the path (what many implementations actually do).
func wellKnownCandidates(base *url.URL, name string) []string {
	path := strings.Trim(base.Path, "/")
	inserted := *base
	if path == "" {
		inserted.Path = "/.well-known/" + name
	} else {
		inserted.Path = "/.well-known/" + name + "/" + path
	}
	inserted.RawQuery = ""
	inserted.Fragment = ""

	appended := *base
	appended.Path = strings.TrimRight(base.Path, "/") + "/.well-known/" + name
	appended.RawQuery = ""
	appended.Fragment = ""

	out := []string{inserted.String()}
	if appended.String() != inserted.String() {
		out = append(out, appended.String())
	}
	return out
}

func (c *Client) newRequest(ctx context.Context, method, rawURL string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, body)
	if err != nil {
		return nil, fmt.Errorf("mcpauth: build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	return req, nil
}

func (c *Client) getJSON(ctx context.Context, rawURL string, out any) error {
	req, err := c.newRequest(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	return c.doJSON(req, out, http.StatusOK)
}

// doJSON performs req, requires one of okStatuses, and decodes the body
// into out. A non-ok status is turned into an error by tokenError, which
// never includes the response body verbatim.
func (c *Client) doJSON(req *http.Request, out any, okStatuses ...int) error {
	// #nosec G704 -- gosec's taint analysis is correct that req.URL traces back
	// to network data, and cannot see the two controls that make that safe.
	// Both are enforced before any call reaches here:
	//
	//  1. The requests that carry a credential -- the token exchange, the
	//     refresh, and dynamic client registration -- go only to an https URL
	//     on the *same host as the authorization server's issuer*, checked by
	//     requireIssuerHost at each of those three call sites (not merely at
	//     discovery time, so a tampered keystore blob cannot redirect one
	//     either). A metadata document that names a third-party token endpoint
	//     is rejected rather than posted to; see
	//     TestClient_Fn_RefusesToSendCredentialsOffTheIssuersHost.
	//  2. Cross-host redirects are refused (refuseCrossHostRedirect), closing
	//     the route around control 1.
	//
	// The remaining requests are the two discovery GETs to `.well-known` paths.
	// Those *do* reach an arbitrary host -- unavoidably, because the MCP server
	// URL is bring-your-own by design and fetching metadata from
	// the server the user configured is the feature. They are also harmless in
	// the SSRF sense that matters here: they are GETs with no Authorization
	// header, no form body, and no credential of any kind, so the worst
	// available outcome is an outbound request to a URL the user typed into
	// their own local settings panel. Narrowing them further would mean
	// hardcoding an allowlist of docs servers, which is the opposite of what
	// this feature is for.
	resp, err := c.httpClient().Do(req)
	if err != nil {
		// Deliberately does not wrap err: a transport error's message can
		// contain the full request URL, and for the token endpoint the
		// request body is separate but the URL is not interesting enough to
		// risk the habit. Report the host only.
		return fmt.Errorf("mcpauth: request to %s failed", req.URL.Host)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return fmt.Errorf("mcpauth: read response from %s: %w", req.URL.Host, err)
	}

	ok := false
	for _, status := range okStatuses {
		if resp.StatusCode == status {
			ok = true
			break
		}
	}
	if !ok {
		return tokenError(resp.StatusCode, body)
	}
	if err := json.Unmarshal(body, out); err != nil {
		// Deliberately does not wrap err. On the token endpoint the response
		// body *is* the credential, and while encoding/json's errors quote at
		// most a single offending character, "at most a character of the
		// secret" is not a guarantee worth relying on when the host it came
		// from is all a caller needs to debug this.
		return fmt.Errorf("mcpauth: could not decode the response from %s", req.URL.Host)
	}
	return nil
}
