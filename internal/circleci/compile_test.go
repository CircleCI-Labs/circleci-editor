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

package circleci_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
)

// newFakeCircleCI builds an httptest.Server driven by handler, standing in
// for the real CircleCI API, and a Client configured to talk to it.
func newFakeCircleCI(t *testing.T, token string, handler http.HandlerFunc) (*httptest.Server, *circleci.Client) {
	t.Helper()

	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)

	client, err := circleci.NewClient(circleci.Config{Host: ts.URL, Token: token})
	assert.NilError(t, err)

	return ts, client
}

func TestCompileConfig_ValidConfig(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, r.URL.Path, "/api/v2/compile-config-with-defaults")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"valid":       true,
			"source-yaml": "version: 2.1\n",
			"output-yaml": "version: 2.1\njobs: {}\n",
			"errors":      []any{},
		})
	})

	result, err := client.CompileConfig(context.Background(), circleci.CompileRequest{ConfigYAML: "version: 2.1\n"})
	assert.NilError(t, err)
	assert.Assert(t, result.Valid)
	assert.Equal(t, result.SourceYAML, "version: 2.1\n")
	assert.Equal(t, result.OutputYAML, "version: 2.1\njobs: {}\n")
	assert.Equal(t, len(result.Errors), 0)
}

func TestCompileConfig_InvalidConfig_ReturnsNoGoError(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"valid":       false,
			"source-yaml": "version: 2.1\nbogus: true\n",
			"output-yaml": "",
			"errors": []map[string]string{
				{"message": "invalid key 'bogus'"},
			},
		})
	})

	result, err := client.CompileConfig(context.Background(), circleci.CompileRequest{ConfigYAML: "version: 2.1\nbogus: true\n"})
	assert.NilError(t, err, "an invalid config must not be reported as a Go error")
	assert.Assert(t, !result.Valid)
	assert.Equal(t, len(result.Errors), 1)
	assert.Equal(t, result.Errors[0].Message, "invalid key 'bogus'")
}

func TestCompileConfig_RequestShape(t *testing.T) {
	var gotBody map[string]any
	_, client := newFakeCircleCI(t, "the-token", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, r.Header.Get("Circle-Token"), "the-token")
		assert.NilError(t, json.NewDecoder(r.Body).Decode(&gotBody))
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"valid": true})
	})

	_, err := client.CompileConfig(context.Background(), circleci.CompileRequest{
		ConfigYAML:         "version: 2.1\n",
		OwnerID:            "owner-123",
		UseNextCompiler:    true,
		PipelineValues:     map[string]any{"pipeline.git.branch": "main"},
		PipelineParameters: map[string]any{"deploy": true},
	})
	assert.NilError(t, err)

	assert.Equal(t, gotBody["config_yaml"], "version: 2.1\n")
	options, ok := gotBody["options"].(map[string]any)
	assert.Assert(t, ok, "expected options object, got %#v", gotBody["options"])
	assert.Equal(t, options["owner_id"], "owner-123")
	assert.Equal(t, options["next"], true)

	pipelineValues, ok := options["pipeline_values"].(map[string]any)
	assert.Assert(t, ok)
	assert.Equal(t, pipelineValues["pipeline.git.branch"], "main")

	pipelineParams, ok := options["pipeline_parameters"].(map[string]any)
	assert.Assert(t, ok)
	assert.Equal(t, pipelineParams["deploy"], true)
}

func TestCompileConfig_Unauthorized(t *testing.T) {
	_, client := newFakeCircleCI(t, "bad-token", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"message":"unauthorized"}`))
	})

	_, err := client.CompileConfig(context.Background(), circleci.CompileRequest{ConfigYAML: "version: 2.1\n"})
	assert.Assert(t, err != nil)
	assert.Assert(t, circleci.IsUnauthorized(err), "expected IsUnauthorized, got: %v", err)
}

func TestCompileConfig_RetriesOn429ThenSucceeds(t *testing.T) {
	var attempts atomic.Int32
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, _ *http.Request) {
		n := attempts.Add(1)
		if n == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"message":"rate limited"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"valid": true})
	})

	result, err := client.CompileConfig(context.Background(), circleci.CompileRequest{ConfigYAML: "version: 2.1\n"})
	assert.NilError(t, err)
	assert.Assert(t, result.Valid)
	assert.Equal(t, attempts.Load(), int32(2))
}

func TestCompileConfig_ExhaustsRetriesOn500(t *testing.T) {
	var attempts atomic.Int32
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, _ *http.Request) {
		attempts.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"message":"boom"}`))
	})

	_, err := client.CompileConfig(context.Background(), circleci.CompileRequest{ConfigYAML: "version: 2.1\n"})
	assert.Assert(t, err != nil)
	assert.Assert(t, is.Contains(err.Error(), "500"))
	assert.Equal(t, attempts.Load(), int32(3))
}

func TestCompileConfig_ContextCancellationAborts(t *testing.T) {
	blockUntilCanceled := make(chan struct{})
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, _ *http.Request) {
		<-blockUntilCanceled
		w.WriteHeader(http.StatusOK)
	})
	t.Cleanup(func() { close(blockUntilCanceled) })

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	_, err := client.CompileConfig(ctx, circleci.CompileRequest{ConfigYAML: "version: 2.1\n"})
	assert.Assert(t, err != nil)
	assert.ErrorIs(t, err, context.DeadlineExceeded)
}

// staticHandler is a convenience for tests that don't need per-call state.
func staticHandler(status int, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}

func TestCompileConfig_MalformedResponseIsAGoError(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", staticHandler(http.StatusOK, "not json"))

	_, err := client.CompileConfig(context.Background(), circleci.CompileRequest{ConfigYAML: "version: 2.1\n"})
	assert.Assert(t, err != nil)
}
