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

// Package dockerhub answers issue #77's tag-freshness question: the SPA's
// vendored `cimg/*` image list (web/src/lib/schema/images.ts) deliberately
// excludes version tags because they churn too fast to bake into a
// hand-curated table (see that file's own provenance comment). Rather than
// leave the image picker and the `docker: - image:` autocomplete with no
// version information at all, this package fetches real tags from Docker
// Hub's public, unauthenticated v2 API -- through the Go host, never
// directly from the browser (see internal/host/dockertags.go's doc comment
// for why: CORS, and not leaking the user's browsing to a third party
// without them knowing).
//
// Unlike internal/orbs, no CircleCI API token is involved at any point --
// Docker Hub's repository/tag listing endpoints have never required
// authentication for a public repo, which happens to make "no token" one of
// this feature's two offline requirements for free. The other -- "no
// network" -- is Cache's job (see cache.go): a failed or slow fetch falls
// back to whatever was last cached to disk, and ultimately to nothing at
// all, at which point the caller (the SPA) already knows to fall back
// further, to images.ts's own vendored variant-suffix list.
package dockerhub

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// defaultBaseURL is Docker Hub's public API host. Overridable (via
// newClientWithBaseURL, used only by tests) so tests can point at an
// httptest.Server instead of the real internet.
const defaultBaseURL = "https://hub.docker.com"

// requestTimeout bounds a single HTTP round trip to Docker Hub, independent
// of whatever timeout the caller's context already carries -- this package
// is on the critical path for the image picker opening, so a hung upstream
// must not hang the UI indefinitely. ListTags issues up to dockerHubPageCap
// (see cache.go) of these per call, so a full pagination run is bounded by a
// small multiple of this, not by it alone.
const requestTimeout = 8 * time.Second

// dockerHubPageSize is how many tags are requested per HTTP round trip.
// Docker Hub's own tag-listing endpoint has been observed to honour larger
// values, but 100 is comfortably inside whatever cap it applies and keeps
// each individual page small and fast; ListTags reaches a larger total by
// following the response's own `next` link across several such pages (see
// its doc comment), not by asking for a bigger one.
const dockerHubPageSize = 100

// Tag is one entry from a Docker Hub repository's tag listing.
type Tag struct {
	// Name is the tag itself, e.g. "20.11.0" or "20.11.0-browsers".
	Name string
	// LastUpdated is when this tag was last pushed, as reported by Docker
	// Hub. Kept (rather than discarded after fetching) so callers besides
	// RankVersionTags -- e.g. a future "how stale is this" UI affordance --
	// have it without a second request.
	LastUpdated time.Time
}

// Client fetches tag listings from Docker Hub's public v2 API. The zero
// value is not usable; construct with NewClient.
type Client struct {
	httpClient *http.Client
	baseURL    string
}

// NewClient constructs a Client that talks to the real Docker Hub API.
func NewClient() *Client {
	return &Client{
		httpClient: &http.Client{Timeout: requestTimeout},
		baseURL:    defaultBaseURL,
	}
}

// newClientWithBaseURL is like NewClient but talks to baseURL instead of the
// real Docker Hub -- used only by tests, to point at an httptest.Server.
func newClientWithBaseURL(baseURL string) *Client {
	c := NewClient()
	c.baseURL = baseURL
	return c
}

// tagsResponse is the subset of Docker Hub's
// `GET /v2/repositories/<repo>/tags/` response this package reads. The real
// response carries many more fields (image digests, sizes, per-architecture
// detail); everything else is ignored by encoding/json. Next is Docker Hub's
// own fully-qualified URL for the following page, ""  on the last one -- see
// ListTags, which follows it rather than reconstructing page numbers itself.
type tagsResponse struct {
	Results []struct {
		Name          string    `json:"name"`
		TagLastPushed time.Time `json:"tag_last_pushed"`
	} `json:"results"`
	Next string `json:"next"`
}

// Page is what ListTags returns: the tags it collected, and whether that is
// known to be fewer than what Docker Hub actually has.
type Page struct {
	// Tags is newest first, deduplicated across pages by construction (each
	// page is a disjoint slice of Docker Hub's own ordering).
	Tags []Tag
	// Truncated is true when ListTags stopped before reaching either
	// maxTags or Docker Hub's own last page -- i.e. fewer tags came back than
	// the repo may actually have, for a reason other than "that's all of
	// them." Distinct from stopping *at* maxTags with more available, which
	// is this package's own deliberate bound (see maxTagsFetch in cache.go)
	// and not a degraded result -- Truncated is only set for the honest
	// surprise, not the planned one.
	Truncated bool
	// TruncatedReason explains Truncated, e.g. naming the HTTP status Docker
	// Hub returned partway through. Set iff Truncated.
	TruncatedReason string
}

// ListTags fetches up to maxTags tags of repo (e.g. "cimg/node"), newest
// first, paginating through Docker Hub's own `next` links as needed.
//
// "Newest first" here means Docker Hub's own `ordering=last_updated` query
// parameter, confirmed empirically (2026-07-28) against the real API:
//
//	curl -s 'https://hub.docker.com/v2/repositories/cimg/android/tags/?page_size=5&ordering=last_updated'
//
// returns that repo's most recently pushed tags first -- counter-intuitively,
// since the parameter carries no "-" descending marker the way e.g.
// `ordering=-last_updated` does on many other Docker Hub/Hub-like APIs (that
// form was tried too, and returned the *oldest* tags first). This is Docker
// Hub's own documented-by-behavior quirk, not a guess; if a future refresh
// of this comment finds different behavior, the query parameter below is the
// only thing that needs to change.
//
// # Pagination (issue #243)
//
// A single page used to be fetched -- no pagination -- on the reasoning that
// RankVersionTags only needs the most recent handful of distinct minor
// versions. That stopped being the whole story once issue #213 turned the
// tag control into a type-to-filter combobox over *every* tag fetched
// (Result.AllTags in cache.go): "hundreds of tags" was true of what cimg/*
// repos publish, but false of what this package returned, since one
// dockerHubPageSize page tops out at 100. ListTags now follows Docker Hub's
// own `next` link across pages until maxTags is reached or Docker Hub itself
// runs out (a short last page, or no `next` at all).
//
// It stops at maxTags rather than crawling every page a popular image has --
// cimg/node alone has published 300+ tags and growing, and an unbounded
// crawl on every cold cache fill would be both slow for whoever is waiting on
// the picker to open and needlessly heavy on a third party's free,
// unauthenticated API purely to list *pinnable* versions.
//
// A page fetch failing mid-crawl (including a 429 -- Docker Hub does
// rate-limit anonymous callers) does not discard the pages already collected:
// this mirrors issue #259's stale-but-labelled precedent for the orb cache
// -- a partial tag list is still a real, usable tag list, so it is
// returned with Truncated set and TruncatedReason naming why, rather than
// thrown away in favour of an error that would make Cache.Get fall back to
// whatever (possibly much older, or absent) copy is on disk. Failing on the
// very first page is different: there is nothing yet to prefer over an error,
// so that case still returns one, exactly as before pagination existed.
func (c *Client) ListTags(ctx context.Context, repo string, maxTags int) (Page, error) {
	url := fmt.Sprintf("%s/v2/repositories/%s/tags/?page_size=%d&ordering=last_updated", c.baseURL, repo, dockerHubPageSize)

	var tags []Tag
	for url != "" && len(tags) < maxTags {
		parsed, status, err := c.fetchTagsPage(ctx, url)
		if err != nil {
			if len(tags) > 0 {
				return Page{Tags: tags, Truncated: true, TruncatedReason: err.Error()}, nil
			}
			return Page{}, fmt.Errorf("dockerhub: list tags for %s: %w", repo, err)
		}
		if status != http.StatusOK {
			reason := fmt.Sprintf("Docker Hub returned status %d", status)
			if status == http.StatusTooManyRequests {
				reason = "Docker Hub rate-limited this request (HTTP 429)"
			}
			if len(tags) > 0 {
				return Page{Tags: tags, Truncated: true, TruncatedReason: reason}, nil
			}
			return Page{}, fmt.Errorf("dockerhub: list tags for %s: unexpected status %d", repo, status)
		}

		for _, r := range parsed.Results {
			tags = append(tags, Tag{Name: r.Name, LastUpdated: r.TagLastPushed})
		}
		url = parsed.Next
	}

	if len(tags) > maxTags {
		tags = tags[:maxTags]
	}
	return Page{Tags: tags}, nil
}

// fetchTagsPage performs one HTTP round trip and decodes its body, without
// interpreting the status code -- that is ListTags's job, since what a
// non-200 means (fail outright vs. return what's already collected) depends
// on whether this was the first page.
func (c *Client) fetchTagsPage(ctx context.Context, url string) (tagsResponse, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return tagsResponse{}, 0, fmt.Errorf("build request: %w", err)
	}

	resp, err := c.httpClient.Do(req) //nolint:gosec // repo is validated by the caller before it ever reaches here: internal/host's cimgImageNamePattern restricts GET /api/docker-tags's "image" query parameter to lowercase-alnum names, which handleDockerTags prefixes with the fixed "cimg/" literal (see that file's own doc comment on why this is deliberately not a general Docker Hub proxy) -- there is no request-input path into repo that isn't one of the ~20 names in images.ts's CIMG_IMAGES table. url itself is either built from that validated repo or is Docker Hub's own `next` link, echoed back to Docker Hub and nowhere else.
	if err != nil {
		return tagsResponse{}, 0, err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return tagsResponse{}, resp.StatusCode, nil
	}

	var parsed tagsResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return tagsResponse{}, 0, fmt.Errorf("decode tags response: %w", err)
	}
	return parsed, http.StatusOK, nil
}
