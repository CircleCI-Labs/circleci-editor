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

package dockerhub

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	// cacheSchemaVersion is bumped whenever the on-disk JSON shape changes
	// incompatibly -- see loadDisk. Mirrors internal/orbs/cache.go's own
	// diskCacheSchemaVersion, same rationale.
	cacheSchemaVersion = 1

	// cacheTTL bounds how long an in-memory or on-disk entry is trusted
	// before Get re-fetches. Shorter than internal/orbs's 24h: this
	// project's own vendored variant-suffix list already says (see
	// images.ts) that a cimg/* image cuts a new tag "roughly every few
	// weeks," so half a day of staleness is a closer match to how often
	// this data actually changes than a full day would be, while still
	// keeping repeat picker opens within a session fetch-free.
	cacheTTL = 12 * time.Hour

	// diskFileName is the cache file's name within the shared cache
	// directory (see internal/orbs.DefaultCacheDir, reused by the host for
	// this cache too -- there is exactly one cache root for the whole
	// application, per-feature files within it).
	diskFileName = "docker-tags.json"

	// maxTagsFetch bounds how many of a repo's tags ListTags will collect in
	// total across every page it follows (issue #243).
	//
	// Chosen as five of Client's own dockerHubPageSize-tag pages: enough that
	// "hundreds of tags" (the combobox's own framing, and genuinely true of a
	// popular cimg/* repo -- cimg/node alone has published 300+) is actually
	// true of what gets offered, while keeping a cold cache fill to a small,
	// fixed number of sequential Docker Hub requests -- at most five, only when
	// this repo's 12h disk-cache entry (cacheTTL) has actually expired or never
	// existed, never on every picker open. An unbounded crawl of every page a
	// popular image has would cost this same request budget on every such
	// fill for marginal benefit: RankVersionTags's representatives and almost
	// every tag someone would plausibly search for already show up well
	// within the first page or two.
	maxTagsFetch = 5 * dockerHubPageSize

	// maxRankedTags bounds how many ranked version tags Get returns.
	maxRankedTags = 8

	// maxAllTags bounds how many *unranked* version tags Get returns in
	// Result.AllTags -- the list the image picker's combobox types over (issue
	// #213).
	//
	// Equal to maxTagsFetch, i.e. "all of them", because that is the most this
	// package ever fetches and reducing it further would only reintroduce the
	// problem the combobox exists to solve: a tag the user knows they want and
	// cannot find. It is still a bound rather than an unbounded slice, so this
	// stays predictable regardless of how many pages a fetch happened to follow.
	maxAllTags = maxTagsFetch
)

// TagLister is the subset of *Client the cache needs, defined here (rather
// than depended on directly) so tests can substitute a fake without making
// any HTTP calls -- same rationale as internal/orbs.OrbLister.
type TagLister interface {
	ListTags(ctx context.Context, repo string, maxTags int) (Page, error)
}

// Result is what Cache.Get returns: a ranked, ready-to-display tag list for
// one repo, plus enough provenance for the UI to say honestly where it came
// from.
type Result struct {
	// Tags is the ranked version-tag list (see RankVersionTags), newest
	// first. Never nil on success, though it may be empty if the repo
	// publishes no version-shaped tags at all.
	Tags []string
	// AllTags is every version-shaped tag this repo published across the
	// pages fetched (see VersionTags), newest first and bounded by maxAllTags
	// -- up to maxTagsFetch tags, not just one page's worth (issue #243). A
	// superset of Tags.
	//
	// Both are served because the picker needs both: Tags is what it
	// *recommends*, AllTags is what type-to-filter searches (issue #213). May
	// be empty for an entry cached by a build that predates it, in which case
	// the caller falls back to Tags -- see the SPA's own handling in
	// imageTags.ts. Not necessarily every tag Docker Hub has for this repo --
	// see Truncated for whether even this list is known to have been cut
	// short of that.
	AllTags []string
	// FetchedAt is when Tags was actually fetched from Docker Hub -- not
	// necessarily "just now": a cache hit reports the original fetch time,
	// so the UI can show staleness rather than implying every response is
	// fresh.
	FetchedAt time.Time
	// Live is true iff this call itself performed a network fetch, false if
	// served from the in-memory/disk cache without one.
	Live bool
	// Truncated reports that the fetch behind this result (this call's own,
	// if Live, or the one that populated the cache entry, if not) stopped
	// early for a reason other than reaching maxTagsFetch or genuinely running
	// out of pages -- Docker Hub returned an error (rate limiting, most likely)
	// partway through pagination. See Client.Page's own doc comment. Never set
	// merely because maxTagsFetch was reached with more tags left on Docker
	// Hub: that bound is this package's own deliberate choice, not a
	// degradation worth flagging.
	Truncated bool
	// TruncatedReason explains Truncated, e.g. naming the HTTP status Docker
	// Hub returned. Set iff Truncated.
	TruncatedReason string
}

// entry is both the in-memory and on-disk representation of one cached
// repo's tags.
//
// AllTags is `omitempty` and read back without a schema bump on purpose: an
// entry written by an older build simply has none, and Get then serves the
// ranked list for both fields rather than treating the file as unreadable.
// Bumping cacheSchemaVersion would discard every user's warm cache to add a
// field whose absence is already handled, which is a worse trade than one
// afternoon of slightly shorter tag lists.
type entry struct {
	Tags      []string  `json:"tags"`
	AllTags   []string  `json:"allTags,omitempty"`
	FetchedAt time.Time `json:"fetchedAt"`
	// Truncated and TruncatedReason mirror Result's own fields -- omitempty,
	// and read back without a schema bump, on the same reasoning as AllTags: an
	// entry written by a build that predates pagination simply has neither, and
	// false/"" is the correct reading of "we don't know this fetch was cut
	// short," not a lie.
	Truncated       bool   `json:"truncated,omitempty"`
	TruncatedReason string `json:"truncatedReason,omitempty"`
}

// result turns a cache entry into what Get returns, filling AllTags from the
// ranked list when the entry predates it (see the type's doc comment). A caller
// therefore never has to distinguish "this repo published no tags" from "this
// entry was written by an older build".
func (e entry) result(live bool) Result {
	all := e.AllTags
	if len(all) == 0 {
		all = e.Tags
	}
	return Result{
		Tags:            e.Tags,
		AllTags:         all,
		FetchedAt:       e.FetchedAt,
		Live:            live,
		Truncated:       e.Truncated,
		TruncatedReason: e.TruncatedReason,
	}
}

// diskCache is the on-disk JSON shape written by save and read by loadDisk.
type diskCache struct {
	SchemaVersion int              `json:"schemaVersion"`
	Entries       map[string]entry `json:"entries"`
}

// Cache is a small, disk-persisted, per-repo TTL cache of ranked Docker Hub
// version tags. Unlike internal/orbs.Cache, there is no warm-on-startup
// stage: fetching every cimg/* repo's tags eagerly would mean ~20 outbound
// requests before the editor has any idea whether the user will ever open
// the image picker, for data that (per cacheTTL) is fine to fetch lazily,
// the first time it's actually needed. Get therefore fetches on demand and
// remembers the result, both in memory and on disk, for next time.
type Cache struct {
	client   TagLister
	cacheDir string

	mu      sync.Mutex
	entries map[string]entry
	loaded  bool // whether the disk file has been read into entries yet.

	// refreshMu and refreshing back Refresh's own dedupe (issue #285): a
	// refresh already running for a given repo makes a second call wait on
	// the first's result rather than issuing a second Docker Hub request.
	// Separate from mu (which only ever guards entries/loaded) so a refresh
	// in flight for one repo never blocks an unrelated Get/Refresh for
	// another.
	refreshMu  sync.Mutex
	refreshing map[string]*pendingRefresh
}

// pendingRefresh is one in-flight Refresh call, shared with any concurrent
// caller asking to refresh the same repo. done closes once result/err are
// set, mirroring the orbs package's warmDone-style "closed channel as a
// completion signal" convention.
type pendingRefresh struct {
	done   chan struct{}
	result Result
	err    error
}

// New constructs a Cache. client supplies tag listings (a real *Client in
// production, a fake in tests). cacheDir is the directory the persisted
// cache file lives under (see internal/orbs.DefaultCacheDir, which the host
// also uses for this cache -- so orb and Docker Hub caches share one root
// directory); an empty cacheDir disables disk persistence, matching
// internal/orbs.Cache's own convention.
func New(client TagLister, cacheDir string) *Cache {
	return &Cache{
		client:     client,
		cacheDir:   cacheDir,
		entries:    make(map[string]entry),
		refreshing: make(map[string]*pendingRefresh),
	}
}

// Get returns repo's ranked version tags (see RankVersionTags), consulting
// (and populating) the cache first.
//
// Graceful degradation is the point of this method, not an edge case: a
// fetch failure (no network, Docker Hub unreachable, a non-200 response)
// falls back to whatever is already cached -- even past its TTL -- rather
// than erroring, since a stale tag list is still far more useful than none.
// Get only returns an error when there is truly nothing to fall back to:
// no cache entry has ever been populated for repo, in this process or a
// previous one via the disk file, and the fetch itself failed. Callers
// (internal/host's handler) treat that as "unavailable" and the SPA falls
// back further still, to images.ts's own vendored variant list -- see this
// package's own doc comment for the full degradation chain.
func (c *Cache) Get(ctx context.Context, repo string) (Result, error) {
	c.ensureLoaded()

	c.mu.Lock()
	cached, ok := c.entries[repo]
	c.mu.Unlock()

	if ok && time.Since(cached.FetchedAt) < cacheTTL {
		return cached.result(false), nil
	}

	return c.fetchLive(ctx, repo)
}

// Refresh forces a live Docker Hub fetch for repo, ignoring cacheTTL, for the
// manual "check now" affordance issue #285 adds to the image tag picker. It
// stores the result exactly as Get does on a natural TTL expiry -- same
// on-disk entry, same fallback to whatever was cached before on a fetch
// failure (see fetchLive) -- so the only difference from Get is *when* the
// fetch happens, never how its result is handled.
//
// A refresh already running for this exact repo makes a second call wait for
// the first's result rather than issuing a second request: Docker Hub
// rate-limits anonymous callers (issue #243 already had to reason about that
// limit), and a refresh button is exactly the kind of control someone clicks
// twice, or that two browser tabs open on the same image trigger at once.
func (c *Cache) Refresh(ctx context.Context, repo string) (Result, error) {
	c.ensureLoaded()

	c.refreshMu.Lock()
	if existing, inFlight := c.refreshing[repo]; inFlight {
		c.refreshMu.Unlock()
		<-existing.done
		return existing.result, existing.err
	}
	pending := &pendingRefresh{done: make(chan struct{})}
	c.refreshing[repo] = pending
	c.refreshMu.Unlock()

	result, err := c.fetchLive(ctx, repo)

	c.refreshMu.Lock()
	delete(c.refreshing, repo)
	c.refreshMu.Unlock()

	pending.result, pending.err = result, err
	close(pending.done)

	return result, err
}

// fetchLive performs the actual Docker Hub round trip behind both Get (on a
// TTL miss) and Refresh (unconditionally), ranks and stores the result, and
// degrades the same way in both cases: a fetch failure falls back to
// whatever this repo already had cached -- even if that entry is itself
// stale -- rather than erroring, since a stale tag list is still far more
// useful than none (see Get's own doc comment for the fuller rationale).
// Only returns an error when there is truly nothing to fall back to: no
// entry has ever been populated for repo and the fetch itself failed.
func (c *Cache) fetchLive(ctx context.Context, repo string) (Result, error) {
	c.mu.Lock()
	cached, ok := c.entries[repo]
	c.mu.Unlock()

	page, err := c.client.ListTags(ctx, repo, maxTagsFetch)
	if err != nil {
		if ok {
			// Stale-but-present beats erroring out -- see Get's doc comment.
			return cached.result(false), nil
		}
		return Result{}, fmt.Errorf("dockerhub: fetch tags for %s: %w", repo, err)
	}

	names := make([]string, len(page.Tags))
	for i, t := range page.Tags {
		names[i] = t.Name
	}
	ranked := RankVersionTags(names, maxRankedTags)
	all := VersionTags(names, maxAllTags)
	fetchedAt := time.Now()

	c.mu.Lock()
	c.entries[repo] = entry{
		Tags:            ranked,
		AllTags:         all,
		FetchedAt:       fetchedAt,
		Truncated:       page.Truncated,
		TruncatedReason: page.TruncatedReason,
	}
	snapshot := make(map[string]entry, len(c.entries))
	for k, v := range c.entries {
		snapshot[k] = v
	}
	c.mu.Unlock()

	c.save(snapshot)

	return Result{
		Tags:            ranked,
		AllTags:         all,
		FetchedAt:       fetchedAt,
		Live:            true,
		Truncated:       page.Truncated,
		TruncatedReason: page.TruncatedReason,
	}, nil
}

// ensureLoaded reads the disk cache file into c.entries exactly once per
// Cache -- lazily, on the first Get, rather than in New, so constructing a
// Cache never does file I/O a caller didn't ask for.
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
		return // Corrupt file -- ignored, same as internal/orbs.Cache.loadFreshDiskCache; Get will just re-fetch.
	}
	if dc.SchemaVersion != cacheSchemaVersion {
		return
	}
	c.entries = dc.Entries
	if c.entries == nil {
		c.entries = make(map[string]entry)
	}
}

// diskPath returns this Cache's persisted file path, or "" if disk
// persistence is disabled (empty cacheDir).
func (c *Cache) diskPath() string {
	if c.cacheDir == "" {
		return ""
	}
	return filepath.Join(c.cacheDir, diskFileName)
}

// save persists entries to disk atomically (write to a temp file in the same
// directory, then rename over the target path), mirroring
// internal/orbs/cache.go's saveDiskCache. It never returns an error: a
// failure to persist only costs the next process start a re-fetch, so it is
// silently ignored -- there is no logf hook here the way internal/orbs.Cache
// has one, since a single failed write is far less consequential than a
// failed orb-registry crawl and not worth plumbing a logger through for.
func (c *Cache) save(entries map[string]entry) {
	path := c.diskPath()
	if path == "" {
		return
	}

	data, err := json.Marshal(diskCache{SchemaVersion: cacheSchemaVersion, Entries: entries})
	if err != nil {
		return
	}

	if mkdirErr := os.MkdirAll(c.cacheDir, 0o750); mkdirErr != nil {
		return
	}

	tmp, err := os.CreateTemp(c.cacheDir, "docker-tags-*.tmp")
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
