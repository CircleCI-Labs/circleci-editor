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
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/dockerhub"
	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

// fakeDockerTagsCache is a fake implementation of the host package's
// unexported dockerTagsCache interface.
type fakeDockerTagsCache struct {
	result dockerhub.Result
	err    error

	gotRepo string

	// refreshResult/refreshErr are what Refresh returns, independent of
	// result/err, so a test can tell the two calls apart -- e.g. asserting
	// that ?refresh=1 reached Refresh and not Get. Defaults to result/err
	// when left unset, since most tests that don't care about the
	// distinction still want Refresh to behave sensibly if called.
	refreshResult    dockerhub.Result
	refreshErr       error
	refreshResultSet bool
	gotRefreshRepo   string
	refreshCalls     int
}

func (f *fakeDockerTagsCache) Get(_ context.Context, repo string) (dockerhub.Result, error) {
	f.gotRepo = repo
	return f.result, f.err
}

func (f *fakeDockerTagsCache) Refresh(_ context.Context, repo string) (dockerhub.Result, error) {
	f.gotRefreshRepo = repo
	f.refreshCalls++
	if f.refreshResultSet {
		return f.refreshResult, f.refreshErr
	}
	return f.result, f.err
}

// newDockerTagsServer builds a host.Server around the given fake cache --
// unlike orbs, this endpoint needs no CIRCLE_TOKEN at all (see
// TestServer_DockerTags_WorksWithNoCircleToken), so every other test here
// leaves CIRCLE_TOKEN whatever the ambient environment happens to have,
// same as this package's other non-token-gated endpoint tests.
func newDockerTagsServer(t *testing.T, cache *fakeDockerTagsCache) *httptest.Server {
	t.Helper()

	srv, err := host.New(host.Options{
		WorkDir:         t.TempDir(),
		Version:         "test-version",
		DockerTagsCache: cache,
	})
	assert.NilError(t, err)

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func TestServer_DockerTags_HappyPath(t *testing.T) {
	fetchedAt := time.Date(2026, 7, 20, 12, 0, 0, 0, time.UTC)
	cache := &fakeDockerTagsCache{result: dockerhub.Result{
		Tags:      []string{"20.11.0", "20.10.0"},
		FetchedAt: fetchedAt,
		Live:      true,
	}}
	ts := newDockerTagsServer(t, cache)

	status, body := doRequest(t, ts, http.MethodGet, "/api/docker-tags?image=node", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, cache.gotRepo, "cimg/node")

	var got struct {
		Available bool     `json:"available"`
		Tags      []string `json:"tags"`
		FetchedAt string   `json:"fetchedAt"`
		Live      bool     `json:"live"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, true)
	assert.DeepEqual(t, got.Tags, []string{"20.11.0", "20.10.0"})
	assert.Equal(t, got.FetchedAt, "2026-07-20T12:00:00Z")
	assert.Equal(t, got.Live, true)
}

func TestServer_DockerTags_FetchFailure_ReturnsUnavailable(t *testing.T) {
	cache := &fakeDockerTagsCache{err: errors.New("network unreachable")}
	ts := newDockerTagsServer(t, cache)

	status, body := doRequest(t, ts, http.MethodGet, "/api/docker-tags?image=node", nil)
	assert.Equal(t, status, http.StatusOK, "a fetch failure must still be a 200 with available:false -- the SPA must be able to fall back without treating this as a hard error")

	var got struct {
		Available bool   `json:"available"`
		Reason    string `json:"reason"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, false)
	assert.Assert(t, got.Reason != "")
}

// TestServer_DockerTags_RefreshUsesTheCachesRefreshMethod pins issue #285's
// manual refresh affordance: ?refresh=1 must call the cache's Refresh (which
// bypasses cacheTTL for this one repo -- see dockerhub.Cache.Refresh), not
// Get, and an ordinary request must never reach Refresh at all.
func TestServer_DockerTags_RefreshUsesTheCachesRefreshMethod(t *testing.T) {
	cache := &fakeDockerTagsCache{
		result:           dockerhub.Result{Tags: []string{"20.10.0"}, Live: false},
		refreshResultSet: true,
		refreshResult:    dockerhub.Result{Tags: []string{"20.11.0"}, Live: true},
	}
	ts := newDockerTagsServer(t, cache)

	status, body := doRequest(t, ts, http.MethodGet, "/api/docker-tags?image=node", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, cache.refreshCalls, 0, "an ordinary request must not refresh")
	assert.Assert(t, is.Contains(body, "20.10.0"))

	status, body = doRequest(t, ts, http.MethodGet, "/api/docker-tags?image=node&refresh=1", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, cache.refreshCalls, 1)
	assert.Equal(t, cache.gotRefreshRepo, "cimg/node")
	assert.Assert(t, is.Contains(body, "20.11.0"), "refresh=1 must serve Refresh's result, not Get's")
}

func TestServer_DockerTags_MissingImage_BadRequest(t *testing.T) {
	ts := newDockerTagsServer(t, &fakeDockerTagsCache{})

	status, body := doRequest(t, ts, http.MethodGet, "/api/docker-tags", nil)
	assert.Equal(t, status, http.StatusBadRequest)
	assert.Assert(t, is.Contains(body, `"error"`))
}

func TestServer_DockerTags_RejectsNonCimgNamespace(t *testing.T) {
	// This endpoint is not a general Docker Hub proxy: it must reject
	// anything that isn't a bare lowercase-alnum name, since that name
	// always gets prefixed with "cimg/" server-side -- see
	// cimgImageNamePattern's own doc comment.
	tests := []string{
		"../secret",
		"node/../../etc",
		"someorg/someimage",
		"Node",
		"node ",
		"",
	}
	for _, image := range tests {
		t.Run(image, func(t *testing.T) {
			cache := &fakeDockerTagsCache{}
			ts := newDockerTagsServer(t, cache)

			status, _ := doRequest(t, ts, http.MethodGet, "/api/docker-tags?image="+image, nil)
			assert.Equal(t, status, http.StatusBadRequest)
			assert.Equal(t, cache.gotRepo, "", "the cache must never be consulted for a rejected image name")
		})
	}
}

func TestServer_DockerTags_WrongMethod(t *testing.T) {
	ts := newDockerTagsServer(t, &fakeDockerTagsCache{})

	status, body := doRequest(t, ts, http.MethodPost, "/api/docker-tags?image=node", nil)
	assert.Equal(t, status, http.StatusMethodNotAllowed)
	assert.Assert(t, is.Contains(body, `"error"`))
}

func TestServer_DockerTags_WorksWithNoCircleToken(t *testing.T) {
	// The defining property of this endpoint versus /api/orbs/*: it must
	// work even when CIRCLE_TOKEN is entirely unset, since Docker Hub's
	// public tag-listing API needs no CircleCI credentials whatsoever.
	clearCircleEnv(t)
	t.Setenv("CIRCLE_TOKEN", "")

	cache := &fakeDockerTagsCache{result: dockerhub.Result{Tags: []string{"1.0.0"}}}
	ts := newDockerTagsServer(t, cache)

	status, body := doRequest(t, ts, http.MethodGet, "/api/docker-tags?image=node", nil)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Available bool `json:"available"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, true)
}

// TestServer_DockerTags_ServesTruncationHonestly is issue #243's wire
// requirement: a listing the host knows was cut short (Docker Hub rate
// limiting, most likely -- see internal/dockerhub.Page) must say so on the
// wire, mirroring issue #259's rule that a degraded listing is served
// labelled rather than silently presented as complete.
func TestServer_DockerTags_ServesTruncationHonestly(t *testing.T) {
	cache := &fakeDockerTagsCache{result: dockerhub.Result{
		Tags:            []string{"20.11.0"},
		AllTags:         []string{"20.11.0"},
		Truncated:       true,
		TruncatedReason: "Docker Hub rate-limited this request (HTTP 429)",
		FetchedAt:       time.Date(2026, 7, 20, 12, 0, 0, 0, time.UTC),
	}}
	ts := newDockerTagsServer(t, cache)

	status, body := doRequest(t, ts, http.MethodGet, "/api/docker-tags?image=node", nil)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Truncated       bool   `json:"truncated"`
		TruncatedReason string `json:"truncatedReason"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Assert(t, got.Truncated)
	assert.Equal(t, got.TruncatedReason, "Docker Hub rate-limited this request (HTTP 429)")
}

// TestServer_DockerTags_OrdinaryFetchIsNotMislabelledTruncated guards the
// opposite direction: an ordinary result must serve truncated:false (i.e.
// the field must be omitted or false), not a copy-paste of the truncated
// case.
func TestServer_DockerTags_OrdinaryFetchIsNotMislabelledTruncated(t *testing.T) {
	cache := &fakeDockerTagsCache{result: dockerhub.Result{Tags: []string{"20.11.0"}}}
	ts := newDockerTagsServer(t, cache)

	status, body := doRequest(t, ts, http.MethodGet, "/api/docker-tags?image=node", nil)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Truncated bool `json:"truncated"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Assert(t, !got.Truncated)
}

// TestServer_DockerTags_ServesBothTheRankedAndTheFullList is issue #213's wire
// requirement. The picker's combobox types over the full list while still
// recommending the ranked handful first, so the response has to carry both --
// eight ranked representatives answer "which should I pick?" and are the wrong
// answer to "is 20.11.2 available?".
func TestServer_DockerTags_ServesBothTheRankedAndTheFullList(t *testing.T) {
	cache := &fakeDockerTagsCache{result: dockerhub.Result{
		Tags:      []string{"20.11.2", "20.10.0"},
		AllTags:   []string{"20.11.2", "20.11.0", "20.11.0-browsers", "20.10.0"},
		FetchedAt: time.Date(2026, 7, 20, 12, 0, 0, 0, time.UTC),
	}}
	ts := newDockerTagsServer(t, cache)

	status, body := doRequest(t, ts, http.MethodGet, "/api/docker-tags?image=node", nil)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Tags    []string `json:"tags"`
		AllTags []string `json:"allTags"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.DeepEqual(t, got.Tags, []string{"20.11.2", "20.10.0"})
	assert.DeepEqual(t, got.AllTags, []string{"20.11.2", "20.11.0", "20.11.0-browsers", "20.10.0"})
}
