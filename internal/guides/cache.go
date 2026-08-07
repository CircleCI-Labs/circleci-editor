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

package guides

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/envcompat"
)

const (
	// diskCacheSchemaVersion is bumped whenever the on-disk JSON shape
	// changes incompatibly, so a file written by an older binary is
	// discarded rather than mis-decoded. Mirrors internal/orbs and
	// internal/dockerhub, same rationale.
	diskCacheSchemaVersion = 1

	// diskFileName is this cache's file within the shared cache directory
	// (orbs.DefaultCacheDir -- one cache root for the whole application,
	// one file per feature).
	diskFileName = "guides.json"

	// refreshTTL is how long a fetched copy of the guides is considered
	// current. Seven days, because:
	//
	//   - The upstream pages change on the order of weeks, not hours. Whereas
	//     the editor is opened many times a day, so refreshing on every open
	//     would be almost entirely wasted network for a *reference pane*.
	//   - It is short enough that a config-syntax change reaches users well
	//     inside a release cycle, which a vendored-only snapshot could not
	//     promise.
	//
	// The TTL only decides when a *background* refresh is attempted; nothing
	// ever waits on it.
	refreshTTL = 7 * 24 * time.Hour

	// refreshTimeout bounds one whole background refresh.
	//
	// Ten minutes, raised from three when the snapshot went from three pages to
	// twenty (issue #176). FetchAll is sequential and fetchTimeout allows each
	// file 20 seconds, so the arithmetic -- not the observed duration -- is what
	// sets this: a ~40-file closure whose requests all crawl would need 13
	// minutes, and the honest bound has to leave room for a slow network rather
	// than turn one into a permanent refresh failure. Nothing waits on this, so
	// a generous bound costs nothing; too tight a one would silently freeze the
	// snapshot, which is the whole failure mode this issue exists to avoid.
	refreshTimeout = 10 * time.Minute

	// NoRefreshEnvVar disables the background refresh entirely when set to a
	// non-empty value. The pane still works -- it falls back to the embedded
	// snapshot, which is the point of having one -- so this is a supported
	// way to run the editor with no outbound requests at all beyond those a
	// user explicitly triggers.
	NoRefreshEnvVar = "CIRCLECI_EDITOR_GUIDES_NO_REFRESH"

	// supersededNoRefreshEnvVar is the pre-rename spelling, still honoured with
	// a deprecation warning -- see internal/envcompat.
	supersededNoRefreshEnvVar = "VCE_GUIDES_NO_REFRESH"
)

// Source describes where the currently-served guides came from.
type Source string

const (
	// SourceVendored means the copy embedded in this binary.
	SourceVendored Source = "vendored"
	// SourceRefreshed means a copy fetched from upstream (this session or a
	// previous one, via the disk cache).
	SourceRefreshed Source = "refreshed"
)

// Provenance is everything the UI needs to state honestly where the guide text
// came from and how old it is. Every field is surfaced in the pane: a
// reference the user cannot date is a reference they cannot trust.
type Provenance struct {
	// Repo is the upstream repository.
	Repo string `json:"repo"`
	// Ref is the branch Commit was resolved from (DefaultBranch today --
	// circleci/circleci-docs has no tags or releases to prefer instead; see
	// DefaultBranch's own comment). Named explicitly so the pane can say
	// *which* moving target this was pinned from, not just show a bare SHA
	// (issue #286).
	Ref string `json:"ref"`
	// Commit is the upstream commit the served text came from.
	Commit string `json:"commit"`
	// CommittedAt is that commit's own upstream timestamp -- how old the
	// *text* is, as distinct from when this copy of it was obtained.
	CommittedAt time.Time `json:"committedAt"`
	// FetchedAt is when this copy was obtained (the vendoring time for the
	// embedded snapshot).
	FetchedAt time.Time `json:"fetchedAt"`
	// Source is SourceVendored or SourceRefreshed.
	Source Source `json:"source"`
	// Refreshing reports that a background refresh is in flight. The served
	// guides are complete and usable regardless; this only lets the UI say
	// "checking for updates" rather than implying the pane is loading.
	Refreshing bool `json:"refreshing"`
	// Error is the most recent background-refresh failure, if any. It never
	// affects what is served -- a failed refresh leaves the previous copy in
	// place -- and exists so the pane can say "showing the copy from <date>;
	// the last update check failed" instead of silently going stale.
	Error string `json:"error,omitempty"`
}

// Cache holds the parsed guides and keeps them current.
//
// The shape is deliberate, and is the answer to the owner's open question
// ("do we scrape it and keep it up to date, or parse it once like the orb
// hash?"): *both*, layered, so neither failure mode can bite.
//
//  1. The embedded snapshot is the floor. Start parses it synchronously, with
//     no network and no token, so the pane has full content on first launch,
//     offline, forever. This is the property the schema-derived reference
//     already had and that adding prose must not cost.
//  2. A disk cache remembers the most recent successful refresh across
//     restarts, so an editor opened twenty times a day fetches nothing at all.
//  3. A background refresh runs only when the newest copy is older than
//     refreshTTL, and only ever *replaces* content on success. Guides() never
//     blocks on it.
//
// Contrast internal/orbs.Cache, which has no equivalent of step 1: there is no
// way to embed 6,400 orbs in a binary, so a cold orb cache genuinely has
// nothing to show. The guides do, which is why this cache can promise
// something stronger -- content is never absent, only ever possibly stale, and
// Provenance always says which.
type Cache struct {
	fetcher  *Fetcher
	cacheDir string
	// debugf receives progress and bookkeeping -- refresh checks, disk-cache
	// housekeeping -- which the host discards unless --debug is on. warnf
	// receives the reasons this cache is serving something other than the
	// newest upstream copy, which the host always prints. Two hooks rather
	// than one because issue #216 made the terminal quiet by default and
	// named a refresh failure as something that must survive that: a docs
	// pane silently stuck on a vendored snapshot is the failure mode.
	debugf func(string, ...any)
	warnf  func(string, ...any)
	// noRefresh disables the background refresh; see NoRefreshEnvVar.
	noRefresh bool

	// loadOnce guards the synchronous, network-free load (embedded snapshot,
	// then any persisted refresh) so that it happens exactly once whether it
	// is triggered by Start or by the first Guides call. A Server constructed
	// but never Run -- which every host handler test does -- therefore still
	// serves full content.
	loadOnce sync.Once

	mu         sync.RWMutex
	guides     []Guide
	provenance Provenance
	// parseErr records a failure to parse even the embedded snapshot, which
	// should be impossible (TestSnapshotParses would have caught it) but must
	// still produce an explanatory pane rather than an empty one.
	parseErr error
}

// NewCache constructs a Cache. cacheDir is where the persisted refresh lives
// (an empty cacheDir disables disk persistence, matching internal/orbs and
// internal/dockerhub).
//
// debugf receives progress and bookkeeping; warnf receives the reason a
// refresh did not happen or did not parse. Either may be nil, which discards
// that level -- so NewCache(dir, nil, nil) is the silent cache tests want.
// See the struct fields for why these are separate.
func NewCache(cacheDir string, debugf, warnf func(string, ...any)) *Cache {
	if debugf == nil {
		debugf = func(string, ...any) {}
	}
	if warnf == nil {
		warnf = func(string, ...any) {}
	}
	return &Cache{
		fetcher:   &Fetcher{},
		cacheDir:  cacheDir,
		debugf:    debugf,
		warnf:     warnf,
		noRefresh: envcompat.Set(NoRefreshEnvVar, supersededNoRefreshEnvVar),
	}
}

// Guides returns the currently-served guides and their provenance. It never
// blocks on the network and never returns a nil slice alongside a nil error.
//
// The returned slice must not be mutated: a refresh publishes an entirely new
// slice rather than modifying the one callers may still hold, so concurrent
// reads need no copying.
func (c *Cache) Guides() ([]Guide, Provenance, error) {
	c.load()
	return c.snapshot()
}

// snapshot reads the currently-published state.
func (c *Cache) snapshot() ([]Guide, Provenance, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.guides, c.provenance, c.parseErr
}

// load performs the synchronous, network-free load exactly once: parse the
// embedded snapshot, then upgrade to any persisted refresh.
func (c *Cache) load() {
	c.loadOnce.Do(func() {
		c.loadVendored()
		c.loadDisk()
	})
}

// Start makes the guides available and, if the newest copy is stale, starts a
// background refresh. It returns as soon as content is servable -- always
// before any network call -- and never returns an error: every failure is
// recorded in Provenance and logged.
func (c *Cache) Start(ctx context.Context) {
	c.load()

	if c.noRefresh {
		c.debugf("guides: %s is set; not checking upstream for updates", NoRefreshEnvVar)
		return
	}
	if !c.stale() {
		return
	}
	go c.refresh(ctx)
}

// Refresh triggers a background check-for-updates outside Start's own TTL
// schedule -- the manual "check now" affordance issue #285 exists to add, for
// the owner's specific complaint that there is no way to tell whether the
// "CircleCI docs offline" badge means "will update" or "never will", let
// alone force the former sooner than refreshTTL.
//
// It deliberately ignores noRefresh (CIRCLECI_EDITOR_GUIDES_NO_REFRESH): that variable
// disables the *automatic* seven-day check, documented from the start as
// leaving room for "no outbound requests beyond those a user explicitly
// triggers" -- a manual click is exactly that, so it must still work even
// when the background cycle has been turned off.
//
// It is a no-op whenever a refresh (Start's own or an earlier Refresh) is
// already in flight, checked and set atomically alongside Provenance so two
// overlapping calls can never both start one -- the same reasoning as
// orbs.Cache.Refresh, applied to a smaller but still real cost (a handful of
// GitHub raw-content requests, run on every launch that finds the copy
// stale; a button next to that must not be able to multiply it).
//
// Refresh never blocks: it returns as soon as that decision is made. A
// caller observes the outcome through Guides()'s Provenance, exactly as it
// already does for the automatic refresh -- Refreshing clears and either the
// content or Error changes, never both a change and a blank pane.
func (c *Cache) Refresh(ctx context.Context) {
	c.load()

	c.mu.Lock()
	if c.provenance.Refreshing {
		c.mu.Unlock()
		return
	}
	c.provenance.Refreshing = true
	c.mu.Unlock()

	go c.refresh(ctx)
}

// loadVendored parses the embedded snapshot and publishes it.
func (c *Cache) loadVendored() {
	manifest, err := LoadManifest()
	if err != nil {
		c.setParseErr(err)
		return
	}
	parsed, err := ParseSnapshot()
	if err != nil {
		c.setParseErr(err)
		return
	}
	c.publish(parsed, Provenance{
		Repo: manifest.Repo,
		// firstNonEmpty: a snapshot vendored before issue #286 added this
		// field has no "ref" key in its manifest.json, but every snapshot
		// this tool has ever produced was in fact resolved from
		// DefaultBranch -- there being no other option -- so backfilling it
		// states a true fact rather than a guess.
		Ref:         firstNonEmpty(manifest.Ref, DefaultBranch),
		Commit:      manifest.Commit,
		CommittedAt: manifest.CommittedAt,
		FetchedAt:   manifest.VendoredAt,
		Source:      SourceVendored,
	})
}

func (c *Cache) setParseErr(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.parseErr = err
	c.warnf("guides: %v", err)
}

// diskCache is the on-disk JSON shape. It stores the *raw AsciiDoc*, not the
// parsed block model, on purpose: the parser then always runs at the version
// baked into the binary that is reading the file, so a parser improvement
// takes effect immediately and a parser change can never have to migrate a
// cached model.
type diskCache struct {
	SchemaVersion int               `json:"schemaVersion"`
	Repo          string            `json:"repo"`
	Ref           string            `json:"ref"`
	Commit        string            `json:"commit"`
	CommittedAt   time.Time         `json:"committedAt"`
	FetchedAt     time.Time         `json:"fetchedAt"`
	Files         map[string][]byte `json:"files"`
}

func (c *Cache) diskPath() string {
	if c.cacheDir == "" {
		return ""
	}
	return filepath.Join(c.cacheDir, diskFileName)
}

// loadDisk replaces the vendored copy with a previously-refreshed one, if a
// usable file exists.
//
// "Usable" deliberately does *not* include a TTL check. An expired file is
// still the best content available -- newer than the vendored snapshot -- so it
// is served while the refresh happens behind it. The TTL governs whether to
// refresh (see stale), not whether to display, which is what makes this pane
// never blank and never spinning.
func (c *Cache) loadDisk() {
	path := c.diskPath()
	if path == "" {
		return
	}
	data, err := os.ReadFile(path) //nolint:gosec // path is the operator-controlled cache directory plus a constant filename, not request input.
	if err != nil {
		return
	}

	var dc diskCache
	if unmarshalErr := json.Unmarshal(data, &dc); unmarshalErr != nil {
		c.debugf("guides: cache file %s is corrupt, ignoring it: %v", path, unmarshalErr)
		return
	}
	if dc.SchemaVersion != diskCacheSchemaVersion {
		c.debugf("guides: cache file %s has schema version %d, want %d; ignoring it", path, dc.SchemaVersion, diskCacheSchemaVersion)
		return
	}
	if dc.Commit == "" || len(dc.Files) == 0 {
		return
	}

	_, current, _ := c.snapshot()
	if dc.Commit == current.Commit {
		// Same upstream commit as the vendored snapshot: identical bytes, so
		// keep serving the embedded copy but adopt the disk file's fetch time
		// so a refresh that already confirmed this commit is current isn't
		// repeated on every launch.
		c.mu.Lock()
		c.provenance.FetchedAt = laterOf(c.provenance.FetchedAt, dc.FetchedAt)
		c.mu.Unlock()
		return
	}

	parsed, err := ParseFiles(dc.Files)
	if err != nil {
		c.debugf("guides: cached refresh at %s does not parse, falling back to the vendored snapshot: %v", dc.Commit, err)
		return
	}
	c.publish(parsed, Provenance{
		Repo:        firstNonEmpty(dc.Repo, UpstreamRepo),
		Ref:         firstNonEmpty(dc.Ref, DefaultBranch),
		Commit:      dc.Commit,
		CommittedAt: dc.CommittedAt,
		FetchedAt:   dc.FetchedAt,
		Source:      SourceRefreshed,
	})
}

func laterOf(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

// stale reports whether the served copy is older than refreshTTL.
func (c *Cache) stale() bool {
	_, prov, _ := c.snapshot()
	return time.Since(prov.FetchedAt) > refreshTTL
}

// refresh fetches, parses and publishes a newer copy of the guides, then
// persists it. Every failure path leaves the previously-served guides exactly
// as they were and records the reason in Provenance.Error.
func (c *Cache) refresh(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, refreshTimeout)
	defer cancel()

	c.setRefreshing(true)
	defer c.setRefreshing(false)

	commit, committedAt, err := c.fetcher.ResolveCommit(ctx)
	if err != nil {
		c.failRefresh(ctx, "resolve upstream commit", err)
		return
	}

	_, current, _ := c.snapshot()
	if commit == current.Commit {
		// Already current. Record the check so the TTL restarts rather than
		// re-checking on every launch.
		c.mu.Lock()
		c.provenance.FetchedAt = time.Now().UTC()
		c.provenance.Error = ""
		c.mu.Unlock()
		c.debugf("guides: upstream is unchanged at %s", shortCommit(commit))
		c.saveDiskMarker(commit, committedAt)
		return
	}

	fetched, err := c.fetcher.FetchAll(ctx, commit)
	if err != nil {
		c.failRefresh(ctx, "fetch guides", err)
		return
	}
	parsed, err := ParseFiles(fetched)
	if err != nil {
		// A refresh that does not parse is not published: the previous copy,
		// stale as it may be, is known-good.
		c.failRefresh(ctx, "parse refreshed guides", err)
		return
	}

	now := time.Now().UTC()
	c.publish(parsed, Provenance{
		Repo:        UpstreamRepo,
		Ref:         DefaultBranch,
		Commit:      commit,
		CommittedAt: committedAt.UTC(),
		FetchedAt:   now,
		Source:      SourceRefreshed,
	})
	c.saveDisk(diskCache{
		SchemaVersion: diskCacheSchemaVersion,
		Repo:          UpstreamRepo,
		Ref:           DefaultBranch,
		Commit:        commit,
		CommittedAt:   committedAt.UTC(),
		FetchedAt:     now,
		Files:         fetched,
	})
	c.debugf("guides: refreshed to %s (%d files)", shortCommit(commit), len(fetched))
}

func shortCommit(commit string) string {
	if len(commit) > 12 {
		return commit[:12]
	}
	return commit
}

// failRefresh records a background-refresh failure. A cancelled context (the
// server shutting down) is not a failure worth telling the user about.
func (c *Cache) failRefresh(ctx context.Context, what string, err error) {
	if ctx.Err() != nil && errors.Is(err, context.Canceled) {
		return
	}
	c.warnf("guides: %s: %v", what, err)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.provenance.Error = fmt.Sprintf("%s: %v", what, err)
}

func (c *Cache) setRefreshing(v bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.provenance.Refreshing = v
}

func (c *Cache) publish(guides []Guide, prov Provenance) {
	c.mu.Lock()
	defer c.mu.Unlock()
	refreshing := c.provenance.Refreshing
	c.guides = guides
	c.provenance = prov
	c.provenance.Refreshing = refreshing
	c.parseErr = nil
}

// saveDiskMarker records "upstream is still at this commit, checked now"
// without rewriting the file bodies -- so a no-op check still restarts the TTL
// across restarts.
func (c *Cache) saveDiskMarker(commit string, committedAt time.Time) {
	path := c.diskPath()
	if path == "" {
		return
	}
	// Read the existing file (if any) so its bodies survive; a marker with no
	// bodies would make the next launch fall back to the vendored snapshot.
	var dc diskCache
	if data, err := os.ReadFile(path); err == nil { //nolint:gosec // See loadDisk.
		_ = json.Unmarshal(data, &dc)
	}
	if len(dc.Files) == 0 {
		// Nothing cached yet and nothing new fetched: the vendored snapshot is
		// what is being served, and it needs no disk copy.
		return
	}
	dc.SchemaVersion = diskCacheSchemaVersion
	dc.Repo = UpstreamRepo
	dc.Ref = DefaultBranch
	dc.Commit = commit
	dc.CommittedAt = committedAt.UTC()
	dc.FetchedAt = time.Now().UTC()
	c.saveDisk(dc)
}

// saveDisk writes dc atomically (temp file in the same directory, then
// rename). It never returns an error: a failure to persist only costs a
// re-fetch after the TTL next expires.
func (c *Cache) saveDisk(dc diskCache) {
	path := c.diskPath()
	if path == "" {
		return
	}
	if err := os.MkdirAll(c.cacheDir, 0o750); err != nil {
		c.debugf("guides: create cache directory %s: %v", c.cacheDir, err)
		return
	}
	data, err := json.Marshal(dc)
	if err != nil {
		c.debugf("guides: marshal disk cache: %v", err)
		return
	}

	tmp, err := os.CreateTemp(c.cacheDir, "guides-*.tmp")
	if err != nil {
		c.debugf("guides: create temp cache file: %v", err)
		return
	}
	// tmpPath is the name os.CreateTemp itself chose inside c.cacheDir; it is
	// not derived from request input, so the Remove/Rename calls below are not
	// the traversal risk gosec assumes for a variable named "path".
	tmpPath := tmp.Name()

	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(tmpPath) //nolint:gosec // See tmpPath comment above.
		c.debugf("guides: write temp cache file %s: write=%v close=%v", tmpPath, writeErr, closeErr)
		return
	}
	if err := os.Rename(tmpPath, path); err != nil { //nolint:gosec // See tmpPath comment above.
		_ = os.Remove(tmpPath) //nolint:gosec // See tmpPath comment above.
		c.debugf("guides: rename %s to %s: %v", tmpPath, path, err)
	}
}
