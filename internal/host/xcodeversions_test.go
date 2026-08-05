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
	"errors"
	"net/http"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

// xcodeVersionsResponse mirrors xcodeVersionsPayload across the JSON boundary.
// Spelled out here rather than imported so the test fails if a field is renamed
// on either side.
type xcodeVersionsResponse struct {
	Derived  bool   `json:"derived"`
	Reason   string `json:"reason"`
	Default  string `json:"default"`
	Versions []struct {
		Version         string   `json:"version"`
		Label           string   `json:"label"`
		Spec            string   `json:"spec"`
		ResourceClasses []string `json:"resourceClasses"`
		Prerelease      bool     `json:"prerelease"`
		PrereleaseKind  string   `json:"prereleaseKind"`
	} `json:"versions"`
	Provenance struct {
		Repo   string `json:"repo"`
		Commit string `json:"commit"`
		Source string `json:"source"`
	} `json:"provenance"`
}

func getXcodeVersions(t *testing.T, options host.Options) xcodeVersionsResponse {
	t.Helper()

	ts := newGuidesTestServer(t, "", options)
	status, body := doRequest(t, ts, http.MethodGet, "/api/xcode-versions", nil)
	assert.Equal(t, status, http.StatusOK)

	var payload xcodeVersionsResponse
	assert.NilError(t, json.Unmarshal([]byte(body), &payload))
	return payload
}

// TestServer_XcodeVersions_NoToken_DerivesFromTheVendoredTable mirrors the
// resource-classes endpoint: the supported-Xcode table is AsciiDoc embedded in
// the binary, so the list is served with no CIRCLE_TOKEN and with no request
// reaching CircleCI or GitHub.
func TestServer_XcodeVersions_NoToken_DerivesFromTheVendoredTable(t *testing.T) {
	payload := getXcodeVersions(t, host.Options{})

	assert.Equal(t, payload.Derived, true)
	assert.Equal(t, payload.Reason, "")
	assert.Assert(t, len(payload.Versions) > 0)
	assert.Equal(t, payload.Provenance.Repo, "circleci/circleci-docs")

	// Every version is a plain, non-empty string, and none of them is the
	// invented `15.3.0` this endpoint exists to replace (issue #203).
	for _, version := range payload.Versions {
		assert.Assert(t, version.Version != "")
		assert.Assert(t, version.Version != "15.3.0")
		assert.Assert(t, len(version.ResourceClasses) > 0, "version %s", version.Version)
	}
}

// TestServer_XcodeVersions_DefaultIsOneOfTheOfferedVersions is the invariant
// that would have caught issue #203 on its own: whatever a new macOS job starts
// on must be a version the table lists. The old literal was not, and nothing
// checked.
func TestServer_XcodeVersions_DefaultIsOneOfTheOfferedVersions(t *testing.T) {
	payload := getXcodeVersions(t, host.Options{})

	assert.Assert(t, payload.Default != "")
	found := false
	for _, version := range payload.Versions {
		if version.Version != payload.Default {
			continue
		}
		found = true
		assert.Assert(t, !version.Prerelease,
			"a new macOS job must not default to a pre-release image: upstream says those are not frozen")
	}
	assert.Assert(t, found, "default %q is not in the offered list", payload.Default)
}

// TestServer_XcodeVersions_FallsBackWhenTheDocsCannotBeRead is the honest
// degradation, and the same shape as the resource-classes one: the list comes
// from the snapshot embedded in this release and the response says so. Never
// empty, and never a retyped literal.
func TestServer_XcodeVersions_FallsBackWhenTheDocsCannotBeRead(t *testing.T) {
	for name, cache := range map[string]*fakeGuidesCache{
		"parse failed":   {err: errors.New("guides: snapshot is unreadable")},
		"nothing loaded": {},
	} {
		t.Run(name, func(t *testing.T) {
			payload := getXcodeVersions(t, host.Options{GuidesCache: cache})

			assert.Equal(t, payload.Derived, false)
			assert.Assert(t, payload.Reason != "", "a non-derived response must say why")
			assert.Assert(t, is.Contains(payload.Reason, "embedded in this release"))
			assert.Assert(t, len(payload.Versions) > 0, "the fallback must not be empty")
			// The default still has to be real, even in the degraded case.
			assert.Assert(t, payload.Default != "")
		})
	}
}

// TestServer_XcodeVersions_NoCacheHeaders pins the difference from /api/schema:
// a background guides refresh can change this response mid-process, so it must
// not be cached by the browser.
func TestServer_XcodeVersions_NoCacheHeaders(t *testing.T) {
	ts := newGuidesTestServer(t, "", host.Options{})

	resp, err := http.Get(ts.URL + "/api/xcode-versions")
	assert.NilError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, resp.Header.Get("Cache-Control"), "")
	assert.Equal(t, resp.Header.Get("ETag"), "")
}

func TestServer_XcodeVersions_RejectsNonGET(t *testing.T) {
	ts := newGuidesTestServer(t, "", host.Options{})

	status, _ := doRequest(t, ts, http.MethodPost, "/api/xcode-versions", []byte("{}"))
	assert.Equal(t, status, http.StatusMethodNotAllowed)
}
