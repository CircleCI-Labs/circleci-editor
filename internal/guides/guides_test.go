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

// TestSnapshotChecksums is the provenance guarantee: every vendored file
// matches the SHA-256 recorded in snapshot/manifest.json, and the manifest
// lists exactly the files present. An accidental local edit to redistributed
// third-party content, or a half-finished refresh, fails here rather than
// silently changing what this project claims to be redistributing.
//
// See internal/guides's package doc comment and CONTRIBUTING.md's
// third-party attributions for the licensing this snapshot rests on.
func TestSnapshotChecksums(t *testing.T) {
	t.Parallel()
	assert.NilError(t, VerifySnapshot())
}

func TestSnapshotManifestRecordsItsUpstreamCommit(t *testing.T) {
	t.Parallel()

	manifest, err := LoadManifest()
	assert.NilError(t, err)
	assert.Equal(t, manifest.Repo, UpstreamRepo)
	// Issue #286: the manifest names *which* moving target Commit was
	// resolved from, not just that it was resolved from something.
	assert.Equal(t, manifest.Ref, DefaultBranch)
	// A full 40-character SHA, not a branch name or an abbreviation: the point
	// of the record is that anyone can fetch exactly these bytes again.
	assert.Assert(t, is.Len(manifest.Commit, 40), "commit=%q", manifest.Commit)
	assert.Assert(t, !manifest.CommittedAt.IsZero())
	assert.Assert(t, !manifest.VendoredAt.IsZero())
	assert.Assert(t, len(manifest.Files) >= len(UpstreamSources()))

	// Every upstream entry page is individually recorded. `>=` above would be
	// satisfied by twenty partials and no pages at all; this is the stronger
	// claim this project actually makes about the snapshot.
	for _, src := range UpstreamSources() {
		_, ok := manifest.Files[src.entryPath()]
		assert.Assert(t, ok, "the manifest does not record %s (%s)", src.ID, src.entryPath())
	}
}

// TestSourcesAreWellFormed pins the invariants the pane and the refresher both
// assume of the guide list: unique IDs (they address persisted UI state), a
// label and a category for every entry (the picker groups by category and would
// otherwise grow an unnamed group), and coordinates appropriate to the origin.
func TestSourcesAreWellFormed(t *testing.T) {
	t.Parallel()

	seenID := map[string]bool{}
	seenPath := map[string]bool{}
	for _, src := range Sources {
		assert.Assert(t, src.ID != "", "a source has no ID")
		assert.Assert(t, !seenID[src.ID], "duplicate source ID %q", src.ID)
		seenID[src.ID] = true
		assert.Assert(t, src.Label != "", "%s has no label", src.ID)
		assert.Assert(t, src.Category != "", "%s has no category", src.ID)

		switch src.Origin {
		case OriginCircleCI:
			assert.Assert(t, src.File == "", "%s is a vendored page but names an editor file", src.ID)
			assert.Assert(t, src.Component != "" && src.Module != "" && src.Page != "",
				"%s is missing Antora coordinates", src.ID)
			path := src.entryPath()
			assert.Assert(t, !seenPath[path], "two sources both vendor %s", path)
			seenPath[path] = true
			assert.Assert(t, strings.HasPrefix(src.URL(), "https://circleci.com/docs/"), "%s url=%q", src.ID, src.URL())
		case OriginEditor:
			assert.Assert(t, src.Component == "" && src.Module == "" && src.Page == "",
				"%s is our own page but carries Antora coordinates", src.ID)
			assert.Assert(t, strings.HasSuffix(src.File, ".adoc"), "%s file=%q", src.ID, src.File)
			// Never a circleci.com URL: our own writing must not be presented
			// as though CircleCI had published it.
			assert.Assert(t, !strings.Contains(src.URL(), "circleci.com"), "%s url=%q", src.ID, src.URL())
		default:
			t.Fatalf("%s has unknown origin %q", src.ID, src.Origin)
		}
	}

	// The picker groups by category, so a category's entries must be contiguous
	// in Sources -- otherwise one group would render twice.
	var order []string
	for _, src := range Sources {
		if len(order) == 0 || order[len(order)-1] != src.Category {
			assert.Assert(t, !contains(order, src.Category), "category %q is split across Sources", src.Category)
			order = append(order, src.Category)
		}
	}

	// The configuration reference stays first (the key browser joins against it
	// and the pane opens on it), and this project's own pages stay last, so the
	// pane never opens on our words where CircleCI's were expected.
	assert.Equal(t, Sources[0].ID, "configuration-reference")
	assert.Equal(t, Sources[len(Sources)-1].Origin, OriginEditor)
	assert.Equal(t, Sources[0].Origin, OriginCircleCI)
}

func contains(haystack []string, needle string) bool {
	for _, item := range haystack {
		if item == needle {
			return true
		}
	}
	return false
}

// TestExcludedPathReasonRejectsArchivedAndServerAdminContent pins the exclusion
// policy itself, against paths taken from circleci-docs at 447dc483 rather than
// invented. Over half that corpus -- 429 of 811 .adoc files, 3.3 of 6.1 MB -- is
// archived or server-admin content, and issue #176's stated trap is excluding it
// by omission, which lasts exactly until someone writes a glob.
func TestExcludedPathReasonRejectsArchivedAndServerAdminContent(t *testing.T) {
	t.Parallel()

	for _, excluded := range []string{
		"archive/test-splitting-tutorial.adoc",
		"archive/server 4.1/server-admin/modules/ROOT/pages/overview.adoc",
		"archive/server-admin-4.2/modules/installation/pages/phase-1-aws.adoc",
		"docs/server-admin-4.7/modules/ROOT/pages/caching.adoc",
		"docs/server-admin-4.10/modules/operator/pages/backup-and-restore.adoc",
	} {
		assert.Assert(t, ExcludedPathReason(excluded) != "", "%s should be excluded", excluded)
	}

	for _, allowed := range []string{
		"docs/reference/modules/ROOT/pages/configuration-reference.adoc",
		"docs/guides/modules/optimize/pages/caching.adoc",
		"docs/guides/modules/ROOT/partials/notes/docker-auth.adoc",
		"docs/orbs/modules/use/pages/orb-concepts.adoc",
		// Neither of these is archived or server-admin, however much the
		// substrings look like it: the rule is per path *segment*, so a page
		// merely discussing an archive or naming a server admin is fine.
		"docs/guides/modules/ROOT/pages/archived-artifacts.adoc",
		"docs/guides/modules/ROOT/pages/server-administration-overview.adoc",
	} {
		assert.Equal(t, ExcludedPathReason(allowed), "", "%s should be allowed", allowed)
	}
}

// TestNoSourceIsAnExcludedPath is the belt to ExcludedPathReason's braces: the
// policy and the page list must agree, so that adding a page cannot quietly
// re-admit content the policy forbids.
func TestNoSourceIsAnExcludedPath(t *testing.T) {
	t.Parallel()

	for _, src := range UpstreamSources() {
		assert.Equal(t, ExcludedPathReason(src.entryPath()), "",
			"source %s vendors an excluded path", src.ID)
	}
}

// TestSnapshotExcludesArchivedAndServerAdminContent applies the policy to what
// was actually vendored -- including everything the include closure dragged in,
// which is the half nobody chose by hand.
func TestSnapshotExcludesArchivedAndServerAdminContent(t *testing.T) {
	t.Parallel()

	files, err := snapshotFiles()
	assert.NilError(t, err)
	assert.Assert(t, len(files) > len(UpstreamSources()), "the closure should pull in partials")

	for name := range files {
		assert.Equal(t, ExcludedPathReason(name), "", "the snapshot contains %s", name)
	}
}

// TestEditorDocsAreOutsideTheVendoredSnapshot is a licensing test, not a
// housekeeping one.
//
// snapshot/manifest.json claims that every file under snapshot/
// is CircleCI's, taken verbatim, at one recorded commit. This project's own
// documentation about this editor is neither CircleCI's nor fetched, so if it
// ever landed under snapshot/ that claim would become false -- and the
// owner's explicit grant that the vendored content rests on would start
// covering text the grant was never about.
func TestEditorDocsAreOutsideTheVendoredSnapshot(t *testing.T) {
	t.Parallel()

	manifest, err := LoadManifest()
	assert.NilError(t, err)
	for name := range manifest.Files {
		assert.Assert(t, !strings.Contains(name, "using-this-editor"), "%s is in the vendored manifest", name)
		assert.Assert(t, !strings.Contains(name, "editor-limits"), "%s is in the vendored manifest", name)
	}

	// And they are genuinely embedded and parseable, from the other directory.
	for _, src := range Sources {
		if src.Origin != OriginEditor {
			continue
		}
		guide, parseErr := parseEditorGuide(src)
		assert.NilError(t, parseErr)
		assert.Assert(t, guide.Title != "", "%s has no title", src.ID)
		assert.Assert(t, len(guide.Sections) > 0, "%s has no sections", src.ID)
	}
}

// TestEditorDocsSayTheyAreNotCircleCIDocumentation is the honesty check on our
// own content. It sits beside CircleCI's twenty pages in the same picker, so the
// text itself -- not just a badge the reader may not look at -- has to say whose
// words these are. Asserted on the parsed prose rather than the raw file so it
// still holds if the wording is reformatted.
func TestEditorDocsSayTheyAreNotCircleCIDocumentation(t *testing.T) {
	t.Parallel()

	parsed, err := ParseSnapshot()
	assert.NilError(t, err)

	found := 0
	for _, guide := range parsed {
		if guide.Origin != OriginEditor {
			continue
		}
		found++
		lead := strings.ToLower(plainTextBlocks(guide.Lead))
		assert.Assert(t, is.Contains(lead, "this application"), "%s: %s", guide.ID, lead)
		assert.Assert(t, is.Contains(lead, "not"), "%s does not disclaim being CircleCI's: %s", guide.ID, lead)
	}
	assert.Equal(t, found, 2, "both editor pages should be served")
}

// plainTextBlocks flattens blocks to text, for assertions about prose.
func plainTextBlocks(blocks []Block) string {
	var parts []string
	for _, block := range blocks {
		if text := plainText(block.Spans); text != "" {
			parts = append(parts, text)
		}
		if inner := plainTextBlocks(block.Blocks); inner != "" {
			parts = append(parts, inner)
		}
		for _, item := range block.Items {
			if inner := plainTextBlocks(item.Blocks); inner != "" {
				parts = append(parts, inner)
			}
		}
	}
	return strings.Join(parts, " ")
}

// TestSnapshotParses is the property everything else rests on: the embedded
// snapshot yields every guide with no network, no token and no filesystem. It is
// what lets the pane promise content on a first launch with no connectivity.
func TestSnapshotParses(t *testing.T) {
	t.Parallel()

	parsed, err := ParseSnapshot()
	assert.NilError(t, err)
	assert.Assert(t, is.Len(parsed, len(Sources)))

	for i, guide := range parsed {
		assert.Equal(t, guide.ID, Sources[i].ID)
		assert.Equal(t, guide.Origin, Sources[i].Origin)
		assert.Equal(t, guide.Category, Sources[i].Category)
		assert.Assert(t, guide.Title != "", "%s has no title", guide.ID)

		switch guide.Origin {
		case OriginCircleCI:
			assert.Assert(t, strings.HasPrefix(guide.URL, "https://circleci.com/docs/"), "%s url=%q", guide.ID, guide.URL)
		case OriginEditor:
			// Our own pages are not published on circleci.com, and claiming a
			// URL there would be a link that 404s under a heading that says
			// CircleCI wrote it.
			assert.Assert(t, !strings.Contains(guide.URL, "circleci.com"), "%s url=%q", guide.ID, guide.URL)
		}

		// Loosely bounded on purpose: an exact section count would fail on
		// every upstream edit, which is noise, but a page that suddenly has
		// almost nothing in it means the parser broke.
		//
		// Three, not the eight this asserted while only long pages were
		// vendored. Two of the twenty upstream pages are genuinely short --
		// `selecting-a-workflow-to-run-using-pipeline-parameters.adoc` is 2.7 KB
		// and has three headings, `using-matrix-jobs.adoc` likewise -- and they
		// were selected *because* they are the short, specific answer to a
		// question the editor raises, not despite it. The floor still catches a
		// parser that stopped finding headings, which is what it is for.
		assert.Assert(t, len(guide.Sections) >= 3, "%s has only %d sections", guide.ID, len(guide.Sections))
	}

	// And the widening actually happened: enough guides, and enough of them
	// CircleCI's, that a regression to the original three would fail here.
	assert.Assert(t, len(parsed) >= 20, "only %d guides", len(parsed))
	assert.Assert(t, is.Len(UpstreamSources(), len(Sources)-2))
}

// TestSnapshotSectionIDsAreUniqueAndAddressable pins the invariant the pane's
// navigation depends on: within a guide, every section has a distinct,
// non-empty ID, even where upstream reuses an anchor.
func TestSnapshotSectionIDsAreUniqueAndAddressable(t *testing.T) {
	t.Parallel()

	parsed, err := ParseSnapshot()
	assert.NilError(t, err)

	for _, guide := range parsed {
		seen := map[string]bool{}
		for _, section := range guide.Sections {
			assert.Assert(t, section.ID != "", "%s has a section with an empty ID (%q)", guide.ID, section.Title)
			assert.Assert(t, !seen[section.ID], "%s reuses section ID %q", guide.ID, section.ID)
			seen[section.ID] = true

			if section.AnchorDerived {
				// A derived anchor is not a live-page fragment; claiming one
				// would produce a link that 200s and scrolls nowhere.
				assert.Assert(t, !strings.Contains(section.URL, "#"),
					"%s/%s has a derived anchor but a fragment URL %q", guide.ID, section.ID, section.URL)
			}
		}
	}
}

// TestSnapshotCrossReferencesAllResolve checks that no in-pane cross-reference
// points at an anchor the guide does not define. Upstream's own AsciiDoc has
// three broken `<<...>>` links at the time of writing (all to
// `expression-based-job-filters`, a level-4 heading), so this test also pins
// that heading anchors are recorded -- without that, three visible controls in
// the pane would do nothing.
func TestSnapshotCrossReferencesAllResolve(t *testing.T) {
	t.Parallel()

	parsed, err := ParseSnapshot()
	assert.NilError(t, err)

	for _, guide := range parsed {
		var dangling []string
		var walkSpans func(spans []Span)
		walkSpans = func(spans []Span) {
			for _, span := range spans {
				if span.Kind == SpanRef {
					if _, ok := guide.Anchors[span.Target]; !ok {
						dangling = append(dangling, span.Target)
					}
				}
				walkSpans(span.Children)
			}
		}
		var walk func(blocks []Block)
		walk = func(blocks []Block) {
			for _, block := range blocks {
				walkSpans(block.Spans)
				walk(block.Blocks)
				for _, item := range block.Items {
					walk(item.Blocks)
				}
				if block.Table != nil {
					for _, cell := range block.Table.Header {
						walkSpans(cell.Spans)
					}
					for _, row := range block.Table.Rows {
						for _, cell := range row {
							walkSpans(cell.Spans)
						}
					}
				}
			}
		}
		walk(guide.Lead)
		for _, section := range guide.Sections {
			walkSpans(section.TitleSpans)
			walk(section.Blocks)
		}
		assert.Assert(t, is.Len(dangling, 0), "%s has unresolvable in-pane references: %v", guide.ID, dangling)
	}
}

// TestSnapshotHasNoRawAsciiDocLeftInProse is the "did the parser actually
// understand this?" check. Any of these strings appearing in *rendered prose*
// means a construct fell through as literal markup, which reads as a bug in
// this app rather than as documentation.
func TestSnapshotHasNoRawAsciiDocLeftInProse(t *testing.T) {
	t.Parallel()

	parsed, err := ParseSnapshot()
	assert.NilError(t, err)

	// Deliberately excludes code blocks, which are verbatim by design and
	// legitimately contain things like `<< pipeline.number >>`.
	markers := []string{"xref:", "include::", "link:http", "menu:", "image:", "[.", "|===", "----"}

	for _, guide := range parsed {
		var offenders []string
		check := func(where string, spans []Span) {
			text := plainText(spans)
			for _, marker := range markers {
				if strings.Contains(text, marker) {
					offenders = append(offenders, where+": "+marker+" in "+truncate(text, 90))
				}
			}
		}
		var walk func(where string, blocks []Block)
		walk = func(where string, blocks []Block) {
			for _, block := range blocks {
				switch block.Kind {
				case KindParagraph, KindHeading, KindNote:
					check(where, block.Spans)
				case KindTable:
					if block.Table != nil {
						for _, cell := range block.Table.Header {
							check(where, cell.Spans)
						}
						for _, row := range block.Table.Rows {
							for _, cell := range row {
								check(where, cell.Spans)
							}
						}
					}
				case KindCode:
					// Verbatim by design.
				case KindAdmonition, KindList:
					// Container kinds; their contents are walked below.
				}
				walk(where, block.Blocks)
				for _, item := range block.Items {
					walk(where, item.Blocks)
				}
			}
		}
		walk(guide.ID+"/lead", guide.Lead)
		for _, section := range guide.Sections {
			walk(guide.ID+"/"+section.ID, section.Blocks)
		}
		assert.Assert(t, is.Len(offenders, 0), "unparsed AsciiDoc reached rendered prose:\n%s", strings.Join(offenders, "\n"))
	}
}

// TestSnapshotConfigurationReferenceCoversTheSchemasKeys is the reconciliation
// check between this package and the schema-derived key browser (issue #104's
// actual complaint: `display` renders as "a bare, unexplained key").
//
// It asserts two things at once, and the second is the interesting one:
//
//   - Every top-level key a project config actually uses has prose here, so
//     the key browser can show it.
//   - `display`, `examples` and `experimental` have *none* -- because the
//     official configuration reference genuinely does not document them. That
//     absence is the evidence the pane uses to label them orb-authoring
//     metadata, instead of this project maintaining a hand-written denylist
//     that would quietly rot the moment CircleCI documented one of them.
func TestSnapshotConfigurationReferenceCoversTheSchemasKeys(t *testing.T) {
	t.Parallel()

	parsed, err := ParseSnapshot()
	assert.NilError(t, err)

	var reference *Guide
	for i := range parsed {
		if parsed[i].ID == "configuration-reference" {
			reference = &parsed[i]
		}
	}
	assert.Assert(t, reference != nil)

	documented := map[string]bool{}
	for _, section := range reference.Sections {
		for _, key := range section.Keys {
			documented[key] = true
		}
	}

	// The schema's top-level keys that a project config author writes.
	for _, key := range []string{"version", "setup", "orbs", "commands", "parameters", "executors", "jobs", "workflows", "job-groups"} {
		assert.Assert(t, documented[key], "the configuration reference has no section for the %q key", key)
	}

	// The orb-authoring-only keys the owner reported as confusing.
	for _, key := range []string{"display", "examples", "experimental"} {
		assert.Assert(t, !documented[key],
			"the configuration reference now documents %q; the pane's orb-authoring labelling should be revisited", key)
	}

	// Every built-in step this editor has an inspector for must be findable,
	// which is what lets a step's prose appear next to its schema fields.
	for _, step := range []string{"run", "checkout", "setup_remote_docker", "save_cache", "restore_cache",
		"store_artifacts", "store_test_results", "persist_to_workspace", "attach_workspace", "add_ssh_keys"} {
		assert.Assert(t, documented[step], "the configuration reference has no section for the %q step", step)
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
