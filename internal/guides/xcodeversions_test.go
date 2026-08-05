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

package guides

import (
	"strings"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"
)

// wantXcodeVersions is what this project claims are legal `xcode:` values,
// spelled out in full and in upstream's own order (newest first).
//
// **This is the test issue #211 asks for**, and the reason it matters is #203:
// the value this editor used to write, `15.3.0`, is not in this list and never
// was. It is not a version that used to be supported and was dropped -- it does
// not appear anywhere in CircleCI's table -- so no drift check would have caught
// it, because there was nothing to check against. There is now, and it fails the
// moment the vendored table and the offered versions disagree.
//
// When `task guides:refresh` brings in a genuinely changed table, update this
// list and say so in the changelog. Do not update it to match a shape change you
// have not read: a version disappearing here means CircleCI stopped supporting
// it, which is a fact worth noticing rather than a test to silence.
//
// Checked against the table as vendored at circleci-docs 447dc483.
var wantXcodeVersions = []string{
	"27.0", "26.6", "26.5", "26.4.1", "26.3.0",
	"26.2.0", "26.1.1", "16.4.0", "15.4.0", "14.3.1",
}

// wantXcodePrereleases are the versions upstream's own table marks as still in
// pre-release, and in which word -- see prereleaseKind. Every other row in
// wantXcodeVersions must carry no marker at all.
var wantXcodePrereleases = map[string]string{
	"27.0": "beta",
	"26.6": "release candidate",
}

func xcodeVersionStrings(versions []XcodeVersion) []string {
	out := make([]string, 0, len(versions))
	for _, version := range versions {
		out = append(out, version.Version)
	}
	return out
}

// TestXcodeVersionsFromVendoredSnapshot is the drift check: the versions this
// project offers, extracted from the vendored table, against wantXcodeVersions.
func TestXcodeVersionsFromVendoredSnapshot(t *testing.T) {
	t.Parallel()

	versions, err := EmbeddedXcodeVersions()
	assert.NilError(t, err)
	assert.DeepEqual(t, xcodeVersionStrings(versions), wantXcodeVersions)
}

// TestTheOldHardcodedXcodeDefaultIsNotSupported is issue #203 stated as a test.
// `15.3.0` was the macOS card's `defaultImage` and the mutation layer's
// fallback, and it is not a version CircleCI offers. The assertion is deliberately
// the *negative* one: this must keep being true, and if a future refresh ever
// reintroduced 15.3.0 the failure is a prompt to delete this test knowingly
// rather than a bug.
func TestTheOldHardcodedXcodeDefaultIsNotSupported(t *testing.T) {
	t.Parallel()

	versions, err := EmbeddedXcodeVersions()
	assert.NilError(t, err)
	for _, version := range versions {
		assert.Assert(t, version.Version != "15.3.0",
			"15.3.0 is back in CircleCI's table; issue #203's premise no longer holds")
	}
}

// TestDefaultXcodeVersionSkipsPrereleases pins what a new macOS job starts on:
// the newest version upstream does not mark a pre-release. The table is
// newest-first and its top rows are routinely a beta and a release candidate, and
// upstream's own beta-image section says those images are not frozen and can
// change under a running job.
func TestDefaultXcodeVersionSkipsPrereleases(t *testing.T) {
	t.Parallel()

	versions, err := EmbeddedXcodeVersions()
	assert.NilError(t, err)
	assert.Equal(t, DefaultXcodeVersion(versions), "26.5")

	// The mechanism, not just the current answer.
	assert.Equal(t, DefaultXcodeVersion([]XcodeVersion{
		{Version: "99.0", Prerelease: true},
		{Version: "98.0", Prerelease: true},
		{Version: "97.0"},
	}), "97.0")

	// Every row marked: the newest is still a real supported version, so it is
	// better than nothing and better than inventing one.
	assert.Equal(t, DefaultXcodeVersion([]XcodeVersion{
		{Version: "99.0", Prerelease: true},
	}), "99.0")

	assert.Equal(t, DefaultXcodeVersion(nil), "")
}

// TestXcodePrereleasesComeFromUpstreamsOwnLinks pins the pre-release marker,
// including the case that makes the rule non-obvious: Xcode 14.3.1 is a long-
// shipped stable version whose release-notes link is titled
// `xcode-14-3-1-rc-released`. A rule that matched a bare `rc` would call it a
// release candidate; requiring a numbered marker (`rc-2`, `beta-4`) does not.
func TestXcodePrereleasesComeFromUpstreamsOwnLinks(t *testing.T) {
	t.Parallel()

	versions, err := EmbeddedXcodeVersions()
	assert.NilError(t, err)

	for _, version := range versions {
		want := wantXcodePrereleases[version.Version]
		assert.Equal(t, version.PrereleaseKind, want, "version %s", version.Version)
		assert.Equal(t, version.Prerelease, want != "", "version %s", version.Version)
	}
}

// TestXcodeVersionLabelsAndSpecsComeFromTheTableColumns checks that everything a
// dropdown shows next to a version is CircleCI's own wording read out of the
// table's own columns, rather than prose written here -- the property that makes
// this list unable to disagree with the docs about what a version *is*.
func TestXcodeVersionLabelsAndSpecsComeFromTheTableColumns(t *testing.T) {
	t.Parallel()

	versions, err := EmbeddedXcodeVersions()
	assert.NilError(t, err)
	byVersion := map[string]XcodeVersion{}
	for _, version := range versions {
		byVersion[version.Version] = version
	}

	// The "Xcode Version" column, including Apple's own build number.
	assert.Equal(t, byVersion["26.5"].Label, "Xcode 26.5 (17F42)")
	// Note `16.4.0` is the config value while the label is "Xcode 16.4": the two
	// columns genuinely disagree upstream, which is exactly why the config value
	// is read from the Config column and not derived from the label.
	assert.Equal(t, byVersion["16.4.0"].Label, "Xcode 16.4 (16F6)")

	// The remaining non-link columns, by their own headers.
	assert.Equal(t, byVersion["26.5"].Spec, "macOS Version 26.3.1")
	// The AsciiDoc hard break in the resource-class cell must not survive into
	// anything a user reads -- "m4pro.medium + m4pro.large" would look like a
	// claim about using both at once.
	assert.Assert(t, !strings.Contains(byVersion["26.5"].Spec, "+"), "spec=%q", byVersion["26.5"].Spec)
	assert.DeepEqual(t, byVersion["26.5"].ResourceClasses, []string{"m4pro.medium", "m4pro.large"})
}

// TestXcodeResourceClassesAgreeWithTheResourceTables cross-checks the two
// vendored tables against each other. The supported-Xcode table names the classes
// each image runs on; the macOS resource table lists the classes the executor
// offers. They are maintained separately upstream, so a disagreement is a real
// signal -- and it is the one thing that could make the Xcode field and the
// resource-class field contradict one another in the same dialog.
func TestXcodeResourceClassesAgreeWithTheResourceTables(t *testing.T) {
	t.Parallel()

	versions, err := EmbeddedXcodeVersions()
	assert.NilError(t, err)
	environments, err := EmbeddedResourceClasses()
	assert.NilError(t, err)

	offered := map[string]bool{}
	for _, env := range environments {
		if env.Kind != KindMacOS {
			continue
		}
		for _, class := range env.Classes {
			offered[class.Name] = true
		}
	}
	assert.Assert(t, len(offered) > 0)

	for _, version := range versions {
		assert.Assert(t, is.Len(version.ResourceClasses, len(offered)))
		for _, name := range version.ResourceClasses {
			assert.Assert(t, offered[name],
				"the supported-Xcode table says %s runs on %q, which the macOS resource table does not list", version.Version, name)
		}
	}
}

// TestExtractXcodeVersionsRejectsAShapeChange covers the fallback trigger. Like
// resource classes this is all-or-nothing: a partial list would omit versions
// with nothing in the UI able to say which, and "the version you need is
// missing" is indistinguishable from "the version you need does not exist".
func TestExtractXcodeVersionsRejectsAShapeChange(t *testing.T) {
	t.Parallel()

	t.Run("a renamed Config column", func(t *testing.T) {
		t.Parallel()
		parsed := parsedSnapshotWithReplacement(t, "| Config\n| Xcode Version", "| Value\n| Xcode Version")
		_, err := ExtractXcodeVersions(parsed)
		assert.ErrorContains(t, err, "no longer has a supported-Xcode table")
	})

	t.Run("a removed Xcode Version column heading", func(t *testing.T) {
		t.Parallel()
		parsed := parsedSnapshotWithReplacement(t, "| Xcode Version\n| macOS Version", "| Version\n| macOS Version")
		_, err := ExtractXcodeVersions(parsed)
		assert.ErrorContains(t, err, "no longer has a supported-Xcode table")
	})

	t.Run("a removed section anchor", func(t *testing.T) {
		t.Parallel()
		parsed := parsedSnapshotWithReplacement(t, "[#supported-xcode-versions-silicon]", "[#supported-xcode-versions-apple-silicon]")
		_, err := ExtractXcodeVersions(parsed)
		assert.ErrorContains(t, err, XcodeTableAnchor)
	})

	t.Run("a config cell with no code span", func(t *testing.T) {
		t.Parallel()
		parsed := parsedSnapshotWithReplacement(t, "| `26.4.1`\n| Xcode 26.4.1", "| 26.4.1\n| Xcode 26.4.1")
		_, err := ExtractXcodeVersions(parsed)
		assert.ErrorContains(t, err, "could not be read")
	})

	t.Run("the guide itself missing", func(t *testing.T) {
		t.Parallel()
		_, err := ExtractXcodeVersions(nil)
		assert.ErrorContains(t, err, "is not available")
	})
}

// TestXcodeVersionsFallsBackToTheEmbeddedSnapshot is the honest-degradation path,
// and the one that matters most here: the fallback is the *same extraction* run
// against the embedded snapshot, never a retyped literal. A literal is what
// produced `15.3.0`.
func TestXcodeVersionsFallsBackToTheEmbeddedSnapshot(t *testing.T) {
	t.Parallel()

	embedded, err := EmbeddedXcodeVersions()
	assert.NilError(t, err)

	result := XcodeVersions(nil)
	assert.Assert(t, !result.Derived)
	assert.Assert(t, strings.Contains(result.Reason, "embedded in this release"), "reason=%q", result.Reason)
	assert.DeepEqual(t, result.Versions, embedded)

	parsed, err := ParseSnapshot()
	assert.NilError(t, err)
	ok := XcodeVersions(parsed)
	assert.Assert(t, ok.Derived)
	assert.Equal(t, ok.Reason, "")
	assert.DeepEqual(t, ok.Versions, embedded)
}

// TestXcodeTableAnchorResolves validates the one thing this file hardcodes
// besides the guide ID: the anchor the table sits under must be an anchor the
// macOS guide really defines. That is what makes a moved anchor a loud extraction
// failure rather than a quietly empty dropdown.
func TestXcodeTableAnchorResolves(t *testing.T) {
	t.Parallel()

	parsed, err := ParseSnapshot()
	assert.NilError(t, err)
	guide := findGuideByID(parsed, XcodeGuideID)
	assert.Assert(t, guide != nil)

	_, known := guide.Anchors[XcodeTableAnchor]
	assert.Assert(t, known, "%q is not an anchor in the %s guide", XcodeTableAnchor, XcodeGuideID)
}

// TestXcodeExtractionIgnoresTheMacOSResourceTable is why isXcodeVersionTable
// requires two columns rather than one. The macOS guide includes the macOS
// *resource* table three headings below the Xcode one, and both are tables of
// short code spans under a section anchor; matching on "Config" alone would be
// one upstream column rename away from offering resource classes as Xcode
// versions.
func TestXcodeExtractionIgnoresTheMacOSResourceTable(t *testing.T) {
	t.Parallel()

	parsed, err := ParseSnapshot()
	assert.NilError(t, err)
	guide := findGuideByID(parsed, XcodeGuideID)
	assert.Assert(t, guide != nil)

	tables := tablesByAnchor(*guide, isXcodeVersionTable)
	assert.Assert(t, is.Len(tables, 1))
	_, ok := tables[XcodeTableAnchor]
	assert.Assert(t, ok)
}
