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

	"github.com/CircleCI-Labs/circleci-editor/internal/schema"
)

// schemaCacheControl marks GET /api/schema's response as long-lived: the
// embedded schema (see package schema) can only change by rebuilding this
// binary, so within the lifetime of any one running instance the response
// is completely immutable. A day is used rather than something unbounded so
// a long-running dev session that happens to span a binary upgrade doesn't
// pin a stale schema in the browser's cache indefinitely; ETag-based
// revalidation (below) makes that cheap even within the day.
const schemaCacheControl = "public, max-age=86400"

// handleSchema serves GET /api/schema: the vendored CircleCI configuration
// JSON Schema (see package schema for provenance), used by the YAML editor
// pane to drive autocompletion. Unlike every other /api/ endpoint, this
// requires no CIRCLE_TOKEN and consults neither s.env nor any CircleCI API
// — the schema is a static asset baked into the binary at build time, so it
// is always available, token or not.
func (s *Server) handleSchema(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	tag := schema.ETag()
	w.Header().Set("ETag", tag)
	w.Header().Set("Cache-Control", schemaCacheControl)

	if match := r.Header.Get("If-None-Match"); match != "" && match == tag {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(schema.JSON())
}
