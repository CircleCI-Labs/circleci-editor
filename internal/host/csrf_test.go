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

// This file covers the confirmed CSRF exposure on the local HTTP API: with
// nothing checking Origin/Referer or requiring a secret only the served page
// knows, any tab the user has open could fire a state-changing request at
// this server and have it honoured with the user's own credentials. See
// internal/host/csrf.go's package doc comment for the full threat model.
//
// PUT /api/config stands in for "a state-changing endpoint" throughout: it
// needs no CIRCLE_TOKEN and no fake upstream client, so a test here is about
// the CSRF gate itself rather than anything downstream of it. run_test.go
// separately exercises the same gate in front of POST /api/run, the
// highest-stakes case, through the ordinary run-availability plumbing.
//
// Every test drives a real Server through Run on a real loopback listener
// (the same pattern clients_test.go uses), rather than wrapping Handler() in
// its own httptest.Server. That distinction matters here specifically:
// sameOrigin (csrf.go) checks a request's Origin against this server's own
// s.Addr(), i.e. the exact port Run bound -- and only Run guarantees those
// are the same port. An httptest.Server wrapping Handler() binds an
// unrelated port of its own, which would make even a genuinely same-origin
// request in a test look cross-origin purely as a test-harness artifact.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

// csrfTestServer is a Server actually running (via Run, on its own real
// loopback listener), plus the config path it will write to -- kept
// together because most tests below need the underlying *host.Server (to
// read the one launch's CSRFToken()) as well as an address to talk HTTP to.
type csrfTestServer struct {
	srv        *host.Server
	baseURL    string
	configPath string
}

func newCSRFTestServer(t *testing.T) csrfTestServer {
	t.Helper()
	clearCircleEnv(t)

	dir := t.TempDir()
	srv, err := host.New(host.Options{WorkDir: dir, Version: "test-version"})
	assert.NilError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = srv.Run(ctx) }()
	waitForServer(t, srv.URL())

	return csrfTestServer{
		srv:        srv,
		baseURL:    srv.URL(),
		configPath: filepath.Join(dir, ".circleci", "config.yml"),
	}
}

// putConfig sends a raw PUT /api/config, letting the caller set exactly the
// headers a real forged (or real legitimate) request would carry -- nothing
// here defaults an Origin, a Referer or a token behind the caller's back.
// Returns the status and body, closing the response itself (the same shape
// api_test.go's doRequest uses), so nothing above this call ever has to
// remember to close a *http.Response of its own.
func (c csrfTestServer) putConfig(t *testing.T, body string, setHeaders func(*http.Request)) (int, string) {
	t.Helper()

	req, err := http.NewRequest(http.MethodPut, c.baseURL+"/api/config", strings.NewReader(body)) //nolint:noctx // test, short-lived local request.
	assert.NilError(t, err)
	req.Header.Set("Content-Type", "application/json")
	if setHeaders != nil {
		setHeaders(req)
	}

	resp, err := http.DefaultClient.Do(req)
	assert.NilError(t, err)
	defer func() { assert.NilError(t, resp.Body.Close()) }()

	got, err := io.ReadAll(resp.Body)
	assert.NilError(t, err)

	return resp.StatusCode, string(got)
}

// assertConfigFileAbsent fails the test if anything was ever written to the
// config path -- the property every rejected request in this file must have.
func assertConfigFileAbsent(t *testing.T, path string) {
	t.Helper()
	_, err := os.Stat(path)
	assert.Assert(t, os.IsNotExist(err), "a rejected request must never reach the filesystem, but %s exists", path)
}

// TestCSRF_ForgedCrossOriginRequestIsRejected is the exploit itself: a page
// at another origin -- exactly what a forged <form> or fetch from some other
// tab the user has open would send -- names itself in Origin. The request
// also carries this launch's *correct* token, which a real attacker's page
// could never have (it cannot read GET /api/meta's response cross-origin --
// see metaResponse.CSRFToken's own doc comment), but is included here anyway
// to isolate what is under test: the Origin check alone must reject this,
// never leaving the token as the only line of defence.
func TestCSRF_ForgedCrossOriginRequestIsRejected(t *testing.T) {
	c := newCSRFTestServer(t)

	status, _ := c.putConfig(t, `{"contents":"version: 2.1\n"}`, func(r *http.Request) {
		r.Header.Set("Origin", "https://attacker.example")
		r.Header.Set(host.CSRFTokenHeader, c.srv.CSRFToken())
	})

	assert.Equal(t, status, http.StatusForbidden)
	assertConfigFileAbsent(t, c.configPath)
}

// TestCSRF_ForgedRefererIsRejected covers the Referer half of the same
// check, for a request that (unusually) carries a Referer but no Origin --
// some non-fetch/XHR request paths can look like this.
func TestCSRF_ForgedRefererIsRejected(t *testing.T) {
	c := newCSRFTestServer(t)

	status, _ := c.putConfig(t, `{"contents":"version: 2.1\n"}`, func(r *http.Request) {
		r.Header.Set("Referer", "https://attacker.example/evil-page.html")
		r.Header.Set(host.CSRFTokenHeader, c.srv.CSRFToken())
	})

	assert.Equal(t, status, http.StatusForbidden)
	assertConfigFileAbsent(t, c.configPath)
}

// TestCSRF_SameOriginRequestFromTheServedPageSucceeds is the legitimate case
// this app relies on every time it saves: a same-origin fetch from the page
// this host itself served, carrying an Origin naming this server (which
// modern browsers attach to every same-origin fetch/XHR whose method is not
// GET/HEAD -- see csrf.go's sameOrigin) and the token that same page read
// from GET /api/meta.
func TestCSRF_SameOriginRequestFromTheServedPageSucceeds(t *testing.T) {
	c := newCSRFTestServer(t)

	status, _ := c.putConfig(t, `{"contents":"version: 2.1\n"}`, func(r *http.Request) {
		r.Header.Set("Origin", c.baseURL)
		r.Header.Set(host.CSRFTokenHeader, c.srv.CSRFToken())
	})

	assert.Equal(t, status, http.StatusOK)

	written, err := os.ReadFile(c.configPath) //nolint:gosec // test-controlled path.
	assert.NilError(t, err)
	assert.Equal(t, string(written), "version: 2.1\n")
}

// TestCSRF_MissingOriginAndRefererStillRequiresTheToken locks in the
// deliberate decision documented on sameOrigin: a request naming nowhere at
// all is not rejected for that alone (there is no reliable way to tell a
// legitimate non-browser caller apart from a browser that omitted both), but
// it still is not exempt from anything -- it must carry the correct
// per-launch token like every other state-changing request, and one with no
// token at all is refused exactly as a browser-based forgery would be.
func TestCSRF_MissingOriginAndRefererStillRequiresTheToken(t *testing.T) {
	c := newCSRFTestServer(t)

	rejectedStatus, _ := c.putConfig(t, `{"contents":"version: 2.1\n"}`, nil)
	assert.Equal(t, rejectedStatus, http.StatusForbidden)
	assertConfigFileAbsent(t, c.configPath)

	acceptedStatus, _ := c.putConfig(t, `{"contents":"version: 2.1\n"}`, func(r *http.Request) {
		r.Header.Set(host.CSRFTokenHeader, c.srv.CSRFToken())
	})
	assert.Equal(t, acceptedStatus, http.StatusOK)
}

// TestCSRF_MissingOrIncorrectTokenIsRejected covers the token half of the
// gate on its own, holding Origin fixed at this server's own (same-origin,
// so this is never about the Origin check) to isolate it.
func TestCSRF_MissingOrIncorrectTokenIsRejected(t *testing.T) {
	tests := []struct {
		name  string
		token string
		set   bool
	}{
		{name: "no token header at all", set: false},
		{name: "empty token", token: "", set: true},
		{name: "wrong token", token: "not-the-real-token-0123456789012345678901234", set: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := newCSRFTestServer(t)

			status, _ := c.putConfig(t, `{"contents":"version: 2.1\n"}`, func(r *http.Request) {
				r.Header.Set("Origin", c.baseURL)
				if tc.set {
					r.Header.Set(host.CSRFTokenHeader, tc.token)
				}
			})

			assert.Equal(t, status, http.StatusForbidden)
			assertConfigFileAbsent(t, c.configPath)
		})
	}
}

// TestCSRF_TokenFromAnotherLaunchIsRejected is what actually makes the token
// a per-launch secret rather than a fixed constant: a value that was valid
// for a previous run of this same binary must not still work.
func TestCSRF_TokenFromAnotherLaunchIsRejected(t *testing.T) {
	other := newCSRFTestServer(t)
	c := newCSRFTestServer(t)

	status, _ := c.putConfig(t, `{"contents":"version: 2.1\n"}`, func(r *http.Request) {
		r.Header.Set("Origin", c.baseURL)
		r.Header.Set(host.CSRFTokenHeader, other.srv.CSRFToken())
	})

	assert.Equal(t, status, http.StatusForbidden)
	assertConfigFileAbsent(t, c.configPath)
}

// TestCSRF_TrailingGarbageAfterValidJSONIsRejected is the enctype="text/plain"
// form-CSRF trick named in csrf.go's decodeJSONBody doc comment: a body that
// starts with a value this endpoint would otherwise accept, followed by more
// bytes a plain json.Decoder.Decode would silently ignore. Same-origin and
// carrying the correct token, so this is purely about the body check.
func TestCSRF_TrailingGarbageAfterValidJSONIsRejected(t *testing.T) {
	c := newCSRFTestServer(t)

	status, _ := c.putConfig(t, `{"contents":"version: 2.1\n"}and-then-some-trailing-form-field=x`, func(r *http.Request) {
		r.Header.Set("Origin", c.baseURL)
		r.Header.Set(host.CSRFTokenHeader, c.srv.CSRFToken())
	})

	assert.Equal(t, status, http.StatusBadRequest)
	assertConfigFileAbsent(t, c.configPath)
}

// TestCSRF_TrailingWhitespaceAfterValidJSONIsStillAccepted guards the other
// side of that same check: trailing whitespace is not "trailing data", and a
// request must not start failing merely because a client (or an intervening
// proxy) appended a trailing newline the way many JSON emitters do.
func TestCSRF_TrailingWhitespaceAfterValidJSONIsStillAccepted(t *testing.T) {
	c := newCSRFTestServer(t)

	status, _ := c.putConfig(t, "{\"contents\":\"version: 2.1\\n\"}\n", func(r *http.Request) {
		r.Header.Set("Origin", c.baseURL)
		r.Header.Set(host.CSRFTokenHeader, c.srv.CSRFToken())
	})

	assert.Equal(t, status, http.StatusOK)
}

// TestCSRF_TokenDiffersBetweenLaunches is generateCSRFToken's own contract:
// a value predictable across runs (a build-time constant, a value seeded
// from something an attacker could also observe) would defeat the whole
// mechanism, which is why it is minted from crypto/rand, never math/rand,
// inside New. Ten launches, not two, so this cannot pass by the coincidence
// a two-sample comparison could not rule out.
func TestCSRF_TokenDiffersBetweenLaunches(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 10; i++ {
		srv, err := host.New(host.Options{WorkDir: t.TempDir(), Version: "test-version"})
		assert.NilError(t, err)

		token := srv.CSRFToken()
		assert.Assert(t, token != "", "launch %d minted an empty token", i)
		assert.Assert(t, !seen[token], "launch %d reused a token an earlier launch already used", i)
		seen[token] = true
	}
}

// TestCSRF_MetaServesTheLaunchToken pins the delivery mechanism: the served
// page has no way to learn the token except by reading it from GET
// /api/meta (see metaResponse.CSRFToken), so that field must actually carry
// this launch's real value, not an empty string or a placeholder.
func TestCSRF_MetaServesTheLaunchToken(t *testing.T) {
	c := newCSRFTestServer(t)

	resp, err := http.Get(c.baseURL + "/api/meta") //nolint:noctx,gosec // test, short-lived local request.
	assert.NilError(t, err)
	defer func() { assert.NilError(t, resp.Body.Close()) }()
	assert.Equal(t, resp.StatusCode, http.StatusOK)

	body, err := io.ReadAll(resp.Body)
	assert.NilError(t, err)

	var meta struct {
		CSRFToken string `json:"csrfToken"`
	}
	assert.NilError(t, json.Unmarshal(body, &meta))
	assert.Equal(t, meta.CSRFToken, c.srv.CSRFToken())
}

// TestCSRF_SafeMethodsBypassBothChecks confirms GET (and by the same
// isUnsafeMethod logic, HEAD) is exempt from both checks -- deliberately, so
// that GET /api/meta itself remains reachable without already holding the
// token it exists to hand out, and so a forged cross-origin GET (which
// cannot be prevented by this mechanism at all, and carries no side effect
// here to protect against) is not confused with the state-changing requests
// this file is about.
func TestCSRF_SafeMethodsBypassBothChecks(t *testing.T) {
	c := newCSRFTestServer(t)

	req, err := http.NewRequest(http.MethodGet, c.baseURL+"/api/config", nil) //nolint:noctx // test, short-lived local request.
	assert.NilError(t, err)
	req.Header.Set("Origin", "https://attacker.example")

	resp, err := http.DefaultClient.Do(req)
	assert.NilError(t, err)
	defer func() { assert.NilError(t, resp.Body.Close()) }()

	assert.Equal(t, resp.StatusCode, http.StatusOK)
}
