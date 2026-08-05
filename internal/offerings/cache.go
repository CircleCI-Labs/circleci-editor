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

// Package offerings caches CircleCI's live machine-image catalog (issue
// #305): GET /api/v3/catalog/offerings, which lists the machine images
// offered per resource class (linux/windows/macos) plus a deprecated list
// keyed by executor.
//
// # Why this cache looks like internal/dockerhub's, not internal/orbs's
//
// The catalog is one small (~20KB) JSON document, not a 6,400-entry registry
// to crawl -- so, like internal/dockerhub.Cache and unlike internal/orbs.Cache,
// there is no two-stage warm and no warm-on-startup at all: fetching it
// eagerly on every launch would be an outbound request most sessions never
// need (many editing sessions never open the machine-image or Xcode
// picker). Get fetches lazily, on the first call that needs it, and
// remembers the result -- in memory and on disk -- for cacheTTL.
//
// # Why this cache has no embedded fallback of its own
//
// internal/guides.Cache always has *something* to serve (an embedded
// AsciiDoc snapshot) even on a cold, offline start. This cache does not: there
// is no vendored copy of a live catalog to embed, and issue #242 already
// established the reason a *derived* fallback is not attempted either --
// "a correct literal beats a wrong derived one" holds exactly as much for a
// network outage as it did for the vendored docs' own gap. So when this cache
// has never successfully fetched anything (this process or, via the disk
// file, a previous one), Get returns an error and the caller — GET
// /api/machine-offerings, per its own doc comment — reports that honestly,
// and the SPA's picker falls back one layer further, to images.ts's
// hand-curated MACHINE_IMAGES literal. Fetched data supersedes that literal;
// a fetch failure falls back to it and says so.
//
// # The five states issue #285 asks every cache to make honest
//
//   - never fetched: Status().Attempted is false.
//   - fetching: Status().Fetching is true.
//   - fetched-and-empty: Attempted, no Err, Status().Empty.
//   - failed-with-reason: Status().Err is non-nil and FetchedAt is zero --
//     nothing has ever been fetched, and Err says why.
//   - stale-but-labelled: FetchedAt is non-zero and Status().Stale is true.
//     A non-nil Err alongside a non-zero FetchedAt is the specific case of
//     this state where the *most recent* refresh attempt is what failed,
//     leaving the previous (now ageing) catalog in place -- exactly
//     internal/orbs.Status.Err's own convention.
package offerings

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
)

const (
	// cacheSchemaVersion is bumped whenever the on-disk JSON shape changes
	// incompatibly. Mirrors internal/orbs, internal/dockerhub and
	// internal/guides, same rationale: a file written by an older schema
	// is discarded rather than mis-decoded.
	cacheSchemaVersion = 1

	// diskFileName is this cache's file within the shared cache directory
	// (orbs.DefaultCacheDir -- one cache root for the whole application,
	// one file per feature).
	diskFileName = "offerings.json"

	// cacheTTL bounds how long a fetched catalog is served before Get
	// re-fetches. Shorter than internal/guides' seven days (a live compute
	// inventory changes on the order of days, e.g. a new resource-class
	// generation appearing, not weeks like prose documentation) and longer
	// than internal/dockerhub's twelve hours (this is CircleCI's own
	// catalog, not a third party publishing dozens of tags a week) --
	// twenty-four hours, matching internal/orbs.RefreshWindow's own
	// "once a day is enough for a background process; a button covers the
	// rest" reasoning.
	cacheTTL = 24 * time.Hour

	// fetchTimeout bounds one fetch attempt. Ten seconds: the catalog is a
	// single ~20KB request (verified live), so this only ever matters
	// against an unreachable or hung network, not a slow-but-working one.
	fetchTimeout = 10 * time.Second
)

// Fetcher is the subset of *circleci.Client this cache needs, defined here
// (rather than depended on directly) so tests can substitute a fake without
// making any HTTP calls -- same rationale as internal/orbs.OrbLister and
// internal/dockerhub.TagLister.
type Fetcher interface {
	GetOfferings(ctx context.Context) (*circleci.Offerings, error)
}

// Status describes the cache's current state, honestly -- see the package
// doc comment for how its fields combine into the five states issue #285
// asks every cache to be able to report.
type Status struct {
	// Attempted reports whether a fetch has ever completed (successfully or
	// not) for this cache, in this process or, via the disk file, a
	// previous one.
	Attempted bool
	// Fetching reports that a fetch is in flight right now.
	Fetching bool
	// FetchedAt is when the currently-held catalog was fetched. Zero iff
	// nothing has ever been successfully fetched.
	FetchedAt time.Time
	// Empty reports that the most recent successful fetch returned a
	// catalog with no linux, windows or macos entries at all -- a
	// well-formed but unhelpful response, distinct from a fetch failure.
	Empty bool
	// Stale reports that FetchedAt is set and is older than cacheTTL.
	// Computed fresh on every Status() call, exactly as
	// internal/orbs.Status.Stale is.
	Stale bool
	// Err is the most recent fetch failure, if any. Sharing this field
	// between "failed, nothing cached" and "stale, last refresh failed" is
	// deliberate -- see the package doc comment -- and callers distinguish
	// the two the same way internal/host's guides/orbs handlers already do:
	// by whether FetchedAt is zero.
	Err error
}

// Result is what Get and Refresh return: one fetch (or cache-hit)'s worth
// of catalog, plus enough provenance for a caller to say honestly where it
// came from.
type Result struct {
	// Offerings is the catalog itself.
	Offerings circleci.Offerings
	// FetchedAt is when this catalog was actually fetched -- not
	// necessarily "just now": a cache hit reports the original fetch time.
	FetchedAt time.Time
	// Live is true iff this call performed a network fetch, false if
	// served from the in-memory/disk cache without one.
	Live bool
	// Empty mirrors Status.Empty for this specific result.
	Empty bool
}

// entry is both the in-memory and on-disk representation of the one catalog
// this cache holds.
type entry struct {
	Offerings circleci.Offerings `json:"offerings"`
	FetchedAt time.Time          `json:"fetchedAt"`
}

func isEmptyOfferings(o circleci.Offerings) bool {
	return len(o.Linux) == 0 && len(o.Windows) == 0 && len(o.MacOS) == 0
}

func (e entry) result(live bool) Result {
	return Result{
		Offerings: e.Offerings,
		FetchedAt: e.FetchedAt,
		Live:      live,
		Empty:     isEmptyOfferings(e.Offerings),
	}
}

// diskCache is the on-disk JSON shape written by save and read by
// ensureLoaded.
type diskCache struct {
	SchemaVersion int   `json:"schemaVersion"`
	Entry         entry `json:"entry"`
}

// pendingFetch is the one in-flight fetch, shared with any concurrent
// caller -- whether it arrived via Get's TTL-miss path or a manual
// Refresh -- mirrors internal/dockerhub's pendingRefresh: a "check now"
// button next to a picker is exactly the kind of control someone
// double-clicks, or that two browser tabs open on the same dialog trigger
// at once, and this catalog is one shared resource (unlike Docker Hub's
// per-repo tags), so *every* concurrent caller shares one request.
type pendingFetch struct {
	done   chan struct{}
	result Result
	err    error
}

// Cache is a small, disk-persisted cache of one CircleCI catalog: the
// currently-offered machine images, keyed by resource class. See the
// package doc comment for why it looks like internal/dockerhub's cache
// rather than internal/orbs' or internal/guides'.
type Cache struct {
	client   Fetcher
	cacheDir string

	mu        sync.RWMutex
	loaded    bool // whether the disk file has been read into current yet.
	attempted bool
	fetching  bool
	current   entry
	err       error

	fetchMu sync.Mutex
	pending *pendingFetch
}

// New constructs a Cache. client supplies the catalog fetch (a real
// *circleci.Client in production, a fake in tests). cacheDir is the
// directory the persisted cache file lives under (see
// internal/orbs.DefaultCacheDir, which the host also uses for this cache);
// an empty cacheDir disables disk persistence, matching every other cache
// in this project.
func New(client Fetcher, cacheDir string) *Cache {
	return &Cache{client: client, cacheDir: cacheDir}
}

// Get returns the current catalog, fetching it first if nothing is cached
// or the cached copy is older than cacheTTL.
//
// Graceful degradation is the point, not an edge case, mirroring
// internal/dockerhub.Cache.Get: a fetch failure falls back to whatever is
// already cached -- even past cacheTTL -- rather than erroring (see
// Status's own doc comment for "stale-but-labelled"). Get only returns an
// error when there is truly nothing to fall back to: no catalog has ever
// been fetched, in this process or a previous one via the disk file, and
// this fetch also failed. Callers (internal/host's handler) treat that as
// "unavailable" and the SPA falls back further still, to images.ts's own
// vendored MACHINE_IMAGES literal -- the same degradation chain
// internal/dockerhub's own doc comment describes for Docker Hub tags.
func (c *Cache) Get(ctx context.Context) (Result, error) {
	c.ensureLoaded()

	c.mu.RLock()
	cur, attempted := c.current, c.attempted
	c.mu.RUnlock()

	if attempted && time.Since(cur.FetchedAt) < cacheTTL {
		return cur.result(false), nil
	}

	return c.fetchShared(ctx)
}

// Refresh forces a live fetch, ignoring cacheTTL, for the manual "check
// now" affordance issue #285 established and issue #305 extends to this
// cache. It shares fetchShared's dedupe with Get: a refresh already in
// flight (started by a concurrent Get's own TTL miss, or another Refresh)
// makes this call wait for that result rather than issuing a second
// request.
func (c *Cache) Refresh(ctx context.Context) (Result, error) {
	c.ensureLoaded()
	return c.fetchShared(ctx)
}

// fetchShared performs (or waits on) one live fetch, deduplicating
// concurrent callers -- see pendingFetch's doc comment for why every
// concurrent caller shares one request, unlike internal/dockerhub's
// per-repo dedupe.
func (c *Cache) fetchShared(ctx context.Context) (Result, error) {
	c.fetchMu.Lock()
	if existing := c.pending; existing != nil {
		c.fetchMu.Unlock()
		<-existing.done
		return existing.result, existing.err
	}
	pending := &pendingFetch{done: make(chan struct{})}
	c.pending = pending
	c.fetchMu.Unlock()

	result, err := c.fetchLive(ctx)

	c.fetchMu.Lock()
	c.pending = nil
	c.fetchMu.Unlock()

	pending.result, pending.err = result, err
	close(pending.done)

	return result, err
}

// fetchLive performs the actual round trip, publishes and persists the
// result on success, and degrades on failure exactly as Get's doc comment
// describes.
func (c *Cache) fetchLive(ctx context.Context) (Result, error) {
	c.mu.Lock()
	c.fetching = true
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.fetching = false
		c.mu.Unlock()
	}()

	fetchCtx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()

	fetched, err := c.client.GetOfferings(fetchCtx)
	if err != nil {
		c.mu.Lock()
		c.attempted = true
		c.err = err
		fallback := c.current
		hadPrevious := !fallback.FetchedAt.IsZero()
		c.mu.Unlock()

		if hadPrevious {
			// Stale-but-present beats erroring out -- see Get's doc comment.
			return fallback.result(false), nil
		}
		return Result{}, fmt.Errorf("offerings: fetch machine-image catalog: %w", err)
	}

	e := entry{Offerings: *fetched, FetchedAt: time.Now().UTC()}
	c.mu.Lock()
	c.attempted = true
	c.err = nil
	c.current = e
	c.mu.Unlock()

	c.save(e)

	return e.result(true), nil
}

// Status reports the cache's current state without triggering a fetch --
// see the package doc comment for how its fields read as one of the five
// honest states issue #285 asks for.
func (c *Cache) Status() Status {
	c.mu.RLock()
	defer c.mu.RUnlock()

	stale := c.attempted && !c.current.FetchedAt.IsZero() && time.Since(c.current.FetchedAt) > cacheTTL
	empty := c.attempted && c.err == nil && isEmptyOfferings(c.current.Offerings)

	return Status{
		Attempted: c.attempted,
		Fetching:  c.fetching,
		FetchedAt: c.current.FetchedAt,
		Empty:     empty,
		Stale:     stale,
		Err:       c.err,
	}
}

// ensureLoaded reads the disk cache file into memory exactly once per
// Cache -- lazily, on the first Get/Refresh/Status call, rather than in
// New, so constructing a Cache never does file I/O a caller didn't ask for.
// Mirrors internal/dockerhub.Cache.ensureLoaded.
func (c *Cache) ensureLoaded() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.loaded {
		return
	}
	c.loaded = true

	path := c.diskPath()
	if path == "" {
		return
	}

	data, err := os.ReadFile(path) //nolint:gosec // path is derived from an operator-controlled cache directory plus a fixed filename, not from request input.
	if err != nil {
		return // No file yet, or unreadable -- either way, start empty and let Get populate it.
	}

	var dc diskCache
	if err := json.Unmarshal(data, &dc); err != nil {
		return // Corrupt file -- ignored, same as every other cache in this project; the next fetch just repopulates it.
	}
	if dc.SchemaVersion != cacheSchemaVersion {
		return
	}
	if dc.Entry.FetchedAt.IsZero() {
		return
	}

	c.current = dc.Entry
	c.attempted = true
}

// diskPath returns this Cache's persisted file path, or "" if disk
// persistence is disabled (empty cacheDir).
func (c *Cache) diskPath() string {
	if c.cacheDir == "" {
		return ""
	}
	return filepath.Join(c.cacheDir, diskFileName)
}

// save persists e to disk atomically (write to a temp file in the same
// directory, then rename over the target path), mirroring every other
// cache in this project. It never returns an error: a failure to persist
// only costs the next process start a re-fetch.
func (c *Cache) save(e entry) {
	path := c.diskPath()
	if path == "" {
		return
	}

	data, err := json.Marshal(diskCache{SchemaVersion: cacheSchemaVersion, Entry: e})
	if err != nil {
		return
	}

	if mkdirErr := os.MkdirAll(c.cacheDir, 0o750); mkdirErr != nil {
		return
	}

	tmp, err := os.CreateTemp(c.cacheDir, "offerings-*.tmp")
	if err != nil {
		return
	}
	tmpPath := tmp.Name()

	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(tmpPath) //nolint:gosec // tmpPath is chosen by os.CreateTemp itself inside c.cacheDir, not from request input.
		return
	}

	_ = os.Rename(tmpPath, path) //nolint:gosec // see above.
}
