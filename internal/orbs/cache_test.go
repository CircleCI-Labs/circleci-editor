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

package orbs_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
	"github.com/CircleCI-Labs/circleci-editor/internal/orbs"
)

// fakeLister is a fake implementation of orbs.OrbLister, standing in for a
// real *circleci.Client. Calls are dispatched on opts.Certified so tests can
// script the certified stage and the full crawl independently; unblock (if
// non-nil) is read once before returning, letting tests hold the full crawl
// open to observe intermediate cache Status.
//
// The cache deliberately performs a single unfiltered full crawl (the registry
// ignores filter[visibility]), so anything that is not the certified query is
// served from the public field.
type fakeLister struct {
	mu sync.Mutex

	certified []circleci.OrbPackage
	public    []circleci.OrbPackage

	certifiedErr error
	publicErr    error

	// publicRejectAboveLimit, when non-zero, makes the full-crawl branch
	// simulate the API's observed page-size ceiling: any call whose
	// opts.Limit exceeds this returns a 502 ResourceExhausted APIError with
	// the exact body IsResourceExhausted matches, instead of publicErr or
	// public. It lets tests exercise listWithPageSizeFallback without a real
	// HTTP server, by scripting the same "too large" response the live API
	// was observed to give at page[limit] above 500.
	publicRejectAboveLimit int

	publicUnblock chan struct{} // closed by the test to let the full crawl proceed.
	// publicEntered, when non-nil, receives once as the full crawl begins.
	// Reaching that point proves the certified stage has already finished, so
	// a test can assert on the state between the two stages without racing
	// the background goroutine. Sent to without blocking so a second call
	// cannot deadlock here.
	publicEntered chan struct{}

	calls []circleci.ListOrbsOptions
}

func (f *fakeLister) ListAllOrbPackages(ctx context.Context, opts circleci.ListOrbsOptions, onPage func(int)) ([]circleci.OrbPackage, error) {
	f.mu.Lock()
	f.calls = append(f.calls, opts)
	f.mu.Unlock()

	switch {
	case opts.Certified != nil && *opts.Certified:
		if f.certifiedErr != nil {
			return nil, f.certifiedErr
		}
		if onPage != nil {
			onPage(len(f.certified))
		}
		return f.certified, nil
	default:
		if f.publicEntered != nil {
			select {
			case f.publicEntered <- struct{}{}:
			default:
			}
		}
		if f.publicUnblock != nil {
			select {
			case <-f.publicUnblock:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		if f.publicRejectAboveLimit > 0 && opts.Limit > f.publicRejectAboveLimit {
			return nil, resourceExhaustedErr()
		}
		if f.publicErr != nil {
			return nil, f.publicErr
		}
		if onPage != nil {
			onPage(len(f.public))
		}
		return f.public, nil
	}
}

// resourceExhaustedErr builds the exact *circleci.APIError shape observed
// from the live orb registry when page[limit] is too large: HTTP 502, body
// {"error":{"type":"ResourceExhausted","title":"Bad Gateway."}}. Used by
// fakeLister to simulate that boundary without a real HTTP server.
func resourceExhaustedErr() error {
	return &circleci.APIError{
		StatusCode: 502,
		Method:     "GET",
		Path:       "/api/v3/orb/packages",
		Body:       `{"error":{"type":"ResourceExhausted","title":"Bad Gateway."}}`,
	}
}

func (f *fakeLister) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func pkgV(name, id, version string) circleci.OrbPackage {
	return circleci.OrbPackage{
		ID:   id,
		Name: name,
		Versions: []circleci.OrbVersion{
			{ID: id + "-v1", Version: version, CreatedAt: time.Now()},
		},
	}
}

// waitWarm blocks until done (a Cache's WarmDone() channel) closes, failing
// the test if that takes longer than timeout.
//
// done closes exactly when the background crawl's goroutine returns (or,
// for the fresh-disk-cache fast path, before Start even returns), so under
// normal conditions this returns as soon as that happens rather than on
// some fixed cadence. timeout exists only as a backstop against a genuine
// hang -- a wedged fake or a real deadlock -- never as a budget the crawl
// is expected to take; do not read it as a performance assertion.
func waitWarm(t *testing.T, done <-chan struct{}, timeout time.Duration) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(timeout):
		t.Fatalf("warm did not finish within %s", timeout)
	}
}

func TestCache_TwoStageWarm_CertifiedSearchableBeforeFullCrawlFinishes(t *testing.T) {
	lister := &fakeLister{
		certified:     []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		public:        []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0"), pkgV("someorg/extra", "e1", "1.0.0")},
		publicUnblock: make(chan struct{}),
	}

	cache := orbs.New(lister, "", "example.com", nil)

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	cache.Start(ctx)

	// Start returns once the certified stage is done; the full crawl is
	// blocked on publicUnblock, so the cache should be Ready but not yet
	// Complete, with only the certified orb searchable.
	status := cache.Status()
	assert.Assert(t, status.Ready)
	assert.Assert(t, !status.Complete)
	assert.Equal(t, status.Count, 1)

	results := cache.Search("node", 10)
	assert.Equal(t, len(results), 1)
	assert.Equal(t, results[0].Package.Name, "circleci/node")

	close(lister.publicUnblock)

	waitWarm(t, cache.WarmDone(), 2*time.Second)
	status = cache.Status()
	assert.Equal(t, status.Count, 2)
	assert.Assert(t, !status.FetchedAt.IsZero())

	// Certification learned from stage 1 must carry through to the orb
	// found again by the full crawl.
	results = cache.Search("circleci/node", 10)
	assert.Equal(t, len(results), 1)
	assert.Assert(t, results[0].Package.Certified)

	extra := cache.Search("extra", 10)
	assert.Equal(t, len(extra), 1)
	assert.Assert(t, !extra[0].Package.Certified)
}

func TestCache_DiskRoundTrip_ReusedWithinTTL(t *testing.T) {
	dir := t.TempDir()
	lister := &fakeLister{
		certified: []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		public:    []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
	}

	cache := orbs.New(lister, dir, "circleci.com", nil)
	cache.Start(context.Background())
	waitWarm(t, cache.WarmDone(), 2*time.Second)

	// Count only the persisted cache file. A leftover temp file from a failed
	// write would otherwise be indistinguishable from success, and asserting
	// on the raw entry count made this sensitive to write ordering.
	cacheFiles := func() []string {
		entries, err := os.ReadDir(dir)
		assert.NilError(t, err)
		var names []string
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
				names = append(names, e.Name())
			}
		}
		return names
	}

	assert.Assert(t, len(cacheFiles()) == 1,
		"expected exactly one persisted cache file, got %v", cacheFiles())

	// A second Cache pointed at the same directory/host must reuse the
	// file rather than crawling again.
	lister2 := &fakeLister{}
	cache2 := orbs.New(lister2, dir, "circleci.com", nil)
	cache2.Start(context.Background())

	status := cache2.Status()
	assert.Assert(t, status.Ready)
	assert.Assert(t, status.Complete)
	assert.Equal(t, status.Count, 1)
	assert.Equal(t, lister2.callCount(), 0, "must not have made any API calls when a fresh disk cache was available")
}

func TestCache_DiskCache_DifferentHostDoesNotCollide(t *testing.T) {
	dir := t.TempDir()
	listerA := &fakeLister{
		certified: []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		public:    []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
	}
	cacheA := orbs.New(listerA, dir, "circleci.com", nil)
	cacheA.Start(context.Background())
	waitWarm(t, cacheA.WarmDone(), 2*time.Second)

	// A different host must not see cacheA's persisted file.
	listerB := &fakeLister{
		certified: []circleci.OrbPackage{pkgV("selfhosted/orb", "s1", "1.0.0")},
		public:    []circleci.OrbPackage{pkgV("selfhosted/orb", "s1", "1.0.0")},
	}
	cacheB := orbs.New(listerB, dir, "self-hosted.example.com", nil)
	cacheB.Start(context.Background())
	waitWarm(t, cacheB.WarmDone(), 2*time.Second)

	assert.Assert(t, listerB.callCount() > 0, "expected cacheB to crawl independently of cacheA's cache file")
}

func TestCache_CorruptDiskCache_TriggersRecrawl(t *testing.T) {
	dir := t.TempDir()

	// Write a garbage file at some plausible cache path. Since the exact
	// hashed filename is an implementation detail, write garbage to every
	// entry a first (successful) run would have created, by first running
	// once to learn the path, then corrupting it.
	lister := &fakeLister{
		certified: []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		public:    []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
	}
	cache := orbs.New(lister, dir, "circleci.com", nil)
	cache.Start(context.Background())
	waitWarm(t, cache.WarmDone(), 2*time.Second)

	entries, err := os.ReadDir(dir)
	assert.NilError(t, err)
	assert.Equal(t, len(entries), 1)
	path := filepath.Join(dir, entries[0].Name())
	assert.NilError(t, os.WriteFile(path, []byte("{not valid json"), 0o600))

	lister2 := &fakeLister{
		certified: []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		public:    []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0"), pkgV("someorg/second", "s1", "1.0.0")},
	}
	cache2 := orbs.New(lister2, dir, "circleci.com", nil)
	cache2.Start(context.Background())
	waitWarm(t, cache2.WarmDone(), 2*time.Second)

	assert.Assert(t, lister2.callCount() > 0, "corrupt cache file must trigger a re-crawl")
	assert.Equal(t, cache2.Status().Count, 2)
}

// writeDiskCache overwrites the cache file a previous run created with the
// same packages under a chosen FetchedAt, which is how the age-dependent paths
// below are exercised without waiting out RefreshWindow. It returns the path.
func writeDiskCache(t *testing.T, dir string, fetchedAt time.Time) string {
	t.Helper()

	entries, err := os.ReadDir(dir)
	assert.NilError(t, err)
	assert.Equal(t, len(entries), 1, "expected exactly one persisted cache file")
	path := filepath.Join(dir, entries[0].Name())

	data, err := os.ReadFile(path) //nolint:gosec // a path this test just created inside t.TempDir().
	assert.NilError(t, err)

	var raw map[string]any
	assert.NilError(t, json.Unmarshal(data, &raw))
	raw["fetchedAt"] = fetchedAt.Format(time.RFC3339Nano)

	rewritten, err := json.Marshal(raw)
	assert.NilError(t, err)
	assert.NilError(t, os.WriteFile(path, rewritten, 0o600))
	return path
}

// A persisted listing older than RefreshWindow used to be discarded, which
// meant an old file plus an unreachable API produced an empty orb browser --
// the app throwing away the only registry listing it had at exactly the moment
// it could not get another (issue #257). It is now served, flagged Stale, while
// the replacing crawl runs.
func TestCache_StaleDiskCache_IsServedAndFlaggedStale(t *testing.T) {
	dir := t.TempDir()

	seed := &fakeLister{
		certified: []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		public: []circleci.OrbPackage{
			pkgV("circleci/node", "n1", "1.0.0"),
			pkgV("someorg/second", "s1", "1.0.0"),
		},
	}
	seedCache := orbs.New(seed, dir, "circleci.com", nil)
	seedCache.Start(context.Background())
	waitWarm(t, seedCache.WarmDone(), 2*time.Second)
	writeDiskCache(t, dir, time.Now().Add(-30*24*time.Hour))

	// The re-crawl fails, which is the whole point: what is on screen has to
	// come from the expired file rather than from nothing.
	failing := &fakeLister{
		publicErr: &circleci.APIError{StatusCode: 503, Method: "GET", Path: "/api/v3/orb/packages", Body: "boom"},
	}
	cache := orbs.New(failing, dir, "circleci.com", nil)
	cache.Start(context.Background())

	status := cache.Status()
	assert.Equal(t, status.Count, 2, "the expired listing must still be searchable")
	assert.Assert(t, status.Ready)
	assert.Assert(t, status.Stale, "a listing older than RefreshWindow must be flagged, not silently served as current")
	assert.Assert(t, len(cache.Search("node", 5)) > 0)

	// The certified stage is skipped on this path on purpose: it would replace
	// the full stale set with the certified subset, which is fewer orbs and not
	// obviously fresher.
	waitWarm(t, cache.WarmDone(), 2*time.Second)
	failing.mu.Lock()
	for _, opts := range failing.calls {
		assert.Assert(t, opts.Certified == nil || !*opts.Certified,
			"a stale-cache start must go straight to the full crawl")
	}
	failing.mu.Unlock()

	final := cache.Status()
	assert.Equal(t, final.Count, 2, "a failed refresh must not empty the list it could not refresh")
	assert.Assert(t, final.Stale)
}

// The same expired file, but the crawl succeeds: the stale listing is a
// fallback, never something that sticks around once real data arrives.
func TestCache_StaleDiskCache_IsReplacedByASuccessfulCrawl(t *testing.T) {
	dir := t.TempDir()

	seed := &fakeLister{
		certified: []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		public:    []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
	}
	seedCache := orbs.New(seed, dir, "circleci.com", nil)
	seedCache.Start(context.Background())
	waitWarm(t, seedCache.WarmDone(), 2*time.Second)
	writeDiskCache(t, dir, time.Now().Add(-30*24*time.Hour))

	fresh := &fakeLister{
		public: []circleci.OrbPackage{
			pkgV("circleci/node", "n1", "1.0.0"),
			pkgV("someorg/second", "s1", "1.0.0"),
			pkgV("someorg/third", "t1", "1.0.0"),
		},
	}
	cache := orbs.New(fresh, dir, "circleci.com", nil)
	cache.Start(context.Background())
	waitWarm(t, cache.WarmDone(), 2*time.Second)

	status := cache.Status()
	assert.Assert(t, status.Complete)
	assert.Assert(t, !status.Stale, "a fresh crawl must clear the stale flag")
	assert.Assert(t, status.Err == nil)
}

// A fresh file is still the fast path: no crawl at all, and not stale.
func TestCache_FreshDiskCache_IsNotStale(t *testing.T) {
	dir := t.TempDir()

	seed := &fakeLister{
		certified: []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		public:    []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
	}
	seedCache := orbs.New(seed, dir, "circleci.com", nil)
	seedCache.Start(context.Background())
	waitWarm(t, seedCache.WarmDone(), 2*time.Second)

	reused := &fakeLister{}
	cache := orbs.New(reused, dir, "circleci.com", nil)
	cache.Start(context.Background())

	status := cache.Status()
	assert.Assert(t, status.Complete)
	assert.Assert(t, !status.Stale)
	assert.Equal(t, reused.callCount(), 0, "a fresh disk cache must not trigger any API call")
}

// A crawl in flight is reported from the moment Start begins, not only once
// something has been published. Without it, a failed certified stage left
// Warming false with nothing published, so "nothing yet, and a fetch is
// running" was indistinguishable from "nothing, and nothing is being done
// about it" -- the two states issue #257 needs told apart.
func TestCache_WarmingIsSetBeforeTheFirstPublish(t *testing.T) {
	entered := make(chan struct{}, 1)
	lister := &fakeLister{
		certifiedErr:  &circleci.APIError{StatusCode: 500, Method: "GET", Path: "/api/v3/orb/packages", Body: "boom"},
		publicErr:     &circleci.APIError{StatusCode: 500, Method: "GET", Path: "/api/v3/orb/packages", Body: "boom"},
		publicUnblock: make(chan struct{}),
		publicEntered: entered,
	}

	cache := orbs.New(lister, "", "example.com", nil)
	cache.Start(context.Background())

	// Wait for the full crawl to have begun, and hold it there.
	//
	// Both stages fail immediately against this fake -- there is no network to
	// be slow -- so the entire warm cycle could finish before the assertions
	// below ran, at which point Warming is legitimately false and this test
	// failed on the scheduler rather than on the cache. It did exactly that on
	// CI, on a branch that touched no Go code.
	//
	// Blocking the crawl makes the state being asserted the *only* state the
	// cache can be in: the certified stage has failed and published nothing
	// (reaching the full crawl proves it finished), and the crawl cannot
	// complete until this test allows it.
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the full crawl to start")
	}

	status := cache.Status()
	assert.Equal(t, status.Count, 0)
	assert.Assert(t, status.Err != nil, "the certified-stage failure must be recorded")
	assert.Assert(t, status.Warming, "a crawl is running, and an empty list must be able to say so")

	// Once that crawl fails too, Warming drops and the reason is what is left.
	close(lister.publicUnblock)
	waitWarm(t, cache.WarmDone(), 2*time.Second)
	assert.Assert(t, cache.Status().Err != nil)
}

// TestCache_FullCrawlIsUnfiltered guards against re-introducing a second,
// visibility-filtered crawl. The registry ignores filter[visibility] and
// returns the identical set for public and private, so crawling twice
// duplicated every orb in search results.
func TestCache_FullCrawlIsUnfiltered(t *testing.T) {
	lister := &fakeLister{
		certified: []circleci.OrbPackage{},
		public:    []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
	}

	cache := orbs.New(lister, "", "example.com", nil)
	cache.Start(context.Background())
	waitWarm(t, cache.WarmDone(), 2*time.Second)

	lister.mu.Lock()
	defer lister.mu.Unlock()

	fullCrawls := 0
	for _, opts := range lister.calls {
		if opts.Certified != nil && *opts.Certified {
			continue
		}
		fullCrawls++
		assert.Equal(t, opts.Visibility, "",
			"the full crawl must not send filter[visibility]; the API ignores it and returns the whole registry either way")
	}
	assert.Equal(t, fullCrawls, 1, "the registry must be crawled exactly once")
	assert.Equal(t, cache.Status().Count, 1)
}

// TestCache_DuplicateOrbsCollapse covers a registry (or overlapping pages)
// returning the same orb more than once: search must show it a single time,
// keeping the copy with the fullest version list.
func TestCache_DuplicateOrbsCollapse(t *testing.T) {
	twoVersions := pkgV("circleci/node", "n1", "1.0.0")
	twoVersions.Versions = append(twoVersions.Versions, circleci.OrbVersion{ID: "v2", Version: "2.0.0"})

	lister := &fakeLister{
		certified: []circleci.OrbPackage{},
		public: []circleci.OrbPackage{
			pkgV("circleci/node", "n1", "1.0.0"),
			twoVersions,
			pkgV("circleci/node", "n1", "1.0.0"),
		},
	}

	cache := orbs.New(lister, "", "example.com", nil)
	cache.Start(context.Background())
	waitWarm(t, cache.WarmDone(), 2*time.Second)

	assert.Equal(t, cache.Status().Count, 1, "a duplicated orb must collapse to one entry")

	results := cache.Search("node", 10)
	assert.Equal(t, len(results), 1)
	assert.Equal(t, len(results[0].Package.Versions), 2, "the entry with the most versions must win")
}

// TestCache_CertifiedFlagSurvivesFullCrawl covers the ranking bug where the
// full crawl replaced the certified set and dropped the Certified flag, so an
// official orb lost its tie-break and fell below unrelated same-name orbs.
func TestCache_CertifiedFlagSurvivesFullCrawl(t *testing.T) {
	lister := &fakeLister{
		certified: []circleci.OrbPackage{pkgV("circleci/slack", "s1", "4.0.0")},
		public: []circleci.OrbPackage{
			pkgV("amos47/slack", "a1", "1.0.0"),
			pkgV("circleci/slack", "s1", "4.0.0"),
		},
	}

	cache := orbs.New(lister, "", "example.com", nil)
	cache.Start(context.Background())
	waitWarm(t, cache.WarmDone(), 2*time.Second)

	results := cache.Search("slack", 10)
	assert.Assert(t, len(results) > 0)
	assert.Equal(t, results[0].Package.Name, "circleci/slack",
		"the certified orb must outrank an equally-matching community orb")
	assert.Assert(t, results[0].Package.Certified, "the certified flag must survive the full crawl")
}

func TestCache_PublicCrawlFailure_KeepsCertifiedResultsReady(t *testing.T) {
	lister := &fakeLister{
		certified: []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		publicErr: &circleci.APIError{StatusCode: 500, Method: "GET", Path: "/api/v3/orb/packages", Body: "boom"},
	}

	cache := orbs.New(lister, "", "example.com", nil)
	cache.Start(context.Background())

	waitWarm(t, cache.WarmDone(), 2*time.Second)
	status := cache.Status()
	assert.Assert(t, status.Ready)
	assert.Assert(t, !status.Complete)
	assert.Equal(t, status.Count, 1, "the certified-only set from stage 1 must remain searchable")

	// Issue #257: the failure is carried as an error value, not a string, so
	// the caller has to classify it (internal/host's describeUpstreamError)
	// before showing it. *circleci.APIError's own Error() text embeds the
	// upstream response body -- "boom", here -- which must never reach a
	// browser, and a string field would have made forwarding it the path of
	// least resistance.
	code, ok := circleci.StatusCode(status.Err)
	assert.Assert(t, ok, "the warm error must still be classifiable as an API error")
	assert.Equal(t, code, 500)
}

// TestCache_FullCrawl_DegradesPageSizeOnResourceExhausted covers the boundary
// moving: if the API starts rejecting fullCrawlPageLimit as too large (the
// shape circleci.IsResourceExhausted recognises), the crawl must retry at a
// smaller page size rather than fail outright and lose the whole registry
// listing -- the point of issue B's page-size fallback.
func TestCache_FullCrawl_DegradesPageSizeOnResourceExhausted(t *testing.T) {
	lister := &fakeLister{
		certified:              []circleci.OrbPackage{},
		public:                 []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		publicRejectAboveLimit: 200, // rejects the starting 500 and its first halving (250); accepts 125 and below.
	}

	cache := orbs.New(lister, "", "example.com", nil)
	cache.Start(context.Background())
	waitWarm(t, cache.WarmDone(), 2*time.Second)

	status := cache.Status()
	assert.Assert(t, status.Complete, "the crawl must still complete once it degrades to a page size the API accepts")
	assert.Assert(t, status.Err == nil, "a page-size retry that goes on to succeed must not leave a stale error behind")
	assert.Equal(t, status.Count, 1)

	// The full crawl must have tried more than once, at strictly decreasing
	// limits, proving the fallback -- not a lucky first attempt -- is what
	// produced the result above.
	lister.mu.Lock()
	var limits []int
	for _, opts := range lister.calls {
		if opts.Certified == nil {
			limits = append(limits, opts.Limit)
		}
	}
	lister.mu.Unlock()

	assert.Assert(t, len(limits) >= 2, "expected at least one retry at a smaller page size, got calls %v", limits)
	for i := 1; i < len(limits); i++ {
		assert.Assert(t, limits[i] < limits[i-1], "page size must strictly decrease on each retry: %v", limits)
	}
	assert.Assert(t, limits[len(limits)-1] <= 200, "the crawl's last attempt must be a page size the fake accepts: %v", limits)
}

// TestCache_FullCrawl_GivesUpPastPageSizeFloor covers the other half of the
// same design: if even the smallest page size the fallback will try is
// rejected -- from this response alone, indistinguishable from an ordinary
// outage that happens to share the same error shape -- the crawl must still
// terminate and report the failure normally, rather than retry forever.
func TestCache_FullCrawl_GivesUpPastPageSizeFloor(t *testing.T) {
	lister := &fakeLister{
		certified:              []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		publicRejectAboveLimit: 50, // rejects every page size the fallback will try, including its floor.
	}

	cache := orbs.New(lister, "", "example.com", nil)
	cache.Start(context.Background())
	waitWarm(t, cache.WarmDone(), 2*time.Second)

	status := cache.Status()
	assert.Assert(t, !status.Complete, "a crawl that never finds an accepted page size must not be reported as complete")
	assert.Assert(t, status.Err != nil, "the exhausted fallback must still report a failure, not silently vanish")
	code, ok := circleci.StatusCode(status.Err)
	assert.Assert(t, ok, "the failure must still be classifiable as an API error")
	assert.Equal(t, code, 502)
	assert.Equal(t, status.Count, 1, "the certified-only set from stage 1 must remain searchable despite the full-crawl failure")

	// Bounded: the fallback must not have kept retrying below its floor, and
	// its last attempt must be exactly that floor rather than some smaller
	// guess.
	lister.mu.Lock()
	var limits []int
	for _, opts := range lister.calls {
		if opts.Certified == nil {
			limits = append(limits, opts.Limit)
		}
	}
	lister.mu.Unlock()

	assert.Assert(t, len(limits) <= 10, "the page-size fallback must be bounded, not an unbounded retry loop: %v", limits)
	assert.Equal(t, limits[len(limits)-1], 100, "the fallback's last attempt must be exactly its floor")
}

func TestCache_CertifiedStageFailure_StillAttemptsFullCrawl(t *testing.T) {
	lister := &fakeLister{
		certifiedErr: &circleci.APIError{StatusCode: 500, Method: "GET", Path: "/api/v3/orb/packages", Body: "boom"},
		public:       []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
	}

	cache := orbs.New(lister, "", "example.com", nil)
	cache.Start(context.Background())

	// Even though certified failed (so Start returns having published
	// nothing yet), the full crawl must still run in the background and
	// eventually make the cache Ready and Complete.
	waitWarm(t, cache.WarmDone(), 2*time.Second)
	assert.Equal(t, cache.Status().Count, 1)
}

func TestCache_StatusTransitions(t *testing.T) {
	lister := &fakeLister{
		certified:     []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		public:        []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		publicUnblock: make(chan struct{}),
	}
	cache := orbs.New(lister, "", "example.com", nil)

	initial := cache.Status()
	assert.Assert(t, !initial.Ready)
	assert.Assert(t, !initial.Complete)

	cache.Start(context.Background())

	afterCertified := cache.Status()
	assert.Assert(t, afterCertified.Ready)
	assert.Assert(t, !afterCertified.Complete)
	assert.Assert(t, afterCertified.Warming)

	close(lister.publicUnblock)
	waitWarm(t, cache.WarmDone(), 2*time.Second)

	final := cache.Status()
	assert.Assert(t, final.Ready)
	assert.Assert(t, final.Complete)
	assert.Assert(t, !final.Warming)
}

// waitUntilNotWarming polls cache.Status().Warming until it is false, failing
// if timeout elapses first. Unlike waitWarm, this does not read WarmDone:
// that channel closes exactly once, on Start's own warm attempt, so a crawl
// started later by Refresh needs its own way to observe completion.
func waitUntilNotWarming(t *testing.T, cache *orbs.Cache, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !cache.Status().Warming {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("cache did not stop warming within %s", timeout)
}

// TestCache_Refresh_NoOpWhileWarming pins issue #285's rate-limit
// requirement: a refresh button sitting next to a ~6,400-orb crawl must not
// be able to start a second one just because it was clicked while the first
// (here, Start's own) is still running.
func TestCache_Refresh_NoOpWhileWarming(t *testing.T) {
	lister := &fakeLister{
		certified:     []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		public:        []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		publicUnblock: make(chan struct{}),
	}
	cache := orbs.New(lister, "", "example.com", nil)
	cache.Start(context.Background())

	assert.Assert(t, cache.Status().Warming, "the full crawl must still be running")
	callsBeforeRefresh := lister.callCount()

	cache.Refresh(context.Background())
	// No new crawl was started, so no new request was made -- Refresh
	// returning promptly rather than blocking on the existing crawl is itself
	// part of the assertion (a blocking Refresh would also happen to pass the
	// call-count check below by accident).
	assert.Equal(t, lister.callCount(), callsBeforeRefresh)

	close(lister.publicUnblock)
	waitWarm(t, cache.WarmDone(), 2*time.Second)
}

// TestCache_Refresh_RecrawlsAndReplacesTheListing covers the happy path: once
// Start's own warm has finished, Refresh performs a genuinely new crawl and
// its result -- not the one Start already published -- is what Search then
// returns.
func TestCache_Refresh_RecrawlsAndReplacesTheListing(t *testing.T) {
	lister := &fakeLister{
		certified: []circleci.OrbPackage{},
		public:    []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
	}
	cache := orbs.New(lister, "", "example.com", nil)
	cache.Start(context.Background())
	waitWarm(t, cache.WarmDone(), 2*time.Second)

	firstFetchedAt := cache.Status().FetchedAt
	assert.Equal(t, cache.Status().Count, 1)

	// Simulate a newly published orb version turning up on the next crawl --
	// exactly the scenario the owner asked this button to shorten the wait
	// for.
	lister.mu.Lock()
	lister.public = []circleci.OrbPackage{
		pkgV("circleci/node", "n1", "1.0.0"),
		pkgV("circleci/go", "g1", "1.0.0"),
	}
	lister.mu.Unlock()

	cache.Refresh(context.Background())
	waitUntilNotWarming(t, cache, 2*time.Second)

	status := cache.Status()
	assert.Equal(t, status.Count, 2, "the re-crawl's result must replace the old listing")
	assert.Assert(t, status.FetchedAt.After(firstFetchedAt) || status.FetchedAt.Equal(firstFetchedAt),
		"FetchedAt must advance to the new crawl's time, never regress")

	results := cache.Search("go", 10)
	assert.Assert(t, len(results) > 0, "the newly published orb must be searchable after Refresh")
}

// TestCache_Refresh_FailureLeavesThePreviousListingInPlace is issue #257's
// rule applied to a manually triggered refresh, not just the automatic one:
// a failed refresh must never blank what was already being served.
func TestCache_Refresh_FailureLeavesThePreviousListingInPlace(t *testing.T) {
	lister := &fakeLister{
		certified: []circleci.OrbPackage{},
		public:    []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
	}
	cache := orbs.New(lister, "", "example.com", nil)
	cache.Start(context.Background())
	waitWarm(t, cache.WarmDone(), 2*time.Second)
	assert.Equal(t, cache.Status().Count, 1)

	lister.mu.Lock()
	lister.publicErr = &circleci.APIError{StatusCode: 503, Method: "GET", Path: "/api/v3/orb/packages", Body: "boom"}
	lister.mu.Unlock()

	cache.Refresh(context.Background())
	waitUntilNotWarming(t, cache, 2*time.Second)

	status := cache.Status()
	assert.Equal(t, status.Count, 1, "the previous listing must still be served, not blanked")
	assert.Assert(t, status.Err != nil, "the failed refresh must be recorded")
}

// Status breaks its Count down by the two facts a search can be filtered on
// (issue #151). PrivateCount is the load-bearing one: the UI uses "zero
// private orbs cached" to say something honest about what the crawl was shown,
// which it can only do if this count is reported rather than guessed at.
func TestCache_StatusCountsCertifiedAndPrivateOrbs(t *testing.T) {
	private := pkgV("myorg/deploy", "p1", "1.0.0")
	private.Private = true

	lister := &fakeLister{
		certified: []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		public: []circleci.OrbPackage{
			pkgV("circleci/node", "n1", "1.0.0"),
			pkgV("acme/thing", "a1", "1.0.0"),
			private,
		},
	}

	cache := orbs.New(lister, "", "example.com", nil)
	cache.Start(context.Background())
	waitWarm(t, cache.WarmDone(), 2*time.Second)

	status := cache.Status()
	assert.Equal(t, status.Count, 3)
	assert.Equal(t, status.CertifiedCount, 1)
	assert.Equal(t, status.PrivateCount, 1)

	// And the same crawl is searchable through the filter, so a caller never
	// has to re-derive the scope from Packages() itself.
	page := cache.SearchFiltered("", orbs.FilterPrivate, 10)
	assert.Equal(t, len(page.Results), 1)
	assert.Equal(t, page.Results[0].Package.Name, "myorg/deploy")
	assert.Equal(t, page.ScopeSize, 1)
}

func TestCache_StartCancellation_StopsBackgroundCrawlPromptly(t *testing.T) {
	block := make(chan struct{})
	lister := &fakeLister{
		certified:     []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		publicUnblock: block,
	}
	t.Cleanup(func() { close(block) })

	ctx, cancel := context.WithCancel(context.Background())
	cache := orbs.New(lister, "", "example.com", nil)
	cache.Start(ctx)

	assert.Assert(t, cache.Status().Ready)
	cancel()

	// The background crawl should observe ctx cancellation and stop
	// without ever marking the cache Complete or publishing an Error. Proven
	// here by waiting for the goroutine itself to return (WarmDone), not by
	// guessing how long that takes with a fixed sleep -- block is still open,
	// so warmFull only unblocks via ctx.Done().
	waitWarm(t, cache.WarmDone(), 2*time.Second)
	status := cache.Status()
	assert.Assert(t, !status.Complete)
	assert.Assert(t, status.Err == nil)
}

// TestCache_StartCalledTwice_ClosingWarmDoneDoesNotPanic guards WarmDone's
// documented call-once contract against actually crashing when it is
// violated. Start is not supposed to be called twice on the same Cache, but
// if a future caller does it anyway -- a retry, a re-warm on token change --
// each call's warmFull tries to close the same warmDone channel on its own
// background goroutine, and closing an already-closed channel panics.
// Without a guard around the close, that panic would land on a background
// goroutine and take the whole process down, over a misuse this type should
// simply make harmless.
//
// Both Start calls are made before publicUnblock is closed, so their two
// warmFull goroutines are genuinely racing to close warmDone (not just
// closing it one after the other), which is what makes this test meaningful
// under -race as well as without it.
func TestCache_StartCalledTwice_ClosingWarmDoneDoesNotPanic(t *testing.T) {
	lister := &fakeLister{
		certified:     []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		public:        []circleci.OrbPackage{pkgV("circleci/node", "n1", "1.0.0")},
		publicUnblock: make(chan struct{}),
	}
	cache := orbs.New(lister, "", "example.com", nil)

	cache.Start(context.Background())
	cache.Start(context.Background())

	close(lister.publicUnblock)

	// If either warmFull's close(warmDone) were unguarded, one of these two
	// goroutines would panic before ever reaching here, taking the test
	// binary down with it rather than failing this assertion cleanly.
	waitWarm(t, cache.WarmDone(), 2*time.Second)
	assert.Assert(t, cache.Status().Complete)
}

func TestDefaultCacheDir_HonoursXDGCacheHome(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", "/tmp/xdg-cache-example")
	dir, err := orbs.DefaultCacheDir()
	assert.NilError(t, err)
	assert.Equal(t, dir, filepath.Join("/tmp/xdg-cache-example", "circleci-editor"))
}

func TestDefaultCacheDir_FallsBackToDotCache(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", "")
	dir, err := orbs.DefaultCacheDir()
	assert.NilError(t, err)
	assert.Assert(t, is.Contains(dir, filepath.Join(".cache", "circleci-editor")))
}
