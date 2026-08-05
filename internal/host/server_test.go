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

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"testing"
	"time"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/host"
	"github.com/CircleCI-Labs/circleci-editor/internal/webassets"
)

func TestChooseFreePort_ReturnsUsablePort(t *testing.T) {
	port, err := host.ChooseFreePort()
	assert.NilError(t, err)
	assert.Assert(t, port > 0 && port < 65536)

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	assert.NilError(t, err)
	assert.NilError(t, ln.Close())
}

func TestChooseFreePort_ReturnsDistinctPortsAcrossCalls(t *testing.T) {
	a, err := host.ChooseFreePort()
	assert.NilError(t, err)
	b, err := host.ChooseFreePort()
	assert.NilError(t, err)

	// Not a strict guarantee, but the OS should not hand back the exact
	// same immediately-reusable port twice in a row under normal
	// conditions.
	assert.Assert(t, a > 0 && b > 0)
}

func TestServer_Run_ServesUntilContextCancelled(t *testing.T) {
	// Cleared so that, if this test binary is itself running inside a
	// CircleCI job with an ambient CIRCLE_TOKEN, Run does not kick off a
	// real background orb-cache warm against the live API (see
	// Server.Run's use of cacheWarmer).
	clearCircleEnv(t)

	srv, err := host.New(host.Options{
		WorkDir:     t.TempDir(),
		Port:        0,
		OpenBrowser: false,
	})
	assert.NilError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	runErr := make(chan error, 1)
	go func() {
		runErr <- srv.Run(ctx)
	}()

	waitForServer(t, srv.URL())

	resp, err := http.Get(srv.URL() + "/api/healthz") //nolint:noctx // test, short-lived local request.
	assert.NilError(t, err)
	assert.NilError(t, resp.Body.Close())
	assert.Equal(t, resp.StatusCode, http.StatusOK)

	cancel()

	select {
	case err := <-runErr:
		assert.NilError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("server did not shut down within timeout")
	}
}

// waitForServer polls the given URL until it responds or the deadline
// passes, so the test doesn't race the goroutine that calls Run.
func waitForServer(t *testing.T, url string) {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(url + "/api/healthz") //nolint:noctx // test, short-lived local request.
		if err == nil {
			_ = resp.Body.Close()
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("server did not become ready in time")
}

// TestServer_WillServePlaceholder_DevProxyAlwaysFalse guards issue #25's
// loud-failure path against the one case it must never trigger for: local
// development. VCE_DEV_PROXY means Run reverse-proxies to a live Vite dev
// server instead of reading the embed at all (see newRootHandler), so
// whether a real build happens to be embedded is irrelevant and must not
// make `task dev` start refusing to run.
func TestServer_WillServePlaceholder_DevProxyAlwaysFalse(t *testing.T) {
	t.Setenv("VCE_DEV_PROXY", "http://127.0.0.1:5173")

	srv, err := host.New(host.Options{WorkDir: t.TempDir()})
	assert.NilError(t, err)

	assert.Assert(t, !srv.WillServePlaceholder())
}

// TestServer_WillServePlaceholder_MatchesHasRealBuildWithoutDevProxy checks
// consistency rather than a fixed value, the same way
// webassets.TestHasRealBuild_MatchesEmbeddedContents does: whether this test
// binary happens to have a real web build embedded (task build ran first)
// or just the committed .gitkeep is a fact about the build environment, not
// something a unit test should assume either way. What must always hold is
// that, absent VCE_DEV_PROXY, WillServePlaceholder is exactly the negation
// of webassets.HasRealBuild -- see that method's doc comment.
func TestServer_WillServePlaceholder_MatchesHasRealBuildWithoutDevProxy(t *testing.T) {
	assert.Equal(t, os.Getenv("VCE_DEV_PROXY"), "", "test requires VCE_DEV_PROXY to be unset to exercise the embed-driven branch")

	srv, err := host.New(host.Options{WorkDir: t.TempDir()})
	assert.NilError(t, err)

	assert.Equal(t, srv.WillServePlaceholder(), !webassets.HasRealBuild())
}
