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
	"net/http"

	"github.com/CircleCI-Labs/circleci-editor/internal/guides"
)

// guidesPayload is the JSON shape of GET /api/guides.
//
// It carries the same `available`/`reason` envelope as the other
// degradable endpoints, but for a narrower reason than most: the guides are
// embedded in the binary, so `available: false` means the *parser* failed on
// its own vendored snapshot -- which the package's own tests make close to
// impossible. It exists so that the case still produces an explanatory pane
// with links to the live docs rather than a blank one.
type guidesPayload struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	// Guides is the parsed block model; see internal/guides/model.go, which
	// web/src/lib/guides/types.ts mirrors.
	Guides []guides.Guide `json:"guides,omitempty"`
	// Provenance says which upstream commit this text came from, when it was
	// obtained, and whether an update check is in flight or last failed --
	// everything the pane needs to date its own content.
	Provenance guides.Provenance `json:"provenance"`
	// Links are the canonical live-docs URLs for each guide, so the pane can
	// always offer a way out to the real page even when Guides is empty.
	Links []guideLink `json:"links"`
}

// guideLink pairs a guide's stable ID with its live URL and display label.
type guideLink struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	URL   string `json:"url"`
}

// guideLinks is the fallback link set, built from internal/guides.Sources so
// it cannot drift from the guides actually served.
func guideLinks() []guideLink {
	out := make([]guideLink, 0, len(guides.Sources))
	for _, src := range guides.Sources {
		out = append(out, guideLink{ID: src.ID, Label: src.Label, URL: src.URL()})
	}
	return out
}

// handleGuides serves GET /api/guides: the three CircleCI prose configuration
// guides, parsed from vendored (and periodically refreshed) AsciiDoc source
// into a block model the SPA renders with its own components (issue #104).
//
// Like GET /api/schema, this needs no CIRCLE_TOKEN and consults no CircleCI
// API. Unlike it, the content *can* be newer than the binary: internal/guides's
// cache refreshes it from public GitHub raw content in the background, on a
// seven-day TTL. That refresh never gates a response -- this handler always
// answers from whatever is in memory, which starts as the embedded snapshot --
// so the endpoint behaves identically with no network, and only the reported
// Provenance differs.
//
// No caching headers: unlike the schema, this response can change while the
// process runs (a background refresh landing mid-session), and the payload is
// served over loopback where a re-read costs nothing worth optimising.
func (s *Server) handleGuides(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	if s.guides == nil {
		// Only reachable in a test that overrode the cache with nil; the
		// production path always has one. Answered honestly rather than with
		// a 500, because the pane's job here is to explain and link out.
		writeJSON(w, http.StatusOK, guidesPayload{
			Available: false,
			Reason:    "the built-in guides are not loaded in this build",
			Links:     guideLinks(),
		})
		return
	}

	// ?refresh=1 is the manual "check now" affordance issue #285 adds --
	// the owner's own complaint was that the "CircleCI docs offline" badge
	// gave no way to tell whether it would ever update, let alone force it
	// to sooner than the seven-day background TTL. Like the orbs endpoint's
	// own refresh=1 (see that handler's comment), this only triggers the
	// check via Refresh (a no-op while one is already running) and answers
	// with whatever is in memory right now; s.shutdownCtx so the fetch
	// outlives this one request.
	if r.URL.Query().Get("refresh") == "1" {
		s.guides.Refresh(s.shutdownCtx)
	}

	parsed, provenance, err := s.guides.Guides()
	if err != nil || len(parsed) == 0 {
		reason := "the built-in guides could not be parsed"
		if err != nil {
			reason = err.Error()
		}
		writeJSON(w, http.StatusOK, guidesPayload{
			Available:  false,
			Reason:     reason,
			Provenance: provenance,
			Links:      guideLinks(),
		})
		return
	}

	writeJSON(w, http.StatusOK, guidesPayload{
		Available:  true,
		Guides:     parsed,
		Provenance: provenance,
		Links:      guideLinks(),
	})
}
