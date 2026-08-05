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
	"crypto/subtle"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai/secret"
)

// callbackPath is the only path the loopback listener answers. Everything
// else gets a 404 with no body, so the ephemeral port does not become a
// general-purpose local HTTP server for the couple of minutes it is open.
const callbackPath = "/oauth/mcp/callback"

// ErrCallbackTimeout is returned by Loopback.Wait when no valid callback
// arrived before the deadline -- the ordinary outcome of a user closing the
// sign-in tab, and therefore something the UI reports plainly rather than
// as an internal failure.
var ErrCallbackTimeout = errors.New("mcpauth: timed out waiting for the sign-in callback")

// ErrAuthorizationDenied is returned when the authorization server
// redirected back with an `error` parameter -- the user declined, or the
// server refused.
var ErrAuthorizationDenied = errors.New("mcpauth: sign-in was declined or failed at the authorization server")

// Loopback is a single-use HTTP listener on a loopback address that receives
// one OAuth authorization-code redirect.
//
// # Why this is written defensively
//
// A callback listener on a loopback port is reachable by every process on
// the machine, and -- because browsers happily issue cross-origin GETs -- by
// any web page the user has open. So it is treated as hostile input:
//
//   - It binds 127.0.0.1 explicitly, never 0.0.0.0, so nothing off-box can
//     reach it even briefly.
//   - The port is ephemeral (:0) and the listener lives only for the length
//     of one sign-in, so there is no stable port to target.
//   - It answers exactly one path and only GET.
//   - `state` is compared with crypto/subtle.ConstantTimeCompare against a
//     32-byte crypto/rand value, and a mismatch is discarded *silently* --
//     no error surfaced to the waiter, no log line, listener stays open for
//     the real callback. A wrong-state request is either a stray page or a
//     probe; either way it must not be able to abort the user's sign-in,
//     which a "first request wins" design would let it do.
//   - Only the first *state-valid* request is accepted (sync.Once); after
//     that the channel is closed and later requests get the same neutral
//     page.
//   - The code is captured as a secret.String and never written to the HTTP
//     response, so it does not end up in the browser's history, in a
//     Referer header, or on screen.
//
// Even so, the real defence against a forged callback is PKCE, not the port
// binding: an attacker who somehow guesses `state` still has to supply an
// authorization code that was issued against *our* code challenge, and
// cannot obtain one. `state` protects the flow's integrity; PKCE protects
// the token.
type Loopback struct {
	listener net.Listener
	server   *http.Server
	// results carries at most one callback. Buffered so the HTTP handler
	// never blocks on a waiter that has already given up.
	results chan callbackResult
	once    sync.Once
	closeMu sync.Mutex
	closed  bool

	// expectedState is the `state` value the pending flow committed to,
	// written by Wait and read by the HTTP handler on another goroutine --
	// hence the mutex. It lives on the struct rather than being closed over
	// at Listen time because the listener has to be up (so its port is
	// known) before the authorize URL, and therefore the state value, can be
	// built. Empty means "no flow has committed to a state yet", which
	// handleCallback treats as "reject everything".
	stateMu       sync.RWMutex
	expectedState string
}

type callbackResult struct {
	code secret.String
	err  error
}

// Listen binds an ephemeral port on 127.0.0.1 and starts serving the
// callback path. The caller must Close the returned Loopback.
//
// The listener is started *before* the client is registered, on purpose:
// dynamic client registration has to name the exact redirect URI including
// the port, so the port must already be known. That ordering is why
// RedirectURI exists as a method rather than a parameter.
func Listen() (*Loopback, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("mcpauth: bind loopback listener: %w", err)
	}

	lb := &Loopback{
		listener: listener,
		results:  make(chan callbackResult, 1),
	}
	mux := http.NewServeMux()
	mux.HandleFunc(callbackPath, lb.handleCallback)
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	lb.server = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() { _ = lb.server.Serve(listener) }()
	return lb, nil
}

// RedirectURI is the exact loopback URL to register and to send as
// redirect_uri. Uses the 127.0.0.1 literal rather than "localhost" -- see
// validateLoopbackRedirect for why the distinction is deliberate.
func (l *Loopback) RedirectURI() string {
	return fmt.Sprintf("http://127.0.0.1:%d%s", l.Port(), callbackPath)
}

// Port is the ephemeral port the listener bound.
func (l *Loopback) Port() int {
	if addr, ok := l.listener.Addr().(*net.TCPAddr); ok {
		return addr.Port
	}
	return 0
}

// handleCallback receives the browser redirect.
func (l *Loopback) handleCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	query := r.URL.Query()
	gotState := query.Get("state")
	want := l.state()

	// Constant-time compare, and an unequal length is a mismatch rather
	// than something ConstantTimeCompare is asked to reason about.
	if want == "" || len(gotState) != len(want) ||
		subtle.ConstantTimeCompare([]byte(gotState), []byte(want)) != 1 {
		// Silently ignored -- see the type's doc comment on why a bad-state
		// request must not be able to end the user's sign-in. A neutral 404
		// also avoids confirming to a prober that a flow is in progress.
		w.WriteHeader(http.StatusNotFound)
		return
	}

	if errCode := query.Get("error"); errCode != "" {
		l.deliver(callbackResult{err: fmt.Errorf("%w (%s)", ErrAuthorizationDenied, sanitizeErrorCode(errCode))})
		writeCallbackPage(w, "Sign-in did not complete. You can close this tab and try again in the editor.")
		return
	}

	code := query.Get("code")
	if code == "" {
		l.deliver(callbackResult{err: errors.New("mcpauth: callback carried neither code nor error")})
		writeCallbackPage(w, "Sign-in did not complete. You can close this tab and try again in the editor.")
		return
	}

	l.deliver(callbackResult{code: secret.New(code)})
	writeCallbackPage(w, "Signed in. You can close this tab and return to the editor.")
}

// deliver posts the first result and ignores every later one.
func (l *Loopback) deliver(res callbackResult) {
	l.once.Do(func() {
		l.results <- res
		close(l.results)
	})
}

// Wait blocks until a state-valid callback arrives, ctx is done, or timeout
// elapses, and returns the authorization code.
//
// expectedState must be the value that was put in the authorize URL. Wait
// records it before blocking; a callback arriving before Wait is called
// (possible in principle, since the listener is up first) is rejected as
// state-mismatched, which is the correct conservative answer: this process
// has not yet committed to a state, so no callback can be legitimate.
func (l *Loopback) Wait(ctx context.Context, expectedState string, timeout time.Duration) (secret.String, error) {
	l.setState(expectedState)

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case res, ok := <-l.results:
		if !ok {
			return secret.String{}, ErrCallbackTimeout
		}
		if res.err != nil {
			return secret.String{}, res.err
		}
		return res.code, nil
	case <-ctx.Done():
		return secret.String{}, ctx.Err()
	case <-timer.C:
		return secret.String{}, ErrCallbackTimeout
	}
}

// Close shuts the listener down. Safe to call more than once.
func (l *Loopback) Close() error {
	l.closeMu.Lock()
	already := l.closed
	l.closed = true
	l.closeMu.Unlock()
	if already {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return l.server.Shutdown(ctx)
}

// state / setState guard the expected state value, which is written by Wait
// and read by the HTTP handler on another goroutine.
func (l *Loopback) state() string {
	l.stateMu.RLock()
	defer l.stateMu.RUnlock()
	return l.expectedState
}

func (l *Loopback) setState(s string) {
	l.stateMu.Lock()
	l.expectedState = s
	l.stateMu.Unlock()
}

// writeCallbackPage renders the one page the browser ever sees. It contains
// no code, no state, and no token -- nothing that should not end up in the
// browser's history, in a screenshot, or in a Referer header on whatever the
// user clicks next.
func writeCallbackPage(w http.ResponseWriter, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// Referrer-Policy on the page the redirect lands on: the URL of *this*
	// page still has the code in its query string, and a no-referrer policy
	// is what stops it being sent onward if the page ever links anywhere.
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, callbackPageTemplate, message)
}

const callbackPageTemplate = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>CircleCI Config Editor</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#161616}
main{max-width:32rem;padding:2rem;text-align:center}
@media (prefers-color-scheme:dark){body{background:#161616;color:#f6f7f9}}
</style></head>
<body><main><p>%s</p></main></body></html>
`
