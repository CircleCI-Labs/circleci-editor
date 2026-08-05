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

// resourceClassesResponse mirrors resourceClassesPayload across the JSON
// boundary. Spelled out here rather than imported so the test fails if a field
// is renamed on either side.
type resourceClassesResponse struct {
	Derived      bool   `json:"derived"`
	Reason       string `json:"reason"`
	Environments []struct {
		ID           string `json:"id"`
		Label        string `json:"label"`
		Kind         string `json:"kind"`
		Architecture string `json:"architecture"`
		Generation   string `json:"generation"`
		Classes      []struct {
			Name         string `json:"name"`
			Spec         string `json:"spec"`
			Default      bool   `json:"default"`
			Architecture string `json:"architecture"`
			Generation   string `json:"generation"`
		} `json:"classes"`
	} `json:"environments"`
	Provenance struct {
		Repo   string `json:"repo"`
		Commit string `json:"commit"`
		Source string `json:"source"`
	} `json:"provenance"`
}

func getResourceClasses(t *testing.T, cache host.Options) resourceClassesResponse {
	t.Helper()

	ts := newGuidesTestServer(t, "", cache)
	status, body := doRequest(t, ts, http.MethodGet, "/api/resource-classes", nil)
	assert.Equal(t, status, http.StatusOK)

	var payload resourceClassesResponse
	assert.NilError(t, json.Unmarshal([]byte(body), &payload))
	return payload
}

// TestServer_ResourceClasses_NoToken_DerivesFromTheVendoredTables is this
// endpoint's load-bearing assertion, and it mirrors the guides and schema
// endpoints': the resource tables are AsciiDoc embedded in the binary, so the
// list is served with no CIRCLE_TOKEN and with no request reaching CircleCI or
// GitHub.
func TestServer_ResourceClasses_NoToken_DerivesFromTheVendoredTables(t *testing.T) {
	payload := getResourceClasses(t, host.Options{})

	assert.Equal(t, payload.Derived, true)
	assert.Equal(t, payload.Reason, "")
	assert.Equal(t, payload.Provenance.Repo, "circleci/circleci-docs")
	assert.Assert(t, is.Len(payload.Provenance.Commit, 40))

	byID := map[string][]string{}
	kinds := map[string]int{}
	for _, env := range payload.Environments {
		assert.Assert(t, env.Label != "", "%s has no label", env.ID)
		for _, class := range env.Classes {
			byID[env.ID] = append(byID[env.ID], class.Name)
			assert.Assert(t, class.Generation != "", "%s has no generation", class.Name)
		}
		kinds[env.Kind]++
	}

	// The reported defect, at the HTTP boundary: Docker offers Arm classes and
	// the machine executor offers the larger Arm sizes.
	assert.DeepEqual(t, byID["arm"], []string{"arm.medium", "arm.large", "arm.xlarge", "arm.2xlarge"})
	assert.DeepEqual(t, byID["arm-execution-environment-linux"], []string{"arm.medium", "arm.large", "arm.xlarge", "arm.2xlarge"})
	// And gen2 is representable, so it is offered.
	assert.Assert(t, is.Contains(byID["x86-gen2"], "xlarge.gen2"))
	assert.Assert(t, is.Contains(byID["linuxvm-gen2-execution-environment"], "large.gen2"))

	assert.Equal(t, kinds["docker"], 3)
	assert.Equal(t, kinds["machine"], 6)
	assert.Equal(t, kinds["macos"], 1)
}

// TestServer_ResourceClasses_FallsBackWhenTheDocsCannotBeRead is the honest
// degradation: whatever the guides cache holds is unreadable, so the list comes
// from the snapshot embedded in this release and the response says so. Never an
// empty list -- an executor field with an empty dropdown is worse than one with
// a dated list, provided it admits to being dated.
func TestServer_ResourceClasses_FallsBackWhenTheDocsCannotBeRead(t *testing.T) {
	for name, cache := range map[string]*fakeGuidesCache{
		"parse failed":   {err: errors.New("guides: snapshot is unreadable")},
		"nothing loaded": {},
	} {
		t.Run(name, func(t *testing.T) {
			payload := getResourceClasses(t, host.Options{GuidesCache: cache})

			assert.Equal(t, payload.Derived, false)
			assert.Assert(t, payload.Reason != "", "a non-derived response must say why")
			assert.Assert(t, is.Contains(payload.Reason, "embedded in this release"))
			assert.Assert(t, len(payload.Environments) > 0, "the fallback must not be empty")
		})
	}
}

// TestServer_ResourceClasses_NoCacheHeaders pins the difference from
// /api/schema: a background guides refresh can change this response mid-process,
// so it must not be cached by the browser.
func TestServer_ResourceClasses_NoCacheHeaders(t *testing.T) {
	ts := newGuidesTestServer(t, "", host.Options{})

	resp, err := http.Get(ts.URL + "/api/resource-classes")
	assert.NilError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, resp.Header.Get("Cache-Control"), "")
	assert.Equal(t, resp.Header.Get("ETag"), "")
}

func TestServer_ResourceClasses_RejectsNonGET(t *testing.T) {
	ts := newGuidesTestServer(t, "", host.Options{})

	status, _ := doRequest(t, ts, http.MethodPost, "/api/resource-classes", []byte("{}"))
	assert.Equal(t, status, http.StatusMethodNotAllowed)
}
