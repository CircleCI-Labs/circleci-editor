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

// resourceClassesPayload is the JSON shape of GET /api/resource-classes: the
// resource classes each executor environment offers, derived from CircleCI's own
// vendored resource tables (issue #181).
//
// Deliberately its own endpoint rather than a field on GET /api/guides or GET
// /api/schema:
//
//   - /api/guides is ~500 KB of parsed prose. The executor field needs ten short
//     class lists, and opening a "New job" dialog should not pull the whole
//     documentation corpus to populate a dropdown.
//   - /api/schema is served with a day of Cache-Control because the schema can
//     only change by rebuilding the binary. That is untrue of this: the guides
//     cache refreshes upstream AsciiDoc in the background on a seven-day TTL, so
//     a cached response could pin a resource-class list the running process has
//     already replaced.
//
// No caching headers, for that same reason and for the reason /api/guides has
// none: the response can change while the process runs, and it is served over
// loopback where a re-read costs nothing worth optimising.
// It carries no `available` flag, unlike the other degradable endpoints. The
// question that flag answers elsewhere -- "is there anything to render?" -- is
// already answered by Environments being empty, and a second boolean that is
// true in every reachable case would only invite a caller to check the wrong
// one. What a caller must branch on is Derived, which is a real and much more
// likely outcome.
type resourceClassesPayload struct {
	// Environments are the resource tables to offer, in upstream document order.
	// Empty only when even the embedded snapshot could not be read, which is a
	// build defect; the executor field then falls back to free text and says so.
	Environments []guides.ResourceClassEnvironment `json:"environments"`
	// Derived reports that Environments came from the documentation this host is
	// currently serving. When false, they are the copy embedded in this release
	// and Reason says why -- and the executor field must say so too, rather than
	// presenting a possibly-stale list as current.
	Derived bool `json:"derived"`
	// Reason is set when Derived is false: a sentence a UI can show.
	Reason string `json:"reason,omitempty"`
	// Provenance dates the underlying documentation, exactly as /api/guides
	// reports it, so the executor field can answer "how old is this list?" with
	// the same answer the docs pane gives.
	Provenance guides.Provenance `json:"provenance"`
}

// handleResourceClasses serves GET /api/resource-classes.
//
// Like GET /api/guides and GET /api/schema this needs no CIRCLE_TOKEN and
// consults no CircleCI API. There is deliberately no per-project variant: no
// CircleCI API exposes which resource classes a given project's plan may
// actually use (five candidate endpoints 404'd -- see issue #143), so
// the documentation tables are the only authority available, and the field says
// as much next to the list.
func (s *Server) handleResourceClasses(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	if s.guides == nil {
		// Only reachable in a test that overrode the cache with nil. Answered
		// honestly rather than with a 500: the field's job here is to fall back
		// to free text and explain itself.
		writeJSON(w, http.StatusOK, resourceClassesPayload{
			Environments: []guides.ResourceClassEnvironment{},
			Reason:       "the built-in documentation is not loaded in this build, so CircleCI's resource-class tables could not be read",
		})
		return
	}

	// Errors from the cache are not handled separately: guides.ResourceClasses
	// treats an empty parse the same as an unreadable one and falls back to the
	// snapshot embedded in this binary, which is exactly the right answer here.
	parsed, provenance, _ := s.guides.Guides()
	result := guides.ResourceClasses(parsed)
	writeJSON(w, http.StatusOK, resourceClassesPayload{
		Environments: result.Environments,
		Derived:      result.Derived,
		Reason:       result.Reason,
		Provenance:   provenance,
	})
}
