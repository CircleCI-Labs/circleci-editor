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

package mcpauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
)

// Credential is everything needed to keep presenting a bearer token to one
// MCP server without asking the user to sign in again: the dynamic client
// registration, the tokens, and enough of the discovery result to perform a
// refresh months later without re-running discovery.
//
// # Why this one is a JSON blob when the BYO URL/token pair is two entries
//
// internal/host/ai.go stores the manually-configured MCP URL and token as
// two separate keystore ids, and its comment explains why: the URL is not
// secret and is displayed back to the user, so bundling it with the token
// would mean revealing the token just to redisplay the URL. That reasoning
// does not carry over here, and the opposite one applies:
//
//   - Almost every field here is a credential or is useless without one. A
//     client id whose matching secret has been replaced is not a "partly
//     stale display value", it is a registration that will be rejected.
//   - The fields must move together. A refresh that rotates the refresh
//     token while the recorded expiry stays behind is a broken credential,
//     and eight independent keystore writes have eight places to fail
//     halfway. One value is one atomic write in both backends.
//   - Nothing in here is ever displayed. What the UI needs is TokenInfo,
//     which is derived and contains no secret material.
//
// So this deliberately does not follow that precedent, and equally does not
// change keystore.Store to understand structured values -- the blob is
// marshalled here and handed over as an ordinary secret.String, so the
// keystore stays a flat string map exactly as its own doc comment insists.
type Credential struct {
	// Resource is the MCP endpoint this credential is for. Checked before
	// use: a credential minted for one server must never be presented to a
	// different one just because the user re-pointed the URL setting.
	Resource string
	// Server is the discovered authorization-server metadata, kept so a
	// refresh needs no network round trip to rediscover it, and so a server
	// that changes its endpoints later produces a clean re-auth rather than
	// a silent redirect somewhere new.
	Server ServerMetadata
	// Client is the dynamic client registration.
	Client ClientCredentials
	// Token is the current access/refresh token pair.
	Token Token
}

// persistedSecret is a credential field that must survive a JSON round trip
// into the keystore, while staying unprintable everywhere else.
//
// secret.String cannot do this job, deliberately: its MarshalJSON redacts,
// which is exactly right for anything heading towards a log or an HTTP
// response and exactly wrong for the one path whose whole purpose is to write
// the value into the OS keychain and read it back. Rather than weaken
// secret.String -- which would silently remove the guarantee every other user
// of it depends on -- this type inverts only the JSON half:
//
//   - MarshalJSON/UnmarshalJSON round-trip the real value, because persisting
//     a credential to the keychain is not a leak. The output is handed to
//     keystore.Store and nowhere else, and Credential.Marshal returns it
//     already wrapped in a secret.String, so even the serialized blob is
//     unprintable.
//   - String/GoString redact, so `%v`, `%s`, `%+v` and `%#v` on a
//     credentialFile -- the realistic accident, in an error or a debug log --
//     emit nothing.
//
// Unexported, and used by exactly one struct, so it cannot drift into being a
// general-purpose way to serialize a secret by accident.
type persistedSecret struct{ value secret.String }

func (p persistedSecret) MarshalJSON() ([]byte, error) {
	// Reveal() here is the designated persistence crossing point -- see this
	// type's doc comment for why this single path must produce the real value.
	return json.Marshal(p.value.Reveal())
}

func (p *persistedSecret) UnmarshalJSON(data []byte) error {
	// Delegating to secret.String's own UnmarshalJSON keeps "a malformed value
	// must never be quoted back in the error" in one place.
	return p.value.UnmarshalJSON(data)
}

// String redacts, making this type exactly as safe to print as secret.String.
func (p persistedSecret) String() string { return p.value.String() }

// GoString redacts, so %#v is as safe as %v.
func (p persistedSecret) GoString() string { return p.value.GoString() }

// credentialFile is Credential's on-disk JSON shape. Separate from
// Credential so the persisted format is an explicit, reviewable contract
// rather than whatever the Go struct happens to look like. Every field that
// carries a credential is a persistedSecret, never a string, so this struct
// holds no printable secret at all -- see that type's doc comment.
type credentialFile struct {
	// Version guards against a future format change being misread as a
	// valid credential. An unrecognised version is treated as "no
	// credential stored" (see ParseCredential), which degrades to a
	// re-auth prompt rather than an error the user can do nothing about.
	Version  int    `json:"version"`
	Resource string `json:"resource"`

	Issuer                        string   `json:"issuer"`
	AuthorizationEndpoint         string   `json:"authorizationEndpoint"`
	TokenEndpoint                 string   `json:"tokenEndpoint"`
	RegistrationEndpoint          string   `json:"registrationEndpoint,omitempty"`
	ScopesSupported               []string `json:"scopesSupported,omitempty"`
	GrantTypesSupported           []string `json:"grantTypesSupported,omitempty"`
	CodeChallengeMethodsSupported []string `json:"codeChallengeMethodsSupported,omitempty"`

	ClientID              string          `json:"clientId"`
	ClientSecret          persistedSecret `json:"clientSecret,omitempty"`
	ClientRedirectURI     string          `json:"clientRedirectUri"`
	ClientSecretExpiresAt int64           `json:"clientSecretExpiresAt,omitempty"`

	AccessToken  persistedSecret `json:"accessToken"`
	RefreshToken persistedSecret `json:"refreshToken,omitempty"`
	TokenType    string          `json:"tokenType,omitempty"`
	Expiry       string          `json:"expiry,omitempty"`
	Scope        string          `json:"scope,omitempty"`
}

// credentialVersion is the current credentialFile.Version.
const credentialVersion = 1

// Marshal encodes c for storage, wrapped in secret.String so that the
// serialised blob -- which contains the refresh token -- is itself
// unprintable. There is deliberately no plain-string Marshal: a caller that
// wants the bytes has to go through Reveal and justify it, which for this
// value happens exactly once, in the keystore write.
func (c Credential) Marshal() (secret.String, error) {
	file := credentialFile{
		Version:                       credentialVersion,
		Resource:                      c.Resource,
		Issuer:                        c.Server.Issuer,
		AuthorizationEndpoint:         c.Server.AuthorizationEndpoint,
		TokenEndpoint:                 c.Server.TokenEndpoint,
		RegistrationEndpoint:          c.Server.RegistrationEndpoint,
		ScopesSupported:               c.Server.ScopesSupported,
		GrantTypesSupported:           c.Server.GrantTypesSupported,
		CodeChallengeMethodsSupported: c.Server.CodeChallengeMethodsSupported,
		ClientID:                      c.Client.ID,
		ClientSecret:                  persistedSecret{c.Client.Secret},
		ClientRedirectURI:             c.Client.RedirectURI,
		ClientSecretExpiresAt:         c.Client.SecretExpiresAt,
		AccessToken:                   persistedSecret{c.Token.AccessToken},
		RefreshToken:                  persistedSecret{c.Token.RefreshToken},
		TokenType:                     c.Token.TokenType,
		Scope:                         c.Token.Scope,
	}
	if !c.Token.Expiry.IsZero() {
		file.Expiry = c.Token.Expiry.UTC().Format(time.RFC3339)
	}

	// The result is returned wrapped in secret.String, so the serialized blob
	// -- which does contain the real refresh token, by design; see
	// persistedSecret -- cannot be logged or echoed by accident.
	encoded, err := json.Marshal(file)
	if err != nil {
		return secret.String{}, fmt.Errorf("mcpauth: encode credential: %w", err)
	}
	return secret.New(string(encoded)), nil
}

// ParseCredential decodes a credential previously produced by Marshal.
//
// A blob that is empty, unparseable, of an unknown version, or missing the
// fields a refresh needs is reported as ok=false with no error: from the
// caller's point of view "there is no usable credential" and "there is a
// corrupt one" have the same correct response -- offer the user a sign-in --
// and turning a stale keystore entry into a hard error would make the AI
// pane worse rather than better (the same reasoning internal/host/ai.go's
// loadMCPConfig applies to storage failures).
func ParseCredential(stored secret.String) (Credential, bool) {
	if !stored.IsSet() {
		return Credential{}, false
	}
	var file credentialFile
	// Reveal() here is the mirror of Marshal's: this is the designated
	// deserialisation path for a value this package itself wrote.
	if err := json.Unmarshal([]byte(stored.Reveal()), &file); err != nil {
		return Credential{}, false
	}
	if file.Version != credentialVersion {
		return Credential{}, false
	}
	if !file.AccessToken.value.IsSet() || file.TokenEndpoint == "" || file.ClientID == "" {
		return Credential{}, false
	}

	cred := Credential{
		Resource: file.Resource,
		Server: ServerMetadata{
			Issuer:                        file.Issuer,
			AuthorizationEndpoint:         file.AuthorizationEndpoint,
			TokenEndpoint:                 file.TokenEndpoint,
			RegistrationEndpoint:          file.RegistrationEndpoint,
			ScopesSupported:               file.ScopesSupported,
			GrantTypesSupported:           file.GrantTypesSupported,
			CodeChallengeMethodsSupported: file.CodeChallengeMethodsSupported,
		},
		Client: ClientCredentials{
			ID:              file.ClientID,
			Secret:          file.ClientSecret.value,
			RedirectURI:     file.ClientRedirectURI,
			SecretExpiresAt: file.ClientSecretExpiresAt,
		},
		Token: Token{
			AccessToken:  file.AccessToken.value,
			RefreshToken: file.RefreshToken.value,
			TokenType:    file.TokenType,
			Scope:        file.Scope,
		},
	}
	if file.Expiry != "" {
		if parsed, err := time.Parse(time.RFC3339, file.Expiry); err == nil {
			cred.Token.Expiry = parsed
		}
	}
	return cred, true
}

// Info describes this credential without exposing any of it -- the shape a
// settings UI renders, and the answer to "will I be asked to sign in
// again?".
func (c Credential) Info() TokenInfo {
	info := TokenInfo{
		HasRefreshToken: c.Token.RefreshToken.IsSet(),
		Scope:           c.Token.Scope,
	}
	if !c.Token.Expiry.IsZero() {
		info.ExpiresAt = c.Token.Expiry.UTC().Format(time.RFC3339)
		if remaining := int(time.Until(c.Token.Expiry).Seconds()); remaining > 0 {
			info.LifetimeSeconds = remaining
		}
	}
	return info
}

// WithToken returns c with tok applied, preserving the existing refresh
// token when tok does not carry one.
//
// This exists as a method rather than as field assignment at the call site
// because getting it wrong is silent and expensive: RFC 6749 §6 lets a
// server omit refresh_token from a refresh response, meaning "keep using the
// one you have". A caller that assigns the whole Token struct would blank the
// refresh token on the first successful refresh and then force an interactive
// sign-in on the second -- which would look, to a user, exactly like the
// repeated-prompt bug this whole feature was built to avoid reproducing.
func (c Credential) WithToken(tok Token) Credential {
	if !tok.RefreshToken.IsSet() {
		tok.RefreshToken = c.Token.RefreshToken
	}
	out := c
	out.Token = tok
	return out
}

// ErrResourceMismatch is returned by EnsureFresh when the stored credential
// belongs to a different MCP endpoint than the one being asked about --
// i.e. the user re-pointed the URL setting without re-authenticating. The
// remedy is a fresh sign-in, never presenting the old token to the new
// server.
var ErrResourceMismatch = errors.New("mcpauth: stored credential was issued for a different MCP server")

// EnsureFresh returns a credential whose access token is currently valid,
// refreshing it first if it has expired (or is about to -- see refreshSkew).
//
// changed reports whether a refresh happened and the caller must therefore
// persist the returned credential. Callers must honour it: a rotated refresh
// token that is not written back is a credential that works exactly once.
//
// The three failure modes are deliberately distinguishable, because they
// have three different remedies and collapsing them is how a UI ends up
// telling a user to sign in again when the real problem was their wifi:
//
//   - ErrNoRefreshToken -- the server never issued one; interactive sign-in
//     required, and honestly so. This is the case the docs server's OAuth
//     integration could not rule out in advance (#103).
//   - *InvalidGrantError -- the refresh token was rejected (revoked or
//     expired); interactive sign-in required.
//   - anything else -- transient; the caller should degrade to ungrounded
//     for this request and try again on the next one, not discard the
//     credential.
func (c *Client) EnsureFresh(ctx context.Context, cred Credential, resource string) (fresh Credential, changed bool, err error) {
	if resource != "" && cred.Resource != "" && cred.Resource != resource {
		return Credential{}, false, ErrResourceMismatch
	}
	if !cred.Token.Expired() {
		return cred, false, nil
	}
	tok, err := c.Refresh(ctx, cred.Server, cred.Client, cred.Token.RefreshToken)
	if err != nil {
		return Credential{}, false, err
	}
	return cred.WithToken(tok), true, nil
}
