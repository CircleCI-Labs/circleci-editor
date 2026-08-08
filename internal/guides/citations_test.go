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
	"errors"
	"strings"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"
)

// fakeGuides is a small stand-in for the parsed snapshot, so the policy tests
// below state their own inputs instead of depending on upstream prose that can
// be reworded by a snapshot refresh. The snapshot-backed assertions are in
// TestCitationResolver_AgainstTheRealSnapshot.
func fakeGuides() []Guide {
	return []Guide{
		{
			ID:    "configuration-reference",
			Title: "Configuration reference",
			URL:   "https://circleci.com/docs/reference/configuration-reference/",
			Sections: []Section{
				{ID: "docker", Title: "docker", URL: "https://circleci.com/docs/reference/configuration-reference/#docker"},
				{ID: "savecache", Title: "save_cache", URL: "https://circleci.com/docs/reference/configuration-reference/#savecache"},
			},
			Images: []string{"shared-diagram.png"},
		},
		{
			ID:       "dynamic-config",
			Title:    "Dynamic configuration overview",
			URL:      "https://circleci.com/docs/guides/orchestrate/dynamic-config/",
			Sections: []Section{},
			Images:   []string{"dynamic-config-enable.png", "shared-diagram.png"},
		},
	}
}

func TestCitationResolver_ResolvesPageAndSectionTitlesOffline(t *testing.T) {
	t.Parallel()

	got := NewCitationResolver(fakeGuides()).Normalize([]string{
		"https://circleci.com/docs/guides/orchestrate/dynamic-config/",
		"https://circleci.com/docs/reference/configuration-reference/#savecache",
	})

	assert.DeepEqual(t, got, []Citation{
		{URL: "https://circleci.com/docs/guides/orchestrate/dynamic-config/", Title: "Dynamic configuration overview"},
		{URL: "https://circleci.com/docs/reference/configuration-reference/#savecache", Title: "save_cache"},
	})
}

// An unknown fragment must fall back to the page's own title rather than to
// nothing: a citation of a section this snapshot doesn't happen to have an
// anchor for is still a citation of a page we can name.
func TestCitationResolver_UnknownFragmentFallsBackToThePageTitle(t *testing.T) {
	t.Parallel()

	got := NewCitationResolver(fakeGuides()).Normalize([]string{
		"https://circleci.com/docs/reference/configuration-reference/#some-anchor-we-do-not-have",
	})

	assert.Assert(t, is.Len(got, 1))
	assert.Equal(t, got[0].Title, "Configuration reference")
}

// A page outside the three vendored guides keeps its URL and gets no title --
// the frontend derives a label from the path. Crucially it is *not* dropped:
// the source is real even when this snapshot cannot name it.
func TestCitationResolver_KeepsUnknownPagesWithoutATitle(t *testing.T) {
	t.Parallel()

	got := NewCitationResolver(fakeGuides()).Normalize([]string{
		"https://circleci.com/docs/guides/execution-managed/persist-data/",
	})

	assert.DeepEqual(t, got, []Citation{
		{URL: "https://circleci.com/docs/guides/execution-managed/persist-data/"},
	})
}

// The owner's report, both halves (issue #156): a cited image becomes the page
// that shows it, and an image whose page is not in the snapshot is dropped
// rather than shown as a bare asset.
func TestCitationResolver_MapsAnImageToItsPageAndDropsUnmappableOnes(t *testing.T) {
	t.Parallel()

	got := NewCitationResolver(fakeGuides()).Normalize([]string{
		"https://circleci.com/docs/guides/_images/dynamic-config-enable.png",
		"https://circleci.com/docs/guides/_images/workspace.png",
	})

	assert.DeepEqual(t, got, []Citation{
		{URL: "https://circleci.com/docs/guides/orchestrate/dynamic-config/", Title: "Dynamic configuration overview"},
	})
}

// The exact string shape the owner saw -- a repository-relative path, not a
// URL. It still gets its one chance to be mapped, and is dropped when it
// cannot be: a bare asset path is never shown as a source.
func TestCitationResolver_MapsABareImagePathAndDropsAnUnmappableOne(t *testing.T) {
	t.Parallel()

	resolver := NewCitationResolver(fakeGuides())

	assert.DeepEqual(t, resolver.Normalize([]string{"circleci-docs/guides/_images/dynamic-config-enable.png"}),
		[]Citation{{URL: "https://circleci.com/docs/guides/orchestrate/dynamic-config/", Title: "Dynamic configuration overview"}})

	assert.Assert(t, is.Len(resolver.Normalize([]string{"circleci-docs/guides/_images/workspace.png"}), 0))
}

// Mapping an image can *create* a duplicate, which is the case the owner's
// report runs into: the reply cited both the workspaces page and its diagram.
func TestCitationResolver_CollapsesADuplicateCreatedByMapping(t *testing.T) {
	t.Parallel()

	got := NewCitationResolver(fakeGuides()).Normalize([]string{
		"https://circleci.com/docs/guides/orchestrate/dynamic-config/",
		"https://circleci.com/docs/guides/_images/dynamic-config-enable.png",
	})

	assert.DeepEqual(t, got, []Citation{
		{URL: "https://circleci.com/docs/guides/orchestrate/dynamic-config/", Title: "Dynamic configuration overview"},
	})
}

func TestCitationResolver_DropsNonPageAssetsAndUnlinkableURLs(t *testing.T) {
	t.Parallel()

	got := NewCitationResolver(fakeGuides()).Normalize([]string{
		"https://circleci.com/assets/site.css",
		"https://circleci.com/assets/bundle.js",
		"https://circleci.com/assets/fonts/inter.woff2",
		// Not a scheme this UI will ever link to. The frontend rejects these
		// too (defence in depth) but they must not get that far.
		"javascript:alert(1)",
		"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
		"ftp://example.com/docs/page/",
		"file:///etc/passwd",
		"not a url at all",
		"",
	})

	assert.Assert(t, is.Len(got, 0), "got=%+v", got)
}

// Deduplication is on host + path + fragment, ignoring the query string (only
// tracking parameters ever add one) and a trailing slash, but *not* the
// fragment: two sections of one page are two citations.
func TestCitationResolver_DeduplicatesButKeepsDistinctSections(t *testing.T) {
	t.Parallel()

	got := NewCitationResolver(fakeGuides()).Normalize([]string{
		"https://circleci.com/docs/reference/configuration-reference/#docker",
		"https://circleci.com/docs/reference/configuration-reference/?utm_source=kapa#docker",
		"http://circleci.com/docs/reference/configuration-reference#docker",
		"https://circleci.com/docs/reference/configuration-reference/#savecache",
	})

	assert.DeepEqual(t, got, []Citation{
		{URL: "https://circleci.com/docs/reference/configuration-reference/#docker", Title: "docker"},
		{URL: "https://circleci.com/docs/reference/configuration-reference/#savecache", Title: "save_cache"},
	})
}

// Order is the provider's, never this package's: the first citation is the one
// the model leant on most heavily, and reordering would quietly editorialise.
func TestCitationResolver_PreservesProviderOrder(t *testing.T) {
	t.Parallel()

	got := NewCitationResolver(fakeGuides()).Normalize([]string{
		"https://example.com/b/",
		"https://example.com/a/",
	})

	assert.DeepEqual(t, got, []Citation{
		{URL: "https://example.com/b/"},
		{URL: "https://example.com/a/"},
	})
}

// A resolver with nothing indexed (the host's snapshot failed to parse) must
// still filter and deduplicate. Fewer bad citations, not none.
func TestCitationResolver_WithNoGuidesStillFiltersAndDeduplicates(t *testing.T) {
	t.Parallel()

	got := NewCitationResolver(nil).Normalize([]string{
		"https://circleci.com/docs/guides/_images/workspace.png",
		"https://circleci.com/docs/guides/execution-managed/persist-data/",
		"https://circleci.com/docs/guides/execution-managed/persist-data/",
	})

	assert.DeepEqual(t, got, []Citation{
		{URL: "https://circleci.com/docs/guides/execution-managed/persist-data/"},
	})
}

// The same shared image on two pages resolves to the first page in guide
// order, deterministically -- a collision picks one of two pages that both
// show it, which is still better than citing the asset.
func TestCitationResolver_SharedImageResolvesDeterministically(t *testing.T) {
	t.Parallel()

	resolver := NewCitationResolver(fakeGuides())
	for range 5 {
		got := resolver.Normalize([]string{"https://circleci.com/docs/_images/shared-diagram.png"})
		assert.DeepEqual(t, got, []Citation{
			{URL: "https://circleci.com/docs/reference/configuration-reference/", Title: "Configuration reference"},
		})
	}
}

// The properties that must hold against the real vendored AsciiDoc rather than
// a fixture: the snapshot yields an image index at all (so the `image::`
// scraping in asciidoc.go is actually wired up), and a real section anchor
// resolves to a real section title.
func TestCitationResolver_AgainstTheRealSnapshot(t *testing.T) {
	t.Parallel()

	parsed, err := ParseSnapshot()
	assert.NilError(t, err)

	var images int
	for _, guide := range parsed {
		images += len(guide.Images)
	}
	assert.Assert(t, images > 0, "the snapshot should contain at least one image:: macro to index")

	resolver := NewCitationResolver(parsed)

	// The dynamic-config guide's own screenshot, cited as a published docs
	// asset URL, must resolve to that guide's page.
	got := resolver.Normalize([]string{"https://circleci.com/docs/guides/_images/dynamic-config-enable.png"})
	assert.Assert(t, is.Len(got, 1), "got=%+v", got)
	assert.Equal(t, got[0].URL, "https://circleci.com/docs/guides/orchestrate/dynamic-config/")
	assert.Assert(t, got[0].Title != "")

	// A real anchor in the configuration reference resolves to a real title.
	got = resolver.Normalize([]string{"https://circleci.com/docs/reference/configuration-reference/#docker"})
	assert.Assert(t, is.Len(got, 1))
	assert.Equal(t, got[0].Title, "docker")
}

// The parser change that feeds all of the above: an `image::` macro is
// recorded and no longer leaks into the prose as literal macro text (which is
// what it did before -- it fell through to parseParagraph).
func TestParseGuide_RecordsImagesAndKeepsTheMacroOutOfTheProse(t *testing.T) {
	t.Parallel()

	source := `= Persisting data
:page-description: How workspaces work.

== Workspaces

Workspaces move data between jobs.

image::guides:ROOT:workspace.png[Workspace diagram]

More prose after the image.
`
	guide := parseGuide("persist-data", "guides", "execution-managed", "persist-data", "", []byte(source), nil)

	assert.DeepEqual(t, guide.Images, []string{"workspace.png"})
	assert.Assert(t, is.Len(guide.Sections, 1))
	text := citationsBlocksText(guide.Sections[0].Blocks)
	assert.Assert(t, !strings.Contains(text, "image::"), "the image macro must not render as prose: %q", text)
	assert.Assert(t, strings.Contains(text, "More prose after the image."), "prose after the image must survive: %q", text)
}

// An image inside an included partial belongs to the page that includes it --
// that is the whole point of indexing after include expansion.
func TestParseGuide_AttributesAPartialsImageToTheIncludingPage(t *testing.T) {
	t.Parallel()

	partial := "Some shared prose.\n\nimage::guides:ROOT:from-partial.png[A diagram]\n"
	resolve := func(repoPath string) ([]byte, error) {
		if repoPath == "docs/guides/modules/ROOT/partials/shared.adoc" {
			return []byte(partial), nil
		}
		return nil, errors.New("not in this fixture: " + repoPath)
	}

	source := "= A page\n\n== A section\n\ninclude::partial$shared.adoc[]\n"
	guide := parseGuide("a-page", "guides", "ROOT", "a-page", "", []byte(source), resolve)

	assert.DeepEqual(t, guide.Images, []string{"from-partial.png"})
}

// An image macro pointing outside the docs site says nothing about which docs
// page shows what, so it is not indexed.
func TestParseGuide_IgnoresAnExternalImageMacro(t *testing.T) {
	t.Parallel()

	source := "= A page\n\n== A section\n\nimage::https://example.com/x.png[External]\n"
	guide := parseGuide("a-page", "guides", "ROOT", "a-page", "", []byte(source), nil)

	assert.Assert(t, is.Len(guide.Images, 0), "images=%v", guide.Images)
}

// TestCitationResolver_AgainstTheRealSnapshotAfterWidening records what the
// twenty-page snapshot actually did to image citations, which is the question
// issue #171 was opened to track.
//
// Before #176 the index held exactly one image (`dynamic-config-enable.png`),
// because only three pages were vendored. It now holds twenty-three across
// thirteen pages, and the citation the owner reported in #156 -- a reply grounded
// in the workspaces documentation citing its diagram rather than its page -- maps
// to the page.
//
// The nuance worth pinning, because it is easy to get wrong twice: the owner
// quoted the asset as `workspace.png`, singular. **No such file exists in
// circleci-docs.** The only workspace diagram upstream is `workspaces.png`,
// plural (the only other match in the whole tree is
// `slack-orb-install-workspace.png`), so the singular string was a transcription
// slip or an asset path the model invented. The plural now resolves; the
// singular is still dropped, and dropping a citation of a file that does not
// exist is the correct answer rather than a remaining gap.
func TestCitationResolver_AgainstTheRealSnapshotAfterWidening(t *testing.T) {
	t.Parallel()

	parsed, err := ParseSnapshot()
	assert.NilError(t, err)
	resolver := NewCitationResolver(parsed)

	// The image the owner actually meant, in both the URL and the bare-path
	// shapes a provider has produced.
	want := []Citation{{
		URL:   "https://circleci.com/docs/guides/orchestrate/workspaces/",
		Title: "Using workspaces to share data between jobs",
	}}
	assert.DeepEqual(t, resolver.Normalize([]string{"https://circleci.com/docs/guides/_images/workspaces.png"}), want)
	assert.DeepEqual(t, resolver.Normalize([]string{"circleci-docs/guides/_images/workspaces.png"}), want)

	// The string as quoted. Unmappable because upstream has no such file, and
	// therefore still dropped rather than guessed at.
	assert.Assert(t, is.Len(resolver.Normalize([]string{"circleci-docs/guides/_images/workspace.png"}), 0))

	// The widening is real: more of the diagrams a docs-grounded answer is
	// likely to cite now resolve to the page that shows them.
	for image, page := range map[string]string{
		"caching-dependencies-overview.png": "https://circleci.com/docs/guides/optimize/caching/",
		"job-output-save-cache.png":         "https://circleci.com/docs/guides/optimize/persist-data/",
		"fan-out-in.png":                    "https://circleci.com/docs/guides/orchestrate/workflows/",
		"env-var-order.png":                 "https://circleci.com/docs/guides/security/env-vars/",
		"dynamic-config-enable.png":         "https://circleci.com/docs/guides/orchestrate/dynamic-config/",
	} {
		got := resolver.Normalize([]string{"https://circleci.com/docs/guides/_images/" + image})
		assert.Assert(t, is.Len(got, 1), "%s did not map", image)
		assert.Equal(t, got[0].URL, page, "%s mapped to the wrong page", image)
	}

	// And the collision #171 asked about is a live case now rather than a
	// hypothetical: `view-resource-usage.png` is shown by the Docker, macOS and
	// Windows executor pages. Document order decides, deterministically, and
	// Docker comes first in Sources -- so the answer is stable across runs even
	// though it is arbitrary between three equally correct pages.
	collided := resolver.Normalize([]string{"https://circleci.com/docs/guides/_images/view-resource-usage.png"})
	assert.Assert(t, is.Len(collided, 1))
	assert.Equal(t, collided[0].URL, "https://circleci.com/docs/guides/execution-managed/using-docker/")
}

// TestCitationResolver_AddImageIndexFillsGapsWithoutDisplacingVendoredMappings
// is the remaining piece of issue #19 ("Image indexing beyond the vendored
// guides"), exercised at the level that matters: a citation of an image on a
// page this pane never vendors as prose now resolves instead of being
// dropped, while an image the vendored guides already know keeps its
// titled mapping rather than being displaced by the wider, title-less index.
func TestCitationResolver_AddImageIndexFillsGapsWithoutDisplacingVendoredMappings(t *testing.T) {
	t.Parallel()

	resolver := NewCitationResolver(fakeGuides())

	// A basename the vendored guides already map to a page with a title. The
	// wider index disagrees on purpose (a different, wrong URL) so this test
	// fails if AddImageIndex is ever changed to let it win.
	idx := ImageIndex{Images: map[string]string{
		"shared-diagram.png": "https://circleci.com/docs/guides/execution-managed/using-docker/",
		"artifacts.png":      "https://circleci.com/docs/guides/optimize/artifacts/",
	}}
	resolver.AddImageIndex(idx)

	// The vendored mapping still wins, titled, exactly as before AddImageIndex.
	got := resolver.Normalize([]string{"https://circleci.com/docs/_images/shared-diagram.png"})
	assert.DeepEqual(t, got, []Citation{
		{URL: "https://circleci.com/docs/reference/configuration-reference/", Title: "Configuration reference"},
	})

	// A basename only the wider index knows now resolves -- with no title,
	// since ImageIndex carries none: this is the gap #19 asked to close.
	got = resolver.Normalize([]string{"https://circleci.com/docs/guides/_images/artifacts.png"})
	assert.DeepEqual(t, got, []Citation{
		{URL: "https://circleci.com/docs/guides/optimize/artifacts/"},
	})

	// A basename neither source knows is still dropped, never guessed at a
	// page -- honest degradation holds after widening exactly as it did
	// before.
	got = resolver.Normalize([]string{"https://circleci.com/docs/guides/_images/totally-unknown-basename.png"})
	assert.Assert(t, is.Len(got, 0), "got=%+v", got)
}

// TestImageIndex_WidensRealCitationsBeyondTheVendoredGuides runs the same
// widening against the real, embedded, generated artifact (not a fixture) --
// the end-to-end proof that cmd/refresh-image-index's output is actually
// wired up: a real page circleci-docs publishes, which this pane does not
// vendor as prose, resolves once AddImageIndex is applied and is dropped
// without it.
func TestImageIndex_WidensRealCitationsBeyondTheVendoredGuides(t *testing.T) {
	t.Parallel()

	idx, err := LoadImageIndex()
	assert.NilError(t, err)
	assert.Equal(t, idx.Repo, UpstreamRepo)
	assert.Assert(t, idx.Commit != "", "the generated index carries no commit -- was cmd/refresh-image-index ever run?")
	assert.Assert(t, len(idx.Images) > 0)

	parsed, err := ParseSnapshot()
	assert.NilError(t, err)

	// Before widening: a citation of an image on a page this pane does not
	// vendor -- the artifacts guide, not one of the twenty in Sources -- is
	// dropped exactly as issue #19 described.
	before := NewCitationResolver(parsed)
	assert.Assert(t, is.Len(before.Normalize([]string{"https://circleci.com/docs/guides/_images/artifacts.png"}), 0),
		"artifacts.png should be unresolvable before widening -- if this now passes, the artifacts guide was added to Sources and this test should name a different unvendored page")

	// After: the same citation resolves to that page's own canonical URL.
	after := NewCitationResolver(parsed)
	after.AddImageIndex(idx)
	got := after.Normalize([]string{"https://circleci.com/docs/guides/_images/artifacts.png"})
	assert.Assert(t, is.Len(got, 1), "got=%+v", got)
	assert.Equal(t, got[0].URL, "https://circleci.com/docs/guides/optimize/artifacts/")
	assert.Equal(t, got[0].Title, "", "the wider index carries no titles -- the frontend derives a label from the URL")
}

func citationsBlocksText(blocks []Block) string {
	var out strings.Builder
	for _, block := range blocks {
		for _, span := range block.Spans {
			out.WriteString(span.Text)
		}
		out.WriteString(block.Text)
		out.WriteString("\n")
		out.WriteString(citationsBlocksText(block.Blocks))
	}
	return out.String()
}
