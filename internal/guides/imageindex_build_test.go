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
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"
)

// fakeTreeUpstream serves a minimal but structurally real repository tree
// plus raw file content at a fixed commit, so BuildImageIndex's walk can be
// tested without a single real network request -- the same reasoning
// cache_test.go's fakeUpstream applies to FetchAll.
type fakeTreeUpstream struct {
	commit string
	files  map[string]string
}

func (f *fakeTreeUpstream) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/tree", func(w http.ResponseWriter, _ *http.Request) {
		type entry struct {
			Path string `json:"path"`
			Type string `json:"type"`
		}
		entries := make([]entry, 0, len(f.files))
		for p := range f.files {
			entries = append(entries, entry{Path: p, Type: "blob"})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(struct {
			Truncated bool    `json:"truncated"`
			Tree      []entry `json:"tree"`
		}{Truncated: false, Tree: entries})
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		prefix := "/" + UpstreamRepo + "/" + f.commit + "/"
		p := strings.TrimPrefix(r.URL.Path, prefix)
		body, ok := f.files[p]
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

// TestBuildImageIndex_FromAFixtureCollidesDeterministicallyAndRecordsProvenance
// is index generation exercised end to end against a fixture upstream,
// covering every property the wider index promises:
//
//   - a page's own image:: macro, and one pulled in from a partial it
//     includes, both attribute to that page's canonical URL;
//   - a page under archive/ is never fetched and never contributes an entry,
//     matching FetchAll's own policy (ExcludedPathReason);
//   - two pages showing the same basename resolve to the alphabetically-first
//     repository path, deterministically, and the collision is counted;
//   - a page with no image:: macro at all contributes neither an image nor a
//     PageChecksums entry;
//   - the result carries the same kind of provenance Manifest gives the
//     vendored prose (repo, ref, commit, commit timestamp) plus a per-page
//     SHA-256 for every page that actually contributed a mapping.
func TestBuildImageIndex_FromAFixtureCollidesDeterministicallyAndRecordsProvenance(t *testing.T) {
	t.Parallel()

	const (
		workflowsPath  = "docs/guides/modules/orchestrate/pages/workflows.adoc"
		partialPath    = "docs/guides/modules/ROOT/partials/shared-partial.adoc"
		pipelinesPath  = "docs/guides/modules/orchestrate/pages/pipelines.adoc"
		cachingPath    = "docs/guides/modules/optimize/pages/caching.adoc"
		noPicturesPath = "docs/guides/modules/orchestrate/pages/no-pictures.adoc"
		archivedPath   = "docs/archive/modules/ROOT/pages/old.adoc"
	)

	upstream := &fakeTreeUpstream{
		commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		files: map[string]string{
			workflowsPath:  "= Workflows\n\nimage::guides:ROOT:two-a.png[]\n\ninclude::ROOT:partial$shared-partial.adoc[]\n",
			partialPath:    "Some shared prose.\n\nimage::guides:ROOT:partial-image.png[]\n",
			pipelinesPath:  "= Pipelines\n\nimage::guides:ROOT:shared.png[]\n",
			cachingPath:    "= Caching\n\nimage::guides:ROOT:shared.png[]\n",
			noPicturesPath: "= No pictures\n\nJust prose, nothing to see.\n",
			archivedPath:   "= Old\n\nimage::guides:ROOT:should-be-excluded.png[]\n",
		},
	}
	server := upstream.server(t)
	f := &Fetcher{BaseURL: server.URL, TreeAPIURL: server.URL + "/tree"}

	committedAt := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)
	idx, stats, err := f.BuildImageIndex(context.Background(), upstream.commit, committedAt)
	assert.NilError(t, err)

	// Provenance: the same shape Manifest gives the vendored prose.
	assert.Equal(t, idx.Repo, UpstreamRepo)
	assert.Equal(t, idx.Ref, DefaultBranch)
	assert.Equal(t, idx.Commit, upstream.commit)
	assert.Equal(t, idx.CommittedAt, committedAt)
	assert.Assert(t, !idx.GeneratedAt.IsZero())

	// archive/ is excluded outright: fetched by nothing, indexed by nothing.
	_, excluded := idx.Images["should-be-excluded.png"]
	assert.Assert(t, !excluded, "an archived page's image must never be indexed")

	// A page's own image, and one from a partial it includes, both attribute
	// to that page -- the same rule Guide.Images already applies to the
	// twenty vendored pages.
	assert.Equal(t, idx.Images["two-a.png"], "https://circleci.com/docs/guides/orchestrate/workflows/")
	assert.Equal(t, idx.Images["partial-image.png"], "https://circleci.com/docs/guides/orchestrate/workflows/")

	// The collision: "optimize" sorts before "orchestrate", so caching.adoc's
	// page wins over pipelines.adoc's -- deterministically, by repository
	// path, per imageIndexSeeds's documented rule.
	assert.Equal(t, idx.Images["shared.png"], "https://circleci.com/docs/guides/optimize/caching/")
	assert.Equal(t, stats.Collisions, 1)

	// A page with nothing to show contributes no image and no checksum.
	_, hasChecksum := idx.PageChecksums[noPicturesPath]
	assert.Assert(t, !hasChecksum)

	// Per-page provenance: re-hashing the fixture body must match exactly
	// what a real auditor re-fetching the page at Commit would do.
	sum := sha256.Sum256([]byte(upstream.files[cachingPath]))
	assert.Equal(t, idx.PageChecksums[cachingPath], hex.EncodeToString(sum[:]))
	_, partialHasOwnEntry := idx.PageChecksums[partialPath]
	assert.Assert(t, !partialHasOwnEntry, "a partial has no URL of its own, so it is not a PageChecksums entry")

	// Stats: four non-excluded pages scanned (workflows, pipelines, caching,
	// no-pictures -- old.adoc is excluded before it is ever counted), five
	// files fetched (those four plus the one shared partial).
	assert.Equal(t, stats.PagesScanned, 4)
	assert.Equal(t, stats.FilesFetched, 5)
	assert.Equal(t, stats.PagesScanned, idx.PagesScanned)
	assert.Equal(t, stats.FilesFetched, idx.FilesFetched)
}

// TestBuildImageIndex_TruncatedTreeFailsRatherThanIndexingPartially pins the
// honest-failure path: a truncated tree listing cannot promise "every page
// was considered", so BuildImageIndex must refuse to write anything rather
// than silently ship an index that looks complete but is not.
func TestBuildImageIndex_TruncatedTreeFailsRatherThanIndexingPartially(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/tree", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"truncated": true, "tree": []}`)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	f := &Fetcher{BaseURL: server.URL, TreeAPIURL: server.URL + "/tree"}
	_, _, err := f.BuildImageIndex(context.Background(), "abc123", time.Now())
	assert.ErrorContains(t, err, "truncated")
}

// TestImageIndexSeeds_ExcludesArchiveAndServerAdmin pins ExcludedPathReason's
// application to this walk specifically, independent of the fixture above:
// an archived or server-admin page must never even become a seed, so it can
// neither be fetched nor cited.
func TestImageIndexSeeds_ExcludesArchiveAndServerAdmin(t *testing.T) {
	t.Parallel()

	tree := []string{
		"docs/guides/modules/orchestrate/pages/workflows.adoc",
		"docs/archive/modules/ROOT/pages/old.adoc",
		"docs/server-admin-4.10/modules/ROOT/pages/install.adoc",
		"docs/guides/modules/ROOT/partials/shared.adoc", // not a page family: not a seed
		"docs/guides/modules/orchestrate/images/diagram.png",
	}
	seeds := imageIndexSeeds(tree)
	assert.Assert(t, is.Len(seeds, 1))
	assert.Equal(t, seeds[0].repoPath, "docs/guides/modules/orchestrate/pages/workflows.adoc")
}

// TestExtractImageBasenames_MatchesTheParsersOwnRule pins that
// extractImageBasenames -- the textual scan cmd/refresh-image-index uses so
// it never has to build a full parser and Guide for 300-odd pages this
// package does not otherwise render -- recognises exactly the macros
// noteImage does, via the imageMacroBasename function both share.
func TestExtractImageBasenames_MatchesTheParsersOwnRule(t *testing.T) {
	t.Parallel()

	source := []byte(`= A page

image::guides:ROOT:workspace.png[Workspace diagram]

Some prose in between.

image::https://example.com/external.png[External, dropped: not a docs-site image]

image::ANOTHER-CASED.PNG[Repeated basename, different case, still one entry]

image::guides:ROOT:workspace.png[The same image again]
`)

	assert.DeepEqual(t, extractImageBasenames(source), []string{"another-cased.png", "workspace.png"})
}
