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
	"fmt"
	"regexp"
	"strings"
)

// Supported Xcode versions, derived from CircleCI's own supported-Xcode table
// rather than retyped from it (issue #211, closing issue #203).
//
// # Why this exists
//
// The macOS executor card carried a single hardcoded `defaultImage: '15.3.0'`,
// and the mutation layer carried the same literal as its fallback. `15.3.0` does
// not appear anywhere in CircleCI's supported-Xcode table -- not as a stale entry
// that used to be there and moved, but as a version this editor invented and
// then wrote into people's configs. Issue #203 found it; issue #211 asks for the
// list as well as the default, on two surfaces (the executor field and the YAML
// pane's completion).
//
// This is the same job resourceclasses.go does for the resource tables, and it
// is deliberately built the same way: read the *parsed block model* of the
// vendored snapshot, join to upstream's own section anchor, fall back to the
// extraction run against the embedded snapshot (never to a retyped literal), and
// pin the result with a test that fails when the table and the offered versions
// disagree.
//
// # What is derived and what is declared
//
// Everything comes from the table:
//
//   - the versions -- the `Config` column's code spans, which are exactly the
//     legal `xcode:` values (upstream's own column name for them is "Config",
//     because that is what you put in the config file);
//   - the human label -- the "Xcode Version" column ("Xcode 26.5 (17F42)");
//   - the tooltip summary -- the table's remaining non-link columns, by their own
//     headers, so a table that grows a column starts saying so with no change
//     here;
//   - which resource classes each version supports -- the code spans of the
//     "Supported Resource Classes" column;
//   - whether a version is a pre-release -- see prereleaseKind.
//
// Two things are declared here and cannot be derived: which guide carries the
// table, and the anchor it sits under. Same join key, and same reasoning, as
// resourceEnvironments: an explicit `[#id]` line upstream's own cross-references
// depend on, so when it does move, extraction fails loudly and the UI says the
// list is a fallback.
//
// # There is no second list
//
// Nothing in this repository writes down an Xcode version. The palette card's
// default is resolved from this table (DefaultXcodeVersion), the completion
// source is fed from it, and the executor field offers it -- so the three cannot
// disagree with each other, and none of them can disagree with CircleCI by more
// than one seven-day refresh.
//
// # Why this file was not retired for GET /api/v3/catalog/offerings (issue #305)
//
// That live endpoint's macOS entries (xcode:<version>) are a genuine
// superset of this table's version strings -- every version this file
// extracts appears in the live response too, verified by
// internal/offerings's TestOfferingsIsASupersetOfAsciiDocXcodeVersions
// against a captured snapshot. But it carries none of the metadata this file
// derives from the table: no prerelease/stability signal (a beta and a
// shipping release sit in the same flat list) and no canonical spelling
// (the same release appears as both "26.0" and "26.0.0"). DefaultXcodeVersion
// needs the former and this file's own Version field needs the latter, so
// this extraction stays the field's source of truth; the live catalog is
// used only for deprecated-image flagging on the machine-image picker
// (which does not touch macOS), not for the Xcode field.

// XcodeGuideID is the guide whose table this file reads.
//
// The macOS *resource* table is included in the configuration reference, but the
// supported-Xcode table is not: upstream includes
// `execution-resources/xcode-silicon-vm.adoc` from the macOS execution-environment
// page alone. So this reads a different guide from ResourceClassGuideID, which is
// why the anchor below is checked by its own test rather than assumed to travel
// with the resource-class anchors.
const XcodeGuideID = "using-macos"

// XcodeTableAnchor is upstream's own section anchor for the supported-Xcode
// table: `[#supported-xcode-versions-silicon]`, "Supported Xcode versions for
// Apple silicon".
//
// The silicon table is the whole of what CircleCI currently supports -- every row
// lists `m4pro.medium`/`m4pro.large` and there is no sibling Intel table in the
// vendored snapshot any more. If upstream reintroduces one, extraction here keeps
// working (this anchor still resolves) and the Intel versions are simply not
// offered until this file names that anchor too, which is the honest failure
// mode: fewer versions, never invented ones.
const XcodeTableAnchor = "supported-xcode-versions-silicon"

// xcodeConfigColumnHeader is the supported-Xcode table's first column. Upstream
// calls it "Config" because its cells are literally what goes in the config
// file. Requiring it -- together with xcodeVersionColumnHeader below -- is what
// keeps this from picking up the macOS *resource* table that sits three headings
// further down the same page.
const xcodeConfigColumnHeader = "config"

// xcodeVersionColumnHeader is the supported-Xcode table's human-readable version
// column ("Xcode 26.5 (17F42)").
const xcodeVersionColumnHeader = "xcode version"

// linkOnlyColumns are the supported-Xcode table's columns whose cells are
// nothing but an outbound link, left out of Spec: "VM Software Manifest" and
// "Release Notes" would each contribute the link's own text ("Installed
// software", "Release Notes") to a tooltip, which says nothing a reader wants in
// a dropdown. They are still read for prereleaseKind, which cares about where
// the link points rather than what it says.
//
// Matched by *shape* rather than by name -- a cell containing exactly one link
// span and no other text -- so a renamed or added link column needs no change
// here. See xcodeSpecSummary.
const xcodeReleaseNotesColumnHeader = "release notes"

// xcodeResourceClassColumnHeader is the column listing which resource classes
// each Xcode image runs on.
const xcodeResourceClassColumnHeader = "supported resource classes"

// prereleaseSlug matches the *numbered* pre-release markers CircleCI puts in its
// own changelog URLs: `xcode-27-0-beta-4-available`, `xcode-26-6-rc-2-available`.
//
// The number is what makes this safe. Upstream numbers the announcement of an
// image that is still in pre-release, and links a shipped version's row at the
// announcement that shipped it -- including, for Xcode 14.3.1, one titled
// `xcode-14-3-1-rc-released`. An unanchored `rc` would mark that long-stable
// version a release candidate, which is precisely the confident wrong answer this
// file exists to avoid; requiring `rc-2` rather than bare `rc` distinguishes "the
// pre-release announcement for an image still in pre-release" from "the
// announcement that a pre-release shipped".
var prereleaseSlug = regexp.MustCompile(`[-/](beta|rc)-?\d`)

// prereleaseWord matches a pre-release marker written in the table's own prose,
// which is where upstream would put it if it stopped encoding it in changelog
// slugs.
var prereleaseWord = regexp.MustCompile(`(?i)\b(beta|release candidate)\b`)

// XcodeVersion is one row of CircleCI's supported-Xcode table.
type XcodeVersion struct {
	// Version is the value to write as `xcode:`, verbatim from the Config
	// column. Quoted when written to YAML -- see the web side's
	// `setJobField(..., ['macos','xcode'], ...)` call, and note that `26.5`
	// unquoted is a YAML float, not the string CircleCI wants.
	Version string `json:"version"`
	// Label is the "Xcode Version" column, verbatim ("Xcode 26.5 (17F42)") --
	// CircleCI's wording for the same row, including Apple's build number.
	Label string `json:"label,omitempty"`
	// Spec is the table's own description of the image, assembled from its
	// remaining non-link columns ("Xcode Version Xcode 26.5 (17F42), macOS
	// Version 26.3.1"), for a tooltip. Empty when the table carried no such
	// columns.
	Spec string `json:"spec,omitempty"`
	// ResourceClasses are the classes the table says this version runs on, from
	// the "Supported Resource Classes" column's code spans. Informational: the
	// resource-class field is still driven by the resource tables
	// (resourceclasses.go), because those are the ones that carry specs and
	// defaults.
	ResourceClasses []string `json:"resourceClasses,omitempty"`
	// Prerelease reports that upstream's own row marks this version a beta or
	// release candidate -- see prereleaseKind. False is "the table does not say
	// so", not "this is stable"; nothing here asserts stability the table has not
	// claimed.
	Prerelease bool `json:"prerelease,omitempty"`
	// PrereleaseKind is "beta" or "release candidate" when Prerelease is true,
	// in upstream's own vocabulary, so a UI can say which rather than flattening
	// both into one warning.
	PrereleaseKind string `json:"prereleaseKind,omitempty"`
}

// XcodeVersionsResult is what a caller gets back: the versions to offer, and
// whether they came from the documentation the app is currently serving.
//
// Mirrors ResourceClassesResult exactly, including why: an empty dropdown is
// worse than a stale one, but a stale one presented as current is worse than
// either, so Derived is surfaced all the way to the field.
type XcodeVersionsResult struct {
	Versions []XcodeVersion `json:"versions"`
	Derived  bool           `json:"derived"`
	Reason   string         `json:"reason,omitempty"`
}

// XcodeVersions derives the supported Xcode versions from parsed guides, falling
// back to the copy embedded in this binary when the table cannot be read.
//
// Returns no error, for the same reason ResourceClasses does not: the caller is
// an HTTP handler serving a form control, and the honest degradation is a
// fallback plus a reason rather than a 500.
//
// The fallback is *the same extraction run against the embedded snapshot*, never
// a retyped literal -- the trap issue #202/#181 removed and the exact trap that
// produced `15.3.0`.
func XcodeVersions(parsed []Guide) XcodeVersionsResult {
	versions, err := ExtractXcodeVersions(parsed)
	if err == nil {
		return XcodeVersionsResult{Versions: versions, Derived: true}
	}
	reason := err.Error()

	embedded, embeddedErr := EmbeddedXcodeVersions()
	if embeddedErr != nil {
		return XcodeVersionsResult{
			Versions: []XcodeVersion{},
			Derived:  false,
			Reason:   reason + "; nor could the copy embedded in this release be read (" + embeddedErr.Error() + ")",
		}
	}
	return XcodeVersionsResult{
		Versions: embedded,
		Derived:  false,
		Reason:   reason + "; showing the list embedded in this release instead, which may be older than CircleCI's current table",
	}
}

// EmbeddedXcodeVersions extracts the supported Xcode versions from the snapshot
// embedded in this binary, ignoring any background refresh. It is the fallback
// path in XcodeVersions, and the input to the test that pins what this project
// claims to offer.
func EmbeddedXcodeVersions() ([]XcodeVersion, error) {
	parsed, err := ParseSnapshot()
	if err != nil {
		return nil, err
	}
	return ExtractXcodeVersions(parsed)
}

// ExtractXcodeVersions reads the supported-Xcode table out of the parsed macOS
// execution-environment guide, in upstream's own order (newest first).
//
// All-or-nothing, like ExtractResourceClasses: a partial list would offer some
// real versions and omit others with nothing in the UI able to say which, and
// "the version you need is missing" is indistinguishable from "the version you
// need does not exist".
func ExtractXcodeVersions(parsed []Guide) ([]XcodeVersion, error) {
	guide := findGuideByID(parsed, XcodeGuideID)
	if guide == nil {
		return nil, fmt.Errorf("guides: the %s guide is not available, so the supported Xcode versions could not be read from CircleCI's own table", XcodeGuideID)
	}

	found, ok := tablesByAnchor(*guide, isXcodeVersionTable)[XcodeTableAnchor]
	if !ok {
		return nil, fmt.Errorf("guides: the %s guide no longer has a supported-Xcode table under its %q section, so the supported Xcode versions could not be read from CircleCI's own table", XcodeGuideID, XcodeTableAnchor)
	}

	versions, err := xcodeVersionsFromTable(found.table)
	if err != nil {
		return nil, fmt.Errorf("guides: the supported-Xcode table under %q could not be read (%w), so the supported Xcode versions could not be read from CircleCI's own table", XcodeTableAnchor, err)
	}
	return versions, nil
}

// isXcodeVersionTable reports whether a parsed table is the supported-Xcode
// table: a header row whose first column is "Config" and which also carries an
// "Xcode Version" column.
//
// Both conditions are load-bearing. "Config" alone is not distinctive enough to
// be safe on a page that also includes the macOS resource table and, in
// principle, any future `Key | Required | Type` table; requiring the Xcode
// column as well means the only table this can match is the one that enumerates
// Xcode versions.
//
// A check against the *parsed model*, not a pattern match against AsciiDoc
// source: the table is wrapped in a `[.table-scroll]` open block, uses `a|`
// AsciiDoc cells for its resource-class column and `link:` macros in two others,
// none of which this has to know about because the parser already has.
func isXcodeVersionTable(table *Table) bool {
	if table == nil || len(table.Header) == 0 || len(table.Rows) == 0 {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(plainText(table.Header[0].Spans)), xcodeConfigColumnHeader) {
		return false
	}
	for _, cell := range table.Header[1:] {
		if strings.EqualFold(strings.TrimSpace(plainText(cell.Spans)), xcodeVersionColumnHeader) {
			return true
		}
	}
	return false
}

// xcodeVersionsFromTable reads the supported-Xcode table's rows.
//
// The version is the first *code* span in the row's Config cell, which is how
// every row writes it (`| `+"`26.4.1`"+`) -- and taking the code span rather
// than the cell's text is what keeps a future `(deprecated)` annotation from
// becoming part of the version string.
func xcodeVersionsFromTable(table *Table) ([]XcodeVersion, error) {
	out := make([]XcodeVersion, 0, len(table.Rows))
	for _, row := range table.Rows {
		if len(row) == 0 {
			continue
		}
		version := firstCodeSpanText(row[0].Spans)
		if version == "" {
			return nil, fmt.Errorf("a row's Config cell has no code span (%q)", strings.TrimSpace(plainText(row[0].Spans)))
		}
		kind := prereleaseKind(table.Header, row)
		out = append(out, XcodeVersion{
			Version:         version,
			Label:           columnText(table.Header, row, xcodeVersionColumnHeader),
			Spec:            xcodeSpecSummary(table.Header, row),
			ResourceClasses: columnCodeSpans(table.Header, row, xcodeResourceClassColumnHeader),
			Prerelease:      kind != "",
			PrereleaseKind:  kind,
		})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("the table has no rows with a version")
	}
	return out, nil
}

// DefaultXcodeVersion is the version to preselect for a new macOS job: the
// newest one upstream's table does *not* mark a pre-release, falling back to the
// newest row when every row is marked and to "" when there are no rows.
//
// Derived rather than declared, and that is the point of issue #203. There is no
// product reason to prefer one Xcode over another the way there is to prefer
// Docker's `medium` over the `small` that heads its table, so unlike
// `defaultResourceClass` this carries no literal preference at all -- there is
// nothing here to go stale.
//
// Skipping pre-releases matters more than it looks: the table is newest-first and
// its top rows are routinely a beta and a release candidate (`27.0` beta 4 and
// `26.6` rc 2 as vendored), and upstream's own beta-image section says those
// images are "not frozen" and can change under a job "with minimal notice". A
// new job should not silently start on one. Choosing a beta remains possible --
// it is in the list, labelled -- it just is not the default.
func DefaultXcodeVersion(versions []XcodeVersion) string {
	for _, version := range versions {
		if !version.Prerelease {
			return version.Version
		}
	}
	if len(versions) > 0 {
		return versions[0].Version
	}
	return ""
}

// prereleaseKind reports whether upstream's own row marks this version a
// pre-release, and in which word.
//
// Two sources, both the table's own content, in this order:
//
//  1. Any cell's prose saying "beta" or "release candidate". This is what a
//     table that annotated its rows directly would look like, and it is checked
//     first so that an explicit annotation always wins.
//  2. The Release Notes column's *link target*. CircleCI encodes the release
//     stage in its own changelog slugs (`xcode-27-0-beta-4-available`,
//     `xcode-26-6-rc-2-available`) and, as vendored, that is the only place the
//     table states it.
//
// Reading a link's URL is still reading the table -- the href is the cell's
// content, not an outside fact -- but it is a weaker signal than prose, so it is
// second and it fails *closed*: a slug convention change yields no marker at
// all, which under-claims (a beta offered unlabelled) rather than mislabelling a
// stable release. That is the right direction for a fallback, and
// TestXcodeVersionsFromVendoredSnapshot pins the current answer so a convention
// change shows up as a failing test rather than as silence.
func prereleaseKind(header []Cell, row []Cell) string {
	for i, cell := range row {
		if i < len(header) && strings.EqualFold(strings.TrimSpace(plainText(header[i].Spans)), xcodeReleaseNotesColumnHeader) {
			continue
		}
		if match := prereleaseWord.FindString(plainText(cell.Spans)); match != "" {
			return normalisePrereleaseKind(match)
		}
	}
	for i, cell := range row {
		if i >= len(header) || !strings.EqualFold(strings.TrimSpace(plainText(header[i].Spans)), xcodeReleaseNotesColumnHeader) {
			continue
		}
		for _, url := range linkURLs(cell.Spans) {
			if match := prereleaseSlug.FindStringSubmatch(url); match != nil {
				return normalisePrereleaseKind(match[1])
			}
		}
	}
	return ""
}

// normalisePrereleaseKind maps the markers found in prose or in a changelog slug
// onto the two words a UI shows.
func normalisePrereleaseKind(match string) string {
	if strings.EqualFold(match, "rc") || strings.EqualFold(match, "release candidate") {
		return "release candidate"
	}
	return "beta"
}

// specSkippedColumns are the columns xcodeSpecSummary leaves out because the
// XcodeVersion struct already carries them in a more useful shape: the Xcode
// Version column is Label, and the resource-class column is ResourceClasses
// (a list, not a string with an AsciiDoc hard break in it). Everything else the
// table carries is summarised generically, so a table that grows a column starts
// saying so with no change here.
var specSkippedColumns = map[string]bool{
	xcodeVersionColumnHeader:       true,
	xcodeResourceClassColumnHeader: true,
}

// xcodeSpecSummary assembles a row's description from the table's own remaining
// columns, skipping the Config column itself, the columns specSkippedColumns
// names, and any cell that is nothing but a link (see
// xcodeReleaseNotesColumnHeader -- "Installed software" as a tooltip line would
// be noise).
func xcodeSpecSummary(header []Cell, row []Cell) string {
	parts := make([]string, 0, len(row))
	for i, cell := range row {
		if i == 0 || i >= len(header) {
			continue
		}
		if isLinkOnlyCell(cell) {
			continue
		}
		name := strings.TrimSpace(plainText(header[i].Spans))
		if specSkippedColumns[strings.ToLower(name)] {
			continue
		}
		value := collapseWhitespace(plainText(cell.Spans))
		if name == "" || value == "" {
			continue
		}
		parts = append(parts, name+" "+value)
	}
	return strings.Join(parts, ", ")
}

// columnText returns a row's cell under the header named `wanted`, as plain
// text, or "" when the table has no such column.
func columnText(header []Cell, row []Cell, wanted string) string {
	for i, cell := range header {
		if !strings.EqualFold(strings.TrimSpace(plainText(cell.Spans)), wanted) {
			continue
		}
		if i >= len(row) {
			return ""
		}
		return strings.TrimSpace(collapseWhitespace(plainText(row[i].Spans)))
	}
	return ""
}

// columnCodeSpans returns every inline-code span in the row's cell under the
// header named `wanted` -- how a cell listing several values (`m4pro.medium` +
// `m4pro.large`, written as an AsciiDoc `a|` cell with a hard line break) is read
// as several values rather than as one string with a newline in it. Delegates to
// codeSpanTexts, the same span walk Section.Keys is built from.
func columnCodeSpans(header []Cell, row []Cell, wanted string) []string {
	for i, cell := range header {
		if !strings.EqualFold(strings.TrimSpace(plainText(cell.Spans)), wanted) {
			continue
		}
		if i >= len(row) {
			return nil
		}
		return codeSpanTexts(row[i].Spans)
	}
	return nil
}

// linkURLs collects every link span's target, in order, searching nested
// children.
func linkURLs(spans []Span) []string {
	var out []string
	for _, span := range spans {
		if span.Kind == SpanLink && span.URL != "" {
			out = append(out, span.URL)
		}
		out = append(out, linkURLs(span.Children)...)
	}
	return out
}

// isLinkOnlyCell reports whether a cell contains a link and no other text -- the
// shape of the supported-Xcode table's manifest and release-notes columns.
// Matched by shape rather than by header name so a renamed or added link column
// needs no change here.
func isLinkOnlyCell(cell Cell) bool {
	if len(linkURLs(cell.Spans)) == 0 {
		return false
	}
	for _, span := range cell.Spans {
		if span.Kind != SpanLink && strings.TrimSpace(span.Text) != "" {
			return false
		}
	}
	return true
}

// collapseWhitespace flattens a cell's plain text onto one line for a tooltip,
// dropping the standalone `+` tokens that are AsciiDoc's hard line break rather
// than content. An `a|` cell written as "`m4pro.medium` + / `m4pro.large`" would
// otherwise read as "m4pro.medium + m4pro.large", which looks like a claim about
// using both at once.
func collapseWhitespace(s string) string {
	fields := strings.Fields(s)
	kept := make([]string, 0, len(fields))
	for _, field := range fields {
		if field == "+" {
			continue
		}
		kept = append(kept, field)
	}
	return strings.Join(kept, " ")
}
