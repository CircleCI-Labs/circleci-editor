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

package offerings_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
	"github.com/CircleCI-Labs/circleci-editor/internal/guides"
)

// TestOfferingsIsASupersetOfAsciiDocXcodeVersions pins the other half of
// issue #305's comparison: unlike resource classes (see
// resourceclass_coverage_test.go), the live offerings snapshot's `xcode:*`
// entries genuinely are a superset of the vendored supported-Xcode table's
// versions -- every version internal/guides/xcodeversions.go extracts from
// the AsciiDoc snapshot appears, verbatim, among the offerings response's
// `xcode:<version>` image names for macOS.
//
// # Why xcodeversions.go is not deleted anyway
//
// A superset of the *version strings* is not a superset of what the field
// actually needs from them. Two things the AsciiDoc table carries and the
// offerings endpoint does not:
//
//   - Prerelease/PrereleaseKind, which DefaultXcodeVersion depends on to
//     avoid preselecting a beta or release candidate for a new job. The live
//     response has no equivalent signal at all -- "27.0.0" and "27.0" sit in
//     the same flat string list as "16.2.0", with nothing distinguishing a
//     shipping release from a beta CircleCI is still iterating on.
//   - A single, consistent spelling per version. The AsciiDoc table has
//     exactly one row per version; the live response carries duplicate
//     spellings of the same release ("26.0" and "26.0.0" both present) with
//     no canonical form declared between them.
//
// So this issue keeps xcodeversions.go's extraction as the source of Label,
// Spec, Prerelease and the safe default, and uses the offerings list only for
// what it adds cleanly and without inventing missing metadata: flagging
// versions the live catalog has since deprecated (Offerings.Deprecated.macos)
// and, in principle, showing versions newer than the vendored snapshot's next
// refresh.
func TestOfferingsIsASupersetOfAsciiDocXcodeVersions(t *testing.T) {
	data, err := os.ReadFile("testdata/live-snapshot-2026-07-31.json")
	assert.NilError(t, err)
	var live circleci.Offerings
	assert.NilError(t, json.Unmarshal(data, &live))

	offeredVersions := map[string]bool{}
	for _, images := range live.MacOS {
		for _, image := range images {
			offeredVersions[strings.TrimPrefix(image, "xcode:")] = true
		}
	}

	versions, err := guides.EmbeddedXcodeVersions()
	assert.NilError(t, err)
	assert.Assert(t, len(versions) > 0)

	for _, v := range versions {
		assert.Assert(t, offeredVersions[v.Version],
			"expected AsciiDoc-derived Xcode version %q to also appear live in offerings -- if this now fails, re-check the finding in this file's doc comment", v.Version)
	}
}
