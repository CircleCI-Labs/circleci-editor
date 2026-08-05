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

package host

import (
	"context"
	"net/http"
	"regexp"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/dockerhub"
)

// dockerTagsFetchTimeout bounds how long GET /api/docker-tags waits on a
// (possibly cache-missing) Docker Hub round trip before giving up and
// reporting unavailable -- the image picker opening must never hang the UI
// indefinitely on a slow or half-dead network.
const dockerTagsFetchTimeout = 6 * time.Second

// cimgImageNamePattern is the shape a `cimg/*` repo's own name segment can
// take (see images.ts's CIMG_IMAGES -- every entry there is lowercase
// letters/digits only). GET /api/docker-tags validates its "image" query
// parameter against this before ever building a URL out of it: this
// endpoint is deliberately not a general Docker Hub proxy -- it only ever
// fetches from the single, fixed `cimg/` namespace this project vendors a
// hand-curated image list for, so accepting arbitrary repo strings here
// would turn a "show me tags for the convenience images we already
// recommend" feature into an open proxy for any third party's Docker Hub
// data.
var cimgImageNamePattern = regexp.MustCompile(`^[a-z0-9]+$`)

// dockerTagsCache is the subset of *dockerhub.Cache that handleDockerTags
// needs, defined here (rather than depended on directly) so tests can
// substitute a fake without making any HTTP calls -- same rationale as
// orbCache.
//
// Refresh (issue #285) is the manual "check now" counterpart to Get's own
// lazy, TTL-gated fetch: it bypasses cacheTTL for one named repo, which is
// exactly the scope a picker showing one image's tags needs.
type dockerTagsCache interface {
	Get(ctx context.Context, repo string) (dockerhub.Result, error)
	Refresh(ctx context.Context, repo string) (dockerhub.Result, error)
}

// dockerTagsResponse is the JSON shape returned by GET /api/docker-tags.
//
// Available follows the same convention as validateResponse.Available and
// orbsSearchResponse.Available: false means "there is nothing useful here,
// and Reason says why," true means Tags (however possibly stale --
// FetchedAt says how stale) is meaningful. Unlike the orbs endpoints,
// Available=false is never about a missing CIRCLE_TOKEN (Docker Hub's
// public API needs none) -- it only ever means the fetch failed and no
// previously cached copy exists to fall back to, i.e. genuinely offline on
// the very first request for this image. The SPA's own fallback at that
// point is images.ts's vendored variant-suffix list, not a retry loop here.
type dockerTagsResponse struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	// Tags is the ranked handful the picker *recommends* (see
	// dockerhub.RankVersionTags).
	Tags []string `json:"tags,omitempty"`
	// AllTags is every version-shaped tag on the page fetched (see
	// dockerhub.VersionTags) -- a superset of Tags, and what the picker's
	// type-to-filter searches (issue #213). Both are sent because a
	// recommendation and a search index are different things: eight ranked
	// representatives are the right answer to "which one should I pick?" and the
	// wrong answer to "is 20.11.2 available?".
	AllTags []string `json:"allTags,omitempty"`
	// Truncated and TruncatedReason report that Tags/AllTags are known to be
	// shorter than Docker Hub actually has for this repo, because the fetch
	// that produced them was cut short (rate limiting, most likely) rather
	// than genuinely exhausting the pages available -- see
	// internal/dockerhub.Page's own doc comment. Never set merely because
	// this project's own pagination bound (maxTagsFetch) was reached with
	// more left on Docker Hub; that is a deliberate limit, not a
	// degradation, and the picker's own tag count already says honestly how
	// many were offered without needing a caveat for it.
	Truncated       bool   `json:"truncated,omitempty"`
	TruncatedReason string `json:"truncatedReason,omitempty"`
	FetchedAt       string `json:"fetchedAt,omitempty"`
	Live            bool   `json:"live,omitempty"`
}

// handleDockerTags serves GET /api/docker-tags?image=<name>: it resolves
// "cimg/<name>"'s recent version tags (see package dockerhub for how they're
// ranked and cached) and reports them, or reports Available=false with a
// Reason if nothing could be fetched or was ever cached for this image.
//
// This is the Go-host half of issue #77's "fetch through the host, not
// directly from the browser" decision -- see internal/dockerhub's package
// doc comment for why (CORS; not making the third-party Docker Hub request
// on the user's behalf invisibly from a page they're just editing YAML in).
func (s *Server) handleDockerTags(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	name := r.URL.Query().Get("image")
	if !cimgImageNamePattern.MatchString(name) {
		writeError(w, http.StatusBadRequest, `missing or invalid required query parameter: image (expected a bare "cimg/*" image name, e.g. "node")`)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), dockerTagsFetchTimeout)
	defer cancel()

	repo := "cimg/" + name

	// ?refresh=1 is the manual "check now" affordance issue #285 adds to the
	// image tag picker. Unlike the orbs/guides endpoints, this fetch is
	// small and single-repo, so -- like the contexts palette's own
	// ?refresh=1 -- it is simply awaited within this request rather than
	// only triggered: Refresh bypasses this one repo's cacheTTL and returns
	// the live result (or, on failure, whatever was cached before -- see
	// that method's doc comment), bounded by the same dockerTagsFetchTimeout
	// as every other call here. Two overlapping refreshes for the same image
	// (a double click, two tabs) share one Docker Hub request rather than
	// costing two -- see Cache.Refresh's own dedupe.
	fetch := s.dockerTagsCache.Get
	if r.URL.Query().Get("refresh") == "1" {
		fetch = s.dockerTagsCache.Refresh
	}

	result, err := fetch(ctx, repo)
	if err != nil {
		writeJSON(w, http.StatusOK, dockerTagsResponse{
			Available: false,
			Reason:    "could not reach Docker Hub and no previously cached tag list is available for this image",
		})
		return
	}

	writeJSON(w, http.StatusOK, dockerTagsResponse{
		Available:       true,
		Tags:            result.Tags,
		AllTags:         result.AllTags,
		Truncated:       result.Truncated,
		TruncatedReason: result.TruncatedReason,
		FetchedAt:       result.FetchedAt.UTC().Format(time.RFC3339),
		Live:            result.Live,
	})
}
