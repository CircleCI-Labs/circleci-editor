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

// testCtx is the Antora context the configuration reference is parsed under,
// so cross-reference resolution in these tests matches production.
var testCtx = spanContext{component: "reference", module: "ROOT", pageName: "configuration-reference"}

func TestParseSpansMonospaceAndFormatting(t *testing.T) {
	t.Parallel()

	// The configuration reference writes every key it documents as a
	// backticked run inside a bold run; getting this exact combination wrong
	// would break Section.Keys, which the schema-derived key browser depends
	// on to find a key's prose.
	spans := parseSpans("*`save_cache`*", testCtx)
	assert.Assert(t, is.Len(spans, 1))
	assert.Equal(t, spans[0].Kind, SpanStrong)
	assert.Assert(t, is.Len(spans[0].Children, 1))
	assert.Equal(t, spans[0].Children[0].Kind, SpanCode)
	assert.Equal(t, spans[0].Children[0].Text, "save_cache")
	assert.DeepEqual(t, codeSpanTexts(spans), []string{"save_cache"})
}

func TestParseSpansConstrainedMarkersDoNotRunAway(t *testing.T) {
	t.Parallel()

	// AsciiDoc's constrained-formatting boundary rules are the only thing
	// stopping a glob or a snake_case identifier in prose from swallowing the
	// rest of the sentence as bold/italic.
	for _, input := range []string{
		"Use *.txt to match text files",
		"The key save_cache_thing is not italic",
		"A lone * asterisk",
	} {
		t.Run(input, func(t *testing.T) {
			t.Parallel()
			spans := parseSpans(input, testCtx)
			assert.Equal(t, plainText(spans), input)
			for _, span := range spans {
				assert.Assert(t, span.Kind != SpanStrong, "unexpected bold run in %q", input)
				assert.Assert(t, span.Kind != SpanEm, "unexpected italic run in %q", input)
			}
		})
	}
}

func TestParseSpansCrossReferences(t *testing.T) {
	t.Parallel()

	t.Run("another page becomes an absolute docs URL", func(t *testing.T) {
		t.Parallel()
		spans := parseSpans("See xref:reusing-config.adoc#the-executors-key[the executors key].", testCtx)
		link := findSpan(spans, SpanLink)
		assert.Assert(t, link != nil)
		assert.Equal(t, link.URL, "https://circleci.com/docs/reference/reusing-config/#the-executors-key")
		assert.Equal(t, link.Text, "the executors key")
	})

	t.Run("another component resolves through its module", func(t *testing.T) {
		t.Parallel()
		spans := parseSpans("xref:guides:orchestrate:dynamic-config.adoc#[Dynamic Configuration]", testCtx)
		link := findSpan(spans, SpanLink)
		assert.Assert(t, link != nil)
		assert.Equal(t, link.URL, "https://circleci.com/docs/guides/orchestrate/dynamic-config/")
	})

	t.Run("this same page stays inside the pane", func(t *testing.T) {
		t.Parallel()
		// The whole point of rendering the guides in-app: a self-reference must
		// navigate the pane, not open a browser.
		spans := parseSpans("See the <<executors>> section below.", testCtx)
		ref := findSpan(spans, SpanRef)
		assert.Assert(t, ref != nil)
		assert.Equal(t, ref.Target, "executors")
		assert.Assert(t, is.Nil(findSpan(spans, SpanLink)))
	})

	t.Run("the #-prefixed same-page form resolves the same as the bare one", func(t *testing.T) {
		t.Parallel()
		// Asciidoctor treats `<<#id>>` as identical to `<<id>>` -- a
		// same-document xref, not one qualified by a document ID -- and the
		// config-policies page (issue #247) is the first vendored page to
		// write it. Without stripping the `#`, this would never match a key
		// in anchorSections (which is populated from `[#id]`, without the
		// `#`), and the reference would silently fail to resolve.
		spans := parseSpans("See the <<#executors>> section below.", testCtx)
		ref := findSpan(spans, SpanRef)
		assert.Assert(t, ref != nil)
		assert.Equal(t, ref.Target, "executors")
		assert.Assert(t, is.Nil(findSpan(spans, SpanLink)))
	})

	t.Run("an unresolvable target degrades to plain text, never a dead link", func(t *testing.T) {
		t.Parallel()
		spans := parseSpans("xref:partial$notes/thing.adoc[some note]", testCtx)
		assert.Assert(t, is.Nil(findSpan(spans, SpanLink)))
		assert.Equal(t, plainText(spans), "some note")
	})
}

func TestParseSpansDropsDocsSiteOnlyMarkup(t *testing.T) {
	t.Parallel()

	// `[.circle-green]#Yes#` appears 93 times in the vendored resource tables
	// and exists purely to colour a word on the docs site. The word must
	// survive; the class name must not.
	spans := parseSpans("[.circle-green]#Yes#", testCtx)
	assert.Equal(t, plainText(spans), "Yes")

	// An unknown attribute reference is dropped rather than shown: a literal
	// `{some-attr}` in the pane reads as a bug in this app.
	assert.Equal(t, plainText(parseSpans("a {no-such-attribute} b", testCtx)), "a  b")

	// A passthrough-wrapped literal keeps its contents and loses its markers.
	assert.Equal(t, plainText(parseSpans("`++{{ checksum \"x\" }}++`", testCtx)), `{{ checksum "x" }}`)
}

func TestParseGuideSectionsAndKeys(t *testing.T) {
	t.Parallel()

	source := `= Configuration reference
:page-description: Reference for .circleci/config.yml

Intro prose.

[#version]
== *` + "`version`" + `*

The version field.

[#executor-job]
== Executor *` + "`docker`" + `* / *` + "`machine`" + `*

Pick one.

[#docker]
=== *` + "`docker`" + `*

Docker details.
`

	guide := parseGuide("configuration-reference", "reference", "ROOT", "configuration-reference", "", []byte(source), nil)

	assert.Equal(t, guide.Title, "Configuration reference")
	assert.Equal(t, guide.Description, "Reference for .circleci/config.yml")
	assert.Equal(t, guide.URL, "https://circleci.com/docs/reference/configuration-reference/")
	assert.Assert(t, is.Len(guide.Lead, 1))
	assert.Equal(t, plainText(guide.Lead[0].Spans), "Intro prose.")

	assert.Assert(t, is.Len(guide.Sections, 3))
	assert.Equal(t, guide.Sections[0].ID, "version")
	assert.Equal(t, guide.Sections[0].Level, 2)
	assert.Equal(t, guide.Sections[0].URL, "https://circleci.com/docs/reference/configuration-reference/#version")
	assert.DeepEqual(t, guide.Sections[0].Keys, []string{"version"})

	// A heading naming several keys is discoverable by all of them -- this is
	// how `machine` finds prose despite sharing a heading with `docker`.
	assert.DeepEqual(t, guide.Sections[1].Keys, []string{"docker", "machine"})

	assert.Equal(t, guide.Sections[2].ID, "docker")
	assert.Equal(t, guide.Sections[2].Level, 3)
}

func TestParseGuideDerivedAnchorsAreNotUsedAsLivePageFragments(t *testing.T) {
	t.Parallel()

	// A heading with no `[#id]` still needs an addressable ID for in-pane
	// navigation, but must not claim a live-page fragment: a wrong fragment
	// still returns 200 and scrolls nowhere, which is exactly the failure
	// docsLinks.ts's doc comment warns about.
	guide := parseGuide("g", "reference", "ROOT", "reusing-config", "", []byte("= T\n\n== Some Heading\n\nProse.\n"), nil)
	assert.Assert(t, is.Len(guide.Sections, 1))
	assert.Equal(t, guide.Sections[0].ID, "some-heading")
	assert.Equal(t, guide.Sections[0].AnchorDerived, true)
	assert.Equal(t, guide.Sections[0].URL, "https://circleci.com/docs/reference/reusing-config/")
	assert.Assert(t, !strings.Contains(guide.Sections[0].URL, "#"))
}

func TestParseGuideDuplicateAnchorsStayUniquePerGuide(t *testing.T) {
	t.Parallel()

	// Upstream reuses `[#steps]` and `[#the-when-step]` on two blocks each.
	// Section IDs address sections within the pane, so they must be unique
	// even when upstream's are not -- while the *URL* keeps the anchor
	// upstream actually wrote.
	source := "= T\n\n[#steps]\n== One\n\na\n\n[#steps]\n== Two\n\nb\n"
	guide := parseGuide("g", "reference", "ROOT", "configuration-reference", "", []byte(source), nil)
	assert.Assert(t, is.Len(guide.Sections, 2))
	assert.Equal(t, guide.Sections[0].ID, "steps")
	assert.Equal(t, guide.Sections[1].ID, "steps-2")
	assert.Equal(t, guide.Sections[1].URL, "https://circleci.com/docs/reference/configuration-reference/#steps")
}

func TestParseCodeBlocksAreVerbatim(t *testing.T) {
	t.Parallel()

	// Users copy these samples into a config, so indentation, blank lines and
	// every `*`/`_`/backtick inside must survive untouched.
	sample := "version: 2.1\n\njobs:\n  build:\n    steps:\n      - run: echo '*not bold*'\n"
	source := "= T\n\n== S\n\n.Sample\n[source,yaml]\n----\n" + sample + "----\n"

	guide := parseGuide("g", "reference", "ROOT", "configuration-reference", "", []byte(source), nil)
	blocks := guide.Sections[0].Blocks
	assert.Assert(t, is.Len(blocks, 1))
	assert.Equal(t, blocks[0].Kind, KindCode)
	assert.Equal(t, blocks[0].Language, "yaml")
	assert.Equal(t, blocks[0].Title, "Sample")
	assert.Equal(t, blocks[0].Text, strings.TrimRight(sample, "\n"))
}

func TestListingLanguageSpellings(t *testing.T) {
	t.Parallel()

	// All four spellings occur in the snapshot; `yml` and `yaml` must collapse
	// to one name so the renderer needs one branch, not two.
	for attrs, want := range map[string]string{
		",yaml":          "yaml",
		",yml":           "yaml",
		"source,yaml":    "yaml",
		"%linenums,yaml": "yaml",
		"source":         "",
		"":               "",
		`source,shell`:   "shell",
		`.role,console`:  "shell",
		`cols="1,1"`:     "",
	} {
		assert.Equal(t, listingLanguage(attrs), want, "attrs=%q", attrs)
	}
}

func TestParseTableWithHeaderAndColumns(t *testing.T) {
	t.Parallel()

	source := `= T

== S

[cols="1,1,1,2", options="header"]
|===
| Key | Required | Type | Description

| ` + "`version`" + `
| Y
| String
| ` + "`2.1`" + `
|===
`
	guide := parseGuide("g", "reference", "ROOT", "configuration-reference", "", []byte(source), nil)
	blocks := guide.Sections[0].Blocks
	assert.Assert(t, is.Len(blocks, 1))
	assert.Equal(t, blocks[0].Kind, KindTable)
	table := blocks[0].Table
	assert.Assert(t, table != nil)
	assert.Assert(t, is.Len(table.Header, 4))
	assert.Equal(t, plainText(table.Header[0].Spans), "Key")
	assert.Assert(t, is.Len(table.Rows, 1))
	assert.Assert(t, is.Len(table.Rows[0], 4))
	assert.Equal(t, plainText(table.Rows[0][0].Spans), "version")
	assert.Equal(t, plainText(table.Rows[0][3].Spans), "2.1")
}

// TestParseTableCellSpecifiers is issue #211's root cause as a parser test. A
// line beginning with a cell specifier (`a|`, `d|`, `2+|`) used to fail the
// "starts with |" test and be treated as a continuation of the previous cell, so
// its content was appended to that cell and every later cell in the table shifted
// one column left. Upstream writes several vendored tables that way -- the
// supported-Xcode table's resource-class column among them -- so this was not a
// hypothetical.
func TestParseTableCellSpecifiers(t *testing.T) {
	t.Parallel()

	source := `= T

== S

[cols="1,1,1", options="header"]
|===
| Config
| Classes
| Notes

| ` + "`26.5`" + `
a| ` + "`m4pro.medium`" + ` +
   ` + "`m4pro.large`" + `
| Fine
|===
`
	guide := parseGuide("g", "guides", "execution-managed", "using-macos", "", []byte(source), nil)
	table := guide.Sections[0].Blocks[0].Table
	assert.Assert(t, table != nil)
	assert.Assert(t, is.Len(table.Header, 3))
	assert.Assert(t, is.Len(table.Rows, 1))
	// The row keeps its three columns, in order -- the `a|` cell is its own cell
	// and the specifier itself is dropped rather than becoming content.
	assert.Equal(t, plainText(table.Rows[0][0].Spans), "26.5")
	assert.DeepEqual(t, codeSpanTexts(table.Rows[0][1].Spans), []string{"m4pro.medium", "m4pro.large"})
	assert.Equal(t, plainText(table.Rows[0][2].Spans), "Fine")
}

// TestParseTableSpecifiersDoNotEatContent is the other half of the specifier fix:
// a specifier is only recognised where AsciiDoc recognises one, at the start of a
// cell. `s`, `a`, `e`, `d`, `h`, `l` and `m` are all valid style specifiers, so a
// naive trailing-character strip would turn "Yes" into "Ye" and "2xlarge+" into
// "2xlarg" across every resource table in the snapshot.
func TestParseTableSpecifiersDoNotEatContent(t *testing.T) {
	t.Parallel()

	source := `= T

== S

[cols="1,1,1", options="header"]
|===
| Class | Cloud | Server

| ` + "`2xlarge+`" + ` | Yes | No
|===
`
	guide := parseGuide("g", "reference", "ROOT", "configuration-reference", "", []byte(source), nil)
	table := guide.Sections[0].Blocks[0].Table
	assert.Assert(t, table != nil)
	assert.Assert(t, is.Len(table.Rows, 1))
	assert.Equal(t, plainText(table.Rows[0][0].Spans), "2xlarge+")
	assert.Equal(t, plainText(table.Rows[0][1].Spans), "Yes")
	assert.Equal(t, plainText(table.Rows[0][2].Spans), "No")
}

// TestTrimTrailingCellSpec pins the boundary rule directly, since it is the part
// of the fix with the most ways to be subtly wrong.
func TestTrimTrailingCellSpec(t *testing.T) {
	t.Parallel()

	for input, want := range map[string]string{
		// Real specifiers: start of the part, or after whitespace.
		"a":              "",
		"Some text a":    "Some text",
		"Some text 2+":   "Some text",
		"Some text .2+":  "Some text",
		"Some text ^.^a": "Some text",
		// Not specifiers: no whitespace boundary.
		"Yes":       "Yes",
		"2xlarge+":  "2xlarge+",
		"medium+":   "medium+",
		"":          "",
		"6 @ 4.51":  "6 @ 4.51",
		"Some text": "Some text",
	} {
		assert.Equal(t, trimTrailingCellSpec(input), want, "input=%q", input)
	}
}

func TestParseAdmonitions(t *testing.T) {
	t.Parallel()

	source := "= T\n\n== S\n\nNOTE: Only in 2.1.\n\n[CAUTION]\n====\nBe careful.\n\n[source,yaml]\n----\nkey: value\n----\n====\n"
	guide := parseGuide("g", "reference", "ROOT", "configuration-reference", "", []byte(source), nil)
	blocks := guide.Sections[0].Blocks
	assert.Assert(t, is.Len(blocks, 2))

	assert.Equal(t, blocks[0].Kind, KindAdmonition)
	assert.Equal(t, blocks[0].Admonition, "NOTE")
	assert.Equal(t, plainText(blocks[0].Blocks[0].Spans), "Only in 2.1.")

	// A block admonition keeps its contents as blocks, so a code sample inside
	// a warning is still a code sample.
	assert.Equal(t, blocks[1].Kind, KindAdmonition)
	assert.Equal(t, blocks[1].Admonition, "CAUTION")
	assert.Assert(t, is.Len(blocks[1].Blocks, 2))
	assert.Equal(t, blocks[1].Blocks[1].Kind, KindCode)
	assert.Equal(t, blocks[1].Blocks[1].Text, "key: value")
}

func TestParseDescriptionList(t *testing.T) {
	t.Parallel()

	// `run`'s `when` values and the cache-key templating examples are written
	// as description lists; unhandled, they render a literal `` `on_fail`:: ``.
	source := "= T\n\n== S\n\n`on_success`:: Runs if everything passed.\n`on_fail`:: Runs if something failed.\n"
	guide := parseGuide("g", "reference", "ROOT", "configuration-reference", "", []byte(source), nil)
	blocks := guide.Sections[0].Blocks
	assert.Assert(t, is.Len(blocks, 1))
	assert.Equal(t, blocks[0].Kind, KindList)
	assert.Assert(t, is.Len(blocks[0].Items, 2))
	assert.Equal(t, plainText(blocks[0].Items[0].Blocks[0].Spans), "on_success")
	assert.Equal(t, plainText(blocks[0].Items[0].Blocks[1].Spans), "Runs if everything passed.")
}

func TestParseIncludeResolvedAndUnresolved(t *testing.T) {
	t.Parallel()

	t.Run("resolved includes are spliced in", func(t *testing.T) {
		t.Parallel()
		resolve := func(p string) ([]byte, error) {
			assert.Equal(t, p, "docs/guides/modules/ROOT/partials/notes/docker-auth.adoc")
			return []byte("Shared note text.\n"), nil
		}
		source := "= T\n\n== S\n\ninclude::guides:ROOT:partial$notes/docker-auth.adoc[]\n"
		guide := parseGuide("g", "reference", "ROOT", "configuration-reference", "", []byte(source), resolve)
		blocks := guide.Sections[0].Blocks
		assert.Assert(t, is.Len(blocks, 1))
		assert.Equal(t, plainText(blocks[0].Spans), "Shared note text.")
	})

	t.Run("an unresolvable include says so and links out", func(t *testing.T) {
		t.Parallel()
		// Never a silent hole: the reader has to be able to tell that there is
		// more on the live page.
		source := "= T\n\n== S\n\ninclude::guides:ROOT:partial$notes/gone.adoc[]\n"
		guide := parseGuide("g", "reference", "ROOT", "configuration-reference", "", []byte(source), nil)
		blocks := guide.Sections[0].Blocks
		assert.Assert(t, is.Len(blocks, 1))
		assert.Equal(t, blocks[0].Kind, KindNote)
		text := plainText(blocks[0].Spans)
		assert.Assert(t, is.Contains(text, "not included in the offline snapshot"))
		link := findSpan(blocks[0].Spans, SpanLink)
		assert.Assert(t, link != nil)
		assert.Equal(t, link.URL, "https://circleci.com/docs/reference/configuration-reference/")
	})
}

func TestParseGuideNeverPanicsOnMalformedSource(t *testing.T) {
	t.Parallel()

	// The parser's first promise (see asciidoc.go) is that it always produces
	// a document. These are all shapes that could plausibly appear if upstream
	// mid-edits a page or introduces syntax this parser has never seen.
	for name, source := range map[string]string{
		"empty":                   "",
		"only a title":            "= T\n",
		"unterminated listing":    "= T\n\n== S\n\n[source,yaml]\n----\nkey: value\n",
		"unterminated table":      "= T\n\n== S\n\n|===\n| a | b\n",
		"unterminated admonition": "= T\n\n== S\n\n[NOTE]\n====\nhanging\n",
		"heading with no title":   "= T\n\n==\n\nbody\n",
		"attribute line only":     "= T\n\n== S\n\n[unknown-style]\n",
		"nul bytes":               "= T\n\n== S\n\n\x00\x00\n",
		"deep nesting":            "= T\n\n== S\n\n" + strings.Repeat("* item\n** sub\n", 50),
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			guide := parseGuide("g", "reference", "ROOT", "configuration-reference", "", []byte(source), nil)
			// Nothing is asserted about the *content* here on purpose: the
			// contract is only that parsing terminates and yields a usable
			// value, never that malformed input round-trips.
			assert.Equal(t, guide.ID, "g")
			assert.Assert(t, guide.Sections != nil)
		})
	}
}

func TestParseResourceIDForms(t *testing.T) {
	t.Parallel()

	ctx := spanContext{component: "guides", module: "orchestrate", pageName: "dynamic-config"}
	for _, tc := range []struct {
		id   string
		path string
	}{
		{"ROOT:partial$faq/x.adoc", "docs/guides/modules/ROOT/partials/faq/x.adoc"},
		{"guides:ROOT:partial$execution-resources/y.adoc", "docs/guides/modules/ROOT/partials/execution-resources/y.adoc"},
		{"guides:ROOT:example$orchestration-examples/z.yml", "docs/guides/modules/ROOT/examples/orchestration-examples/z.yml"},
		{"partial$notes/w.adoc", "docs/guides/modules/orchestrate/partials/notes/w.adoc"},
		{"reusing-config.adoc", "docs/guides/modules/orchestrate/pages/reusing-config.adoc"},
	} {
		t.Run(tc.id, func(t *testing.T) {
			t.Parallel()
			parsed, err := parseResourceID(tc.id, ctx)
			assert.NilError(t, err)
			assert.Equal(t, parsed.repoPath(), tc.path)
		})
	}

	_, err := parseResourceID("a:b:c:d$e.adoc", ctx)
	assert.Assert(t, err != nil)
	_, err = parseResourceID("bogus$e.adoc", ctx)
	assert.Assert(t, err != nil)
}

// findSpan returns the first span of kind anywhere in spans (including inside
// children), or nil.
func findSpan(spans []Span, kind SpanKind) *Span {
	for i := range spans {
		if spans[i].Kind == kind {
			return &spans[i]
		}
		if found := findSpan(spans[i].Children, kind); found != nil {
			return found
		}
	}
	return nil
}
