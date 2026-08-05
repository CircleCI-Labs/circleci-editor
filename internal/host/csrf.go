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
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
)

// # Why this file exists
//
// This host binds only 127.0.0.1 (see Run's doc comment), never 0.0.0.0, but
// a loopback bind is not a security boundary against the browser sitting in
// front of it: *any* page the user has open in another tab can address
// 127.0.0.1:<port>, guess or scan the port, and fire requests at this API --
// exactly as freely as the SPA this host actually serves can. Without
// something in this file, a page the user never asked to trust could submit
// POST /api/run (which spends the user's money and starts a pipeline visible
// to their whole organization), PUT /api/config (which writes to their
// checkout), or POST /api/ai/chat (which spends money with a third-party
// provider) -- all with the user's own credentials, since this process holds
// them, not the browser. That is a cross-site request forgery against a
// local server, and it needs the same two-part answer CSRF always does:
//
//  1. Reject the request outright when it *names* somewhere else -- the
//     Origin/Referer check in sameOrigin.
//  2. Require a secret the requesting page cannot have unless it *is* the
//     page this host served -- the per-launch token in csrfMiddleware.
//
// Both apply only to methods that are not GET or HEAD (isUnsafeMethod):
// those are the only ones that change anything here (see buildMux's own
// routing table), and restricting the checks to them is what keeps every
// read-only GET -- including the one, GET /api/meta, that hands the token to
// the page in the first place -- working with no dance at all.

// csrfTokenHeader is the header the served page must send its per-launch
// token on for every state-changing request. A header, not a body field or
// a query parameter: a cross-site <form> submission (the attack this file
// exists to stop) cannot set arbitrary headers at all, so putting the secret
// there is what makes it unreachable from a forged request even before the
// token comparison runs.
const csrfTokenHeader = "X-CircleCI-Editor-CSRF-Token" //nolint:gosec // header name, not a credential.

// generateCSRFToken returns a fresh, unguessable per-launch token: 32 bytes
// of crypto/rand, never math/rand -- the same reasoning and the same shape
// as mcpauth.NewState, whose own doc comment explains why a predictable
// value here would defeat the entire point.
func generateCSRFToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("host: generate csrf token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// isUnsafeMethod reports whether method can change state and must therefore
// pass both CSRF checks. GET and HEAD are the only methods this whole host
// ever treats as read-only (see every handleXxx's own method switch), so
// they are the only ones exempt.
func isUnsafeMethod(method string) bool {
	return method != http.MethodGet && method != http.MethodHead
}

// csrfMiddleware wraps next so that every request whose method is not GET or
// HEAD must both name this server's own loopback origin (or name nothing at
// all -- see sameOrigin's doc comment) and carry the current per-launch
// token. Applied once, around the server's whole handler tree in buildMux,
// so a future state-changing route is protected by construction: there is no
// second place a handler could forget to call into, and no way to register a
// new mutating endpoint that skips it.
func (s *Server) csrfMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isUnsafeMethod(r.Method) {
			next.ServeHTTP(w, r)
			return
		}

		if !s.sameOrigin(r) {
			writeError(w, http.StatusForbidden, "cross-origin request rejected")
			return
		}

		if !s.validCSRFToken(r.Header.Get(csrfTokenHeader)) {
			writeError(w, http.StatusForbidden, "missing or invalid CSRF token")
			return
		}

		next.ServeHTTP(w, r)
	})
}

// sameOrigin reports whether r is either silent about where it came from, or
// says it came from this server's own loopback origin.
//
// ## Why a missing Origin and Referer is let through here
//
// Modern browsers attach an `Origin` header to every fetch/XHR/form request
// whose method is not GET or HEAD -- same-origin requests included, not just
// cross-origin ones -- specifically so a server can make exactly this check
// (Fetch Standard §4.2's "append a request `Origin` header" step; this is
// also why frameworks like Django and Rails now check Origin as their
// primary CSRF defence rather than a fallback). A forged cross-site request
// therefore always carries an `Origin` naming the *attacker's* page, and
// there is no way for that page to suppress or spoof it into naming this
// server instead -- so a *present* Origin (or, absent that, Referer) that
// does not match is rejected outright, below.
//
// A request carrying *neither* header is a different case, and rejecting it
// here would not close any hole: curl, a local script, or any other
// non-browser client talking to this API directly sends neither, and there
// is no reliable way to tell that ordinary case apart from a browser that
// omitted both for some reason this app has never observed. Nothing is
// gained by guessing, because the token check in csrfMiddleware runs
// regardless of what this function decides about a missing header -- and a
// page that cannot read that per-launch, crypto/rand-generated token cannot
// pass that check no matter what it does or does not send here. This
// function's job is only to catch the *lying* case, where a header
// affirmatively names somewhere else; "says nothing" is left for the token
// to decide.
func (s *Server) sameOrigin(r *http.Request) bool {
	if origin := r.Header.Get("Origin"); origin != "" {
		return s.isOwnOrigin(origin)
	}
	if referer := r.Header.Get("Referer"); referer != "" {
		parsed, err := url.Parse(referer)
		if err != nil {
			return false
		}
		return s.isOwnOrigin(parsed.Scheme + "://" + parsed.Host)
	}
	return true
}

// isOwnOrigin reports whether raw parses as exactly this server's own
// http://127.0.0.1:<port> origin -- never https, since Run never serves it.
func (s *Server) isOwnOrigin(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return parsed.Scheme == "http" && parsed.Host == s.Addr()
}

// validCSRFToken reports whether token is exactly this launch's CSRF token.
// Compared in constant time, the same technique (and the same reason) as
// the OAuth `state` comparison in internal/ai/mcpauth/loopback.go: an
// unequal length is treated as a mismatch rather than something
// ConstantTimeCompare is asked to reason about, and no early-return on the
// bytes themselves ever happens.
func (s *Server) validCSRFToken(token string) bool {
	if token == "" || len(token) != len(s.csrfToken) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(s.csrfToken)) == 1
}

// CSRFToken returns this launch's per-launch CSRF token -- the same value
// GET /api/meta hands the served page as metaResponse.CSRFToken. Exported
// for tests in host_test, which (unlike the served page) has no GET
// /api/meta round trip to read it from before making a request of their own.
func (s *Server) CSRFToken() string {
	return s.csrfToken
}

// CSRFTokenHeader is the header name a caller must send s.CSRFToken() on for
// every state-changing request. Exported for the same reason CSRFToken is.
const CSRFTokenHeader = csrfTokenHeader

// errTrailingJSONData is returned by decodeJSONBody when a request body
// parses as one valid JSON value followed by more data.
var errTrailingJSONData = errors.New("host: request body has data after the JSON value")

// decodeJSONBody decodes exactly one JSON value from r.Body into v, and
// rejects a body that contains anything else afterward (aside from
// trailing whitespace, which json.Decoder already treats as the end of the
// stream).
//
// That second part is not a hypothetical hardening. A plain <form
// enctype="text/plain"> submission is a *simple* cross-origin request -- no
// CORS preflight at all -- and a form author fully controls every byte of
// its body. json.Decoder.Decode alone happily parses the first valid JSON
// value in a stream and silently ignores whatever comes after, which is
// exactly the gap an attacker needs: craft the form's fields so the body
// starts with a JSON value this handler will accept, and anything the form's
// own "name=value\r\n" serialization tacks on afterward is simply dropped
// rather than causing a parse error that would give the game away. Calling
// dec.More() after Decode closes that gap by requiring the stream to be
// exhausted, so a body shaped that way is rejected as malformed instead of
// silently accepted.
func decodeJSONBody(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errTrailingJSONData
	}
	return nil
}
