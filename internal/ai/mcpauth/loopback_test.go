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
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai/mcpauth"
)

// The loopback callback is reachable by every process on the machine and by
// any web page the user has open, so these tests are written as an attacker
// would poke at it, not just as a happy path.

func TestLoopback_RedirectURI_BindsALoopbackLiteralOnAnEphemeralPort(t *testing.T) {
	lb, err := mcpauth.Listen()
	assert.NilError(t, err)
	t.Cleanup(func() { _ = lb.Close() })

	assert.Assert(t, lb.Port() != 0, "expected an ephemeral port")
	// 127.0.0.1 rather than "localhost": a literal cannot be redefined by a
	// resolver (RFC 8252 §8.3).
	assert.Assert(t, strings.HasPrefix(lb.RedirectURI(), fmt.Sprintf("http://127.0.0.1:%d/", lb.Port())),
		"unexpected redirect uri %q", lb.RedirectURI())
}

func TestLoopback_Wait_DeliversTheCodeOnAStateMatchingCallback(t *testing.T) {
	lb, err := mcpauth.Listen()
	assert.NilError(t, err)
	t.Cleanup(func() { _ = lb.Close() })

	const state = "the-expected-state-value"
	done := make(chan struct{})
	var code string
	var waitErr error
	go func() {
		defer close(done)
		got, err := lb.Wait(context.Background(), state, 10*time.Second)
		waitErr = err
		if err == nil {
			code = got.Reveal()
		}
	}()

	// Wait records the expected state before blocking; give it a moment so
	// this test exercises the ordinary ordering rather than the
	// callback-before-Wait race (covered separately below).
	waitForListener(t, lb, state)

	body := getCallback(t, lb, "?code="+sentinelCode+"&state="+state)
	<-done

	assert.NilError(t, waitErr)
	assert.Equal(t, code, sentinelCode)

	// The page the browser lands on must not repeat the code: that page's own
	// URL already carries it into browser history, and echoing it into the
	// body would put it on screen and into any Referer that follows.
	assert.Assert(t, !strings.Contains(body, sentinelCode), "callback page echoed the code: %s", body)
	assert.Assert(t, !strings.Contains(body, state), "callback page echoed the state: %s", body)
}

// The important one. A wrong-state request -- a stray page, a local prober --
// must not be able to end the user's sign-in. "First request wins" would let
// any local process cancel it at will.
func TestLoopback_Wait_WrongStateIsIgnoredAndDoesNotAbortTheFlow(t *testing.T) {
	lb, err := mcpauth.Listen()
	assert.NilError(t, err)
	t.Cleanup(func() { _ = lb.Close() })

	const state = "the-expected-state-value"
	done := make(chan struct{})
	var code string
	var waitErr error
	go func() {
		defer close(done)
		got, err := lb.Wait(context.Background(), state, 10*time.Second)
		waitErr = err
		if err == nil {
			code = got.Reveal()
		}
	}()
	waitForListener(t, lb, state)

	// Several hostile shapes, none of which may be accepted or fatal.
	for _, query := range []string{
		"?code=attacker-code&state=wrong-state",
		"?code=attacker-code",
		"?code=attacker-code&state=",
		// Same length as the real state, so this specifically exercises the
		// constant-time comparison rather than the length short-circuit.
		"?code=attacker-code&state=" + strings.Repeat("x", len(state)),
		"?error=access_denied&state=wrong-state",
	} {
		status, _ := getCallbackStatus(t, lb, query)
		assert.Equal(t, status, http.StatusNotFound, "query %q should have been ignored", query)
	}

	// The real callback still works afterwards.
	getCallback(t, lb, "?code="+sentinelCode+"&state="+state)
	<-done
	assert.NilError(t, waitErr)
	assert.Equal(t, code, sentinelCode)
}

func TestLoopback_Fn_AnswersOnlyTheCallbackPathAndOnlyGET(t *testing.T) {
	lb, err := mcpauth.Listen()
	assert.NilError(t, err)
	t.Cleanup(func() { _ = lb.Close() })

	base := fmt.Sprintf("http://127.0.0.1:%d", lb.Port())
	for _, path := range []string{"/", "/oauth", "/oauth/mcp", "/anything-else", "/oauth/mcp/callback/extra"} {
		resp, err := http.Get(base + path) //nolint:noctx // short-lived loopback request in a test
		assert.NilError(t, err)
		_ = resp.Body.Close()
		assert.Equal(t, resp.StatusCode, http.StatusNotFound, "path %q should not be served", path)
	}

	// POST to the callback path is rejected too: the redirect is a GET.
	resp, err := http.Post(lb.RedirectURI(), "application/json", strings.NewReader("{}")) //nolint:noctx // as above
	assert.NilError(t, err)
	_ = resp.Body.Close()
	assert.Equal(t, resp.StatusCode, http.StatusMethodNotAllowed)
}

func TestLoopback_Wait_ReportsAnAuthorizationServerError(t *testing.T) {
	lb, err := mcpauth.Listen()
	assert.NilError(t, err)
	t.Cleanup(func() { _ = lb.Close() })

	const state = "the-expected-state-value"
	done := make(chan struct{})
	var waitErr error
	go func() {
		defer close(done)
		_, waitErr = lb.Wait(context.Background(), state, 10*time.Second)
	}()
	waitForListener(t, lb, state)

	getCallback(t, lb, "?error=access_denied&state="+state)
	<-done
	assert.ErrorIs(t, waitErr, mcpauth.ErrAuthorizationDenied)
	assert.Assert(t, strings.Contains(waitErr.Error(), "access_denied"))
}

func TestLoopback_Wait_TimesOutWithoutACallback(t *testing.T) {
	lb, err := mcpauth.Listen()
	assert.NilError(t, err)
	t.Cleanup(func() { _ = lb.Close() })

	_, err = lb.Wait(context.Background(), "unused-state", 50*time.Millisecond)
	assert.ErrorIs(t, err, mcpauth.ErrCallbackTimeout)
}

func TestLoopback_Wait_HonoursACancelledContext(t *testing.T) {
	lb, err := mcpauth.Listen()
	assert.NilError(t, err)
	t.Cleanup(func() { _ = lb.Close() })

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = lb.Wait(ctx, "unused-state", time.Minute)
	assert.ErrorIs(t, err, context.Canceled)
}

// Before Wait runs, no state has been committed to, so nothing can be a
// legitimate callback -- including a request that guessed the state the
// caller is *about* to use.
func TestLoopback_Fn_RejectsACallbackArrivingBeforeWait(t *testing.T) {
	lb, err := mcpauth.Listen()
	assert.NilError(t, err)
	t.Cleanup(func() { _ = lb.Close() })

	status, _ := getCallbackStatus(t, lb, "?code=early&state=some-state")
	assert.Equal(t, status, http.StatusNotFound)
}

func TestLoopback_Close_IsIdempotent(t *testing.T) {
	lb, err := mcpauth.Listen()
	assert.NilError(t, err)
	assert.NilError(t, lb.Close())
	assert.NilError(t, lb.Close())
}

// waitForListener blocks until Wait has recorded expectedState, detected by
// the callback path answering something other than 404 for a correct-state
// probe... which would consume the flow. So instead it simply polls that the
// listener is accepting connections and yields, which is sufficient: Wait
// records the state as its very first action.
func waitForListener(t *testing.T, lb *mcpauth.Loopback, _ string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		status, _ := getCallbackStatus(t, lb, "?probe=1")
		if status == http.StatusNotFound {
			// Listener is up. Yield once more so Wait's first statement has
			// certainly run on its goroutine.
			time.Sleep(10 * time.Millisecond)
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("loopback listener never came up")
}

func getCallback(t *testing.T, lb *mcpauth.Loopback, query string) string {
	t.Helper()
	_, body := getCallbackStatus(t, lb, query)
	return body
}

func getCallbackStatus(t *testing.T, lb *mcpauth.Loopback, query string) (int, string) {
	t.Helper()
	resp, err := http.Get(lb.RedirectURI() + query) //nolint:noctx // short-lived loopback request in a test
	assert.NilError(t, err)
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	assert.NilError(t, err)
	return resp.StatusCode, string(body)
}
