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
	"encoding/json"
	"net/http"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/schema"
)

// TestServer_Schema_NoToken_StillReturnsSchema is the load-bearing assertion
// for this endpoint: unlike /api/validate and /api/orbs/*, the schema is a
// static asset baked into the binary, not fetched from the CircleCI API, so
// it must be served even when this host has no CIRCLE_TOKEN configured at
// all -- explicitly exercised here with an empty token (which also clears
// any ambient CIRCLE_TOKEN in the test process's environment, see
// newOrbsTestServer / clearCircleEnv), rather than just relying on the
// happy-path test incidentally not setting one.
func TestServer_Schema_NoToken_StillReturnsSchema(t *testing.T) {
	ts := newOrbsTestServer(t, "", nil, nil)

	status, body := doRequest(t, ts, http.MethodGet, "/api/schema", nil)
	assert.Equal(t, status, http.StatusOK)

	var doc map[string]any
	assert.NilError(t, json.Unmarshal([]byte(body), &doc))
	props, ok := doc["properties"].(map[string]any)
	assert.Assert(t, ok)
	_, hasJobs := props["jobs"]
	assert.Assert(t, hasJobs)
}

func TestServer_Schema_HappyPath_HeadersAndBody(t *testing.T) {
	ts := newOrbsTestServer(t, sentinelToken, nil, nil)

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/schema", nil)
	assert.NilError(t, err)
	resp, err := http.DefaultClient.Do(req)
	assert.NilError(t, err)
	defer func() { assert.NilError(t, resp.Body.Close()) }()

	assert.Equal(t, resp.StatusCode, http.StatusOK)
	assert.Equal(t, resp.Header.Get("Content-Type"), "application/json; charset=utf-8")
	assert.Assert(t, is.Contains(resp.Header.Get("Cache-Control"), "max-age"))

	gotETag := resp.Header.Get("ETag")
	assert.Assert(t, gotETag != "")
	assert.Equal(t, gotETag, schema.ETag())
}

func TestServer_Schema_ConditionalGet_ReturnsNotModified(t *testing.T) {
	ts := newOrbsTestServer(t, sentinelToken, nil, nil)

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/schema", nil)
	assert.NilError(t, err)
	req.Header.Set("If-None-Match", schema.ETag())

	resp, err := http.DefaultClient.Do(req)
	assert.NilError(t, err)
	defer func() { assert.NilError(t, resp.Body.Close()) }()

	assert.Equal(t, resp.StatusCode, http.StatusNotModified)
}

func TestServer_Schema_WrongMethod(t *testing.T) {
	ts := newOrbsTestServer(t, sentinelToken, nil, nil)

	status, body := doRequest(t, ts, http.MethodPost, "/api/schema", nil)
	assert.Equal(t, status, http.StatusMethodNotAllowed)
	assert.Assert(t, is.Contains(body, `"error"`))
}
