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
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

// fakeCompiler is a fake implementation of the host package's unexported
// configCompiler interface, standing in for a real circleci.Client.
type fakeCompiler struct {
	result *circleci.CompileResult
	err    error
	gotReq circleci.CompileRequest
}

func (f *fakeCompiler) CompileConfig(_ context.Context, req circleci.CompileRequest) (*circleci.CompileResult, error) {
	f.gotReq = req
	return f.result, f.err
}

// newValidateTestServer builds a host.Server with the given fake compiler
// (which may be nil to exercise the real-client construction path) and
// CIRCLE_TOKEN value, wrapped in an httptest.Server closed on cleanup.
func newValidateTestServer(t *testing.T, token string, compiler *fakeCompiler) *httptest.Server {
	t.Helper()

	clearCircleEnv(t)
	t.Setenv("CIRCLE_TOKEN", token)

	opts := host.Options{WorkDir: t.TempDir(), Version: "test-version"}
	if compiler != nil {
		opts.Compiler = compiler
	}

	srv, err := host.New(opts)
	assert.NilError(t, err)

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func TestServer_Validate_ValidConfig(t *testing.T) {
	compiler := &fakeCompiler{result: &circleci.CompileResult{
		Valid:      true,
		OutputYAML: "version: 2.1\njobs: {}\n",
	}}
	ts := newValidateTestServer(t, sentinelToken, compiler)

	reqBody, err := json.Marshal(map[string]string{"contents": "version: 2.1\n"})
	assert.NilError(t, err)

	status, body := doRequest(t, ts, http.MethodPost, "/api/validate", reqBody)
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !strings.Contains(body, sentinelToken), "response leaked the token: %s", body)

	var got struct {
		Available  bool   `json:"available"`
		Source     string `json:"source"`
		Valid      bool   `json:"valid"`
		OutputYAML string `json:"outputYaml"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, true)
	assert.Equal(t, got.Source, "api")
	assert.Equal(t, got.Valid, true)
	assert.Equal(t, got.OutputYAML, "version: 2.1\njobs: {}\n")

	assert.Equal(t, compiler.gotReq.ConfigYAML, "version: 2.1\n")
}

func TestServer_Validate_InvalidConfig(t *testing.T) {
	compiler := &fakeCompiler{result: &circleci.CompileResult{
		Valid:  false,
		Errors: []circleci.CompileError{{Message: "invalid key 'bogus'"}},
	}}
	ts := newValidateTestServer(t, sentinelToken, compiler)

	reqBody, err := json.Marshal(map[string]string{"contents": "bogus: true\n"})
	assert.NilError(t, err)

	status, body := doRequest(t, ts, http.MethodPost, "/api/validate", reqBody)
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !strings.Contains(body, sentinelToken), "response leaked the token: %s", body)

	var got struct {
		Available bool `json:"available"`
		Source    string
		Valid     bool
		Errors    []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, true)
	assert.Equal(t, got.Valid, false)
	assert.Equal(t, len(got.Errors), 1)
	assert.Equal(t, got.Errors[0].Message, "invalid key 'bogus'")
}

func TestServer_Validate_NoToken_ReturnsUnavailable(t *testing.T) {
	compiler := &fakeCompiler{err: errAssertNeverCalled}
	ts := newValidateTestServer(t, "", compiler)

	reqBody, err := json.Marshal(map[string]string{"contents": "version: 2.1\n"})
	assert.NilError(t, err)

	status, body := doRequest(t, ts, http.MethodPost, "/api/validate", reqBody)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Available bool   `json:"available"`
		Source    string `json:"source"`
		Valid     bool   `json:"valid"`
		Reason    string `json:"reason"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, false)
	assert.Equal(t, got.Source, "unavailable")
	assert.Equal(t, got.Valid, false)
	assert.Assert(t, is.Contains(got.Reason, "token"))
}

// errAssertNeverCalled is used as a fakeCompiler.err sentinel in tests that
// assert the compiler is never invoked (e.g. when no token is configured).
// It has no special behavior beyond making a stray call visibly fail.
var errAssertNeverCalled = &testOnlyError{"CompileConfig should not have been called"}

type testOnlyError struct{ msg string }

func (e *testOnlyError) Error() string { return e.msg }

func TestServer_Validate_NoToken_NeverCallsCompiler(t *testing.T) {
	compiler := &fakeCompiler{err: errAssertNeverCalled}
	ts := newValidateTestServer(t, "", compiler)

	reqBody, err := json.Marshal(map[string]string{"contents": "version: 2.1\n"})
	assert.NilError(t, err)

	status, _ := doRequest(t, ts, http.MethodPost, "/api/validate", reqBody)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, compiler.gotReq.ConfigYAML, "", "compiler must not be called when no token is configured")
}

func TestServer_Validate_UpstreamError(t *testing.T) {
	compiler := &fakeCompiler{err: &circleci.APIError{StatusCode: 500, Method: "POST", Path: "/api/v2/compile-config-with-defaults", Body: "boom"}}
	ts := newValidateTestServer(t, sentinelToken, compiler)

	reqBody, err := json.Marshal(map[string]string{"contents": "version: 2.1\n"})
	assert.NilError(t, err)

	status, body := doRequest(t, ts, http.MethodPost, "/api/validate", reqBody)
	assert.Equal(t, status, http.StatusBadGateway)
	assert.Assert(t, !strings.Contains(body, sentinelToken), "response leaked the token: %s", body)
	assert.Assert(t, is.Contains(body, `"error"`))
	assert.Assert(t, !strings.Contains(body, "boom"), "response leaked the upstream response body: %s", body)
}

// TestServer_Validate_UnauthorizedToken pins issue #224: a token CircleCI
// rejects is not the same failure as an unreachable API, and must not arrive
// dressed as one. It is reported through the same Available=false channel
// "no token configured" uses (HTTP 200), distinguished by Source, rather
// than as an HTTP 502 a generic client cannot tell apart from a genuine
// gateway failure.
func TestServer_Validate_UnauthorizedToken(t *testing.T) {
	compiler := &fakeCompiler{err: &circleci.APIError{StatusCode: http.StatusUnauthorized, Method: "POST", Path: "/api/v2/compile-config-with-defaults", Body: "invalid token"}}
	ts := newValidateTestServer(t, sentinelToken, compiler)

	reqBody, err := json.Marshal(map[string]string{"contents": "version: 2.1\n"})
	assert.NilError(t, err)

	status, body := doRequest(t, ts, http.MethodPost, "/api/validate", reqBody)
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !strings.Contains(body, sentinelToken), "response leaked the token: %s", body)
	assert.Assert(t, !strings.Contains(body, "invalid token"), "response leaked the upstream response body: %s", body)

	var got struct {
		Available bool   `json:"available"`
		Source    string `json:"source"`
		Valid     bool   `json:"valid"`
		Reason    string `json:"reason"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, false)
	assert.Equal(t, got.Source, "unauthorized")
	assert.Equal(t, got.Valid, false)
	assert.Assert(t, is.Contains(got.Reason, "401"))
}

// TestServer_Validate_UnauthorizedToken_DistinctFromNoToken pins the reason
// these are two different Source values rather than one: "no token
// configured" and "token rejected" call for opposite user actions (get a
// token vs. replace the one you have), so a client keying off Source alone
// must be able to tell them apart.
func TestServer_Validate_UnauthorizedToken_DistinctFromNoToken(t *testing.T) {
	unauthorized := &fakeCompiler{err: &circleci.APIError{StatusCode: http.StatusUnauthorized}}
	ts := newValidateTestServer(t, sentinelToken, unauthorized)

	reqBody, err := json.Marshal(map[string]string{"contents": "version: 2.1\n"})
	assert.NilError(t, err)

	_, body := doRequest(t, ts, http.MethodPost, "/api/validate", reqBody)

	var got struct {
		Source string `json:"source"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Assert(t, got.Source != "unavailable", "unauthorized must not be reported as the same Source as no-token")
}

func TestServer_Validate_MalformedBody(t *testing.T) {
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
			ts := newValidateTestServer(t, sentinelToken, &fakeCompiler{err: errAssertNeverCalled})

			status, body := doRequest(t, ts, http.MethodPost, "/api/validate", tc.body)
			assert.Equal(t, status, http.StatusBadRequest)
			assert.Assert(t, is.Contains(body, `"error"`))
		})
	}
}

func TestServer_Validate_WrongMethod(t *testing.T) {
	ts := newValidateTestServer(t, sentinelToken, &fakeCompiler{err: errAssertNeverCalled})

	status, body := doRequest(t, ts, http.MethodGet, "/api/validate", nil)
	assert.Equal(t, status, http.StatusMethodNotAllowed)
	assert.Assert(t, is.Contains(body, `"error"`))
}
