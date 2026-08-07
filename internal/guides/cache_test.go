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
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"
)

// fakeUpstream serves a minimal but structurally real circleci-docs at a
// chosen commit, so cache and fetcher behaviour can be tested without a single
// real network request.
type fakeUpstream struct {
	commit string
	files  map[string]string

	mu sync.Mutex
	// requests counts raw-content requests, so a test can assert that a fresh
	// cache made *no* outbound calls at all.
	requests int
	// requested records which paths were asked for, so a test can assert that a
	// refresh covered *every* vendored page rather than merely some of them.
	requested []string
}

func newFakeUpstream(commit string, extraLead string) *fakeUpstream {
	files := map[string]string{}
	// UpstreamSources(), not Sources: this project's own editor documentation is
	// embedded, never fetched, and a fake upstream that served it would hide the
	// difference.
	for _, src := range UpstreamSources() {
		files[src.entryPath()] = fmt.Sprintf(
			"= %s\n:page-description: fixture\n\n%s\n\n[#alpha]\n== *`alpha`*\n\nAlpha prose.\n",
			src.Label, extraLead)
	}
	return &fakeUpstream{commit: commit, files: files}
}

func (f *fakeUpstream) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/commit", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"sha":%q,"commit":{"committer":{"date":"2026-07-01T00:00:00Z"}}}`, f.commit)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		prefix := "/" + UpstreamRepo + "/" + f.commit + "/"
		path := strings.TrimPrefix(r.URL.Path, prefix)
		f.mu.Lock()
		f.requests++
		f.requested = append(f.requested, path)
		f.mu.Unlock()
		body, ok := f.files[path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(body))
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

// paths returns every raw-content path the fake upstream was asked for.
func (f *fakeUpstream) paths() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.requested...)
}

// fetcherFor points a Fetcher at a fake upstream.
func fetcherFor(server *httptest.Server) *Fetcher {
	return &Fetcher{BaseURL: server.URL, APIBaseURL: server.URL + "/commit"}
}

// TestCacheServesVendoredSnapshotWithoutTouchingTheNetwork is the pane's
// central promise: content on first launch, offline, with no token. A cache
// with no disk file and a *deliberately unreachable* fetcher still serves all
// three guides.
func TestCacheServesVendoredSnapshotWithoutTouchingTheNetwork(t *testing.T) {
	t.Parallel()

	cache := NewCache(t.TempDir(), nil, nil)
	// An unroutable base URL: if Start's synchronous path ever depended on the
	// network, this test would either hang or fail rather than pass quietly.
	cache.fetcher = &Fetcher{
		BaseURL:    "http://127.0.0.1:1/never",
		APIBaseURL: "http://127.0.0.1:1/never",
	}
	cache.noRefresh = true

	cache.Start(context.Background())

	parsed, prov, err := cache.Guides()
	assert.NilError(t, err)
	assert.Assert(t, is.Len(parsed, len(Sources)))
	assert.Equal(t, prov.Source, SourceVendored)
	assert.Equal(t, prov.Repo, UpstreamRepo)
	assert.Equal(t, prov.Ref, DefaultBranch)
	assert.Assert(t, is.Len(prov.Commit, 40))
	assert.Equal(t, prov.Error, "")
}

// waitUntilNotRefreshing polls Guides()'s Provenance.Refreshing until it is
// false, failing if timeout elapses first -- Refresh's own background
// goroutine is the only thing that will ever clear it.
func waitUntilNotRefreshing(t *testing.T, cache *Cache, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		_, prov, _ := cache.Guides()
		if !prov.Refreshing {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("cache did not stop refreshing within %s", timeout)
}

// TestCacheRefresh_ManualCheckReplacesTheVendoredCopy is Refresh's own happy
// path (issue #285): a manual "check now" call, made without ever having
// gone stale, still fetches and publishes upstream's current copy -- Start
// only refreshes past refreshTTL, and Refresh exists precisely so a user is
// not stuck waiting for that.
func TestCacheRefresh_ManualCheckReplacesTheVendoredCopy(t *testing.T) {
	t.Parallel()

	upstream := newFakeUpstream("3333333333333333333333333333333333333333", "Manually refreshed lead.")
	server := upstream.server(t)

	cache := NewCache(t.TempDir(), nil, nil)
	cache.fetcher = fetcherFor(server)
	cache.load()

	cache.Refresh(context.Background())
	waitUntilNotRefreshing(t, cache, 2*time.Second)

	parsed, prov, err := cache.Guides()
	assert.NilError(t, err)
	assert.Equal(t, prov.Source, SourceRefreshed)
	assert.Equal(t, prov.Commit, upstream.commit)
	assert.Equal(t, prov.Error, "")
	assert.Equal(t, plainText(parsed[0].Lead[0].Spans), "Manually refreshed lead.")
}

// TestCacheRefresh_NoOpWhileAlreadyRefreshing guards the same rate-limit
// requirement orbs.Cache.Refresh does: a user (or two browser tabs) clicking
// the button twice must cost one refresh, not two.
func TestCacheRefresh_NoOpWhileAlreadyRefreshing(t *testing.T) {
	t.Parallel()

	upstream := newFakeUpstream("4444444444444444444444444444444444444444", "lead")
	server := upstream.server(t)

	cache := NewCache(t.TempDir(), nil, nil)
	cache.fetcher = fetcherFor(server)
	cache.load()

	cache.mu.Lock()
	cache.provenance.Refreshing = true
	cache.mu.Unlock()

	before := upstream.requests
	cache.Refresh(context.Background())
	// Refresh returns immediately either way, so give a would-be second
	// refresh a moment to have started before checking it didn't.
	time.Sleep(20 * time.Millisecond)
	assert.Equal(t, upstream.requests, before, "a refresh already in flight must make this call a no-op")

	cache.mu.Lock()
	cache.provenance.Refreshing = false
	cache.mu.Unlock()
}

// TestCacheRefresh_IgnoresNoRefreshEnvVar is the other half of issue #285's
// docs note: CIRCLECI_EDITOR_GUIDES_NO_REFRESH disables the *automatic* seven-day check,
// documented from the start as leaving room for requests "a user explicitly
// triggers" -- Refresh is exactly that, and must still work with the
// automatic cycle turned off.
func TestCacheRefresh_IgnoresNoRefreshEnvVar(t *testing.T) {
	t.Parallel()

	upstream := newFakeUpstream("5555555555555555555555555555555555555555", "lead")
	server := upstream.server(t)

	cache := NewCache(t.TempDir(), nil, nil)
	cache.fetcher = fetcherFor(server)
	cache.noRefresh = true
	cache.load()

	cache.Refresh(context.Background())
	waitUntilNotRefreshing(t, cache, 2*time.Second)

	_, prov, err := cache.Guides()
	assert.NilError(t, err)
	assert.Equal(t, prov.Source, SourceRefreshed)
	assert.Equal(t, prov.Commit, upstream.commit)
}

func TestCacheRefreshReplacesTheVendoredCopyAndPersistsIt(t *testing.T) {
	t.Parallel()

	upstream := newFakeUpstream("1111111111111111111111111111111111111111", "Refreshed lead paragraph.")
	server := upstream.server(t)
	dir := t.TempDir()

	cache := NewCache(dir, nil, nil)
	cache.fetcher = fetcherFor(server)
	cache.load()
	cache.refresh(context.Background())

	parsed, prov, err := cache.Guides()
	assert.NilError(t, err)
	assert.Equal(t, prov.Source, SourceRefreshed)
	assert.Equal(t, prov.Commit, upstream.commit)
	assert.Equal(t, prov.Ref, DefaultBranch)
	assert.Equal(t, prov.Error, "")
	assert.Assert(t, is.Len(parsed, len(Sources)))
	assert.Equal(t, plainText(parsed[0].Lead[0].Spans), "Refreshed lead paragraph.")

	// Persisted, so the next launch serves the refreshed copy with no request.
	data, readErr := os.ReadFile(filepath.Join(dir, diskFileName))
	assert.NilError(t, readErr)
	var dc diskCache
	assert.NilError(t, json.Unmarshal(data, &dc))
	assert.Equal(t, dc.SchemaVersion, diskCacheSchemaVersion)
	assert.Equal(t, dc.Commit, upstream.commit)
	assert.Equal(t, dc.Ref, DefaultBranch)
	assert.Assert(t, len(dc.Files) >= len(UpstreamSources()))

	// A second, independent cache over the same directory picks it up without
	// any network at all -- the point of persisting.
	before := upstream.requests
	second := NewCache(dir, nil, nil)
	second.fetcher = fetcherFor(server)
	second.noRefresh = true
	second.Start(context.Background())
	_, secondProv, secondErr := second.Guides()
	assert.NilError(t, secondErr)
	assert.Equal(t, secondProv.Source, SourceRefreshed)
	assert.Equal(t, secondProv.Commit, upstream.commit)
	assert.Equal(t, upstream.requests, before)
}

// TestCacheRefreshFailureKeepsServingTheOldCopy is the "degrade honestly"
// invariant: a failed update never empties the pane, and the reason is
// reported rather than swallowed.
func TestCacheRefreshFailureKeepsServingTheOldCopy(t *testing.T) {
	t.Parallel()

	cache := NewCache(t.TempDir(), nil, nil)
	cache.fetcher = &Fetcher{
		BaseURL:    "http://127.0.0.1:1/never",
		APIBaseURL: "http://127.0.0.1:1/never",
	}
	cache.load()
	_, before, _ := cache.snapshot()

	cache.refresh(context.Background())

	parsed, after, err := cache.Guides()
	assert.NilError(t, err)
	assert.Assert(t, is.Len(parsed, len(Sources)))
	assert.Equal(t, after.Commit, before.Commit)
	assert.Equal(t, after.Source, SourceVendored)
	assert.Assert(t, after.Error != "", "a failed refresh must report why")
	assert.Equal(t, after.Refreshing, false)
}

// TestCacheRefreshThatDoesNotParseIsNotPublished guards the one way a refresh
// could make things *worse* than not refreshing: upstream restructuring a page
// so this parser no longer finds it.
func TestCacheRefreshThatDoesNotParseIsNotPublished(t *testing.T) {
	t.Parallel()

	upstream := newFakeUpstream("2222222222222222222222222222222222222222", "lead")
	// Every entry page gone: FetchAll must refuse to return a partial set.
	upstream.files = map[string]string{}
	server := upstream.server(t)

	cache := NewCache(t.TempDir(), nil, nil)
	cache.fetcher = fetcherFor(server)
	cache.load()
	_, before, _ := cache.snapshot()

	cache.refresh(context.Background())

	parsed, after, err := cache.Guides()
	assert.NilError(t, err)
	assert.Assert(t, is.Len(parsed, len(Sources)))
	assert.Equal(t, after.Commit, before.Commit)
	assert.Assert(t, after.Error != "")
}

func TestCacheUnchangedUpstreamRestartsTheTTLWithoutRefetching(t *testing.T) {
	t.Parallel()

	manifest, err := LoadManifest()
	assert.NilError(t, err)

	// Upstream is at exactly the commit the snapshot was vendored from.
	upstream := newFakeUpstream(manifest.Commit, "lead")
	server := upstream.server(t)

	cache := NewCache(t.TempDir(), nil, nil)
	cache.fetcher = fetcherFor(server)
	cache.load()
	cache.refresh(context.Background())

	_, prov, _ := cache.Guides()
	assert.Equal(t, prov.Source, SourceVendored)
	assert.Equal(t, prov.Commit, manifest.Commit)
	assert.Equal(t, prov.Error, "")
	// No file bodies were fetched: only the one commit-resolution request.
	assert.Equal(t, upstream.requests, 0)
	assert.Assert(t, time.Since(prov.FetchedAt) < time.Minute, "the TTL clock should have been restarted")
}

func TestCacheIgnoresACorruptOrForeignDiskFile(t *testing.T) {
	t.Parallel()

	for name, contents := range map[string]string{
		"corrupt JSON":            "{not json",
		"wrong schema version":    `{"schemaVersion":999,"commit":"abc","files":{"x":"eA=="}}`,
		"no commit":               `{"schemaVersion":1,"files":{"x":"eA=="}}`,
		"unparseable cached text": `{"schemaVersion":1,"commit":"3333333333333333333333333333333333333333","files":{"docs/nope.adoc":"eA=="}}`,
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			dir := t.TempDir()
			assert.NilError(t, os.WriteFile(filepath.Join(dir, diskFileName), []byte(contents), 0o600))

			cache := NewCache(dir, nil, nil)
			cache.noRefresh = true
			cache.Start(context.Background())

			// Falls all the way back to the embedded snapshot rather than
			// serving nothing.
			parsed, prov, err := cache.Guides()
			assert.NilError(t, err)
			assert.Assert(t, is.Len(parsed, len(Sources)))
			assert.Equal(t, prov.Source, SourceVendored)
		})
	}
}

func TestCacheStartWithNoCacheDirStillWorks(t *testing.T) {
	t.Parallel()

	// An empty cacheDir disables persistence (matching internal/orbs and
	// internal/dockerhub) and must not disable the pane.
	cache := NewCache("", nil, nil)
	cache.noRefresh = true
	cache.Start(context.Background())

	parsed, _, err := cache.Guides()
	assert.NilError(t, err)
	assert.Assert(t, is.Len(parsed, len(Sources)))
}

// TestRefreshCoversEveryUpstreamSource is the test issue #176 exists for.
//
// The owner's stated reason for vendoring CircleCI's documentation rather than
// rewriting it is the update mechanism: *"Ideally we could just take from
// CircleCI and utilize that, so that way we can keep that update mechanism
// going."* A refresh that widened to twenty pages but only re-fetched the
// original three would satisfy every other test in this package while quietly
// turning seventeen pages into frozen copies -- indistinguishable from the
// "recreate the documentation" outcome the owner rejected, and invisible until
// someone noticed a page was a year out of date.
//
// So this asserts coverage directly, on the *background* refresh path (the
// seven-day one a running editor uses, not the developer's `task guides:refresh`
// command), by recording which paths the fetcher actually requested:
//
//   - every upstream entry page was requested, by path;
//   - every one of them was published into the served guides at the new commit,
//     so none silently kept its vendored body;
//   - this project's own editor documentation was *not* requested, because it is
//     ours and there is nothing upstream to fetch.
func TestRefreshCoversEveryUpstreamSource(t *testing.T) {
	t.Parallel()

	upstream := newFakeUpstream("6666666666666666666666666666666666666666", "Refreshed everywhere.")
	server := upstream.server(t)

	cache := NewCache(t.TempDir(), nil, nil)
	cache.fetcher = fetcherFor(server)
	cache.load()
	cache.refresh(context.Background())

	parsed, prov, err := cache.Guides()
	assert.NilError(t, err)
	assert.Equal(t, prov.Source, SourceRefreshed)
	assert.Equal(t, prov.Commit, upstream.commit)
	assert.Equal(t, prov.Error, "")

	requested := map[string]bool{}
	for _, path := range upstream.paths() {
		requested[path] = true
	}

	byID := map[string]Guide{}
	for _, guide := range parsed {
		byID[guide.ID] = guide
	}

	upstreamCount := 0
	for _, src := range Sources {
		guide, served := byID[src.ID]
		assert.Assert(t, served, "%s was not served after a refresh", src.ID)

		switch src.Origin {
		case OriginCircleCI:
			upstreamCount++
			assert.Assert(t, requested[src.entryPath()],
				"the background refresh never asked upstream for %s (%s) -- it would stay frozen at whatever this binary shipped",
				src.ID, src.entryPath())
			// The refreshed body, not the vendored one. The fixture's lead is
			// the marker: the real vendored page does not contain it.
			assert.Assert(t, is.Contains(plainText(guide.Lead[0].Spans), "Refreshed everywhere."),
				"%s was requested but is still serving its vendored body", src.ID)
		case OriginEditor:
			assert.Assert(t, !requested[src.ID+".adoc"], "%s should never be fetched", src.ID)
			for path := range requested {
				assert.Assert(t, !strings.Contains(path, src.File),
					"the refresh asked upstream for our own %s", src.File)
			}
		}
	}
	assert.Assert(t, upstreamCount >= 20, "only %d upstream pages were checked", upstreamCount)
}

// TestUpstreamClosureFitsWithinTheFetchBudget checks the real vendored closure
// against maxFiles, so the twenty-page set plus the partials it shares has
// headroom rather than sitting one upstream refactor away from a refresh that
// aborts. Run against the snapshot rather than the network: it is the same
// closure FetchAll resolves, and a test that needs GitHub is a test that fails
// on a plane.
func TestUpstreamClosureFitsWithinTheFetchBudget(t *testing.T) {
	t.Parallel()

	files, err := snapshotFiles()
	assert.NilError(t, err)
	assert.Assert(t, len(files) < maxFiles,
		"the vendored closure is %d files against a %d-file budget", len(files), maxFiles)

	// And every one of them is inside the per-file size bound the fetcher
	// enforces, so a refresh cannot fail on a file the snapshot already holds.
	for name, data := range files {
		assert.Assert(t, len(data) <= maxFileBytes, "%s is %d bytes", name, len(data))
	}
}

// TestFetchAllRefusesToWalkIntoExcludedContent pins the exclusion policy at the
// point it matters: not the hand-written page list (which TestNoSourceIsAn
// ExcludedPath covers) but the include closure, which nobody chooses by hand. An
// upstream page that grows an `include::` of an archived partial must not drag
// 3.3 MB of superseded content into the snapshot.
func TestFetchAllRefusesToWalkIntoExcludedContent(t *testing.T) {
	t.Parallel()

	upstream := newFakeUpstream("7777777777777777777777777777777777777777", "lead")
	entry := UpstreamSources()[0].entryPath()
	upstream.files[entry] = "= Ref\n\n== S\n\ninclude::archive:ROOT:partial$notes/old.adoc[]\n\ninclude::server-admin-4.7:ROOT:partial$notes/admin.adoc[]\n"
	// Present upstream, and still must not be fetched.
	upstream.files["docs/archive/modules/ROOT/partials/notes/old.adoc"] = "Superseded.\n"
	upstream.files["docs/server-admin-4.7/modules/ROOT/partials/notes/admin.adoc"] = "Server admin.\n"
	server := upstream.server(t)

	fetched, err := fetcherFor(server).FetchAll(context.Background(), upstream.commit)
	assert.NilError(t, err)

	for name := range fetched {
		assert.Equal(t, ExcludedPathReason(name), "", "fetched excluded path %s", name)
	}
	for _, path := range upstream.paths() {
		assert.Equal(t, ExcludedPathReason(path), "", "requested excluded path %s", path)
	}

	// Skipped, not silently blank: the parser says so where the content would
	// have been, the same as for a 404.
	parsed, parseErr := ParseFiles(fetched)
	assert.NilError(t, parseErr)
	assert.Equal(t, parsed[0].Sections[0].Blocks[0].Kind, KindNote)
}

func TestFetcherResolvesTheIncludeClosure(t *testing.T) {
	t.Parallel()

	upstream := newFakeUpstream("4444444444444444444444444444444444444444", "lead")
	// Give one entry page an include, and give that partial an include of its
	// own, so the closure has to iterate rather than just look one level deep.
	upstream.files[UpstreamSources()[0].entryPath()] = "= Ref\n\n== S\n\ninclude::guides:ROOT:partial$notes/one.adoc[]\n"
	upstream.files["docs/guides/modules/ROOT/partials/notes/one.adoc"] = "One.\n\ninclude::ROOT:partial$notes/two.adoc[]\n"
	upstream.files["docs/guides/modules/ROOT/partials/notes/two.adoc"] = "Two.\n"
	server := upstream.server(t)

	fetched, err := fetcherFor(server).FetchAll(context.Background(), upstream.commit)
	assert.NilError(t, err)
	assert.Assert(t, is.Contains(keysOf(fetched), "docs/guides/modules/ROOT/partials/notes/two.adoc"))

	// And the closure's contents are what the parser then splices in.
	parsed, parseErr := ParseFiles(fetched)
	assert.NilError(t, parseErr)
	text := plainText(parsed[0].Sections[0].Blocks[0].Spans) + plainText(parsed[0].Sections[0].Blocks[1].Spans)
	assert.Assert(t, is.Contains(text, "One."))
	assert.Assert(t, is.Contains(text, "Two."))
}

func TestFetcherSkipsAMissingIncludeButFailsOnAMissingEntryPage(t *testing.T) {
	t.Parallel()

	upstream := newFakeUpstream("5555555555555555555555555555555555555555", "lead")
	upstream.files[UpstreamSources()[0].entryPath()] = "= Ref\n\n== S\n\ninclude::guides:ROOT:partial$notes/gone.adoc[]\n"
	server := upstream.server(t)

	// A 404 include is a content change upstream, not a transport failure: the
	// fetch succeeds and the parser renders an honest note in its place.
	fetched, err := fetcherFor(server).FetchAll(context.Background(), upstream.commit)
	assert.NilError(t, err)
	parsed, parseErr := ParseFiles(fetched)
	assert.NilError(t, parseErr)
	assert.Equal(t, parsed[0].Sections[0].Blocks[0].Kind, KindNote)

	// A missing *entry page*, by contrast, must abort: a partial snapshot must
	// never overwrite a good one.
	delete(upstream.files, UpstreamSources()[1].entryPath())
	_, err = fetcherFor(server).FetchAll(context.Background(), upstream.commit)
	assert.ErrorContains(t, err, "was not fetched")
}

func TestFetcherSendsNoCredentials(t *testing.T) {
	t.Parallel()

	// This package reads public raw content only. A stray Authorization header
	// would mean it had grown a credential requirement, which is exactly what
	// keeps the pane working for a user with no CIRCLE_TOKEN.
	var sawAuth bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			sawAuth = true
		}
		_, _ = w.Write([]byte("= T\n"))
	}))
	t.Cleanup(server.Close)

	_, err := (&Fetcher{BaseURL: server.URL}).FetchFile(context.Background(), "abc", "docs/x.adoc")
	assert.NilError(t, err)
	assert.Equal(t, sawAuth, false)
}

func keysOf(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// recordingLogs collects what each verbosity level was told, so a test can
// assert not merely *that* something was logged but at which level. Safe for
// the background refresh goroutine to write to.
type recordingLogs struct {
	mu     sync.Mutex
	debug  []string
	notice []string
}

func (r *recordingLogs) debugf(format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.debug = append(r.debug, fmt.Sprintf(format, args...))
}

func (r *recordingLogs) warnf(format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.notice = append(r.notice, fmt.Sprintf(format, args...))
}

func (r *recordingLogs) joined() (debug, notice string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.Join(r.debug, "\n"), strings.Join(r.notice, "\n")
}

// TestCacheRefreshFailureIsANoticeNotADebugLine is issue #216's boundary for
// this cache. The terminal is quiet by default now, and a refresh failure is
// named in that issue as something that must survive it: the visible symptom
// is a docs pane silently stuck on a vendored snapshot, with the reason
// discarded.
func TestCacheRefreshFailureIsANoticeNotADebugLine(t *testing.T) {
	t.Parallel()

	upstream := newFakeUpstream("3333333333333333333333333333333333333333", "lead")
	// Every entry page gone, so FetchAll refuses and the refresh fails.
	upstream.files = map[string]string{}
	server := upstream.server(t)

	logs := &recordingLogs{}
	cache := NewCache(t.TempDir(), logs.debugf, logs.warnf)
	cache.fetcher = fetcherFor(server)
	cache.load()

	cache.refresh(context.Background())

	debug, notice := logs.joined()
	assert.Assert(t, is.Contains(notice, "guides:"),
		"a refresh failure must reach the level that always prints; debug had %q", debug)
	assert.Assert(t, !strings.Contains(debug, "fetch guides"),
		"the failure reason must not be filed as bookkeeping")
}

// TestCacheUnchangedUpstreamIsBookkeepingNotANotice is the other side of the
// same boundary, and the one that makes the default quiet: "upstream is
// unchanged" is the *common* case on every launch, so if it printed at default
// verbosity the issue would not be fixed.
func TestCacheUnchangedUpstreamIsBookkeepingNotANotice(t *testing.T) {
	t.Parallel()

	manifest, err := LoadManifest()
	assert.NilError(t, err)

	upstream := newFakeUpstream(manifest.Commit, "lead")
	server := upstream.server(t)

	logs := &recordingLogs{}
	cache := NewCache(t.TempDir(), logs.debugf, logs.warnf)
	cache.fetcher = fetcherFor(server)
	cache.load()

	cache.refresh(context.Background())

	debug, notice := logs.joined()
	assert.Assert(t, is.Contains(debug, "upstream is unchanged"),
		"--debug should still be able to show why no refresh happened")
	assert.Equal(t, notice, "",
		"a successful no-op refresh check must print nothing at default verbosity")
}

// TestCacheHooksMayBeNil pins the constructor contract the whole test suite
// relies on: NewCache(dir, nil, nil) is a silent cache, not a panic on the
// first diagnostic.
func TestCacheHooksMayBeNil(t *testing.T) {
	t.Parallel()

	cache := NewCache(t.TempDir(), nil, nil)
	cache.load()
	cache.debugf("bookkeeping %d", 1)
	cache.warnf("failure %v", context.Canceled)
}

// TestNoRefresh_SupersededSpelling pins that the pre-rename variable still
// pins the snapshot. This one matters more than it looks: it is the switch that
// keeps tests and offline runs from reaching the network, so silently losing it
// would turn hermetic runs into ones that quietly depend on upstream.
func TestNoRefresh_SupersededSpelling(t *testing.T) {
	t.Setenv(supersededNoRefreshEnvVar, "1")
	// This test is in package guides, so it reads the field the constructor
	// sets rather than needing an accessor exposed only for it.
	assert.Assert(t, NewCache(t.TempDir(), nil, nil).noRefresh,
		"the superseded spelling must still disable the background refresh")
}
