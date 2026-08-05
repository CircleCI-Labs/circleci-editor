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
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/dockerhub"
)

// fakeLister is a fake implementation of dockerhub.TagLister, standing in
// for a real *dockerhub.Client.
type fakeLister struct {
	mu sync.Mutex

	tags            map[string][]dockerhub.Tag
	err             error
	truncated       bool
	truncatedReason string
	calls           int
	gotRepo         []string

	// unblock, when non-nil, is read once before returning -- but only for a
	// call naming blockRepo ("" blocks every repo, matching every existing
	// caller of this fake that never sets blockRepo) -- letting a test hold
	// one repo's fetch open without also stalling an unrelated repo's.
	unblock   chan struct{}
	blockRepo string
}

func (f *fakeLister) ListTags(ctx context.Context, repo string, _ int) (dockerhub.Page, error) {
	f.mu.Lock()
	f.calls++
	f.gotRepo = append(f.gotRepo, repo)
	var unblock chan struct{}
	if f.blockRepo == "" || f.blockRepo == repo {
		unblock = f.unblock
	}
	f.mu.Unlock()

	if unblock != nil {
		select {
		case <-unblock:
		case <-ctx.Done():
			return dockerhub.Page{}, ctx.Err()
		}
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return dockerhub.Page{}, f.err
	}
	return dockerhub.Page{Tags: f.tags[repo], Truncated: f.truncated, TruncatedReason: f.truncatedReason}, nil
}

func (f *fakeLister) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func TestCache_Get_FetchesAndRanksOnFirstCall(t *testing.T) {
	lister := &fakeLister{tags: map[string][]dockerhub.Tag{
		"cimg/node": {{Name: "20.11.0"}, {Name: "20.11.0-browsers"}, {Name: "20.10.0"}},
	}}
	cache := dockerhub.New(lister, "")

	result, err := cache.Get(context.Background(), "cimg/node")
	assert.NilError(t, err)
	assert.Assert(t, result.Live)
	assert.DeepEqual(t, result.Tags, []string{"20.11.0", "20.10.0"})
	assert.Equal(t, lister.callCount(), 1)
}

func TestCache_Get_SecondCallWithinTTLServesFromMemoryWithoutFetching(t *testing.T) {
	lister := &fakeLister{tags: map[string][]dockerhub.Tag{
		"cimg/go": {{Name: "1.21.0"}},
	}}
	cache := dockerhub.New(lister, "")

	_, err := cache.Get(context.Background(), "cimg/go")
	assert.NilError(t, err)

	result, err := cache.Get(context.Background(), "cimg/go")
	assert.NilError(t, err)
	assert.Assert(t, !result.Live, "a cached call must not report Live")
	assert.Equal(t, lister.callCount(), 1, "must not have fetched a second time within the TTL")
	assert.DeepEqual(t, result.Tags, []string{"1.21.0"})
}

func TestCache_Get_FetchFailureWithNoPriorCacheReturnsError(t *testing.T) {
	lister := &fakeLister{err: errors.New("network unreachable")}
	cache := dockerhub.New(lister, "")

	_, err := cache.Get(context.Background(), "cimg/node")
	assert.ErrorContains(t, err, "network unreachable")
}

// TestCache_Get_ExpiredCacheFallsBackToStaleDataOnFetchFailure is the
// graceful-degradation guarantee issue #77 requires: once a repo's tags have
// ever been fetched successfully, a later network failure (offline, Docker
// Hub down) at TTL expiry must not take that data away -- Get must keep
// serving the last known-good list rather than erroring.
//
// The TTL itself expiring is simulated by writing the disk cache file
// directly with a FetchedAt far in the past, rather than waiting out the
// real (12h) TTL or adding a test-only way to shorten it -- this is exactly
// the shape a real long-running editor process would hit after leaving the
// picker open across a lost connection.
func TestCache_Get_ExpiredCacheFallsBackToStaleDataOnFetchFailure(t *testing.T) {
	dir := t.TempDir()
	staleCacheJSON := `{"schemaVersion":1,"entries":{"cimg/node":{"tags":["20.11.0"],"fetchedAt":"2000-01-01T00:00:00Z"}}}`
	assert.NilError(t, os.WriteFile(filepath.Join(dir, "docker-tags.json"), []byte(staleCacheJSON), 0o600))

	lister := &fakeLister{err: errors.New("network unreachable")}
	cache := dockerhub.New(lister, dir)

	result, err := cache.Get(context.Background(), "cimg/node")
	assert.NilError(t, err, "a stale-but-present cache entry must not surface the fetch error")
	assert.Assert(t, !result.Live)
	assert.DeepEqual(t, result.Tags, []string{"20.11.0"})
	assert.Equal(t, lister.callCount(), 1, "must still have attempted a live fetch before falling back")

	// A repo with no prior data at all still surfaces the error -- there is
	// nothing to gracefully degrade to.
	_, err = cache.Get(context.Background(), "cimg/never-fetched")
	assert.ErrorContains(t, err, "network unreachable")
}

// TestCache_Refresh_BypassesTheTTL is Refresh's whole point (issue #285): a
// manual "check now" call fetches live even though the cached entry is well
// within cacheTTL, which Get itself would never do.
func TestCache_Refresh_BypassesTheTTL(t *testing.T) {
	lister := &fakeLister{tags: map[string][]dockerhub.Tag{
		"cimg/node": {{Name: "20.11.0"}},
	}}
	cache := dockerhub.New(lister, "")

	_, err := cache.Get(context.Background(), "cimg/node")
	assert.NilError(t, err)
	assert.Equal(t, lister.callCount(), 1)

	lister.mu.Lock()
	lister.tags["cimg/node"] = []dockerhub.Tag{{Name: "20.12.0"}, {Name: "20.11.0"}}
	lister.mu.Unlock()

	result, err := cache.Refresh(context.Background(), "cimg/node")
	assert.NilError(t, err)
	assert.Assert(t, result.Live)
	assert.DeepEqual(t, result.Tags, []string{"20.12.0", "20.11.0"})
	assert.Equal(t, lister.callCount(), 2, "Refresh must fetch live even though the cached entry is fresh")

	// And the refreshed result is what a plain Get now serves too.
	again, err := cache.Get(context.Background(), "cimg/node")
	assert.NilError(t, err)
	assert.Assert(t, !again.Live)
	assert.DeepEqual(t, again.Tags, []string{"20.12.0", "20.11.0"})
	assert.Equal(t, lister.callCount(), 2, "the just-refreshed entry must serve the next Get without another fetch")
}

// TestCache_Refresh_FailureFallsBackToTheCachedEntry mirrors Get's own
// graceful degradation: a manual refresh that fails must leave the
// previously cached tags in place and reachable, never blank them.
func TestCache_Refresh_FailureFallsBackToTheCachedEntry(t *testing.T) {
	lister := &fakeLister{tags: map[string][]dockerhub.Tag{
		"cimg/node": {{Name: "20.11.0"}},
	}}
	cache := dockerhub.New(lister, "")

	_, err := cache.Get(context.Background(), "cimg/node")
	assert.NilError(t, err)

	lister.mu.Lock()
	lister.err = errors.New("rate limited")
	lister.mu.Unlock()

	result, err := cache.Refresh(context.Background(), "cimg/node")
	assert.NilError(t, err, "a stale-but-present entry must not surface the refresh error")
	assert.Assert(t, !result.Live)
	assert.DeepEqual(t, result.Tags, []string{"20.11.0"})
}

// TestCache_Refresh_ConcurrentCallsForTheSameRepoShareOneFetch pins issue
// #285's rate-limit requirement for Docker Hub specifically: two overlapping
// Refresh calls for the same repo (a double click, or two tabs) must cost
// Docker Hub one request, with the second caller simply waiting for the
// first's result rather than firing its own.
func TestCache_Refresh_ConcurrentCallsForTheSameRepoShareOneFetch(t *testing.T) {
	lister := &fakeLister{
		tags: map[string][]dockerhub.Tag{
			"cimg/node": {{Name: "20.11.0"}},
		},
		unblock: make(chan struct{}),
	}
	cache := dockerhub.New(lister, "")

	type outcome struct {
		result dockerhub.Result
		err    error
	}
	results := make(chan outcome, 2)
	for range 2 {
		go func() {
			result, err := cache.Refresh(context.Background(), "cimg/node")
			results <- outcome{result, err}
		}()
	}

	// Give both goroutines a chance to reach ListTags before releasing it --
	// a flaky sleep would only make a real double-fetch bug harder to see,
	// never invalidate the assertion below.
	time.Sleep(20 * time.Millisecond)
	close(lister.unblock)

	for range 2 {
		out := <-results
		assert.NilError(t, out.err)
		assert.DeepEqual(t, out.result.Tags, []string{"20.11.0"})
	}
	assert.Equal(t, lister.callCount(), 1, "two concurrent refreshes of the same repo must make exactly one Docker Hub request")
}

// TestCache_Refresh_DifferentRepos_DoNotBlockEachOther guards against an
// over-broad lock: refreshing one repo must never make a concurrent refresh
// of an unrelated repo wait on it.
func TestCache_Refresh_DifferentRepos_DoNotBlockEachOther(t *testing.T) {
	lister := &fakeLister{
		tags: map[string][]dockerhub.Tag{
			"cimg/node": {{Name: "20.11.0"}},
			"cimg/go":   {{Name: "1.21.0"}},
		},
		unblock:   make(chan struct{}),
		blockRepo: "cimg/node",
	}
	cache := dockerhub.New(lister, "")

	nodeDone := make(chan struct{})
	go func() {
		_, _ = cache.Refresh(context.Background(), "cimg/node")
		close(nodeDone)
	}()

	// cimg/node is now blocked inside ListTags (unblock is not yet closed).
	// A refresh of an unrelated repo must not wait behind it.
	time.Sleep(20 * time.Millisecond)
	goResult, err := cache.Refresh(context.Background(), "cimg/go")
	assert.NilError(t, err)
	assert.DeepEqual(t, goResult.Tags, []string{"1.21.0"})

	close(lister.unblock)
	<-nodeDone
}

func TestCache_DiskRoundTrip_ReusedByFreshInstance(t *testing.T) {
	dir := t.TempDir()
	lister := &fakeLister{tags: map[string][]dockerhub.Tag{
		"cimg/python": {{Name: "3.13.0"}},
	}}
	cache := dockerhub.New(lister, dir)

	_, err := cache.Get(context.Background(), "cimg/python")
	assert.NilError(t, err)

	// A fresh Cache pointed at the same directory must reuse the persisted
	// file rather than needing its own fetch.
	lister2 := &fakeLister{}
	cache2 := dockerhub.New(lister2, dir)

	result, err := cache2.Get(context.Background(), "cimg/python")
	assert.NilError(t, err)
	assert.Assert(t, !result.Live)
	assert.DeepEqual(t, result.Tags, []string{"3.13.0"})
	assert.Equal(t, lister2.callCount(), 0, "must not have fetched when a fresh disk cache was available")
}

func TestCache_CorruptDiskCache_TriggersRefetchRatherThanErroring(t *testing.T) {
	dir := t.TempDir()
	lister := &fakeLister{tags: map[string][]dockerhub.Tag{
		"cimg/ruby": {{Name: "3.3.0"}},
	}}
	cache := dockerhub.New(lister, dir)
	_, err := cache.Get(context.Background(), "cimg/ruby")
	assert.NilError(t, err)

	entries, err := os.ReadDir(dir)
	assert.NilError(t, err)
	assert.Equal(t, len(entries), 1)
	assert.NilError(t, os.WriteFile(filepath.Join(dir, entries[0].Name()), []byte("{not valid json"), 0o600))

	lister2 := &fakeLister{tags: map[string][]dockerhub.Tag{
		"cimg/ruby": {{Name: "3.4.0"}},
	}}
	cache2 := dockerhub.New(lister2, dir)
	result, err := cache2.Get(context.Background(), "cimg/ruby")
	assert.NilError(t, err)
	assert.DeepEqual(t, result.Tags, []string{"3.4.0"})
	assert.Equal(t, lister2.callCount(), 1, "a corrupt cache file must trigger a re-fetch, not an error")
}

func TestCache_NoCacheDir_StillWorksWithoutPersisting(t *testing.T) {
	lister := &fakeLister{tags: map[string][]dockerhub.Tag{
		"cimg/base": {{Name: "current"}, {Name: "2024.01"}},
	}}
	cache := dockerhub.New(lister, "")

	result, err := cache.Get(context.Background(), "cimg/base")
	assert.NilError(t, err)
	assert.DeepEqual(t, result.Tags, []string{"2024.01"})
}

func TestCache_FetchedAtSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	lister := &fakeLister{tags: map[string][]dockerhub.Tag{
		"cimg/node": {{Name: "20.11.0"}},
	}}
	cache := dockerhub.New(lister, dir)
	first, err := cache.Get(context.Background(), "cimg/node")
	assert.NilError(t, err)
	assert.Assert(t, !first.FetchedAt.IsZero())

	time.Sleep(2 * time.Millisecond)

	cache2 := dockerhub.New(&fakeLister{}, dir)
	second, err := cache2.Get(context.Background(), "cimg/node")
	assert.NilError(t, err)
	assert.Equal(t, second.FetchedAt.UnixNano(), first.FetchedAt.UnixNano(),
		"the persisted fetch time must be preserved across instances, not reset to load time")
}

// TestCache_Get_AllTagsIsTheUnrankedSuperset is issue #213's data requirement:
// the picker's combobox types over the full tag list, so the ranked handful
// (Tags) can no longer be all the cache reports. Both are served, and AllTags is
// a superset containing the individual patch releases ranking collapses.
func TestCache_Get_AllTagsIsTheUnrankedSuperset(t *testing.T) {
	lister := &fakeLister{tags: map[string][]dockerhub.Tag{
		"cimg/node": {
			{Name: "latest"},
			{Name: "20.11.2"},
			{Name: "20.11.0"},
			{Name: "20.11.0-browsers"},
			{Name: "20.10.0"},
		},
	}}
	cache := dockerhub.New(lister, "")

	result, err := cache.Get(context.Background(), "cimg/node")
	assert.NilError(t, err)

	// Ranking still collapses 20.11.x to one representative, unchanged.
	assert.DeepEqual(t, result.Tags, []string{"20.11.2", "20.10.0"})
	// The full list keeps every version-shaped tag, in upstream's newest-first
	// order -- so someone who knows they want 20.11.2 can find it.
	assert.DeepEqual(t, result.AllTags, []string{"20.11.2", "20.11.0", "20.11.0-browsers", "20.10.0"})
	// `latest` is in neither: CircleCI's own docs tell users to avoid mutable
	// tags, so offering one as an option would contradict upstream's advice.
	// Typing it stays possible; the picker warns when you do.
	for _, tag := range result.AllTags {
		assert.Assert(t, tag != "latest")
	}
}

// TestCache_DiskCacheWithoutAllTags_FallsBackToTheRankedList covers an entry
// written by a build that predates AllTags. Rather than bump the schema version
// and throw away every user's warm cache to add one field, an entry with no
// AllTags serves the ranked list for both -- a slightly shorter combobox for at
// most one TTL, instead of a re-fetch storm on upgrade.
func TestCache_DiskCacheWithoutAllTags_FallsBackToTheRankedList(t *testing.T) {
	dir := t.TempDir()
	assert.NilError(t, os.WriteFile(
		filepath.Join(dir, "docker-tags.json"),
		[]byte(`{"schemaVersion":1,"entries":{"cimg/go":{"tags":["1.21.0"],"fetchedAt":"`+
			time.Now().UTC().Format(time.RFC3339Nano)+`"}}}`),
		0o600,
	))

	lister := &fakeLister{}
	cache := dockerhub.New(lister, dir)
	result, err := cache.Get(context.Background(), "cimg/go")
	assert.NilError(t, err)

	assert.Equal(t, lister.callCount(), 0, "a pre-AllTags entry is still fresh and must not force a re-fetch")
	assert.DeepEqual(t, result.Tags, []string{"1.21.0"})
	assert.DeepEqual(t, result.AllTags, []string{"1.21.0"})
}

// TestCache_Get_TruncatedFetchIsLabelledNotSilent is issue #243's honesty
// requirement, mirroring #259's rule for the orb cache: a listing that
// is shorter than it should be because Docker Hub cut the crawl short (rate
// limiting, most likely) must say so, on both the live response and the
// persisted entry a later restart reads back -- never silently presented as
// a complete list.
func TestCache_Get_TruncatedFetchIsLabelledNotSilent(t *testing.T) {
	dir := t.TempDir()
	lister := &fakeLister{
		tags:            map[string][]dockerhub.Tag{"cimg/node": {{Name: "20.11.0"}}},
		truncated:       true,
		truncatedReason: "Docker Hub rate-limited this request (HTTP 429)",
	}
	cache := dockerhub.New(lister, dir)

	result, err := cache.Get(context.Background(), "cimg/node")
	assert.NilError(t, err)
	assert.Assert(t, result.Truncated)
	assert.Equal(t, result.TruncatedReason, "Docker Hub rate-limited this request (HTTP 429)")

	// A fresh instance reading the persisted entry back must see the same
	// flag -- it is a fact about the data, not about the in-flight request.
	cache2 := dockerhub.New(&fakeLister{}, dir)
	result2, err := cache2.Get(context.Background(), "cimg/node")
	assert.NilError(t, err)
	assert.Assert(t, !result2.Live)
	assert.Assert(t, result2.Truncated)
	assert.Equal(t, result2.TruncatedReason, "Docker Hub rate-limited this request (HTTP 429)")
}

// TestCache_Get_UntruncatedFetchDoesNotClaimTruncation guards the opposite
// direction: an ordinary, complete fetch must not be mislabelled truncated
// just because the field exists now.
func TestCache_Get_UntruncatedFetchDoesNotClaimTruncation(t *testing.T) {
	lister := &fakeLister{tags: map[string][]dockerhub.Tag{"cimg/node": {{Name: "20.11.0"}}}}
	cache := dockerhub.New(lister, "")

	result, err := cache.Get(context.Background(), "cimg/node")
	assert.NilError(t, err)
	assert.Assert(t, !result.Truncated)
	assert.Equal(t, result.TruncatedReason, "")
}
