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
	"bufio"
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

func TestServer_Heartbeat_WrongMethod(t *testing.T) {
	ts := newTestServer(t, t.TempDir())

	status, _ := doRequest(t, ts, http.MethodPost, "/api/heartbeat", nil)
	assert.Equal(t, status, http.StatusMethodNotAllowed)
}

// TestServer_Heartbeat_StreamsSSEEvents connects to /api/heartbeat and
// reads the first event straight off the wire, checking both the SSE
// headers a browser EventSource requires and that at least one "ping"
// event arrives without waiting a full heartbeatInterval -- the handler
// writes one immediately on connect precisely so a client learns "the host
// is alive" as soon as it subscribes, not up to 10s later.
func TestServer_Heartbeat_StreamsSSEEvents(t *testing.T) {
	ts := newTestServer(t, t.TempDir())

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, ts.URL+"/api/heartbeat", nil)
	assert.NilError(t, err)

	resp, err := http.DefaultClient.Do(req) //nolint:noctx // context set via NewRequestWithContext above.
	assert.NilError(t, err)
	defer func() { assert.NilError(t, resp.Body.Close()) }()

	assert.Equal(t, resp.StatusCode, http.StatusOK)
	assert.Equal(t, resp.Header.Get("Content-Type"), "text/event-stream")

	reader := bufio.NewReader(resp.Body)
	deadline := time.Now().Add(2 * time.Second)
	var lines []string
	for time.Now().Before(deadline) {
		line, readErr := reader.ReadString('\n')
		if line != "" {
			lines = append(lines, line)
		}
		if readErr != nil {
			break
		}
		if strings.Join(lines, "") != "" && strings.Contains(strings.Join(lines, ""), "\n\n") {
			break
		}
	}

	got := strings.Join(lines, "")
	assert.Assert(t, is.Contains(got, "event: ping"))
	assert.Assert(t, is.Contains(got, "data: "))
}

// TestServer_Heartbeat_DoesNotBlockShutdown is the regression test for the
// exact failure this handler's shutdownCtx select case exists to avoid:
// http.Server.Shutdown does not forcibly close active connections (only
// idle ones), so a naive streaming handler that only watched
// r.Context().Done() would hang graceful shutdown for as long as any
// browser tab kept its heartbeat connection open -- up to shutdownTimeout,
// which would itself surface as an error from Run (see main.go's
// treatment of a non-nil Run error) even though nothing was actually
// wrong. This test holds a heartbeat connection open across cancel() and
// asserts Run still returns promptly, exactly like the existing
// TestServer_Run_ServesUntilContextCancelled but with a live streaming
// client in the picture.
func TestServer_Heartbeat_DoesNotBlockShutdown(t *testing.T) {
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

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, srv.URL()+"/api/heartbeat", nil)
	assert.NilError(t, err)
	resp, err := http.DefaultClient.Do(req) //nolint:noctx // context set via NewRequestWithContext above.
	assert.NilError(t, err)
	defer func() { _ = resp.Body.Close() }()
	assert.Equal(t, resp.StatusCode, http.StatusOK)

	// Read the first event so we know the connection is genuinely
	// established and streaming, not merely accepted -- then leave it open
	// (never call resp.Body.Close() before cancel) to reproduce "a browser
	// tab is still subscribed when the process is asked to shut down".
	_, err = bufio.NewReader(resp.Body).ReadString('\n')
	assert.NilError(t, err)

	cancel()

	select {
	case err := <-runErr:
		assert.NilError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("server did not shut down within timeout while a heartbeat connection was open")
	}
}
