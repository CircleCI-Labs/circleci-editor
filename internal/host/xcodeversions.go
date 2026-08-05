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

// xcodeVersionsPayload is the JSON shape of GET /api/xcode-versions: the Xcode
// versions the macOS executor accepts, derived from CircleCI's own vendored
// supported-Xcode table (issue #211, closing issue #203).
//
// A sibling of /api/resource-classes rather than a field on it, for the same
// reason that endpoint is not a field on /api/guides: two independent consumers
// (the macOS executor field and the YAML pane's `xcode:` completion) want this
// and not the resource tables, the resource-class consumers want the tables and
// not this, and folding them together would mean either endpoint's shape change
// churning the other's callers. Both read the same guides cache, so the second
// endpoint costs no extra parsing.
//
// Same caching stance as /api/resource-classes -- none: the guides cache
// refreshes upstream AsciiDoc in the background on a seven-day TTL, so a cached
// response could pin a version list the running process has already replaced, and
// it is served over loopback where a re-read costs nothing worth optimising.
type xcodeVersionsPayload struct {
	// Versions are the versions to offer, in upstream document order (newest
	// first). Empty only when even the embedded snapshot could not be read, which
	// is a build defect; the macOS field then falls back to free text and says so.
	Versions []guides.XcodeVersion `json:"versions"`
	// Default is the version a newly created macOS job should start on: the
	// newest one upstream does not mark a pre-release. Served rather than
	// recomputed in the SPA so that "what does a new macOS job get?" has exactly
	// one answer, and it is the same answer wherever it is asked -- the defect in
	// issue #203 was three copies of a literal (the palette card, the mutation
	// layer's fallback, and the docs' own example) disagreeing with the table and
	// with each other.
	Default string `json:"default"`
	// Derived reports that Versions came from the documentation this host is
	// currently serving. When false, they are the copy embedded in this release
	// and Reason says why -- and the field must say so too, rather than presenting
	// a possibly-stale list as current.
	Derived bool `json:"derived"`
	// Reason is set when Derived is false: a sentence a UI can show.
	Reason string `json:"reason,omitempty"`
	// Provenance dates the underlying documentation, exactly as /api/guides
	// reports it.
	Provenance guides.Provenance `json:"provenance"`
}

// handleXcodeVersions serves GET /api/xcode-versions.
//
// Needs no CIRCLE_TOKEN and consults no CircleCI API: the answer is in the
// vendored documentation, and there is no per-project variant of it (a macOS job
// on any plan writes the same `xcode:` values; whether the plan includes macOS
// minutes is a different question, and one no CircleCI API answers).
func (s *Server) handleXcodeVersions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	if s.guides == nil {
		// Only reachable in a test that overrode the cache with nil. Answered
		// honestly rather than with a 500: the field's job here is to fall back to
		// free text and explain itself.
		writeJSON(w, http.StatusOK, xcodeVersionsPayload{
			Versions: []guides.XcodeVersion{},
			Reason:   "the built-in documentation is not loaded in this build, so CircleCI's supported-Xcode table could not be read",
		})
		return
	}

	parsed, provenance, _ := s.guides.Guides()
	result := guides.XcodeVersions(parsed)
	writeJSON(w, http.StatusOK, xcodeVersionsPayload{
		Versions:   result.Versions,
		Default:    guides.DefaultXcodeVersion(result.Versions),
		Derived:    result.Derived,
		Reason:     result.Reason,
		Provenance: provenance,
	})
}
