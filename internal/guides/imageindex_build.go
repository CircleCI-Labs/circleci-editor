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
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// This file is cmd/refresh-image-index's engine: it walks every page in
// circleci-docs -- not just the twenty Sources vendors as prose -- and
// records which basename lives on which page's canonical URL. It is the
// remaining piece of issue #19 ("Image indexing beyond the vendored
// guides"): NewCitationResolver's own imagePages (built from Guide.Images)
// only ever covers a page this package renders in the pane, so a citation of
// an image on any other page was dropped rather than mapped.
//
// # Why walk the tree instead of widening Sources, or reusing FetchAll's closure
//
// FetchAll's queue starts from Sources -- twenty pages this project chose to
// show, by the "something you type in the config file" rule in guides.go's
// doc comment -- and that rule is a product decision about the *pane*,
// deliberately narrower than "every page with a picture". Widening Sources to
// satisfy citations would let citation coverage drive what looks like an
// authored guide, which is not what #19 asked for: it asked for the *image*
// index to widen, not the vendored prose. So this seeds its own walk from
// GitHub's recursive tree API -- one request, every path in the repository at
// a single commit -- rather than reusing UpstreamSources(). That is also why
// it is deterministic in a way GitHub *code* search (used only to size this
// feature before writing it -- see the PR that closes #19) is not: code
// search is rate-limited and its index can lag a push by an unspecified
// amount, whereas a tree listing at a pinned commit always returns the same
// paths.
//
// # Why this never touches snapshot/
//
// It shares Fetcher's HTTP plumbing (ResolveCommit, FetchFile, the SSRF
// reasoning in fetch.go's own doc comment) with FetchAll, because a second
// implementation of "fetch a file from a pinned commit over
// raw.githubusercontent.com" would be a second place to get that reasoning
// wrong. It shares nothing else: nothing here calls FetchAll or ParseFiles or
// writes to snapshot/, so `task guides:refresh-image-index` (this file's
// caller) and `task guides:refresh` (fetch.go's) are two independent
// commands that happen to read from the same repository. Running one is
// never a prerequisite for, or a side effect of, running the other -- which
// matters concretely right now, while the vendored prose snapshot itself is
// deliberately not being refreshed pending the decision tracked in #44.

const (
	// maxIndexFiles bounds the number of distinct upstream files this walk
	// will fetch, for the same reason fetch.go's maxFiles exists -- a bug in
	// the include-following below must fail loudly rather than hammer
	// upstream forever -- but it is *not* that constant: this walks a much
	// larger seed set (every non-excluded page in the repository, not the
	// twenty in Sources) and the two budgets must be free to move
	// independently.
	//
	// 171 of circleci-docs's 817 .adoc files carry an image:: macro directly
	// (GitHub code search, q="image:: repo:circleci/circleci-docs
	// extension:adoc", 2026-08-08) -- but that number is *not* this walk's
	// fetch count, and using it to size this budget would have under-shot
	// badly. Code search can tell you which files already contain the
	// string without fetching any of them; this walk cannot skip a page just
	// because it turns out to have no picture, because the only way to learn
	// that is to fetch it and look -- it does not get to consult the search
	// index's answer. Measured directly against the same commit: excluding
	// archive/ and server-admin* (ExcludedPathReason) leaves 308 Antora pages
	// to check, and following the include:: closure each of those pages
	// pulls in -- pages plus every partial they share, deduplicated by the
	// fetched cache in pageImages -- costs 397 files, indexing 320 distinct
	// basenames with 85 cross-page collisions (see TestBuildImageIndex_
	// AgainstLiveUpstream). 500 leaves comfortable headroom above that
	// measured 397 for upstream to add pages before this needs raising,
	// while staying far below the 817-file corpus, matching the margin
	// fetch.go's own maxFiles keeps for the same reason.
	maxIndexFiles = 500

	// treeAPIURL lists every path in a repository at a commit, recursively,
	// in one request -- see this file's doc comment for why that beats
	// GitHub code search as this walk's starting point.
	treeAPIURL = "https://api.github.com/repos/%s/git/trees/%s?recursive=1"
)

// pagePathPattern matches an Antora page-family repository path -- the same
// shape resourceID.repoPath() produces for family "page" -- and captures the
// coordinates parseResourceID needs to resolve that page's own include::
// targets.
var pagePathPattern = regexp.MustCompile(`^docs/([^/]+)/modules/([^/]+)/pages/(.+\.adoc)$`)

// pageSeed is one Antora page this walk considers: a candidate to appear in
// ImageIndex.Images, plus the coordinates needed to resolve its include
// closure and to derive its own canonical URL.
type pageSeed struct {
	repoPath  string
	component string
	module    string
	relpath   string
}

// ImageIndexStats is what cmd/refresh-image-index prints after a run: the
// generation-time facts a change describing this feature needs to cite (how
// many pages were scanned, how many files that took, how many basenames
// collided across pages), kept separate from ImageIndex itself because
// ImageIndex is what ships and these are not something a citation lookup
// ever needs at runtime.
type ImageIndexStats struct {
	PagesScanned int
	FilesFetched int
	Collisions   int
}

// ListTree lists every blob path in the repository at commit. Used only by
// BuildImageIndex: FetchAll finds its files by following include:: targets
// from Sources, which is the right approach for "the twenty pages this
// project vendors" and the wrong one for "every page in the repository",
// this walk's actual question.
func (f *Fetcher) ListTree(ctx context.Context, commit string) ([]string, error) {
	base := f.TreeAPIURL
	if base == "" {
		base = fmt.Sprintf(treeAPIURL, f.repo(), commit)
	}
	body, err := f.get(ctx, base, "application/vnd.github+json")
	if err != nil {
		return nil, err
	}

	var payload struct {
		Truncated bool `json:"truncated"`
		Tree      []struct {
			Path string `json:"path"`
			Type string `json:"type"`
		} `json:"tree"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("guides: parse tree response: %w", err)
	}
	if payload.Truncated {
		// GitHub truncates a tree response past 100,000 entries or 7 MB;
		// circleci-docs's 817 .adoc files (and everything else in the
		// repository) are nowhere near that, so hitting this means the API
		// changed shape underneath this code, not that the repository grew
		// enormously overnight. Either way, a silently partial index is
		// worse than an honest failure -- the whole point of an image index
		// is that a basename *absent* from it is trusted to mean "unknown",
		// and a truncated walk cannot make that promise.
		return nil, errors.New("guides: repository tree listing was truncated by the GitHub API")
	}

	out := make([]string, 0, len(payload.Tree))
	for _, entry := range payload.Tree {
		if entry.Type == "blob" {
			out = append(out, entry.Path)
		}
	}
	return out, nil
}

// imageIndexSeeds returns every Antora page in tree this project will
// consider for ImageIndex.Images, sorted by repository path.
//
// ExcludedPathReason -- the same predicate FetchAll applies to every include
// target -- is applied here too, and for the same reason it is applied
// there: an archived or server-admin page's canonical URL is not one this
// project wants an AI citation resolving to, even for an image, because it is
// superseded or version-specific content that would look current to a
// reader who followed it.
//
// The sort is this generator's collision rule: when two pages show the same
// basename, the alphabetically-first repository path wins (see
// BuildImageIndex). Document order -- the rule NewCitationResolver and
// noteAnchor already use for the analogous ambiguity within one page's own
// headings -- has no meaning across 171 independent pages the way it does
// within a single page; repository path is the one total order every page
// considered here already has, it sorts the same way on every run because
// the tree listing is pinned to one commit, and it costs nothing beyond what
// ListTree already returned -- unlike, say, ordering by upstream nav
// position, which would mean fetching Antora's own navigation partials just
// to break a tie that a citation, dropped or mapped, is indifferent to
// either way.
func imageIndexSeeds(tree []string) []pageSeed {
	var out []pageSeed
	for _, p := range tree {
		m := pagePathPattern.FindStringSubmatch(p)
		if m == nil {
			continue
		}
		if reason := ExcludedPathReason(p); reason != "" {
			continue
		}
		out = append(out, pageSeed{repoPath: p, component: m[1], module: m[2], relpath: m[3]})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].repoPath < out[j].repoPath })
	return out
}

// pageImages returns the lowercased basename of every image seed shows,
// including images inside any partial it includes -- the same rule
// Guide.Images already applies to the twenty vendored pages, applied here to
// every other page instead.
//
// fetched is a cache shared across every seed in one BuildImageIndex run, so
// a partial several pages include in common (an execution-resources table,
// say) is fetched once rather than once per page that includes it -- the
// same amortisation FetchAll gets from its own files map, applied across a
// much larger seed set.
func (f *Fetcher) pageImages(ctx context.Context, commit string, seed pageSeed, fetched map[string][]byte) ([]string, error) {
	type queued struct{ repoPath, component, module string }
	queue := []queued{{seed.repoPath, seed.component, seed.module}}
	visited := map[string]bool{}
	images := map[string]bool{}

	for len(queue) > 0 {
		item := queue[0]
		queue = queue[1:]
		if visited[item.repoPath] {
			continue
		}
		visited[item.repoPath] = true
		if reason := ExcludedPathReason(item.repoPath); reason != "" {
			// Not fetched at all, matching FetchAll's own treatment of an
			// excluded include target: it can neither contribute an image
			// nor be cited as the page that shows one.
			continue
		}

		data, ok := fetched[item.repoPath]
		if !ok {
			if len(fetched) >= maxIndexFiles {
				return nil, fmt.Errorf("guides: image-index walk exceeded %d fetched files", maxIndexFiles)
			}
			var fetchErr error
			data, fetchErr = f.FetchFile(ctx, commit, item.repoPath)
			if fetchErr != nil {
				if errors.Is(fetchErr, ErrNotFound) {
					// A missing include is a content change upstream, same
					// as FetchAll's own handling: nothing to index from a
					// file that is not there.
					continue
				}
				return nil, fetchErr
			}
			fetched[item.repoPath] = data
		}

		if !strings.HasSuffix(item.repoPath, ".adoc") {
			continue
		}
		for _, base := range extractImageBasenames(data) {
			images[base] = true
		}

		ctxFor := spanContext{component: item.component, module: item.module}
		for _, target := range includeTargets(data) {
			id, idErr := parseResourceID(target, ctxFor)
			if idErr != nil {
				// An include this package cannot address contributes no
				// images and is left for the prose parser (not this
				// generator) to report, if and when the page it lives on is
				// ever vendored.
				continue
			}
			queue = append(queue, queued{id.repoPath(), id.component, id.module})
		}
	}
	return sortedKeys(images), nil
}

// BuildImageIndex builds the index cmd/refresh-image-index vendors: it lists
// the repository at commit, considers every Antora page in it, and for every
// one that shows at least one image, records that image's basename against
// the page's own canonical URL.
//
// A basename two different pages both show resolves to whichever page's
// repository path sorts first (imageIndexSeeds's order), and every such
// collision is counted in the returned ImageIndexStats -- so a run against
// live upstream can report exactly how often it happened rather than leaving
// that to be discovered later by whoever reads the PR.
func (f *Fetcher) BuildImageIndex(ctx context.Context, commit string, committedAt time.Time) (ImageIndex, ImageIndexStats, error) {
	tree, err := f.ListTree(ctx, commit)
	if err != nil {
		return ImageIndex{}, ImageIndexStats{}, err
	}
	seeds := imageIndexSeeds(tree)

	fetched := map[string][]byte{}
	images := map[string]string{}
	checksums := map[string]string{}
	stats := ImageIndexStats{PagesScanned: len(seeds)}

	for _, seed := range seeds {
		basenames, pageErr := f.pageImages(ctx, commit, seed, fetched)
		if pageErr != nil {
			return ImageIndex{}, ImageIndexStats{}, pageErr
		}
		if len(basenames) == 0 {
			continue
		}

		url := (resourceID{component: seed.component, module: seed.module, family: "page", relpath: seed.relpath}).pageURL()
		for _, base := range basenames {
			if _, taken := images[base]; !taken {
				images[base] = url
			} else {
				stats.Collisions++
			}
		}

		sum := sha256.Sum256(fetched[seed.repoPath])
		checksums[seed.repoPath] = hex.EncodeToString(sum[:])
	}
	stats.FilesFetched = len(fetched)

	idx := ImageIndex{
		Repo:          f.repo(),
		Ref:           DefaultBranch,
		Commit:        commit,
		CommittedAt:   committedAt.UTC(),
		GeneratedAt:   time.Now().UTC().Truncate(time.Second),
		PagesScanned:  stats.PagesScanned,
		FilesFetched:  stats.FilesFetched,
		Images:        images,
		PageChecksums: checksums,
	}
	return idx, stats, nil
}
