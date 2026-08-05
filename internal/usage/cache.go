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

package usage

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
)

const (
	// DefaultWindowDays is the window size a fresh Cache uses when the host
	// has not configured one. Deliberately the smallest of the three allowed
	// values (see ValidWindowDays), not a middle ground: issue #307's own
	// design brief is explicit that a first run against a large organization
	// is the worst case this feature can produce, and that case must not be
	// the default experience. A 7-day window is also enough runs to say
	// something for any job that runs at all regularly, while a cold-cache
	// first fetch on even a large org is a handful of export files, not
	// dozens.
	DefaultWindowDays = 7

	// MaxWindowDays is the hard retention cap: Cache never fetches or keeps
	// data older than this many days back, however it is configured. Named
	// directly by the owner ("probably only keep at max 30 days of data").
	MaxWindowDays = 30

	// diskCacheSchemaVersion is bumped whenever the on-disk JSON shape
	// changes incompatibly; a mismatch forces a cold re-fetch rather than
	// risking a mismatched decode, matching internal/orbs.Cache's own rule.
	diskCacheSchemaVersion = 1

	// exportPollInterval is how often Cache polls GetUsageExportJob while a
	// job is created or processing.
	exportPollInterval = 3 * time.Second

	// exportJobTimeout bounds one full create-and-poll cycle for a single
	// usage-export job. Issue #307's own live verification found a 1-day,
	// single-org export completing in well under a minute; this is sized
	// generously above that for a 30-day, org-wide export on a large
	// organization, while still guaranteeing this goroutine cannot hang
	// forever against an unresponsive API.
	exportJobTimeout = 10 * time.Minute

	// maxDownloadBytes bounds how much decompressed CSV a single
	// download_urls entry may produce, guarding against an unexpectedly
	// enormous or corrupt response consuming unbounded memory. Sized well
	// above any plausible single-file export chunk.
	maxDownloadBytes = 512 << 20 // 512 MiB
)

// ValidWindowDays are the only window sizes this cache accepts (issue #307:
// "maybe we just stick with 7 days or 14 days or 30 days ... give it a
// setting"). Rejecting anything else outright, rather than clamping, means a
// caller that passes a typo'd value finds out immediately instead of
// silently getting a different window than it asked for.
var ValidWindowDays = []int{7, 14, 30}

// IsValidWindowDays reports whether days is one of ValidWindowDays.
func IsValidWindowDays(days int) bool {
	for _, v := range ValidWindowDays {
		if v == days {
			return true
		}
	}
	return false
}

// ExportClient is the subset of *circleci.Client the cache needs, defined
// here (rather than depended on directly) so tests can substitute a fake
// without making any HTTP calls -- the same reason internal/orbs.OrbLister
// exists.
type ExportClient interface {
	GetOrganization(ctx context.Context, slug string) (*circleci.Organization, error)
	CreateUsageExportJob(ctx context.Context, orgID string, start, end time.Time, sharedOrgIDs []string) (*circleci.UsageExportJob, error)
	GetUsageExportJob(ctx context.Context, orgID, jobID string) (*circleci.UsageExportJob, error)
}

// Downloader fetches one of a completed export job's DownloadURLs and
// returns its content, decompressed, ready for Reduce. A separate interface
// from ExportClient because the URLs it fetches are pre-signed object-storage
// links, not CircleCI API endpoints -- verified live (issue #307): they need
// no Circle-Token, and *circleci.Client's own request signing has no part to
// play in fetching them.
type Downloader interface {
	Download(ctx context.Context, url string) (io.ReadCloser, error)
}

// httpDownloader is the production Downloader: a plain gzip-aware HTTP GET,
// size-bounded.
type httpDownloader struct {
	client *http.Client
}

// NewHTTPDownloader constructs the production Downloader.
func NewHTTPDownloader() Downloader {
	return &httpDownloader{client: &http.Client{}}
}

func (d *httpDownloader) Download(ctx context.Context, url string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("usage: build download request: %w", err)
	}

	resp, err := d.client.Do(req) //nolint:bodyclose,gosec // closed by the caller via the returned io.ReadCloser's chain, or on error below; url is not attacker-controlled request input -- it is one of a completed usage-export job's own download_urls, returned by CircleCI's API in response to a job this host created for an org-slug this host resolved from its own environment (see Cache.runExport), never a URL a browser request supplies.
	if err != nil {
		return nil, fmt.Errorf("usage: download export file: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_ = resp.Body.Close()
		return nil, fmt.Errorf("usage: download export file: unexpected status %d", resp.StatusCode)
	}

	gz, err := gzip.NewReader(io.LimitReader(resp.Body, maxDownloadBytes+1))
	if err != nil {
		_ = resp.Body.Close()
		return nil, fmt.Errorf("usage: ungzip export file: %w", err)
	}
	return &gzipReadCloser{gz: gz, underlying: resp.Body}, nil
}

// gzipReadCloser closes both the gzip reader and the underlying HTTP response
// body it wraps.
type gzipReadCloser struct {
	gz         *gzip.Reader
	underlying io.Closer
}

func (g *gzipReadCloser) Read(p []byte) (int, error) { return g.gz.Read(p) }
func (g *gzipReadCloser) Close() error {
	gzErr := g.gz.Close()
	underlyingErr := g.underlying.Close()
	if gzErr != nil {
		return gzErr
	}
	return underlyingErr
}

// Status describes the Cache's current warm state, following
// internal/orbs.Cache.Status's own convention: never gate a response on
// this cache, serve whatever it holds, and say honestly why it might be
// empty, partial, or old.
type Status struct {
	// Ready reports whether Summaries has anything to report yet -- true as
	// soon as either a first successful warm cycle publishes, or a disk
	// cache (of any age) was loaded at Start.
	Ready bool

	// Warming reports whether a fetch cycle is currently in progress.
	Warming bool

	// WindowDays is the configured retention/fetch window this Status was
	// computed against.
	WindowDays int

	// CoveredStart and CoveredEnd bound the UTC calendar days this cache
	// currently holds data for ([CoveredStart, CoveredEnd), CoveredEnd
	// exclusive). Both zero when nothing is held yet.
	CoveredStart, CoveredEnd time.Time

	// FetchedAt is when the most recent successful warm cycle finished (may
	// have fetched nothing new, if the cache was already current). Zero
	// until the first one completes.
	FetchedAt time.Time

	// Stale reports that CoveredEnd has fallen behind the last complete UTC
	// day -- i.e. this cache has not been refreshed since some day it should
	// have been. Independent of Warming: a cache can be stale *and*
	// currently warming (catching up).
	Stale bool

	// Err is the most recent warm failure, if any -- never fatal to the
	// cache's operation, surfaced only so a caller can explain why the data
	// is missing, partial, or old. See internal/orbs.Status.Err's own doc
	// comment for why this is an error value (routed through a body-free
	// classifier before reaching any UI) rather than a pre-formatted string.
	Err error
}

// Cache holds a locally-persisted, background-warmed, delta-fetched summary
// of CircleCI Usage Export data, reduced to per-job/per-day aggregates (see
// Reduce). It follows internal/orbs.Cache's shape deliberately (issue #307:
// "this is the same shape as the orb cache"): Start warms in the background
// and never blocks a caller on the network, Summaries always serves whatever
// is currently held, and Status says honestly whether that is fresh,
// stale, still warming, or empty because the last attempt failed.
//
// What is single-purpose about this cache, and not shared with orbs.Cache,
// is *why* it never persists what it fetches verbatim: a single usage
// export names every project in the organization (there is no project
// filter -- see internal/circleci's CreateUsageExportJob), so writing the
// raw CSV to disk would mean this editor's cache directory permanently held
// a listing of the whole org's projects and jobs. Reduce discards the raw
// rows the moment they are folded into DayBuckets, and only that reduced,
// derived form (day + job -> aggregated stats, no row-level detail) is ever
// written to disk or kept in memory past a warm cycle.
type Cache struct {
	client     ExportClient
	downloader Downloader
	orgSlug    string
	cacheDir   string
	host       string
	logf       func(string, ...any)

	mu         sync.RWMutex
	windowDays int
	buckets    DayBuckets
	fetchedAt  time.Time
	warming    bool
	err        error
	ready      bool

	// orgID is resolved once, from orgSlug, and cached for the process's
	// lifetime -- mirroring internal/host's policyOwnerResolver. Only a
	// successful resolution is cached; a failure is retried on the next warm
	// cycle, since a transient lookup failure should not permanently wedge
	// this cache.
	orgIDMu sync.Mutex
	orgID   string

	warmDone     chan struct{}
	warmDoneOnce sync.Once

	// now is overridable in tests so delta-fetch planning can be exercised
	// deterministically instead of racing the real clock.
	now func() time.Time
}

// New constructs a Cache. client and downloader supply the network calls (a
// *circleci.Client and NewHTTPDownloader() in production, fakes in tests).
// orgSlug is the "<vcs>/<org>" slug whose usage to export (see
// Environment.OrgSlug); an empty slug makes every warm cycle fail with a
// clear reason rather than attempting a request that cannot succeed.
// cacheDir is the directory a reduced, derived summary is persisted under
// (see DiskCachePath); an empty cacheDir disables disk persistence.
// windowDays must be one of ValidWindowDays. logf receives diagnostic
// messages, never fatal to the cache's operation; a nil logf discards them.
func New(client ExportClient, downloader Downloader, orgSlug, cacheDir, host string, windowDays int, logf func(string, ...any)) *Cache {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	if !IsValidWindowDays(windowDays) {
		windowDays = DefaultWindowDays
	}
	return &Cache{
		client:     client,
		downloader: downloader,
		orgSlug:    orgSlug,
		cacheDir:   cacheDir,
		host:       host,
		logf:       logf,
		windowDays: windowDays,
		buckets:    DayBuckets{},
		warmDone:   make(chan struct{}),
		now:        time.Now,
	}
}

func (c *Cache) closeWarmDone() {
	c.warmDoneOnce.Do(func() { close(c.warmDone) })
}

// WarmDone returns a channel closed once Start's current warm cycle has
// finished, whatever the outcome -- see internal/orbs.Cache.WarmDone, which
// this mirrors for the same reason: package usage_test is a black-box test
// package with no other way to observe the background goroutine finishing.
func (c *Cache) WarmDone() <-chan struct{} {
	return c.warmDone
}

// Status returns the cache's current warm state.
func (c *Cache) Status() Status {
	c.mu.RLock()
	defer c.mu.RUnlock()

	covStart, covEnd, _ := c.buckets.Range()
	lastComplete := truncateToUTCDay(c.now())
	stale := !covEnd.IsZero() && covEnd.Before(lastComplete)

	return Status{
		Ready:        c.ready,
		Warming:      c.warming,
		WindowDays:   c.windowDays,
		CoveredStart: covStart,
		CoveredEnd:   covEnd,
		FetchedAt:    c.fetchedAt,
		Stale:        stale,
		Err:          c.err,
	}
}

// Summaries returns the cache's current per-job rollup. See Summarize for
// what each entry means; the returned slice is a fresh copy each call
// (Summarize builds a new one), so it is always safe for a caller to keep
// without racing a concurrent warm.
func (c *Cache) Summaries() []JobSummary {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return Summarize(c.buckets)
}

// WindowDays returns the cache's currently configured window.
func (c *Cache) WindowDays() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.windowDays
}

// SetWindowDays changes the configured window for future warm cycles. It
// does not itself trigger a fetch or prune -- call Refresh afterward to make
// the change take effect immediately, otherwise it applies on this cache's
// next natural warm cycle. Returns an error (and leaves the window
// unchanged) for anything outside ValidWindowDays.
func (c *Cache) SetWindowDays(days int) error {
	if !IsValidWindowDays(days) {
		return fmt.Errorf("usage: window must be one of %v days, got %d", ValidWindowDays, days)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.windowDays = days
	return nil
}

// Start loads a persisted summary from disk (of any age -- an old summary is
// still real data, served immediately and labelled Stale rather than
// withheld while a warm cycle catches it up, matching internal/orbs.Cache's
// own rule from issue #257) and then always launches a background warm
// cycle: delta-fetching a cold cache's whole window, a small gap, or
// discarding a too-large gap in favour of just the window (issue #307's
// three explicit cases -- see planFetch).
//
// Start never blocks the caller on the network and never returns an error:
// every failure is recorded in Status and logged via logf. Call WarmDone to
// observe the background cycle's completion without polling Status.
func (c *Cache) Start(ctx context.Context) {
	if persisted, ok := c.loadDiskCache(); ok {
		c.mu.Lock()
		c.buckets = persisted.buckets
		c.fetchedAt = persisted.fetchedAt
		c.ready = true
		c.mu.Unlock()
	}

	c.mu.Lock()
	c.warming = true
	c.mu.Unlock()

	go c.warm(ctx)
}

// Refresh triggers a warm cycle outside Start's normal cadence -- the manual
// "check now" affordance issue #285 established for every cache with
// something to refresh from. A no-op while a cycle (from Start or an
// earlier Refresh) is already running, checked and set atomically so two
// overlapping calls can never both start one.
func (c *Cache) Refresh(ctx context.Context) {
	c.mu.Lock()
	if c.warming {
		c.mu.Unlock()
		return
	}
	c.warming = true
	c.mu.Unlock()

	go c.warm(ctx)
}

// warm runs exactly one plan-fetch-merge-prune-publish cycle. It always
// completes (closing warmDone) whether or not it did any network work.
func (c *Cache) warm(ctx context.Context) {
	defer c.closeWarmDone()
	defer func() {
		c.mu.Lock()
		c.warming = false
		c.mu.Unlock()
	}()

	c.mu.RLock()
	windowDays := c.windowDays
	current := c.buckets
	c.mu.RUnlock()

	start, end, needed := planFetch(c.now(), current, windowDays)

	next := cloneBuckets(current)
	if needed {
		fetched, err := c.runExport(ctx, start, end)
		if err != nil {
			if ctx.Err() != nil {
				return // Shutting down; nothing more to do.
			}
			c.logf("usage: warm cycle failed: %v", err)
			c.mu.Lock()
			c.err = err
			c.mu.Unlock()
			return
		}
		// A day within [start, end) with genuinely zero qualifying rows
		// (a quiet weekend, a paused project) must still count as covered,
		// or the next cycle's planFetch would see a "hole" and either
		// re-fetch it forever or misclassify it as a gap. Seeding an empty
		// bucket for every day in the fetched range -- even ones Reduce
		// never touched -- is what makes DayBuckets.Range an honest answer
		// to "what have we actually asked for", not just "what came back
		// non-empty".
		seedEmptyDays(fetched, start, end)
		next.Merge(fetched)
	}

	windowStart := truncateToUTCDay(c.now()).Add(-time.Duration(windowDays) * 24 * time.Hour)
	windowEnd := truncateToUTCDay(c.now())
	next.Prune(windowStart, windowEnd)

	fetchedAt := c.now()
	c.saveDiskCache(next, fetchedAt)

	c.mu.Lock()
	c.buckets = next
	c.fetchedAt = fetchedAt
	c.ready = true
	c.err = nil
	c.mu.Unlock()
}

// runExport creates a usage-export job for [start, end), polls it to
// completion, and downloads and reduces every one of its DownloadURLs (a
// list -- see circleci.UsageExportJob's own doc comment for why iterating
// it, not indexing [0], is load-bearing here).
func (c *Cache) runExport(ctx context.Context, start, end time.Time) (DayBuckets, error) {
	orgID, err := c.resolveOrgID(ctx)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(ctx, exportJobTimeout)
	defer cancel()

	job, err := c.client.CreateUsageExportJob(ctx, orgID, start, end, nil)
	if err != nil {
		return nil, fmt.Errorf("usage: create export job: %w", err)
	}

	for !job.State.Done() {
		if !sleepInterval(ctx, exportPollInterval) {
			return nil, ctx.Err()
		}
		job, err = c.client.GetUsageExportJob(ctx, orgID, job.ID)
		if err != nil {
			return nil, fmt.Errorf("usage: poll export job: %w", err)
		}
	}
	if job.State != circleci.UsageExportJobCompleted {
		return nil, fmt.Errorf("usage: export job ended in state %q", job.State)
	}

	combined := DayBuckets{}
	for _, url := range job.DownloadURLs {
		rc, err := c.downloader.Download(ctx, url)
		if err != nil {
			return nil, fmt.Errorf("usage: download export file: %w", err)
		}
		fileBuckets, reduceErr := Reduce(rc)
		closeErr := rc.Close()
		if reduceErr != nil {
			return nil, fmt.Errorf("usage: parse export file: %w", reduceErr)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("usage: close export file: %w", closeErr)
		}
		combined.Merge(fileBuckets)
	}
	return combined, nil
}

// resolveOrgID resolves c.orgSlug to the organization UUID the export
// endpoints are keyed by, caching only a success (mirroring
// internal/host's policyOwnerResolver) so a transient lookup failure is
// retried on the next warm cycle rather than wedging this cache permanently.
func (c *Cache) resolveOrgID(ctx context.Context) (string, error) {
	if c.orgSlug == "" {
		return "", fmt.Errorf("usage: no organization slug is available to scope a usage export to")
	}

	c.orgIDMu.Lock()
	cached := c.orgID
	c.orgIDMu.Unlock()
	if cached != "" {
		return cached, nil
	}

	org, err := c.client.GetOrganization(ctx, c.orgSlug)
	if err != nil {
		return "", fmt.Errorf("usage: resolve organization %q: %w", c.orgSlug, err)
	}
	if org.ID == "" {
		return "", fmt.Errorf("usage: CircleCI's record for %q carries no organization id", c.orgSlug)
	}

	c.orgIDMu.Lock()
	c.orgID = org.ID
	c.orgIDMu.Unlock()
	return org.ID, nil
}

// planFetch decides what, if anything, warm should fetch this cycle, given
// now, the data already held (current), and the configured window --
// issue #307's three explicit cases:
//
//   - cold cache (current holds nothing): fetch the whole window.
//   - a gap no larger than the window (the common case): fetch only the gap,
//     [current's covered end, now's last complete day).
//   - a gap larger than the window (the app was not opened for a long
//     time), or the window grew since the data held was fetched: fetch the
//     window, not the whole gap or a backfill on top of what is held.
//
// The trailing edge is deliberately *not* now itself: end is truncated to
// the last complete UTC day boundary, because a window ending at now would
// include jobs still running, whose utilisation and credits are not yet
// final (issue #307's own warning). The alternative -- fetching a deliberate
// overlap into "complete" territory and letting later data win on merge --
// was rejected: stopping at the boundary means a day this cache has already
// fetched never needs to be re-fetched or reconciled, at the cost of one
// day of latency on the newest data point.
func planFetch(now time.Time, current DayBuckets, windowDays int) (start, end time.Time, needed bool) {
	end = truncateToUTCDay(now)
	windowDur := time.Duration(windowDays) * 24 * time.Hour
	desiredStart := end.Add(-windowDur)

	covStart, covEnd, ok := current.Range()
	if !ok {
		return desiredStart, end, end.After(desiredStart)
	}
	if !covEnd.Before(end) && !covStart.After(desiredStart) {
		return time.Time{}, time.Time{}, false // Already covers the desired window.
	}

	gapForward := end.Sub(covEnd)
	if covStart.After(desiredStart) || gapForward > windowDur {
		return desiredStart, end, true // Window grew, or the gap exceeds the window: (re)fetch the whole window.
	}
	return covEnd, end, true // The common case: fetch just the gap.
}

// seedEmptyDays ensures every UTC calendar day in [start, end) has at least
// an empty entry in b, so a day with genuinely no qualifying rows still
// registers as covered rather than as a hole in DayBuckets.Range. See
// warm's call site for why this matters.
func seedEmptyDays(b DayBuckets, start, end time.Time) {
	for d := truncateToUTCDay(start); d.Before(end); d = d.AddDate(0, 0, 1) {
		day := d.Format(dayLayout)
		if _, ok := b[day]; !ok {
			b[day] = map[JobKey]DayAggregate{}
		}
	}
}

// truncateToUTCDay returns the start (midnight UTC) of t's UTC calendar day.
func truncateToUTCDay(t time.Time) time.Time {
	u := t.UTC()
	return time.Date(u.Year(), u.Month(), u.Day(), 0, 0, 0, 0, time.UTC)
}

// cloneBuckets returns a deep-enough copy of b for warm to build its next
// published snapshot from without mutating whatever a concurrent Summaries
// or Status call might still be reading via the old c.buckets reference --
// the same "always publish a new value, never mutate the old one in place"
// rule internal/orbs.Cache.publish follows for its packages slice.
func cloneBuckets(b DayBuckets) DayBuckets {
	out := make(DayBuckets, len(b))
	for day, jobs := range b {
		jobsCopy := make(map[JobKey]DayAggregate, len(jobs))
		for k, v := range jobs {
			jobsCopy[k] = v
		}
		out[day] = jobsCopy
	}
	return out
}

// sleepInterval waits for d or until ctx is done, whichever comes first,
// reporting whether the wait completed normally.
func sleepInterval(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

// diskCache is the on-disk JSON shape. Entries flattens DayBuckets' nested
// maps (day -> JobKey -> DayAggregate) because encoding/json cannot marshal
// a map keyed by a struct type -- JobKey and DayAggregate are embedded
// directly into diskEntry instead, whose field sets do not collide.
type diskCache struct {
	SchemaVersion int         `json:"schemaVersion"`
	WindowDays    int         `json:"windowDays"`
	FetchedAt     time.Time   `json:"fetchedAt"`
	Entries       []diskEntry `json:"entries"`
}

type diskEntry struct {
	Day string `json:"day"`
	JobKey
	DayAggregate
}

func toDiskEntries(b DayBuckets) []diskEntry {
	entries := make([]diskEntry, 0)
	for day, jobs := range b {
		for key, agg := range jobs {
			entries = append(entries, diskEntry{Day: day, JobKey: key, DayAggregate: agg})
		}
	}
	return entries
}

func fromDiskEntries(entries []diskEntry) DayBuckets {
	b := DayBuckets{}
	for _, e := range entries {
		jobs := b[e.Day]
		if jobs == nil {
			jobs = make(map[JobKey]DayAggregate)
			b[e.Day] = jobs
		}
		jobs[e.JobKey] = e.DayAggregate
	}
	return b
}

// diskCachePath returns the path of this Cache's persisted file, or "" if
// disk persistence is disabled (empty cacheDir). Keyed by host the same way
// internal/orbs.Cache's own cache file is, so switching CIRCLE_HOST never
// mixes one installation's usage summary into another's.
func (c *Cache) diskCachePath() string {
	if c.cacheDir == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(c.host + "|" + c.orgSlug))
	return filepath.Join(c.cacheDir, fmt.Sprintf("usage-%x.json", sum[:8]))
}

// loadDiskCache attempts to read this cache's persisted summary. It returns
// false if disk persistence is disabled, no file exists, or the file is
// corrupt or from an incompatible schema version.
func (c *Cache) loadDiskCache() (struct {
	buckets   DayBuckets
	fetchedAt time.Time
}, bool) {
	type result = struct {
		buckets   DayBuckets
		fetchedAt time.Time
	}

	path := c.diskCachePath()
	if path == "" {
		return result{}, false
	}

	data, err := os.ReadFile(path) //nolint:gosec // path is derived from an operator-controlled cache directory plus a package-computed hash, not from request input.
	if err != nil {
		return result{}, false
	}

	var dc diskCache
	if err := json.Unmarshal(data, &dc); err != nil {
		c.logf("usage: cache file %s is corrupt, will re-fetch: %v", path, err)
		return result{}, false
	}
	if dc.SchemaVersion != diskCacheSchemaVersion {
		c.logf("usage: cache file %s has schema version %d, want %d; will re-fetch", path, dc.SchemaVersion, diskCacheSchemaVersion)
		return result{}, false
	}
	if dc.FetchedAt.IsZero() {
		c.logf("usage: cache file %s has no fetch time; will re-fetch", path)
		return result{}, false
	}

	return result{buckets: fromDiskEntries(dc.Entries), fetchedAt: dc.FetchedAt}, true
}

// saveDiskCache persists buckets to disk, atomically (write to a temp file in
// the same directory, then rename over the target path). It never returns an
// error: a failure to persist only means the next Start re-fetches, so it is
// logged via logf and otherwise ignored -- matching internal/orbs.Cache's
// own saveDiskCache.
func (c *Cache) saveDiskCache(buckets DayBuckets, fetchedAt time.Time) {
	path := c.diskCachePath()
	if path == "" {
		return
	}

	if err := os.MkdirAll(c.cacheDir, 0o750); err != nil {
		c.logf("usage: create cache directory %s: %v", c.cacheDir, err)
		return
	}

	c.mu.RLock()
	windowDays := c.windowDays
	c.mu.RUnlock()

	data, err := json.Marshal(diskCache{
		SchemaVersion: diskCacheSchemaVersion,
		WindowDays:    windowDays,
		FetchedAt:     fetchedAt,
		Entries:       toDiskEntries(buckets),
	})
	if err != nil {
		c.logf("usage: marshal disk cache: %v", err)
		return
	}

	tmp, err := os.CreateTemp(c.cacheDir, "usage-*.tmp")
	if err != nil {
		c.logf("usage: create temp cache file: %v", err)
		return
	}
	tmpPath := tmp.Name()

	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(tmpPath) //nolint:gosec // tmpPath is os.CreateTemp's own choice inside c.cacheDir, not request input.
		c.logf("usage: write temp cache file %s: write=%v close=%v", tmpPath, writeErr, closeErr)
		return
	}

	if err := os.Rename(tmpPath, path); err != nil { //nolint:gosec // see tmpPath comment above.
		_ = os.Remove(tmpPath) //nolint:gosec // see tmpPath comment above.
		c.logf("usage: rename %s to %s: %v", tmpPath, path, err)
	}
}
