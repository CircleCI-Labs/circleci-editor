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

// Package webassets embeds the built single-page application so that the
// circleci-editor binary can serve it without any external files.
//
// The dist directory holds generated output only: it is produced by the Vite
// build (task web:build, or pnpm --dir web build) and is not committed apart
// from a .gitkeep, which exists solely so that go:embed always has a file to
// match and go build therefore always succeeds on a fresh clone.
//
// When dist contains no real build, the binary serves the committed
// placeholder.html instead, which tells the user how to build the SPA.
package webassets

import (
	"embed"
	"io/fs"
)

// distFS holds the built SPA. The all: prefix is required so that the
// .gitkeep placeholder (a dot file, which go:embed would otherwise skip) is
// matched, keeping this directive valid before any build has run.
//
//go:embed all:dist
var distFS embed.FS

//go:embed placeholder.html
var placeholderHTML []byte

// indexFile is the SPA entry point that a real Vite build produces.
const indexFile = "index.html"

// FS returns the embedded filesystem rooted at the dist directory, i.e. the
// filesystem containing index.html and the assets directory once the SPA has
// been built.
func FS() (fs.FS, error) {
	return fs.Sub(distFS, "dist")
}

// Placeholder returns the HTML page served when the binary was compiled
// without a built SPA bundle.
func Placeholder() []byte {
	return placeholderHTML
}

// HasRealBuild reports whether the embedded assets contain a real Vite build
// of the SPA, rather than just the .gitkeep that keeps the go:embed directive
// valid on a fresh clone.
func HasRealBuild() bool {
	sub, err := FS()
	if err != nil {
		return false
	}

	info, err := fs.Stat(sub, indexFile)
	if err != nil {
		return false
	}

	return !info.IsDir()
}
