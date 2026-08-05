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

package webassets_test

import (
	"strings"
	"testing"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/webassets"
)

// TestFS_AlwaysUsable guards the go:embed contract: the dist directory is
// generated output that is empty on a fresh clone apart from .gitkeep, so
// FS must still resolve rather than failing the build or returning an error.
func TestFS_AlwaysUsable(t *testing.T) {
	t.Parallel()

	fsys, err := webassets.FS()
	assert.NilError(t, err)
	assert.Assert(t, fsys != nil)
}

// TestPlaceholder_ExplainsHowToBuild ensures the committed fallback page is
// embedded and actually tells the user what to run. This is what a binary
// compiled without the SPA bundle serves.
func TestPlaceholder_ExplainsHowToBuild(t *testing.T) {
	t.Parallel()

	page := string(webassets.Placeholder())

	for _, want := range []string{"<!doctype html>", "not built", "task web:build"} {
		assert.Assert(t, strings.Contains(page, want), "placeholder should mention %q", want)
	}
}

// TestHasRealBuild_MatchesEmbeddedContents checks that HasRealBuild agrees
// with what is actually embedded: true when a built index.html is present,
// false when only .gitkeep is. Both states are legitimate, so this asserts
// consistency rather than a fixed value.
func TestHasRealBuild_MatchesEmbeddedContents(t *testing.T) {
	t.Parallel()

	fsys, err := webassets.FS()
	assert.NilError(t, err)

	_, statErr := fsys.Open("index.html")
	indexPresent := statErr == nil

	assert.Equal(t, webassets.HasRealBuild(), indexPresent)
}
