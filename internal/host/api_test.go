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
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

// sentinelToken is a marker value used to detect whether any API response
// ever leaks the raw CIRCLE_TOKEN value.
const sentinelToken = "sentinel-super-secret-token-value"

// newTestServer builds a host.Server rooted at a fresh temp directory and
// wraps it in an httptest.Server, closing it on test cleanup.
func newTestServer(t *testing.T, dir string) *httptest.Server {
	t.Helper()

	srv, err := host.New(host.Options{
		WorkDir: dir,
		Version: "test-version",
	})
	assert.NilError(t, err)

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// getBody performs an HTTP request with an optional body and returns the
// status code and raw response body, closing the response for the caller.
//
// Every non-GET/HEAD request is given a valid CSRF token (see
// fetchCSRFToken), attached the way the served page itself does -- as a
// header, never as part of body -- so that the hundreds of existing calls to
// this helper across the package's tests keep exercising each handler's own
// logic instead of being turned away at the CSRF gate before ever reaching
// it. A test that wants to exercise the gate itself (a forged cross-origin
// request, a missing or wrong token) talks to the CSRF middleware directly
// rather than through this helper -- see csrf_test.go.
func doRequest(t *testing.T, ts *httptest.Server, method, path string, body []byte) (int, string) {
	t.Helper()

	var reqBody io.Reader
	if body != nil {
		reqBody = bytes.NewReader(body)
	}

	req, err := http.NewRequest(method, ts.URL+path, reqBody)
	assert.NilError(t, err)
	if method != http.MethodGet && method != http.MethodHead {
		req.Header.Set(host.CSRFTokenHeader, fetchCSRFToken(t, ts))
	}

	resp, err := http.DefaultClient.Do(req)
	assert.NilError(t, err)
	defer func() { assert.NilError(t, resp.Body.Close()) }()

	got, err := io.ReadAll(resp.Body)
	assert.NilError(t, err)

	return resp.StatusCode, string(got)
}

// fetchCSRFToken reads the current per-launch CSRF token from GET
// /api/meta -- the same round trip the served page itself makes -- for
// tests that only have a *httptest.Server, not the underlying *host.Server,
// in scope.
func fetchCSRFToken(t *testing.T, ts *httptest.Server) string {
	t.Helper()

	resp, err := http.Get(ts.URL + "/api/meta") //nolint:noctx,gosec // test, short-lived local request.
	assert.NilError(t, err)
	defer func() { assert.NilError(t, resp.Body.Close()) }()
	assert.Equal(t, resp.StatusCode, http.StatusOK)

	var meta struct {
		CSRFToken string `json:"csrfToken"`
	}
	assert.NilError(t, json.NewDecoder(resp.Body).Decode(&meta))
	assert.Assert(t, meta.CSRFToken != "", "meta response carried no csrfToken")
	return meta.CSRFToken
}

func TestServer_Healthz(t *testing.T) {
	ts := newTestServer(t, t.TempDir())

	status, body := doRequest(t, ts, http.MethodGet, "/api/healthz", nil)
	assert.Equal(t, status, http.StatusOK)

	var got map[string]string
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got["status"], "ok")
}

func TestServer_Healthz_WrongMethod(t *testing.T) {
	ts := newTestServer(t, t.TempDir())

	status, _ := doRequest(t, ts, http.MethodPost, "/api/healthz", nil)
	assert.Equal(t, status, http.StatusMethodNotAllowed)
}

func TestServer_Meta_NeverLeaksToken(t *testing.T) {
	t.Setenv("CIRCLE_TOKEN", sentinelToken)
	ts := newTestServer(t, t.TempDir())

	status, body := doRequest(t, ts, http.MethodGet, "/api/meta", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !strings.Contains(body, sentinelToken), "response leaked the token: %s", body)

	var got struct {
		Version      string `json:"version"`
		ConfigPath   string `json:"configPath"`
		ConfigExists bool   `json:"configExists"`
		ConfigFound  bool   `json:"configFound"`
		HasToken     bool   `json:"hasToken"`
		Host         string `json:"host"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Version, "test-version")
	assert.Equal(t, got.HasToken, true)
	assert.Equal(t, got.ConfigFound, false)
	assert.Equal(t, got.ConfigExists, false)
	assert.Equal(t, got.Host, "https://circleci.com")
}

func TestServer_Config_GetAndPut(t *testing.T) {
	dir := t.TempDir()
	ts := newTestServer(t, dir)

	// No config file exists yet.
	status, body := doRequest(t, ts, http.MethodGet, "/api/config", nil)
	assert.Equal(t, status, http.StatusOK)

	var getResp struct {
		Path     string `json:"path"`
		Contents string `json:"contents"`
		Exists   bool   `json:"exists"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &getResp))
	assert.Equal(t, getResp.Exists, false)

	// Write new contents.
	const newContents = "version: 2.1\njobs:\n  build:\n    docker: []\n"
	reqBody, err := json.Marshal(map[string]string{"contents": newContents})
	assert.NilError(t, err)

	putStatus, putBody := doRequest(t, ts, http.MethodPut, "/api/config", reqBody)
	assert.Equal(t, putStatus, http.StatusOK)

	var putParsed struct {
		Path  string `json:"path"`
		Bytes int    `json:"bytes"`
	}
	assert.NilError(t, json.Unmarshal([]byte(putBody), &putParsed))
	assert.Equal(t, putParsed.Bytes, len(newContents))

	// It is now persisted to disk.
	onDisk, err := os.ReadFile(filepath.Join(dir, ".circleci", "config.yml"))
	assert.NilError(t, err)
	assert.Equal(t, string(onDisk), newContents)

	// And GET reflects the new contents.
	status2, body2 := doRequest(t, ts, http.MethodGet, "/api/config", nil)
	assert.Equal(t, status2, http.StatusOK)
	assert.NilError(t, json.Unmarshal([]byte(body2), &getResp))
	assert.Equal(t, getResp.Exists, true)
	assert.Equal(t, getResp.Contents, newContents)
}

func TestServer_Config_Put_MalformedBody(t *testing.T) {
	tests := []struct {
		name string
		body []byte
	}{
		{name: "not json", body: []byte("not json at all")},
		{name: "missing contents field", body: []byte(`{}`)},
		{name: "empty body", body: []byte("")},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ts := newTestServer(t, t.TempDir())

			status, body := doRequest(t, ts, http.MethodPut, "/api/config", tc.body)
			assert.Equal(t, status, http.StatusBadRequest)
			assert.Assert(t, is.Contains(body, `"error"`))
		})
	}
}

func TestServer_Config_WrongMethod(t *testing.T) {
	ts := newTestServer(t, t.TempDir())

	status, body := doRequest(t, ts, http.MethodDelete, "/api/config", nil)
	assert.Equal(t, status, http.StatusMethodNotAllowed)
	assert.Assert(t, is.Contains(body, `"error"`))
}

func TestServer_UnknownAPIPath_ReturnsJSON404(t *testing.T) {
	ts := newTestServer(t, t.TempDir())

	status, body := doRequest(t, ts, http.MethodGet, "/api/does-not-exist", nil)
	assert.Equal(t, status, http.StatusNotFound)
	assert.Assert(t, is.Contains(body, `"error"`))
}

func TestServer_SPAFallback_ServesIndexHTML(t *testing.T) {
	ts := newTestServer(t, t.TempDir())

	paths := []string{"/", "/some/client/route", "/another"}
	for _, p := range paths {
		status, body := doRequest(t, ts, http.MethodGet, p, nil)
		assert.Equal(t, status, http.StatusOK, "path %s", p)
		assert.Assert(t, is.Contains(body, "<html"), "path %s did not serve index.html: %s", p, body)
	}
}
