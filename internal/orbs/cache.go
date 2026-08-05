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

package orbs

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
)

const (
	// diskCacheSchemaVersion is bumped whenever the on-disk JSON shape
	// changes incompatibly; loadFreshDiskCache refuses to reuse a file
	// written by a different schema version, forcing a re-crawl instead of
	// risking a mismatched decode.
	diskCacheSchemaVersion = 1

	// cacheTTL bounds how long a persisted cache is trusted before Start
	// re-crawls instead of reusing it. Exported as RefreshWindow, because a
	// UI that labels a list "stale" has to be able to say what it is stale
	// relative to (issue #257).
	cacheTTL = 24 * time.Hour

	// certifiedPageLimit and fullCrawlPageLimit request the API's maximum
	// page size, minimising the number of requests needed.
	certifiedPageLimit = 100
	fullCrawlPageLimit = 100

	// certifiedWarmTimeout bounds the "instant" first stage of Start (one
	// request for the certified orbs) so a slow or unreachable API cannot
	// delay it indefinitely; the full crawl (warmFull) is bounded
	// separately and more generously, by fullCrawlTimeout.
	certifiedWarmTimeout = 30 * time.Second

	// fullCrawlTimeout bounds the background crawl of the full registry
	// (~64 requests at fullCrawlPageLimit for the ~6,400-orb public
	// registry, plus a private-orb pass). It exists only to guarantee
	// eventual termination if the API becomes unresponsive mid-crawl;
	// ordinary Start/shutdown cancellation (via ctx) is the normal way this
	// stops early.
	fullCrawlTimeout = 15 * time.Minute
)

// RefreshWindow is how old a fetched orb list may be before Start re-crawls
// rather than reusing it, and therefore what Status.Stale is measured against.
// Exported so a caller reporting "this list is stale" can name the window it
// is stale relative to instead of asserting staleness with nothing behind it.
const RefreshWindow = cacheTTL

// OrbLister is the subset of *circleci.Client the cache needs, defined here
// (rather than depended on directly) so tests can substitute a fake without
// making any HTTP calls.
type OrbLister interface {
	ListAllOrbPackages(ctx context.Context, opts circleci.ListOrbsOptions, onPage func(int)) ([]circleci.OrbPackage, error)
}

// Status describes the Cache's current warm state.
type Status struct {
	// Ready reports whether Search has anything useful to search yet
	// (true as soon as the certified-orb stage completes, or immediately
	// if a fresh disk cache was loaded).
	Ready bool

	// Complete reports whether the full-registry crawl (including a
	// best-effort pass over private orbs) has finished. Search remains
	// usable — over the certified-only set — even when this is false.
	Complete bool

	// Count is the number of orb packages currently searchable.
	Count int

	// CertifiedCount and PrivateCount break Count down by the two facts a
	// search can be filtered on (see Filter). They exist so a UI can answer
	// "why is my filtered list empty" honestly: zero private orbs cached is
	// a statement about what this host's token was shown while crawling, not
	// about whether the user's organizations have private orbs, and the two
	// must never be conflated. Reported here rather than derived by the
	// caller so nothing has to walk the whole package slice to find out.
	CertifiedCount int
	PrivateCount   int

	// FetchedAt is when the current (complete) data set was fetched. It is
	// the zero time while Complete is false, since a partial (certified
	// only) result is never persisted or treated as "fetched" in the sense
	// the TTL cares about.
	FetchedAt time.Time

	// Stale reports that FetchedAt is set and is older than RefreshWindow:
	// the packages are a real registry listing that is simply out of date,
	// which is materially different from having none. Derived by Status()
	// rather than stored, since it is a fact about *now*.
	Stale bool

	// Warming reports whether a crawl is currently in progress in the
	// background.
	Warming bool

	// Err is the most recent warm failure, if any. It never prevents Search
	// from working — it is surfaced only so a caller can tell the user why
	// the list they are looking at is empty, short, or old.
	//
	// It is an error rather than the pre-#257 string, and that is the whole
	// point of the field's shape. *circleci.APIError embeds the upstream
	// response body in its Error() text, so a string here is a body waiting
	// to be forwarded somewhere it must never go. Handing the caller
	// the error value instead forces it through whatever classifier it
	// already uses for upstream failures — internal/host's
	// describeUpstreamError, which discloses the status code and nothing
	// else — before any of it can reach a browser or a log line.
	Err error
}

// Cache holds a locally-searchable, periodically-refreshed copy of the
// CircleCI orb registry.
//
// Cache warms in two stages, so search is useful almost immediately rather
// than only after a full crawl:
//
//  1. Start fetches the certified orbs (one request, ~79 orbs at the time
//     of writing) synchronously and marks the cache Ready.
//  2. Start then crawls the full public registry (~6,400 orbs, ~64
//     requests) in the background, and separately attempts to include
//     private orbs (best-effort: a permissions error there is logged, not
//     fatal). Once that finishes, the result atomically replaces the
//     certified-only set and the cache is marked Complete, and persisted to
//     disk for next time.
//
// A Search call never blocks on the background crawl.
type Cache struct {
	client   OrbLister
	cacheDir string
	host     string
	logf     func(string, ...any)

	mu       sync.RWMutex
	packages []OrbPackage
	status   Status

	// warmDone is closed once Start's current warm attempt has nothing
	// further to publish: either the fresh-disk-cache fast path returned
	// without starting a background crawl, or the background crawl
	// (warmFull) has returned, however it ended (success, failure, or ctx
	// cancellation). See WarmDone.
	//
	// warmDoneOnce guards the close. Start is documented as call-once (see
	// WarmDone), but closing an already-closed channel panics, and for
	// warmFull's close that panic lands on a background goroutine -- taking
	// the whole host down over a misuse (a retry, a re-warm on token change)
	// this type can just as easily make harmless instead. Guarding the close
	// costs nothing on the correct, single-Start path.
	warmDone     chan struct{}
	warmDoneOnce sync.Once
}

// closeWarmDone closes warmDone. Safe to call more than once (only the first
// call has any effect): see warmDoneOnce.
func (c *Cache) closeWarmDone() {
	c.warmDoneOnce.Do(func() { close(c.warmDone) })
}

// New constructs a Cache. client supplies orb-listing calls (a
// *circleci.Client in production, a fake in tests). cacheDir is the
// directory persisted caches are written under (see DefaultCacheDir); an
// empty cacheDir disables disk persistence. host distinguishes the on-disk
// cache file per CircleCI host (CIRCLE_HOST), so switching between, say,
// circleci.com and a self-hosted installation never mixes their orbs.
// logf receives diagnostic messages (never fatal to the cache's operation);
// a nil logf discards them.
func New(client OrbLister, cacheDir, host string, logf func(string, ...any)) *Cache {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &Cache{client: client, cacheDir: cacheDir, host: host, logf: logf, warmDone: make(chan struct{})}
}

// WarmDone returns a channel that is closed once the warm attempt started by
// Start has finished publishing everything it is going to publish: either
// the fresh-disk-cache fast path returned without starting a background
// crawl at all, or the background full-registry crawl has returned —
// whether it succeeded, failed, or was cut short by ctx cancellation.
//
// It exists so callers can synchronize with the crawl's completion directly
// instead of polling Status() on a wall-clock budget, which turns a
// deterministic "the goroutine returned" event into a race against however
// busy the machine happens to be. Production code has no need for it today
// (nothing currently blocks on the crawl finishing); it is exported because
// package orbs_test is a black-box test package and has no other way to
// observe the same event.
//
// Start must be called before the channel closes, and must not be called
// more than once on a given Cache: a second warm attempt closes the same
// channel a first one already closed, so it cannot signal its own,
// separate completion. That second close is harmless (see warmDoneOnce) --
// it just means a caller that starts a second warm gets no way to wait for
// it through this channel, not a crash.
func (c *Cache) WarmDone() <-chan struct{} {
	return c.warmDone
}

// Status returns the cache's current warm state, with Stale computed against
// RefreshWindow as of this call.
func (c *Cache) Status() Status {
	c.mu.RLock()
	defer c.mu.RUnlock()

	status := c.status
	status.Stale = !status.FetchedAt.IsZero() &&
		time.Since(status.FetchedAt) > RefreshWindow
	return status
}

// Packages returns the cache's current snapshot of orb packages. The
// returned slice must not be mutated: updates to the cache always build and
// publish an entirely new slice rather than mutating the one callers may
// still be holding, so reading it concurrently with an update is safe
// without copying.
func (c *Cache) Packages() []OrbPackage {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.packages
}

// Search ranks the cache's current packages against query; see the
// package-level Search function for the ranking rules.
func (c *Cache) Search(query string, limit int) []Result {
	return Search(c.Packages(), query, limit)
}

// SearchFiltered ranks the cache's current packages against query within
// filter's scope; see the package-level SearchFiltered for the ranking rules
// and what the returned counts mean.
func (c *Cache) SearchFiltered(query string, filter Filter, limit int) Page {
	return SearchFiltered(c.Packages(), query, filter, limit)
}

// Start warms the cache: it loads a fresh (within cacheTTL) disk cache if
// one is available, or otherwise performs the two-stage warm described on
// Cache. It returns once the cache is at least Ready (certified orbs
// searchable, or a fresh disk cache loaded) — the full-registry crawl, when
// needed, continues in the background after Start returns.
//
// Start never returns an error: every failure along the way (a corrupt disk
// cache, an API error, a permissions error listing private orbs) is
// recorded in Status and logged via logf, never propagated as a reason the
// server should not start. The background crawl it starts stops promptly
// when ctx is cancelled (e.g. on server shutdown). See WarmDone for a way to
// observe that background work finishing without polling Status.
//
// A persisted cache past RefreshWindow is published rather than discarded
// (issue #257). It used to be dropped on the floor, which meant an old file
// plus an unreachable API produced an empty orb browser — the app throwing
// away the only registry listing it had, at exactly the moment it could not
// get another. An old listing is still a real listing; Status reports it as
// Stale so the UI can label it, and the crawl that would replace it runs
// anyway. The certified stage is skipped on that path on purpose: it would
// replace a full ~6,400-orb stale set with ~79 certified orbs, which is fewer
// orbs and not obviously fresher.
func (c *Cache) Start(ctx context.Context) {
	persisted, ok := c.loadDiskCache()
	if ok && time.Since(persisted.FetchedAt) <= RefreshWindow {
		c.publish(persisted.Packages, persisted.FetchedAt, true)
		c.closeWarmDone() // No background crawl on this path; nothing more will be published.
		return
	}
	if ok {
		c.logf("orbs: cache file is older than %s; serving it as stale while re-crawling", RefreshWindow)
		c.publish(persisted.Packages, persisted.FetchedAt, true)
		c.markWarming()
		go c.warmFull(ctx)
		return
	}

	// Set before the first request rather than by the first publish, so
	// "nothing yet, and a fetch is running" is distinguishable from
	// "nothing, and nothing is being done about it" even when the certified
	// stage fails and publishes nothing at all.
	c.markWarming()

	if err := c.warmCertified(ctx); err != nil {
		c.logf("orbs: warm certified orbs: %v", err)
		c.noteWarmError(err)
	}

	go c.warmFull(ctx)
}

// markWarming records that a crawl is in progress without disturbing whatever
// packages are already published.
func (c *Cache) markWarming() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.status.Warming = true
}

// Refresh triggers a re-crawl of the full orb registry outside Start's normal
// warm cycle -- the manual "check now" affordance issue #285 exists to add,
// and the one the owner asked for by name: RefreshWindow's seven days can
// otherwise hide a newly published orb version for a week with no way to ask
// sooner.
//
// It is a no-op whenever a crawl (started by Start or an earlier Refresh) is
// already Warming, checked and set atomically under the same lock so two
// overlapping calls can never both decide to start one. That matters here
// specifically: this crawl is ~64 requests over up to fullCrawlTimeout, and a
// refresh button sitting next to it is exactly the kind of control someone
// double-clicks or, worse, a second browser tab triggers concurrently. Either
// way, the currently-published packages are left exactly as they are while
// the new crawl runs -- Search keeps serving them, stale-labelled if they
// already were, until warmFull publishes a replacement or fails and records
// why.
//
// Refresh never blocks: like Start's own background stage, it returns as
// soon as the decision (start a crawl, or no-op) is made. A caller observes
// the crawl's progress and outcome the same way it always does -- via
// Status().Warming and, once it clears, Status().FetchedAt/Err.
func (c *Cache) Refresh(ctx context.Context) {
	c.mu.Lock()
	if c.status.Warming {
		c.mu.Unlock()
		return
	}
	c.status.Warming = true
	c.mu.Unlock()

	go c.warmFull(ctx)
}

// noteWarmError records why the most recent warm attempt failed, leaving the
// currently published packages (and their FetchedAt) alone — the point of the
// field is to explain a list that is still being served.
func (c *Cache) noteWarmError(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.status.Err = err
}

// warmCertified performs the first warm stage: fetching every certified
// orb in a single request and publishing it as the cache's initial,
// Ready-but-not-Complete content.
func (c *Cache) warmCertified(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, certifiedWarmTimeout)
	defer cancel()

	certified := true
	pkgs, err := c.client.ListAllOrbPackages(ctx, circleci.ListOrbsOptions{
		Certified: &certified,
		Limit:     certifiedPageLimit,
	}, nil)
	if err != nil {
		return err
	}

	converted := make([]OrbPackage, 0, len(pkgs))
	for _, p := range pkgs {
		converted = append(converted, OrbPackage{OrbPackage: p, Certified: true})
	}
	c.publish(converted, time.Time{}, false)
	return nil
}

// warmFull performs the second warm stage: crawling the full public
// registry, then publishing the result as Complete and persisting it to disk.
//
// It performs a single unfiltered crawl on purpose. The registry's
// filter[visibility] parameter is accepted but ignored by the API: requesting
// visibility=private returns the identical set as visibility=public, so
// crawling both and concatenating duplicated every orb (and pushed certified
// orbs out of the top search results). Each package already carries its own
// is_private attribute, so one crawl yields both public and private orbs and
// callers can distinguish them from the response itself.
//
// It degrades gracefully rather than failing outright: if the crawl fails, the
// certified-only set from warmCertified (or whatever the cache already held)
// remains in place and searchable; Status.Err and a logf call report what
// went wrong.
func (c *Cache) warmFull(ctx context.Context) {
	defer c.closeWarmDone() // Whatever happens below, this is the last thing warmFull will publish.

	ctx, cancel := context.WithTimeout(ctx, fullCrawlTimeout)
	defer cancel()

	all, err := c.client.ListAllOrbPackages(ctx, circleci.ListOrbsOptions{
		Limit: fullCrawlPageLimit,
	}, nil)
	if err != nil {
		if ctx.Err() != nil {
			return // Shutting down; nothing more to do.
		}
		c.logf("orbs: crawl orb registry: %v", err)
		c.mu.Lock()
		c.status.Warming = false
		c.status.Err = err
		c.mu.Unlock()
		return
	}

	merged := mergePackages(all, c.certifiedNames())

	fetchedAt := time.Now()

	// Persist before publishing, so that Status().Complete implies the result
	// is on disk. Publishing first left a window in which a caller could
	// observe Complete while the file did not exist yet -- harmless in
	// practice, but it made the disk-cache test racy and it failed on
	// Windows, where the write loses that race more often. Search is already
	// served from the certified set by this point, so nothing is waiting on
	// this write.
	c.saveDiskCache(merged, fetchedAt)
	c.publish(merged, fetchedAt, true)
}

// mergePackages deduplicates a crawl result and restores the certified flag,
// which the packages endpoint does not report and which is therefore only
// known from the separate certified query.
//
// Deduplication is keyed on the orb name rather than the package ID so that
// the same orb arriving from more than one query (or a registry that returns
// overlapping pages) collapses to a single search result. Ties keep the entry
// carrying the most versions, since a truncated version list would otherwise
// hide releases from the version picker.
func mergePackages(pkgs []circleci.OrbPackage, certified map[string]bool) []OrbPackage {
	byName := make(map[string]OrbPackage, len(pkgs))
	order := make([]string, 0, len(pkgs))

	for _, p := range pkgs {
		candidate := OrbPackage{OrbPackage: p, Certified: certified[p.Name]}

		existing, seen := byName[p.Name]
		if !seen {
			byName[p.Name] = candidate
			order = append(order, p.Name)
			continue
		}
		if len(candidate.Versions) > len(existing.Versions) {
			// Keep the certified flag if either copy had it.
			candidate.Certified = candidate.Certified || existing.Certified
			byName[p.Name] = candidate
		} else if candidate.Certified {
			existing.Certified = true
			byName[p.Name] = existing
		}
	}

	merged := make([]OrbPackage, 0, len(order))
	for _, name := range order {
		merged = append(merged, byName[name])
	}
	return merged
}

// certifiedNames returns the set of orb names the cache currently knows to
// be certified, used to carry that flag through the full-registry crawl
// (whose own response, per the API, does not include it).
func (c *Cache) certifiedNames() map[string]bool {
	c.mu.RLock()
	defer c.mu.RUnlock()

	names := make(map[string]bool, len(c.packages))
	for _, p := range c.packages {
		if p.Certified {
			names[p.Name] = true
		}
	}
	return names
}

// publish atomically replaces the cache's package set and updates Status
// accordingly. complete controls both Status.Complete and (inversely)
// Status.Warming; a non-complete publish always leaves FetchedAt at its
// zero value, since a partial set is deliberately never treated as "fresh"
// for disk-cache TTL purposes.
//
// It clears Status.Err, and that is the intended behaviour rather than an
// oversight: a publish means this fetch succeeded, so a reason recorded for an
// earlier failure is no longer why the caller is looking at what it is looking
// at. Callers that need to record a failure *without* discarding the packages
// already published use noteWarmError instead.
func (c *Cache) publish(pkgs []OrbPackage, fetchedAt time.Time, complete bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	certified, private := 0, 0
	for _, pkg := range pkgs {
		if pkg.Certified {
			certified++
		}
		if pkg.Private {
			private++
		}
	}

	c.packages = pkgs
	c.status = Status{
		Ready:          true,
		Complete:       complete,
		Count:          len(pkgs),
		CertifiedCount: certified,
		PrivateCount:   private,
		FetchedAt:      fetchedAt,
		Warming:        !complete,
	}
}

// diskCache is the on-disk (and wire) JSON shape written by saveDiskCache
// and read by loadFreshDiskCache.
type diskCache struct {
	SchemaVersion int          `json:"schemaVersion"`
	FetchedAt     time.Time    `json:"fetchedAt"`
	Packages      []OrbPackage `json:"packages"`
}

// diskCachePath returns the path of this Cache's persisted file, or "" if
// disk persistence is disabled (empty cacheDir).
func (c *Cache) diskCachePath() string {
	if c.cacheDir == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(c.host))
	return filepath.Join(c.cacheDir, fmt.Sprintf("orbs-%x.json", sum[:8]))
}

// loadDiskCache attempts to read this host's persisted cache, returning it and
// true on success. It returns false if disk persistence is disabled, no file
// exists, or the file is corrupt or from an incompatible schema version — in
// every such case the caller has no listing at all and must crawl.
//
// Age is deliberately *not* checked here. Whether a persisted listing is fresh
// enough to be the final answer, or only old enough to need labelling, is
// Start's decision to make (see its doc comment); this function's job is to
// answer "is there a decodable listing on disk", and an expired file answers
// that question yes.
func (c *Cache) loadDiskCache() (diskCache, bool) {
	path := c.diskCachePath()
	if path == "" {
		return diskCache{}, false
	}

	data, err := os.ReadFile(path) //nolint:gosec // path is derived from an operator-controlled cache directory plus a package-computed hash, not from request input.
	if err != nil {
		return diskCache{}, false
	}

	var dc diskCache
	if err := json.Unmarshal(data, &dc); err != nil {
		c.logf("orbs: cache file %s is corrupt, will re-crawl: %v", path, err)
		return diskCache{}, false
	}
	if dc.SchemaVersion != diskCacheSchemaVersion {
		c.logf("orbs: cache file %s has schema version %d, want %d; will re-crawl", path, dc.SchemaVersion, diskCacheSchemaVersion)
		return diskCache{}, false
	}
	if dc.FetchedAt.IsZero() {
		// Nothing partial is ever persisted (see publish), so a zero
		// FetchedAt means a hand-edited or truncated file. Refusing it keeps
		// "Stale is measured against a real fetch time" true downstream.
		c.logf("orbs: cache file %s has no fetch time; will re-crawl", path)
		return diskCache{}, false
	}

	return dc, true
}

// saveDiskCache persists pkgs to disk, atomically (write to a temp file in
// the same directory, then rename over the target path). It never returns
// an error: a failure to persist only means the next Start re-crawls, so it
// is logged via logf and otherwise ignored.
func (c *Cache) saveDiskCache(pkgs []OrbPackage, fetchedAt time.Time) {
	path := c.diskCachePath()
	if path == "" {
		return
	}

	if err := os.MkdirAll(c.cacheDir, 0o750); err != nil {
		c.logf("orbs: create cache directory %s: %v", c.cacheDir, err)
		return
	}

	data, err := json.Marshal(diskCache{
		SchemaVersion: diskCacheSchemaVersion,
		FetchedAt:     fetchedAt,
		Packages:      pkgs,
	})
	if err != nil {
		c.logf("orbs: marshal disk cache: %v", err)
		return
	}

	tmp, err := os.CreateTemp(c.cacheDir, "orbs-*.tmp")
	if err != nil {
		c.logf("orbs: create temp cache file: %v", err)
		return
	}
	// tmpPath is the name os.CreateTemp itself just chose inside
	// c.cacheDir; it is not derived from any request input, so the
	// Remove/Rename calls below are not the path-traversal risk gosec's
	// taint analysis assumes for a variable named "path".
	tmpPath := tmp.Name()

	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(tmpPath) //nolint:gosec // see tmpPath comment above.
		c.logf("orbs: write temp cache file %s: write=%v close=%v", tmpPath, writeErr, closeErr)
		return
	}

	if err := os.Rename(tmpPath, path); err != nil { //nolint:gosec // see tmpPath comment above.
		_ = os.Remove(tmpPath) //nolint:gosec // see tmpPath comment above.
		c.logf("orbs: rename %s to %s: %v", tmpPath, path, err)
	}
}

// DefaultCacheDir returns the base directory the editor's persisted caches
// should live under, following the XDG Base Directory convention:
// $XDG_CACHE_HOME (or ~/.cache when that is unset) plus
// "circleci-editor".
func DefaultCacheDir() (string, error) {
	if dir := os.Getenv("XDG_CACHE_HOME"); dir != "" {
		return filepath.Join(dir, "circleci-editor"), nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("orbs: resolve home directory: %w", err)
	}
	return filepath.Join(home, ".cache", "circleci-editor"), nil
}
