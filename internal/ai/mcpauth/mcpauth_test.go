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

package mcpauth_test

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai/mcpauth"
	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
)

// Every credential in this file is deliberately invalid and exists only to
// be traced through the code. None is, or has ever been, a real token: the
// point of the sentinels is that a test can assert they never appear
// anywhere they shouldn't, which requires them to be recognisable and
// worthless.
const (
	sentinelAccessToken  = "invalid-access-token-must-never-be-logged-or-echoed"
	sentinelRefreshToken = "invalid-refresh-token-must-never-be-logged-or-echoed"
	sentinelClientSecret = "invalid-client-secret-must-never-be-logged-or-echoed"
	sentinelCode         = "invalid-authorization-code-must-never-be-echoed"
)

// fakeAuthServer is an https authorization server good enough to run the
// whole flow against: RFC 9728 protected-resource metadata, RFC 8414
// authorization-server metadata at the *inserted* well-known path, RFC 7591
// registration, and a token endpoint.
//
// It mirrors the shapes observed live from circleci.mcp.kapa.ai on
// 2026-07-28 rather than an idealised spec reading -- including the quirks
// that actually matter: the well-known segment inserted between host and
// path, and a registration response that omits client_secret_expires_at.
type fakeAuthServer struct {
	ts *httptest.Server
	// issuerPath is the path portion of the issuer, e.g. "/auth/public",
	// which is what forces the inserted-well-known spelling.
	issuerPath string
	// omitRegistration drops registration_endpoint from the metadata, the
	// case where this app cannot sign in at all.
	omitRegistration bool
	// omitRefreshToken drops refresh_token from the token response -- the
	// scenario research could not rule out, so it has to be a tested one.
	omitRefreshToken bool
	// expiresIn is the token lifetime advertised; 0 omits the field.
	expiresIn int
	// tokenErrorBody, when set, is returned from the token endpoint with
	// tokenErrorStatus instead of a token.
	tokenErrorBody   string
	tokenErrorStatus int

	// recorded captures what the client actually sent, so tests can assert
	// on PKCE, resource indicators, and client authentication.
	lastRegistration map[string]any
	lastTokenForm    url.Values
}

func newFakeAuthServer(t *testing.T, configure func(*fakeAuthServer)) *fakeAuthServer {
	t.Helper()
	f := &fakeAuthServer{issuerPath: "/auth/public", expiresIn: 3600}
	if configure != nil {
		configure(f)
	}
	mux := http.NewServeMux()
	f.ts = httptest.NewTLSServer(mux)
	t.Cleanup(f.ts.Close)

	mux.HandleFunc("/.well-known/oauth-protected-resource", func(w http.ResponseWriter, _ *http.Request) {
		writeTestJSON(w, map[string]any{
			"resource":              f.ts.URL + "/",
			"authorization_servers": []string{f.ts.URL + f.issuerPath},
			"scopes_supported":      []string{"openid"},
		})
	})

	// The inserted spelling only. A server that also answered the appended
	// spelling would let a regression in candidate ordering pass unnoticed.
	mux.HandleFunc("/.well-known/oauth-authorization-server"+f.issuerPath, func(w http.ResponseWriter, _ *http.Request) {
		doc := map[string]any{
			"issuer":                           f.ts.URL + f.issuerPath,
			"authorization_endpoint":           f.ts.URL + f.issuerPath + "/authorize",
			"token_endpoint":                   f.ts.URL + f.issuerPath + "/token",
			"scopes_supported":                 []string{"openid"},
			"response_types_supported":         []string{"code"},
			"grant_types_supported":            []string{"authorization_code", "refresh_token"},
			"code_challenge_methods_supported": []string{"S256"},
		}
		if !f.omitRegistration {
			doc["registration_endpoint"] = f.ts.URL + f.issuerPath + "/register"
		}
		writeTestJSON(w, doc)
	})

	mux.HandleFunc(f.issuerPath+"/register", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&f.lastRegistration)
		w.WriteHeader(http.StatusCreated)
		// Deliberately no client_secret_expires_at -- RFC 7591 makes it
		// REQUIRED alongside a secret, and the live server omits it.
		writeTestJSONBody(w, map[string]any{
			"client_id":     "invalid-client-id-0000",
			"client_secret": sentinelClientSecret,
		})
	})

	mux.HandleFunc(f.issuerPath+"/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.lastTokenForm = r.PostForm

		if f.tokenErrorBody != "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(f.tokenErrorStatus)
			_, _ = w.Write([]byte(f.tokenErrorBody))
			return
		}
		doc := map[string]any{
			"access_token": sentinelAccessToken,
			"token_type":   "Bearer",
			"scope":        "openid",
		}
		if !f.omitRefreshToken {
			doc["refresh_token"] = sentinelRefreshToken
		}
		if f.expiresIn > 0 {
			doc["expires_in"] = f.expiresIn
		}
		writeTestJSON(w, doc)
	})

	return f
}

// client returns an mcpauth.Client that trusts this server's test
// certificate. Real https, real TLS verification against a real cert -- just
// one the test generated.
func (f *fakeAuthServer) client() *mcpauth.Client {
	return &mcpauth.Client{HTTPClient: f.ts.Client()}
}

func (f *fakeAuthServer) resourceURL() string { return f.ts.URL }

func writeTestJSON(w http.ResponseWriter, doc map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	writeTestJSONBody(w, doc)
}

func writeTestJSONBody(w http.ResponseWriter, doc map[string]any) {
	_ = json.NewEncoder(w).Encode(doc)
}

// discover runs both discovery steps, which most tests need before doing
// anything interesting.
func (f *fakeAuthServer) discover(t *testing.T) (mcpauth.ResourceMetadata, mcpauth.ServerMetadata) {
	t.Helper()
	c := f.client()
	res, err := c.DiscoverResource(context.Background(), f.resourceURL())
	assert.NilError(t, err)
	srv, err := c.DiscoverServer(context.Background(), res.AuthorizationServer)
	assert.NilError(t, err)
	return res, srv
}

func TestClient_DiscoverResource_ReadsProtectedResourceMetadata(t *testing.T) {
	f := newFakeAuthServer(t, nil)

	res, err := f.client().DiscoverResource(context.Background(), f.resourceURL())
	assert.NilError(t, err)
	assert.Equal(t, res.AuthorizationServer, f.ts.URL+"/auth/public")
	assert.Equal(t, res.Resource, f.ts.URL+"/")
	assert.DeepEqual(t, res.ScopesSupported, []string{"openid"})
}

func TestClient_DiscoverResource_RejectsNonHTTPSResourceURL(t *testing.T) {
	_, err := (&mcpauth.Client{}).DiscoverResource(context.Background(), "http://example.test/mcp")
	assert.ErrorContains(t, err, "non-https")
}

// The live CircleCI docs authorization server answers only the *inserted*
// well-known spelling (RFC 8414 §3.1); the appended one 404s. This test
// pins that ordering, because getting it wrong makes discovery fail against
// the one server this feature exists for.
func TestClient_DiscoverServer_UsesTheInsertedWellKnownPath(t *testing.T) {
	f := newFakeAuthServer(t, nil)

	srv, err := f.client().DiscoverServer(context.Background(), f.ts.URL+"/auth/public")
	assert.NilError(t, err)
	assert.Equal(t, srv.TokenEndpoint, f.ts.URL+"/auth/public/token")
	assert.Equal(t, srv.RegistrationEndpoint, f.ts.URL+"/auth/public/register")
	assert.Equal(t, srv.SupportsRefreshTokenGrant(), true)
}

// Discovery documents arrive over the network and name the endpoints this
// client then POSTs a client secret and a refresh token to, so a tampered
// document is a credential-exfiltration primitive unless it is constrained.
// These are the constraints (gosec G704's real finding).
func TestClient_DiscoverServer_RejectsAMetadataDocumentThatWouldRedirectCredentials(t *testing.T) {
	for name, tc := range map[string]struct {
		doc  func(host string) map[string]any
		want string
	}{
		"non-https endpoints": {
			doc: func(host string) map[string]any {
				return map[string]any{
					"issuer":                 "https://" + host,
					"authorization_endpoint": "http://" + host + "/authorize",
					"token_endpoint":         "http://" + host + "/token",
				}
			},
			want: "non-https",
		},
		"token endpoint on a different host": {
			doc: func(host string) map[string]any {
				return map[string]any{
					"issuer":                 "https://" + host,
					"authorization_endpoint": "https://" + host + "/authorize",
					// The exfiltration case: everything looks right except
					// where the credentials actually go.
					"token_endpoint": "https://attacker.example.test/token",
				}
			},
			want: "same host as the authorization server",
		},
		"registration endpoint on a different host": {
			doc: func(host string) map[string]any {
				return map[string]any{
					"issuer":                 "https://" + host,
					"authorization_endpoint": "https://" + host + "/authorize",
					"token_endpoint":         "https://" + host + "/token",
					"registration_endpoint":  "https://attacker.example.test/register",
				}
			},
			want: "same host as the authorization server",
		},
		"issuer does not match the document we fetched (RFC 8414 3.3)": {
			doc: func(host string) map[string]any {
				return map[string]any{
					"issuer":                 "https://attacker.example.test",
					"authorization_endpoint": "https://" + host + "/authorize",
					"token_endpoint":         "https://" + host + "/token",
				}
			},
			want: "declares issuer",
		},
		"no token endpoint at all": {
			doc: func(host string) map[string]any {
				return map[string]any{
					"issuer":                 "https://" + host,
					"authorization_endpoint": "https://" + host + "/authorize",
				}
			},
			want: "token_endpoint",
		},
	} {
		t.Run(name, func(t *testing.T) {
			var host string
			ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				writeTestJSON(w, tc.doc(host))
			}))
			t.Cleanup(ts.Close)
			host = strings.TrimPrefix(ts.URL, "https://")

			c := &mcpauth.Client{HTTPClient: ts.Client()}
			_, err := c.DiscoverServer(context.Background(), ts.URL)
			assert.ErrorContains(t, err, tc.want)
		})
	}
}

// The accept path for the same rules: the real server's shape (verified
// 2026-07-28) puts issuer, authorize, token and register all on one host, so
// the same-host rule must not reject it.
func TestClient_DiscoverServer_AcceptsEndpointsOnTheIssuersOwnHost(t *testing.T) {
	f := newFakeAuthServer(t, nil)

	srv, err := f.client().DiscoverServer(context.Background(), f.ts.URL+"/auth/public")
	assert.NilError(t, err)
	assert.Equal(t, srv.Issuer, f.ts.URL+"/auth/public")
	assert.Equal(t, srv.TokenEndpoint, f.ts.URL+"/auth/public/token")
	assert.Equal(t, srv.RegistrationEndpoint, f.ts.URL+"/auth/public/register")
}

// The pin is re-checked at the request site, not only at discovery, because a
// ServerMetadata can reach a request without having been discovered -- above
// all via ParseCredential rebuilding one from a stored keystore blob. A
// tampered 0600 file must not be able to redirect a refresh token.
func TestClient_Fn_RefusesToSendCredentialsOffTheIssuersHost(t *testing.T) {
	f := newFakeAuthServer(t, nil)
	_, srv := f.discover(t)

	tampered := srv
	tampered.TokenEndpoint = "https://attacker.example.test/token"

	_, err := f.client().Exchange(context.Background(), tampered,
		mcpauth.ClientCredentials{ID: "c", Secret: secret.New(sentinelClientSecret)},
		secret.New(sentinelCode), secret.New("v"), "")
	assert.ErrorContains(t, err, "refusing to send credentials")
	assert.Assert(t, f.lastTokenForm == nil, "nothing may have been sent")

	_, err = f.client().Refresh(context.Background(), tampered,
		mcpauth.ClientCredentials{ID: "c"}, secret.New(sentinelRefreshToken))
	assert.ErrorContains(t, err, "refusing to send credentials")

	_, err = f.client().Register(context.Background(),
		"https://attacker.example.test/register", srv.Issuer, "t",
		"http://127.0.0.1:65000/oauth/mcp/callback", nil)
	assert.ErrorContains(t, err, "refusing to send credentials")

	// And an error message must not name the credential it declined to send.
	for _, leaked := range []string{sentinelClientSecret, sentinelRefreshToken, sentinelCode} {
		assert.Assert(t, !strings.Contains(err.Error(), leaked))
	}
}

// Metadata with no issuer at all leaves nothing to pin against, so a
// credential-bearing request must refuse rather than default to "no
// constraint".
func TestClient_Fn_RefusesACredentialRequestWhenMetadataHasNoIssuer(t *testing.T) {
	f := newFakeAuthServer(t, nil)
	_, srv := f.discover(t)

	noIssuer := srv
	noIssuer.Issuer = ""

	_, err := f.client().Exchange(context.Background(), noIssuer,
		mcpauth.ClientCredentials{ID: "c"}, secret.New(sentinelCode), secret.New("v"), "")
	assert.ErrorContains(t, err, "cannot verify token_endpoint without a valid issuer")
}

// A cross-host redirect walks around the same-host pin, so the default client
// refuses to follow one. (Tests inject their own client, so this exercises the
// policy function's effect through a real redirect chain.)
func TestClient_Fn_RefusesToFollowACrossHostRedirect(t *testing.T) {
	elsewhere := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeTestJSON(w, map[string]any{"access_token": "attacker-supplied"})
	}))
	t.Cleanup(elsewhere.Close)

	var redirected bool
	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.well-known/oauth-protected-resource" {
			redirected = true
			http.Redirect(w, r, elsewhere.URL+"/.well-known/oauth-protected-resource", http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(origin.Close)

	// Trust both test certs, but keep this package's own redirect policy --
	// which is the thing under test.
	pool := x509.NewCertPool()
	pool.AddCert(origin.Certificate())
	pool.AddCert(elsewhere.Certificate())
	client := &mcpauth.Client{HTTPClient: &http.Client{
		Transport:     &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}},
		CheckRedirect: mcpauth.ExportedRefuseCrossHostRedirect,
	}}

	_, err := client.DiscoverResource(context.Background(), origin.URL)
	assert.Assert(t, err != nil, "a cross-host redirect must not be followed")
	assert.Assert(t, redirected, "the origin should have been asked first")
}

func TestClient_Register_SendsLoopbackRedirectAndRefreshTokenGrant(t *testing.T) {
	f := newFakeAuthServer(t, nil)
	res, srv := f.discover(t)

	cred, err := f.client().Register(context.Background(), srv.RegistrationEndpoint, srv.Issuer,
		"test client", "http://127.0.0.1:65000/oauth/mcp/callback", res.ScopesSupported)
	assert.NilError(t, err)
	assert.Equal(t, cred.ID, "invalid-client-id-0000")
	assert.Equal(t, cred.Secret.Reveal(), sentinelClientSecret)
	assert.Equal(t, cred.RedirectURI, "http://127.0.0.1:65000/oauth/mcp/callback")

	grants, _ := f.lastRegistration["grant_types"].([]any)
	assert.Assert(t, len(grants) == 2, "expected two grant types, got %v", grants)
	assert.Equal(t, grants[1], "refresh_token")
	assert.Equal(t, f.lastRegistration["scope"], "openid")
}

func TestClient_Register_RejectsNonLoopbackRedirect(t *testing.T) {
	f := newFakeAuthServer(t, nil)
	_, srv := f.discover(t)

	for _, redirect := range []string{
		"https://example.test/callback",
		// "localhost" is a name, and RFC 8252 §8.3 warns against it: a
		// resolver can be persuaded to point it elsewhere.
		"http://localhost:65000/callback",
		"http://192.168.1.5:65000/callback",
	} {
		_, err := f.client().Register(context.Background(), srv.RegistrationEndpoint, srv.Issuer, "t", redirect, nil)
		assert.Assert(t, err != nil, "redirect %q should have been rejected", redirect)
	}
}

func TestClient_Register_NoRegistrationEndpointIsAClearError(t *testing.T) {
	f := newFakeAuthServer(t, func(f *fakeAuthServer) { f.omitRegistration = true })
	_, srv := f.discover(t)
	assert.Equal(t, srv.RegistrationEndpoint, "")

	_, err := f.client().Register(context.Background(), "", srv.Issuer, "t", "http://127.0.0.1:65000/c", nil)
	assert.ErrorContains(t, err, "no dynamic client registration")
}

func TestAuthorizeURL_Fn_CarriesStatePKCEAndResource(t *testing.T) {
	f := newFakeAuthServer(t, nil)
	res, srv := f.discover(t)

	raw, err := mcpauth.AuthorizeURL(mcpauth.AuthorizeRequest{
		Server:      srv,
		ClientID:    "invalid-client-id-0000",
		RedirectURI: "http://127.0.0.1:65000/oauth/mcp/callback",
		State:       "test-state",
		Challenge:   "test-challenge",
		Scopes:      res.ScopesSupported,
		Resource:    res.Resource,
	})
	assert.NilError(t, err)

	parsed, err := url.Parse(raw)
	assert.NilError(t, err)
	q := parsed.Query()
	assert.Equal(t, q.Get("response_type"), "code")
	assert.Equal(t, q.Get("state"), "test-state")
	assert.Equal(t, q.Get("code_challenge"), "test-challenge")
	assert.Equal(t, q.Get("code_challenge_method"), "S256")
	assert.Equal(t, q.Get("scope"), "openid")
	assert.Equal(t, q.Get("resource"), res.Resource)
	assert.Equal(t, q.Get("redirect_uri"), "http://127.0.0.1:65000/oauth/mcp/callback")
}

func TestAuthorizeURL_Fn_RequiresPKCEAndState(t *testing.T) {
	f := newFakeAuthServer(t, nil)
	_, srv := f.discover(t)

	base := mcpauth.AuthorizeRequest{
		Server:      srv,
		ClientID:    "c",
		RedirectURI: "http://127.0.0.1:65000/c",
		State:       "s",
		Challenge:   "ch",
	}

	noState := base
	noState.State = ""
	_, err := mcpauth.AuthorizeURL(noState)
	assert.ErrorContains(t, err, "missing client id, state, or code challenge")

	noChallenge := base
	noChallenge.Challenge = ""
	_, err = mcpauth.AuthorizeURL(noChallenge)
	assert.ErrorContains(t, err, "missing client id, state, or code challenge")
}

func TestNewPKCE_Fn_ProducesAnS256ChallengeForItsVerifier(t *testing.T) {
	a, err := mcpauth.NewPKCE()
	assert.NilError(t, err)
	b, err := mcpauth.NewPKCE()
	assert.NilError(t, err)

	assert.Assert(t, a.Verifier.IsSet())
	assert.Assert(t, a.Challenge != "")
	// Distinct per call: a reused verifier would defeat the point.
	assert.Assert(t, a.Verifier.Reveal() != b.Verifier.Reveal())
	assert.Assert(t, a.Challenge != b.Challenge)
	// The challenge must not be the verifier -- i.e. this is genuinely S256
	// and not the deprecated "plain" method wearing a different name.
	assert.Assert(t, a.Challenge != a.Verifier.Reveal())
	// And the verifier must not be printable, since it is a secret.String.
	assert.Assert(t, !strings.Contains(fmt.Sprintf("%v", a), a.Verifier.Reveal()))
}

func TestNewState_Fn_IsUnguessableAndUnique(t *testing.T) {
	seen := map[string]bool{}
	for range 32 {
		s, err := mcpauth.NewState()
		assert.NilError(t, err)
		assert.Assert(t, len(s) >= 40, "state %q is too short to be unguessable", s)
		assert.Assert(t, !seen[s], "state %q repeated", s)
		seen[s] = true
	}
}

func TestClient_Exchange_SendsPKCEVerifierAndClientSecret(t *testing.T) {
	f := newFakeAuthServer(t, nil)
	res, srv := f.discover(t)
	cred := mcpauth.ClientCredentials{
		ID:          "invalid-client-id-0000",
		Secret:      secret.New(sentinelClientSecret),
		RedirectURI: "http://127.0.0.1:65000/oauth/mcp/callback",
	}

	tok, err := f.client().Exchange(context.Background(), srv, cred,
		secret.New(sentinelCode), secret.New("test-verifier"), res.Resource)
	assert.NilError(t, err)
	assert.Equal(t, tok.AccessToken.Reveal(), sentinelAccessToken)
	assert.Equal(t, tok.RefreshToken.Reveal(), sentinelRefreshToken)
	assert.Assert(t, !tok.Expiry.IsZero())
	assert.Equal(t, tok.Expired(), false)

	form := f.lastTokenForm
	assert.Equal(t, form.Get("grant_type"), "authorization_code")
	assert.Equal(t, form.Get("code"), sentinelCode)
	assert.Equal(t, form.Get("code_verifier"), "test-verifier")
	assert.Equal(t, form.Get("client_id"), "invalid-client-id-0000")
	assert.Equal(t, form.Get("client_secret"), sentinelClientSecret)
	assert.Equal(t, form.Get("redirect_uri"), cred.RedirectURI)
	assert.Equal(t, form.Get("resource"), res.Resource)
}

// The scenario the whole feature hinges on and that research could not
// settle: a server that issues no refresh token. It must be reported, not
// papered over.
func TestClient_Exchange_NoRefreshTokenIsReportedNotInvented(t *testing.T) {
	f := newFakeAuthServer(t, func(f *fakeAuthServer) { f.omitRefreshToken = true })
	_, srv := f.discover(t)

	tok, err := f.client().Exchange(context.Background(), srv, mcpauth.ClientCredentials{ID: "c"},
		secret.New(sentinelCode), secret.New("v"), "")
	assert.NilError(t, err)
	assert.Equal(t, tok.RefreshToken.IsSet(), false)

	cred := mcpauth.Credential{Token: tok}
	assert.Equal(t, cred.Info().HasRefreshToken, false)

	_, _, err = f.client().EnsureFresh(context.Background(), mcpauth.Credential{
		Server: srv,
		Token:  mcpauth.Token{AccessToken: tok.AccessToken, Expiry: time.Now().Add(-time.Hour)},
	}, "")
	assert.ErrorIs(t, err, mcpauth.ErrNoRefreshToken)
}

func TestClient_Refresh_NoRefreshTokenReturnsTheNamedError(t *testing.T) {
	f := newFakeAuthServer(t, nil)
	_, srv := f.discover(t)

	_, err := f.client().Refresh(context.Background(), srv, mcpauth.ClientCredentials{ID: "c"}, secret.String{})
	assert.ErrorIs(t, err, mcpauth.ErrNoRefreshToken)
}

// RFC 6749 §6: a refresh response may omit refresh_token, meaning "keep
// yours". Blanking it would make the *second* refresh fail and look exactly
// like the repeated-prompt bug this feature exists to avoid.
func TestCredential_WithToken_KeepsTheExistingRefreshTokenWhenNoneIsReturned(t *testing.T) {
	cred := mcpauth.Credential{Token: mcpauth.Token{
		AccessToken:  secret.New("old-access"),
		RefreshToken: secret.New(sentinelRefreshToken),
	}}

	updated := cred.WithToken(mcpauth.Token{AccessToken: secret.New("new-access")})
	assert.Equal(t, updated.Token.AccessToken.Reveal(), "new-access")
	assert.Equal(t, updated.Token.RefreshToken.Reveal(), sentinelRefreshToken)

	rotated := cred.WithToken(mcpauth.Token{
		AccessToken:  secret.New("new-access"),
		RefreshToken: secret.New("rotated-refresh"),
	})
	assert.Equal(t, rotated.Token.RefreshToken.Reveal(), "rotated-refresh")
}

func TestClient_EnsureFresh_RefreshesAnExpiredTokenAndReportsTheChange(t *testing.T) {
	f := newFakeAuthServer(t, nil)
	res, srv := f.discover(t)

	stale := mcpauth.Credential{
		Resource: res.Resource,
		Server:   srv,
		Client:   mcpauth.ClientCredentials{ID: "invalid-client-id-0000", Secret: secret.New(sentinelClientSecret)},
		Token: mcpauth.Token{
			AccessToken:  secret.New("stale-access-token"),
			RefreshToken: secret.New(sentinelRefreshToken),
			Expiry:       time.Now().Add(-time.Hour),
		},
	}

	fresh, changed, err := f.client().EnsureFresh(context.Background(), stale, res.Resource)
	assert.NilError(t, err)
	assert.Equal(t, changed, true)
	assert.Equal(t, fresh.Token.AccessToken.Reveal(), sentinelAccessToken)
	assert.Equal(t, f.lastTokenForm.Get("grant_type"), "refresh_token")
	assert.Equal(t, f.lastTokenForm.Get("refresh_token"), sentinelRefreshToken)
}

func TestClient_EnsureFresh_LeavesAValidTokenAloneAndMakesNoRequest(t *testing.T) {
	f := newFakeAuthServer(t, nil)
	res, srv := f.discover(t)

	cred := mcpauth.Credential{
		Resource: res.Resource,
		Server:   srv,
		Token: mcpauth.Token{
			AccessToken: secret.New(sentinelAccessToken),
			Expiry:      time.Now().Add(time.Hour),
		},
	}

	fresh, changed, err := f.client().EnsureFresh(context.Background(), cred, res.Resource)
	assert.NilError(t, err)
	assert.Equal(t, changed, false)
	assert.Equal(t, fresh.Token.AccessToken.Reveal(), sentinelAccessToken)
	assert.Assert(t, f.lastTokenForm == nil, "a valid token must not trigger a token request")
}

// Re-pointing the MCP URL must not cause a token minted for one server to be
// presented to another.
func TestClient_EnsureFresh_RefusesACredentialForADifferentResource(t *testing.T) {
	f := newFakeAuthServer(t, nil)
	_, srv := f.discover(t)

	cred := mcpauth.Credential{
		Resource: "https://docs.example.test/",
		Server:   srv,
		Token:    mcpauth.Token{AccessToken: secret.New(sentinelAccessToken), Expiry: time.Now().Add(-time.Hour)},
	}

	_, _, err := f.client().EnsureFresh(context.Background(), cred, "https://other.example.test/")
	assert.ErrorIs(t, err, mcpauth.ErrResourceMismatch)
}

func TestToken_Expired_UnknownLifetimeIsNotTreatedAsExpired(t *testing.T) {
	// A server that states no expires_in gives us nothing to go on; throwing
	// the token away pre-emptively would break a session that still works.
	assert.Equal(t, mcpauth.Token{AccessToken: secret.New("a")}.Expired(), false)
	assert.Equal(t, mcpauth.Token{Expiry: time.Now().Add(time.Hour)}.Expired(), false)
	assert.Equal(t, mcpauth.Token{Expiry: time.Now().Add(-time.Second)}.Expired(), true)
	// Within the refresh skew counts as expired, so a token cannot lapse
	// while in flight to the inference provider.
	assert.Equal(t, mcpauth.Token{Expiry: time.Now().Add(30 * time.Second)}.Expired(), true)
}

func TestClient_Exchange_InvalidGrantMapsToTheNamedError(t *testing.T) {
	f := newFakeAuthServer(t, func(f *fakeAuthServer) {
		f.tokenErrorStatus = http.StatusBadRequest
		f.tokenErrorBody = `{"error":"invalid_grant","error_description":"nope"}`
	})
	_, srv := f.discover(t)

	_, err := f.client().Exchange(context.Background(), srv, mcpauth.ClientCredentials{ID: "c"},
		secret.New(sentinelCode), secret.New("v"), "")
	var invalidGrant *mcpauth.InvalidGrantError
	assert.Assert(t, errors.As(err, &invalidGrant), "expected InvalidGrantError, got %v", err)
}

func TestClient_Exchange_InvalidClientMapsToTheNamedError(t *testing.T) {
	f := newFakeAuthServer(t, func(f *fakeAuthServer) {
		f.tokenErrorStatus = http.StatusUnauthorized
		f.tokenErrorBody = `{"error":"invalid_client"}`
	})
	_, srv := f.discover(t)

	_, err := f.client().Exchange(context.Background(), srv, mcpauth.ClientCredentials{ID: "c"},
		secret.New(sentinelCode), secret.New("v"), "")
	var invalidClient *mcpauth.InvalidClientError
	assert.Assert(t, errors.As(err, &invalidClient), "expected InvalidClientError, got %v", err)
}

// The leak test for the usual leak. An OAuth server's error_description is
// free text that frequently quotes back what it was sent -- here, the code
// and the client secret -- and this package drops it on purpose.
func TestClient_Exchange_ErrorMessageNeverRepeatsWhatWeSent(t *testing.T) {
	f := newFakeAuthServer(t, func(f *fakeAuthServer) {
		f.tokenErrorStatus = http.StatusBadRequest
		f.tokenErrorBody = fmt.Sprintf(
			`{"error":"invalid_request","error_description":"code %s and secret %s were rejected"}`,
			sentinelCode, sentinelClientSecret)
	})
	_, srv := f.discover(t)

	_, err := f.client().Exchange(context.Background(), srv,
		mcpauth.ClientCredentials{ID: "c", Secret: secret.New(sentinelClientSecret)},
		secret.New(sentinelCode), secret.New("verifier-value"), "")
	assert.Assert(t, err != nil)

	msg := err.Error()
	for _, leaked := range []string{sentinelCode, sentinelClientSecret, "verifier-value", "were rejected"} {
		assert.Assert(t, !strings.Contains(msg, leaked),
			"error message leaked %q: %s", leaked, msg)
	}
	// The machine-readable code is kept, since it is what a caller acts on.
	assert.Assert(t, strings.Contains(msg, "invalid_request"), "error should name the code: %s", msg)
}

// A remote server must not be able to inject newlines or unbounded text into
// a local error string via the `error` field.
func TestClient_Exchange_SanitizesAHostileErrorCode(t *testing.T) {
	f := newFakeAuthServer(t, func(f *fakeAuthServer) {
		f.tokenErrorStatus = http.StatusBadRequest
		f.tokenErrorBody = `{"error":"bad\nFATAL: fake log line <script>alert(1)</script> ` +
			strings.Repeat("x", 500) + `"}`
	})
	_, srv := f.discover(t)

	_, err := f.client().Exchange(context.Background(), srv, mcpauth.ClientCredentials{ID: "c"},
		secret.New(sentinelCode), secret.New("v"), "")
	assert.Assert(t, err != nil)
	msg := err.Error()
	assert.Assert(t, !strings.Contains(msg, "\n"), "error message must be single-line: %q", msg)
	assert.Assert(t, !strings.Contains(msg, "<script>"), "error message must not carry markup: %q", msg)
	assert.Assert(t, len(msg) < 160, "error message must stay short, got %d chars", len(msg))
}

func TestCredential_Fn_MarshalParseRoundTrip(t *testing.T) {
	f := newFakeAuthServer(t, nil)
	res, srv := f.discover(t)

	original := mcpauth.Credential{
		Resource: res.Resource,
		Server:   srv,
		Client: mcpauth.ClientCredentials{
			ID:          "invalid-client-id-0000",
			Secret:      secret.New(sentinelClientSecret),
			RedirectURI: "http://127.0.0.1:65000/oauth/mcp/callback",
		},
		Token: mcpauth.Token{
			AccessToken:  secret.New(sentinelAccessToken),
			RefreshToken: secret.New(sentinelRefreshToken),
			TokenType:    "Bearer",
			Expiry:       time.Now().Add(time.Hour).Truncate(time.Second),
			Scope:        "openid",
		},
	}

	blob, err := original.Marshal()
	assert.NilError(t, err)

	// The serialised blob is itself a secret.String, so printing it cannot
	// leak the refresh token even though the JSON inside contains it.
	assert.Assert(t, !strings.Contains(fmt.Sprintf("%v %s %+v", blob, blob, blob), sentinelRefreshToken))

	parsed, ok := mcpauth.ParseCredential(blob)
	assert.Assert(t, ok)
	assert.Equal(t, parsed.Resource, original.Resource)
	assert.Equal(t, parsed.Client.ID, original.Client.ID)
	assert.Equal(t, parsed.Client.Secret.Reveal(), sentinelClientSecret)
	assert.Equal(t, parsed.Client.RedirectURI, original.Client.RedirectURI)
	assert.Equal(t, parsed.Token.AccessToken.Reveal(), sentinelAccessToken)
	assert.Equal(t, parsed.Token.RefreshToken.Reveal(), sentinelRefreshToken)
	assert.Equal(t, parsed.Token.Expiry.Unix(), original.Token.Expiry.Unix())
	assert.Equal(t, parsed.Server.TokenEndpoint, srv.TokenEndpoint)
}

// The wire structs decode credentials into secret.String, so a decoded token
// response is never a printable value -- gosec's G117 finding, fixed by making
// redaction the type's default rather than by suppressing the warning.
func TestClient_Fn_DecodedCredentialsAreNeverPrintable(t *testing.T) {
	f := newFakeAuthServer(t, nil)
	res, srv := f.discover(t)

	cred, err := f.client().Register(context.Background(), srv.RegistrationEndpoint, srv.Issuer,
		"test client", "http://127.0.0.1:65000/oauth/mcp/callback", res.ScopesSupported)
	assert.NilError(t, err)
	tok, err := f.client().Exchange(context.Background(), srv, cred,
		secret.New(sentinelCode), secret.New("v"), res.Resource)
	assert.NilError(t, err)

	// Every verb, on every value that holds a credential.
	for _, format := range []string{"%s", "%v", "%+v", "%#v"} {
		for _, value := range []any{cred, tok, mcpauth.Credential{Client: cred, Token: tok}} {
			out := fmt.Sprintf(format, value)
			for _, leaked := range []string{sentinelClientSecret, sentinelAccessToken, sentinelRefreshToken} {
				assert.Assert(t, !strings.Contains(out, leaked),
					"format %q leaked a credential: %s", format, out)
			}
		}
	}

	// And json.Marshal of a credential-bearing struct redacts, so an accidental
	// HTTP response cannot carry one.
	encoded, err := json.Marshal(mcpauth.Credential{Client: cred, Token: tok})
	assert.NilError(t, err)
	for _, leaked := range []string{sentinelClientSecret, sentinelAccessToken, sentinelRefreshToken} {
		assert.Assert(t, !strings.Contains(string(encoded), leaked),
			"json.Marshal leaked a credential: %s", encoded)
	}
}

func TestParseCredential_Fn_UnusableBlobsReportNotOkRatherThanErroring(t *testing.T) {
	for name, blob := range map[string]secret.String{
		"unset":             {},
		"not json":          secret.New("this is not json"),
		"wrong version":     secret.New(`{"version":99,"accessToken":"a","tokenEndpoint":"https://x/t","clientId":"c"}`),
		"no access token":   secret.New(`{"version":1,"tokenEndpoint":"https://x/t","clientId":"c"}`),
		"no token endpoint": secret.New(`{"version":1,"accessToken":"a","clientId":"c"}`),
	} {
		_, ok := mcpauth.ParseCredential(blob)
		assert.Assert(t, !ok, "%s should have reported not-ok", name)
	}
}

func TestCredential_Info_DescribesTheCredentialWithoutExposingIt(t *testing.T) {
	cred := mcpauth.Credential{Token: mcpauth.Token{
		AccessToken:  secret.New(sentinelAccessToken),
		RefreshToken: secret.New(sentinelRefreshToken),
		Expiry:       time.Now().Add(time.Hour),
		Scope:        "openid",
	}}

	info := cred.Info()
	assert.Equal(t, info.HasRefreshToken, true)
	assert.Assert(t, info.ExpiresAt != "")
	assert.Assert(t, info.LifetimeSeconds > 3000 && info.LifetimeSeconds <= 3600)

	// TokenInfo is what crosses to the SPA, so it must be provably unable to
	// carry credential material.
	encoded, err := json.Marshal(info)
	assert.NilError(t, err)
	for _, leaked := range []string{sentinelAccessToken, sentinelRefreshToken} {
		assert.Assert(t, !strings.Contains(string(encoded), leaked),
			"TokenInfo JSON leaked a token: %s", encoded)
	}
}
