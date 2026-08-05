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

package dockerhub_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/dockerhub"
)

func TestClient_ListTags_HappyPath(t *testing.T) {
	var gotPath, gotQuery string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"count":2,"results":[
			{"name":"20.11.0","tag_last_pushed":"2026-01-02T00:00:00Z"},
			{"name":"20.11.0-browsers","tag_last_pushed":"2026-01-02T00:05:00Z"}
		]}`))
	}))
	defer ts.Close()

	client := dockerhub.NewClientWithBaseURL(ts.URL)
	page, err := client.ListTags(context.Background(), "cimg/node", 100)
	assert.NilError(t, err)

	assert.Equal(t, gotPath, "/v2/repositories/cimg/node/tags/")
	assert.Assert(t, is.Contains(gotQuery, "page_size=100"))

	assert.Equal(t, len(page.Tags), 2)
	assert.Equal(t, page.Tags[0].Name, "20.11.0")
	assert.Assert(t, page.Tags[0].LastUpdated.Equal(time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)))
	assert.Equal(t, page.Tags[1].Name, "20.11.0-browsers")
	assert.Assert(t, !page.Truncated)
}

func TestClient_ListTags_NonOKStatus(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer ts.Close()

	client := dockerhub.NewClientWithBaseURL(ts.URL)
	_, err := client.ListTags(context.Background(), "cimg/does-not-exist", 100)
	assert.ErrorContains(t, err, "404")
}

func TestClient_ListTags_MalformedResponse(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{not valid json`))
	}))
	defer ts.Close()

	client := dockerhub.NewClientWithBaseURL(ts.URL)
	_, err := client.ListTags(context.Background(), "cimg/node", 100)
	assert.Assert(t, err != nil)
}

func TestClient_ListTags_RespectsContextCancellation(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(50 * time.Millisecond)
		_, _ = w.Write([]byte(`{"results":[]}`))
	}))
	defer ts.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	client := dockerhub.NewClientWithBaseURL(ts.URL)
	_, err := client.ListTags(ctx, "cimg/node", 100)
	assert.Assert(t, err != nil, "expected a cancelled context to produce an error")
}

// TestClient_ListTags_FollowsPagination is issue #243's core fix: a repo with
// more tags than fit on one page must have the later ones actually reachable,
// not silently dropped at the first page's edge.
func TestClient_ListTags_FollowsPagination(t *testing.T) {
	var gotPaths []string
	mux := http.NewServeMux()
	ts := httptest.NewServer(mux)
	defer ts.Close()

	// The first page's "next" is an absolute URL pointing back at this same
	// test server, mirroring Docker Hub's own real shape -- registered via a
	// ServeMux, rather than closed over before ts.URL is known, so the JSON
	// body can name the real address.
	mux.HandleFunc("/v2/repositories/cimg/node/tags/", func(w http.ResponseWriter, r *http.Request) {
		gotPaths = append(gotPaths, r.URL.String())
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"results":[{"name":"3.0.0"},{"name":"2.0.0"}],"next":"` + ts.URL + `/page2"}`))
	})
	mux.HandleFunc("/page2", func(w http.ResponseWriter, r *http.Request) {
		gotPaths = append(gotPaths, r.URL.String())
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"results":[{"name":"1.0.0"}],"next":""}`))
	})

	client := dockerhub.NewClientWithBaseURL(ts.URL)
	page, err := client.ListTags(context.Background(), "cimg/node", 100)
	assert.NilError(t, err)
	assert.Equal(t, len(gotPaths), 2, "expected ListTags to follow the first page's next link")
	assert.Equal(t, len(page.Tags), 3)
	assert.DeepEqual(t, []string{page.Tags[0].Name, page.Tags[1].Name, page.Tags[2].Name}, []string{"3.0.0", "2.0.0", "1.0.0"})
	assert.Assert(t, !page.Truncated)
}

// TestClient_ListTags_StopsAtMaxTagsWithoutFollowingFurtherPages is the bound
// issue #243 asks for: pagination must stop once maxTags tags have been
// collected, rather than crawling every page a popular repo happens to have.
func TestClient_ListTags_StopsAtMaxTagsWithoutFollowingFurtherPages(t *testing.T) {
	var gotPaths []string
	var ts *httptest.Server
	ts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPaths = append(gotPaths, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"results":[{"name":"3.0.0"},{"name":"2.0.0"}],"next":"` + ts.URL + `/next"}`))
	}))
	defer ts.Close()

	client := dockerhub.NewClientWithBaseURL(ts.URL)
	page, err := client.ListTags(context.Background(), "cimg/node", 2)
	assert.NilError(t, err)
	assert.Equal(t, len(gotPaths), 1, "a maxTags of 2, already satisfied by the first page, must not fetch a second")
	assert.Equal(t, len(page.Tags), 2)
	assert.Assert(t, !page.Truncated, "stopping at the caller's own bound is not a truncation worth flagging")
}

// TestClient_ListTags_RateLimitedMidCrawlReturnsWhatWasCollected is issue
// #243's honesty requirement: a Docker Hub rate limit (or any other error)
// hit after at least one successful page must not discard those tags --
// mirroring #259's "stale-but-labelled beats discarded" precedent for
// the orb cache.
func TestClient_ListTags_RateLimitedMidCrawlReturnsWhatWasCollected(t *testing.T) {
	var calls int
	var ts *httptest.Server
	ts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		if calls == 1 {
			_, _ = w.Write([]byte(`{"results":[{"name":"3.0.0"},{"name":"2.0.0"}],"next":"` + ts.URL + `/next"}`))
			return
		}
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer ts.Close()

	client := dockerhub.NewClientWithBaseURL(ts.URL)
	page, err := client.ListTags(context.Background(), "cimg/node", 100)
	assert.NilError(t, err, "a rate limit hit after at least one page must not surface as an error")
	assert.Equal(t, len(page.Tags), 2, "the first page's tags must still be returned")
	assert.Assert(t, page.Truncated)
	assert.Assert(t, is.Contains(page.TruncatedReason, "429"))
}

// TestClient_ListTags_RateLimitedOnFirstPageIsAnError is the counterpart to
// the mid-crawl case: with nothing collected yet, there is no partial result
// to prefer over an error, so this must behave exactly as any other
// first-page failure (Cache.Get's own fallback to a stale disk entry).
func TestClient_ListTags_RateLimitedOnFirstPageIsAnError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer ts.Close()

	client := dockerhub.NewClientWithBaseURL(ts.URL)
	page, err := client.ListTags(context.Background(), "cimg/node", 100)
	assert.ErrorContains(t, err, "429")
	assert.Equal(t, len(page.Tags), 0)
}
