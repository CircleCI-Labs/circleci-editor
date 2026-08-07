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

package host_test

import (
	"os"
	"testing"
)

// TestMain points this package's persisted caches at a throwaway directory for
// the whole test binary.
//
// Several tests build a real server via host.New, and the caches it constructs
// fall back to orbs.DefaultCacheDir when no fake is injected -- which is
// $XDG_CACHE_HOME, or ~/.cache when that is unset: the developer's own cache
// directory. Any run of the actual editor on the same machine leaves files
// there, and a stale one made TestServer_ResourceClasses_NoToken_DerivesFromTheVendoredTables
// and TestServer_Guides_NoToken_ServesTheVendoredGuides fail locally while
// passing in CI, whose HOME is clean.
//
// Both of those tests assert on vendored data embedded in the binary and say
// so in their own comments, so reading anything outside the process was never
// intended. A test that fails only on a machine that has used the product is
// worse than one that fails everywhere: it reads as "green on CI, broken
// here", so it gets attributed to whatever the developer changed last, which
// is exactly how it cost the review of an unrelated change.
//
// This is the backstop, not the whole fix: it guarantees no test ever writes to
// the developer's real cache, including tests that call host.New directly
// rather than through a helper. It is deliberately *not* enough on its own --
// one directory shared by the whole test binary still lets an earlier test's
// persisted cache be read by a later one, so newGuidesTestServer narrows it
// further to a directory per test. See its own comment.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "circleci-editor-host-tests-")
	if err != nil {
		panic("host_test: create temp cache dir: " + err.Error())
	}
	if err := os.Setenv("XDG_CACHE_HOME", dir); err != nil {
		panic("host_test: set XDG_CACHE_HOME: " + err.Error())
	}

	code := m.Run()

	// Not deferred: os.Exit does not run deferred functions.
	_ = os.RemoveAll(dir)
	os.Exit(code)
}
