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
	"bytes"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"strings"
	"time"
)

// devProxyEnvVar, when set to a base URL (e.g. http://localhost:5173), makes
// the server reverse-proxy all non-API requests to that URL instead of
// serving the embedded SPA assets. This is intended for local development
// against the Vite dev server.
const devProxyEnvVar = "CIRCLECI_EDITOR_DEV_PROXY"

// indexPath is the SPA entry point served for the root path and as the
// fallback for unmatched client-routed paths.
const indexPath = "index.html"

// newAssetsHandler returns a handler that serves the embedded SPA from fsys,
// falling back to index.html for any GET request that does not match a real
// file (so that client-side routing works) and is not under /api.
//
// When fsys contains no built SPA (a binary compiled without running the web
// build), placeholder is served instead for every HTML request, so the user
// gets an explanatory page rather than a 404.
//
// This deliberately avoids http.FileServer: serving a request whose path
// resolves to "index.html" through http.FileServer triggers its built-in
// "drop index.html, redirect to the directory" behavior, which combined
// with our own SPA fallback (which resolves unmatched paths to
// "index.html") produces a redirect loop for any client-routed path.
// Reading the file directly and writing it with http.ServeContent sidesteps
// that special case entirely.
func newAssetsHandler(fsys fs.FS, placeholder []byte) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}

		cleaned := path.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if cleaned == "." {
			cleaned = indexPath
		}

		if !fileExistsInFS(fsys, cleaned) {
			cleaned = indexPath
		}

		data, err := fs.ReadFile(fsys, cleaned)
		if err != nil {
			// No built SPA: explain how to build it instead of 404ing.
			if cleaned == indexPath && len(placeholder) > 0 {
				w.Header().Set("Cache-Control", "no-store")
				http.ServeContent(w, r, indexPath, time.Time{}, bytes.NewReader(placeholder))
				return
			}
			writeError(w, http.StatusNotFound, "not found")
			return
		}

		setCacheControl(w, cleaned)
		http.ServeContent(w, r, cleaned, time.Time{}, bytes.NewReader(data))
	})
}

// fileExistsInFS reports whether name names a regular file (not a
// directory) within fsys.
func fileExistsInFS(fsys fs.FS, name string) bool {
	info, err := fs.Stat(fsys, name)
	if err != nil {
		return false
	}
	return !info.IsDir()
}

// setCacheControl sets a Cache-Control header appropriate for the asset
// being served: the SPA shell (index.html) must never be cached so that
// clients pick up new builds, while immutable, content-hashed files under
// /assets/ can be cached for a long time.
func setCacheControl(w http.ResponseWriter, cleanedPath string) {
	if cleanedPath == indexPath {
		w.Header().Set("Cache-Control", "no-store")
		return
	}
	if strings.HasPrefix(cleanedPath, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
}

// newDevProxyHandler returns a handler that reverse-proxies all requests to
// target, for use against a running Vite dev server. target comes only from
// the developer-controlled CIRCLECI_EDITOR_DEV_PROXY environment variable, never from a
// request, so this is local developer tooling rather than an SSRF vector.
func newDevProxyHandler(target string) (http.Handler, error) {
	targetURL, err := url.Parse(target)
	if err != nil {
		return nil, fmt.Errorf("host: parse %s: %w", devProxyEnvVar, err)
	}
	return httputil.NewSingleHostReverseProxy(targetURL), nil //nolint:gosec // target is a developer-set env var, not request input.
}
