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

// Issue #177's host half: closing the editor window should stop the process.
//
// Every test here drives a real Server through Run on a real loopback
// listener and attaches real /api/heartbeat streams over HTTP, because the
// thing being tested is a property of TCP connections rather than of any
// Go-level bookkeeping -- and because that makes "a reload" expressible
// exactly as the browser performs it: one stream closes, another opens
// shortly afterwards. Nothing here sends a signal or spawns a process, so it
// behaves the same on Linux, macOS and Windows; the timings are scaled off
// testGrace rather than hardcoded, with margins wide enough for a Windows
// timer's ~16ms granularity.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/ai"
	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

const (
	// testGrace stands in for the real per-mode grace periods (6s and 20s --
	// see internal/host/clients.go), which no test should spend real time
	// waiting out. Long enough that a scheduling hiccup on a loaded CI box
	// cannot make a client's departure look like it happened a grace period
	// ago.
	testGrace = 400 * time.Millisecond

	// settleWait is how long a "must not exit" assertion waits before
	// concluding the host is staying up: comfortably more than testGrace, so
	// a host that was going to exit has had every chance to.
	settleWait = 3 * testGrace

	// exitWait bounds how long an expected exit may take. The graceful
	// shutdown inside it is bounded by shutdownTimeout (5s), which it should
	// never come near with no connections left to drain.
	exitWait = testGrace + 10*time.Second
)

// testHost is a Server running under Run, with the plumbing to ask whether
// Run has returned yet and why.
type testHost struct {
	t      *testing.T
	srv    *host.Server
	cancel context.CancelFunc
	errCh  chan error

	mu       sync.Mutex
	consumed bool
	err      error
}

// runTestHost starts srv.Run in the background and waits for it to serve.
// OpenBrowser is forced off: no test may launch a browser on a developer's
// machine, and it is orthogonal to everything here -- the last-client policy
// lives in cmd/circleci-editor's stopOnLastClient (see
// TestStopOnLastClient), while Options.StopOnLastClient is what this package
// obeys.
func runTestHost(t *testing.T, opts host.Options) *testHost {
	t.Helper()
	clearCircleEnv(t)

	if opts.WorkDir == "" {
		opts.WorkDir = t.TempDir()
	}
	if opts.AIStore == nil {
		// Never the real keystore: these tests have no business opening the
		// developer's (or the CI box's) OS keychain.
		opts.AIStore = newFakeKeyStore()
	}
	if opts.AIProviders == nil {
		opts.AIProviders = ai.Registry{}
	}
	opts.OpenBrowser = false
	if opts.LastClientGrace == 0 {
		opts.LastClientGrace = testGrace
	}

	srv, err := host.New(opts)
	assert.NilError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	h := &testHost{t: t, srv: srv, cancel: cancel, errCh: make(chan error, 1)}
	go func() { h.errCh <- srv.Run(ctx) }()

	t.Cleanup(func() {
		cancel()
		h.awaitExit(5 * time.Second)
	})

	waitForServer(t, srv.URL())
	return h
}

// awaitExit waits up to timeout for Run to return, reporting whether it
// returned at all and, if so, its error. Safe to call more than once (the
// cleanup always calls it, whether or not the test already did).
func (h *testHost) awaitExit(timeout time.Duration) (exited bool, runErr error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.consumed {
		return true, h.err
	}
	select {
	case err := <-h.errCh:
		h.consumed = true
		h.err = err
		return true, err
	case <-time.After(timeout):
		return false, nil
	}
}

// assertStillServing fails unless Run is still running after wait -- and
// checks it by making a request, not merely by observing that Run has not
// returned, so "still up" means "still answering".
func (h *testHost) assertStillServing(wait time.Duration) {
	h.t.Helper()

	if exited, _ := h.awaitExit(wait); exited {
		h.t.Fatalf("host exited after %s but should still be serving", wait)
	}

	resp, err := http.Get(h.srv.URL() + "/api/healthz") //nolint:noctx // test, short-lived local request.
	if err != nil {
		// Reached when the host began shutting down (closing its listener)
		// inside the window above but had not returned from Run yet.
		h.t.Fatalf("host stopped listening within %s but should still be serving: %v", wait, err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	assert.NilError(h.t, resp.Body.Close())
	assert.Equal(h.t, resp.StatusCode, http.StatusOK)
}

// assertExitedForLastClient fails unless Run returned ErrLastClientLeft
// within exitWait.
func (h *testHost) assertExitedForLastClient() {
	h.t.Helper()

	exited, err := h.awaitExit(exitWait)
	if !exited {
		h.t.Fatalf("host did not stop within %s of its last client leaving", exitWait)
	}
	assert.Assert(h.t, errors.Is(err, host.ErrLastClientLeft),
		"want ErrLastClientLeft so the CLI can print its own explanation instead of an error, got %v", err)
}

// heartbeatClient is one attached browser client: an open GET /api/heartbeat
// stream, which is exactly what a loaded page holds.
type heartbeatClient struct {
	cancel context.CancelFunc
	body   io.ReadCloser
}

// openHeartbeat attaches a client and returns once the host has certainly
// registered it -- proven by reading the first "ping" event, which the
// handler writes only after counting the client, so no test has to sleep and
// hope.
func openHeartbeat(t *testing.T, baseURL string) *heartbeatClient {
	t.Helper()

	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/heartbeat", nil)
	if err != nil {
		cancel()
		t.Fatal(err)
	}

	// A dedicated client, not http.DefaultClient: closing this stream must
	// close its TCP connection (that is the signal being tested), and a
	// shared connection pool is the one thing that could get in the way.
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	resp, err := client.Do(req)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		cancel()
		t.Fatalf("heartbeat returned %d, want 200", resp.StatusCode)
	}

	buf := make([]byte, 64)
	deadline := time.Now().Add(5 * time.Second)
	var got strings.Builder
	for !strings.Contains(got.String(), "event: ping") {
		if time.Now().After(deadline) {
			_ = resp.Body.Close()
			cancel()
			t.Fatalf("no heartbeat event arrived; got %q", got.String())
		}
		n, readErr := resp.Body.Read(buf)
		got.Write(buf[:n])
		if readErr != nil {
			_ = resp.Body.Close()
			cancel()
			t.Fatalf("reading heartbeat stream: %v (got %q)", readErr, got.String())
		}
	}

	return &heartbeatClient{cancel: cancel, body: resp.Body}
}

// close detaches the client the way a closing or unloading tab does: the
// connection goes away without any parting message.
func (c *heartbeatClient) close() {
	c.cancel()
	_ = c.body.Close()
}

// TestServer_Run_StopsWhenTheLastClientLeaves is the issue's core ask: the
// window closed, so the process should stop instead of sitting in a terminal
// nobody is looking at.
func TestServer_Run_StopsWhenTheLastClientLeaves(t *testing.T) {
	h := runTestHost(t, host.Options{StopOnLastClient: true})

	client := openHeartbeat(t, h.srv.URL())
	client.close()

	h.assertExitedForLastClient()
}

// TestServer_Run_SurvivesAReload is the regression that matters most, because
// getting it wrong would be worse than the bug being fixed: a reload closes
// the page (and its heartbeat stream) and then opens it again, which from the
// host's side is indistinguishable from a close followed by a new window --
// except in timing. Measured on the real bundle, that gap is tens of
// milliseconds (see lastClientGrace's derivation); the reconnect below
// happens well inside the grace period, and the host must still be serving
// long after the point where it would have exited had it not been.
func TestServer_Run_SurvivesAReload(t *testing.T) {
	h := runTestHost(t, host.Options{StopOnLastClient: true})

	first := openHeartbeat(t, h.srv.URL())
	first.close()

	// The gap. A quarter of the grace period, standing in for a real
	// reload's tens of milliseconds against a 6s or 20s grace.
	time.Sleep(testGrace / 4)

	second := openHeartbeat(t, h.srv.URL())
	defer second.close()

	h.assertStillServing(settleWait)
}

// TestServer_Run_KeepsRunningWhileAnotherClientRemains covers two tabs, one
// closed: "no clients" is the condition, not "a client left".
func TestServer_Run_KeepsRunningWhileAnotherClientRemains(t *testing.T) {
	h := runTestHost(t, host.Options{StopOnLastClient: true})

	first := openHeartbeat(t, h.srv.URL())
	second := openHeartbeat(t, h.srv.URL())

	first.close()
	h.assertStillServing(settleWait)

	// ...and once the *last* one goes, it does stop -- the same test proving
	// the clause above isn't just a host that never exits.
	second.close()
	h.assertExitedForLastClient()
}

// TestServer_Run_DoesNotStopOnLastClientWhenDisabled is the host-level half
// of the --no-browser and --keep-alive guarantee: with the option off, a
// client attaching and leaving changes nothing. (The flag-level half is
// TestStopOnLastClient in cmd/circleci-editor.)
func TestServer_Run_DoesNotStopOnLastClientWhenDisabled(t *testing.T) {
	h := runTestHost(t, host.Options{StopOnLastClient: false})

	client := openHeartbeat(t, h.srv.URL())
	client.close()

	h.assertStillServing(settleWait)
}

// TestServer_Run_NeverStopsBeforeAnyClientConnects is --no-browser's real
// hazard, and the reason clientTracker arms itself only on the first
// connection: a host nobody has opened yet also has zero clients, and must
// not read that as the window having been closed. Enabled here on purpose --
// the guarantee has to hold even if a caller turns the option on in a mode
// where nothing ever connects.
func TestServer_Run_NeverStopsBeforeAnyClientConnects(t *testing.T) {
	h := runTestHost(t, host.Options{StopOnLastClient: true})

	h.assertStillServing(settleWait)
}

// TestServer_Run_SignalShutdownStillReturnsNil pins the constraint that
// issue #177 must not disturb: Ctrl-C/SIGTERM keeps returning nil, so
// cmd/circleci-editor keeps printing its own calm shutdown line (issue #67)
// and never mistakes a signal for a last-client exit -- even with the new
// option enabled and a client that has already come and gone.
func TestServer_Run_SignalShutdownStillReturnsNil(t *testing.T) {
	h := runTestHost(t, host.Options{StopOnLastClient: true})

	client := openHeartbeat(t, h.srv.URL())
	defer client.close()

	h.cancel()

	exited, err := h.awaitExit(exitWait)
	assert.Assert(t, exited, "Run did not return after its context was cancelled")
	assert.NilError(t, err)
}

// TestServer_Run_WaitsForAnInFlightConfigWrite covers "never exit mid-write":
// the page fires a save and is then closed, so the heartbeat goes while the
// PUT is still arriving. The host must finish the write, and the file must
// contain all of it.
func TestServer_Run_WaitsForAnInFlightConfigWrite(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, ".circleci", "config.yml")
	assert.NilError(t, os.MkdirAll(filepath.Dir(configPath), 0o750))
	assert.NilError(t, os.WriteFile(configPath, []byte("version: 2.1\n"), 0o600))

	h := runTestHost(t, host.Options{StopOnLastClient: true, WorkDir: dir})

	client := openHeartbeat(t, h.srv.URL())

	// A save whose body arrives in two parts, with the connection-closing
	// event in between. io.Pipe is the slow client: the handler blocks
	// decoding until the second half shows up.
	pr, pw := io.Pipe()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPut, h.srv.URL()+"/api/config", pr)
	assert.NilError(t, err)
	req.Header.Set(host.CSRFTokenHeader, h.srv.CSRFToken())

	type result struct {
		status int
		err    error
	}
	putDone := make(chan result, 1)
	go func() {
		resp, doErr := http.DefaultClient.Do(req)
		if doErr != nil {
			putDone <- result{err: doErr}
			return
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		putDone <- result{status: resp.StatusCode}
	}()

	_, err = pw.Write([]byte(`{"contents":"version: 2.1\njobs: {}`))
	assert.NilError(t, err)

	// Nothing exposes "the handler has started" to a test, so this waits
	// long enough on loopback for it to have done so. Note which way a
	// failure would fall: if the PUT had somehow *not* started, the host
	// would exit below and the test would fail loudly. It cannot pass for
	// the wrong reason.
	time.Sleep(testGrace / 2)

	// The window closes mid-save.
	client.close()

	// Well past the grace period, still up -- because a write is in flight.
	h.assertStillServing(settleWait)

	_, err = pw.Write([]byte(`\n"}`))
	assert.NilError(t, err)
	assert.NilError(t, pw.Close())

	select {
	case got := <-putDone:
		assert.NilError(t, got.err)
		assert.Equal(t, got.status, http.StatusOK)
	case <-time.After(10 * time.Second):
		t.Fatal("PUT /api/config never completed")
	}

	written, err := os.ReadFile(configPath) //nolint:gosec // test-controlled path.
	assert.NilError(t, err)
	assert.Equal(t, string(written), "version: 2.1\njobs: {}\n",
		"the write must have completed in full, not been cut short by the exit")

	// And now that it has, the exit it was holding off happens.
	h.assertExitedForLastClient()
}

// TestServer_Run_WaitsForAPendingOAuthSignIn is the #103/#134 interaction:
// the docs-MCP sign-in sends the user out to an identity provider, and no
// grace period can be both long enough for a human at a 2FA prompt and short
// enough to be a useful answer to #177 -- so a pending flow suspends the
// exit outright, for as long as the flow itself may live (5 minutes).
//
// Everything about the sign-in here is fake and local: an httptest TLS
// authorization server, deliberately invalid credentials, no network.
func TestServer_Run_WaitsForAPendingOAuthSignIn(t *testing.T) {
	fake := newFakeMCPAuthServer(t, nil)
	h := runTestHost(t, host.Options{StopOnLastClient: true, MCPAuthClient: fake.client()})

	client := openHeartbeat(t, h.srv.URL())

	// Start the flow and stop where a real user would be: sent to the
	// provider, nothing yet come back.
	body := []byte(fmt.Sprintf(`{"url":%q}`, fake.ts.URL))
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost,
		h.srv.URL()+"/api/ai/mcp/oauth/start", strings.NewReader(string(body)))
	assert.NilError(t, err)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(host.CSRFTokenHeader, h.srv.CSRFToken())
	resp, err := http.DefaultClient.Do(req)
	assert.NilError(t, err)
	startBody, err := io.ReadAll(resp.Body)
	assert.NilError(t, err)
	assert.NilError(t, resp.Body.Close())
	assert.Equal(t, resp.StatusCode, http.StatusOK, string(startBody))

	var start struct {
		State            string `json:"state"`
		AuthorizationURL string `json:"authorizationUrl"`
	}
	assert.NilError(t, json.Unmarshal(startBody, &start))
	assert.Equal(t, start.State, "pending")
	assert.Assert(t, start.AuthorizationURL != "")

	// The editor's own tab goes away -- a popup blocker, a link pasted over
	// it, a user tidying up while they sign in.
	client.close()

	h.assertStillServing(settleWait)

	// Abandoning the sign-in releases the hold, and the exit that was
	// waiting behind it happens.
	deleteReq, err := http.NewRequestWithContext(context.Background(), http.MethodDelete,
		h.srv.URL()+"/api/ai/mcp/oauth", nil)
	assert.NilError(t, err)
	deleteReq.Header.Set(host.CSRFTokenHeader, h.srv.CSRFToken())
	deleteResp, err := http.DefaultClient.Do(deleteReq)
	assert.NilError(t, err)
	_, _ = io.Copy(io.Discard, deleteResp.Body)
	assert.NilError(t, deleteResp.Body.Close())
	assert.Equal(t, deleteResp.StatusCode, http.StatusOK)

	h.assertExitedForLastClient()
}

// TestServer_ClientGrace_IsOneNumberInEveryMode records the owner's decision
// on issue #216 as a test, so reintroducing a per-mode split is a deliberate
// act rather than a drift: #179 had ordinary browser mode wait 20s and --app
// 6s, and the owner chose 6s everywhere. AppMode is asserted to make *no*
// difference, which is the part that would otherwise silently regress -- the
// old code branched on it. See clients.go for where 6s comes from.
func TestServer_ClientGrace_IsOneNumberInEveryMode(t *testing.T) {
	clearCircleEnv(t)

	browser, err := host.New(host.Options{WorkDir: t.TempDir(), AIStore: newFakeKeyStore()})
	assert.NilError(t, err)
	appMode, err := host.New(host.Options{WorkDir: t.TempDir(), AIStore: newFakeKeyStore(), AppMode: true})
	assert.NilError(t, err)
	overridden, err := host.New(host.Options{
		WorkDir:         t.TempDir(),
		AIStore:         newFakeKeyStore(),
		AppMode:         true,
		LastClientGrace: 42 * time.Millisecond,
	})
	assert.NilError(t, err)

	assert.Equal(t, browser.ClientGrace(), 6*time.Second)
	assert.Equal(t, appMode.ClientGrace(), 6*time.Second)
	assert.Equal(t, appMode.ClientGrace(), browser.ClientGrace(),
		"issue #216: one grace period for every mode, so --app must not change it")
	assert.Equal(t, overridden.ClientGrace(), 42*time.Millisecond)
}

// TestServer_StopsOnLastClient_ReportsTheOption checks what the startup
// banner keys off: the user is told the process will stop on its own only
// when it actually will.
func TestServer_StopsOnLastClient_ReportsTheOption(t *testing.T) {
	clearCircleEnv(t)

	on, err := host.New(host.Options{WorkDir: t.TempDir(), AIStore: newFakeKeyStore(), StopOnLastClient: true})
	assert.NilError(t, err)
	off, err := host.New(host.Options{WorkDir: t.TempDir(), AIStore: newFakeKeyStore()})
	assert.NilError(t, err)

	assert.Assert(t, on.StopsOnLastClient())
	assert.Assert(t, !off.StopsOnLastClient())
}
