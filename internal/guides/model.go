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

// The block model this package parses AsciiDoc into, and the JSON shape
// `GET /api/guides` serves. It is deliberately a *small, closed* vocabulary
// rather than an HTML tree:
//
//   - The pane renders it with the app's own components, so it inherits the
//     app's light/dark theme, type scale and focus rings for free. Importing
//     the docs site's rendered HTML (and therefore its CSS) would have meant
//     a foreign visual language inside a pane sitting next to the editor, and
//     a sanitiser to trust.
//   - A closed vocabulary degrades predictably. Anything the parser doesn't
//     recognise becomes a `paragraph` of its literal text, never a dropped
//     block and never raw markup rendered as if it were prose.
//   - Every field is data, not markup, so the whole model is trivially
//     assertable in tests -- see asciidoc_test.go.
//
// Keep this in sync with `web/src/lib/guides/types.ts`, which mirrors it;
// `TestModelMatchesFrontendTypes` is not possible across languages, so the
// contract is maintained by review plus the frontend's own parse tests
// against real fixtures generated from this package.

// BlockKind enumerates every block shape the renderer knows how to draw.
// A parser that cannot classify something falls back to KindParagraph with
// the source text intact, never to an unlisted kind.
type BlockKind string

const (
	// KindParagraph is running prose: Spans carries its inline formatting.
	KindParagraph BlockKind = "paragraph"

	// KindCode is a listing block (```----```-delimited). Text is the
	// verbatim source, never span-parsed -- a YAML sample must survive
	// byte-for-byte, since a user is expected to copy it into a config.
	KindCode BlockKind = "code"

	// KindTable is a `|===` table. Table carries the header and rows.
	KindTable BlockKind = "table"

	// KindAdmonition is a NOTE/TIP/IMPORTANT/WARNING/CAUTION, in either
	// AsciiDoc's inline (`NOTE: ...`) or block (`[NOTE]` + `====`) form.
	// Admonition names which one; Blocks carries its contents, so an
	// admonition containing a code sample keeps it as a code block rather
	// than flattening it into prose.
	KindAdmonition BlockKind = "admonition"

	// KindList is an ordered or unordered list. Items carries the entries.
	KindList BlockKind = "list"

	// KindHeading is a sub-heading *within* a section (AsciiDoc level 4 and
	// deeper, plus tab labels). Levels 2 and 3 become Sections in their own
	// right instead -- see Section.Level.
	KindHeading BlockKind = "heading"

	// KindNote is the parser's *own* voice, not the upstream document's:
	// used to say plainly that something in the source could not be
	// reproduced here (an unresolved `include::`, for instance) and to point
	// at the live page. It exists so a gap is always visible as a gap.
	KindNote BlockKind = "note"
)

// SpanKind enumerates the inline formatting the renderer knows how to draw.
type SpanKind string

const (
	// SpanText is unformatted text.
	SpanText SpanKind = "text"
	// SpanCode is inline monospace (AsciiDoc backticks).
	SpanCode SpanKind = "code"
	// SpanStrong is bold (`*...*`).
	SpanStrong SpanKind = "strong"
	// SpanEm is italic (`_..._`).
	SpanEm SpanKind = "em"
	// SpanLink is an outbound link; URL is absolute and always
	// `https://circleci.com/docs/...` or an external URL the source itself
	// spelled out in full. See resolveXref for how Antora resource IDs
	// become absolute URLs.
	SpanLink SpanKind = "link"
	// SpanRef is a *within-this-pane* cross-reference: Target is the anchor
	// of another Section in the same guide (AsciiDoc's `<<anchor,text>>`).
	// The renderer turns it into a button that navigates the pane, not a
	// link that leaves the app -- which is the whole point of having the
	// guides in here.
	SpanRef SpanKind = "ref"
)

// Span is one run of inline content.
type Span struct {
	Kind SpanKind `json:"kind"`
	Text string   `json:"text"`
	// URL is set only for SpanLink.
	URL string `json:"url,omitempty"`
	// Target is set only for SpanRef: the in-guide section anchor.
	Target string `json:"target,omitempty"`
	// Children is set for SpanStrong and SpanEm, which can nest (the config
	// reference's own headings are `*` + backticks, e.g. ``*`version`*``).
	Children []Span `json:"children,omitempty"`
}

// Cell is one table cell.
type Cell struct {
	Spans []Span `json:"spans"`
}

// Table is a parsed `|===` table.
type Table struct {
	// Header is the header row's cells, empty when the source table
	// declared no `options="header"`.
	Header []Cell   `json:"header,omitempty"`
	Rows   [][]Cell `json:"rows"`
}

// ListItem is one entry in a KindList block. Blocks (rather than plain
// spans) because AsciiDoc list items legitimately contain code samples and
// nested lists, and flattening those to text loses the sample.
type ListItem struct {
	Blocks []Block `json:"blocks"`
}

// Block is one renderable unit of a guide.
type Block struct {
	Kind BlockKind `json:"kind"`

	// Title is a block title (AsciiDoc's `.Some title` line), e.g. the
	// caption on a code sample. Empty when the source gave none.
	Title string `json:"title,omitempty"`

	// Spans is set for KindParagraph, KindHeading and KindNote.
	Spans []Span `json:"spans,omitempty"`

	// Text and Language are set for KindCode. Language is the source's own
	// declared language (`yaml`, `yml`, `shell`, ...) or "" when it declared
	// none; the renderer must not guess one.
	Text     string `json:"text,omitempty"`
	Language string `json:"language,omitempty"`

	// Table is set for KindTable.
	Table *Table `json:"table,omitempty"`

	// Admonition is set for KindAdmonition: "NOTE", "TIP", "IMPORTANT",
	// "WARNING" or "CAUTION", upper-cased.
	Admonition string `json:"admonition,omitempty"`

	// Blocks is set for KindAdmonition (its contents).
	Blocks []Block `json:"blocks,omitempty"`

	// Items is set for KindList.
	Items []ListItem `json:"items,omitempty"`
	// Ordered is set for KindList: true for a numbered list.
	Ordered bool `json:"ordered,omitempty"`

	// Level is set for KindHeading: the AsciiDoc level (4 or deeper).
	Level int `json:"level,omitempty"`

	// ID is set for KindHeading: the heading's anchor, so a cross-reference
	// to a level-4 heading resolves (the configuration reference has three
	// links to `<<expression-based-job-filters>>`, which is an `h4`). It is
	// recorded in Guide.Anchors, pointing at the enclosing section.
	ID string `json:"id,omitempty"`
}

// Section is one addressable part of a guide: an AsciiDoc level-2 (`==`) or
// level-3 (`===`) heading and everything under it up to the next heading of
// the same or shallower level.
//
// Levels 2 and 3 are both Sections -- rather than level 3 being folded into
// its parent as a heading block -- because level 3 is exactly where the
// configuration reference documents each *built-in step* (`=== *`save_cache`*`
// and friends). Those are the sections the schema-derived key browser links
// into, so they have to be individually addressable. Level 4 and deeper stay
// as KindHeading blocks inside their section; nothing in these three pages
// needs to be addressed that finely.
type Section struct {
	// ID is the section's anchor, unique within its guide.
	ID string `json:"id"`
	// Level is 2 or 3.
	Level int `json:"level"`
	// Title is the heading with all inline formatting stripped -- what a
	// nav list shows and what search matches against.
	Title string `json:"title"`
	// TitleSpans is the heading with its formatting intact, for rendering.
	TitleSpans []Span `json:"titleSpans"`
	// URL is the canonical live-docs URL for this section, including its
	// `#anchor` -- but *only* when the anchor came from the source's own
	// `[#id]` line. When the anchor had to be derived from the title
	// (AnchorDerived), URL is the page URL with no fragment, because a
	// fragment that doesn't exist on the live page scrolls nowhere while
	// still returning 200 -- the exact failure mode docsLinks.ts's doc
	// comment warns about.
	URL string `json:"url"`
	// AnchorDerived reports that ID was computed from Title rather than
	// read from an explicit `[#id]` line, so callers know not to trust it
	// as a live-page fragment. In-pane navigation uses it regardless; it is
	// unique within the guide either way.
	AnchorDerived bool `json:"anchorDerived,omitempty"`
	// Keys are the config keys this section documents, taken from the code
	// spans in its own heading -- `== *`version`*` yields ["version"], and
	// ``== Executor *`docker`* / *`machine`* / *`macos`*`` yields all three.
	// This is how the schema-derived key browser finds a key's prose without
	// anyone maintaining a hand-written key-to-anchor table.
	Keys []string `json:"keys,omitempty"`
	// Blocks is the section's own content, excluding its heading.
	Blocks []Block `json:"blocks"`
}

// Guide is one parsed documentation page.
type Guide struct {
	// ID is this project's stable identifier for the guide
	// ("configuration-reference", "workflows", "using-this-editor", ...) --
	// used in URLs, persisted UI state and tests, and deliberately *not*
	// derived from the upstream title, which upstream may reword.
	ID string `json:"id"`
	// Origin is "circleci" for a page vendored from circleci-docs and
	// "editor" for documentation this project wrote about this editor. The
	// pane must render the distinction visibly: presenting our own writing
	// as though CircleCI had published it would be dishonest, and the two
	// carry different licences. See internal/guides.Origin.
	Origin Origin `json:"origin"`
	// Category is the picker's grouping heading ("Workflows", "Orbs", "This
	// editor", ...). With twenty guides a flat list is a wall, and grouping
	// by the *editor feature* that raises the question beats grouping by
	// CircleCI's own information architecture, which a reader of this pane
	// has no reason to know.
	Category string `json:"category,omitempty"`
	// Title is the document title (the AsciiDoc `= ` line).
	Title string `json:"title"`
	// Description is the `:page-description:` attribute, when present.
	Description string `json:"description,omitempty"`
	// URL is the canonical live-docs URL for the whole page.
	URL string `json:"url"`
	// Sections is the flat, document-ordered section list; group by Level
	// for a nested nav.
	Sections []Section `json:"sections"`
	// Lead is the prose between the document title and the first section
	// heading. Small but load-bearing: on the dynamic-config guide it is
	// the paragraph that says what dynamic config *is*.
	Lead []Block `json:"lead,omitempty"`
	// Anchors maps every anchor defined anywhere in the page -- section
	// anchors *and* the `[#id]` anchors upstream attaches to ordinary blocks
	// -- to the ID of the Section containing it. It is how the renderer
	// resolves a SpanRef: the source cross-references block-level anchors
	// (`<<the-when-attribute>>`, `<<jobfilters>>`) freely, and without this
	// map those would be links to nothing. A target absent from this map is
	// unresolvable -- including because upstream's own xref is broken, which
	// the snapshot has three of -- and the renderer must show its label as
	// plain text rather than a dead control.
	Anchors map[string]string `json:"anchors,omitempty"`
	// Images is the lowercased basename of every image this page shows,
	// including images inside the partials it includes, sorted. The pane does
	// not render docs images at all (the snapshot vendors AsciiDoc, not binary
	// assets) -- this exists so a *citation* of an image asset can be turned
	// into a citation of the page that shows it, offline and deterministically
	// (issue #156; see NewCitationResolver). An image belonging to a page
	// outside the three vendored guides is not in here, and a citation of it is
	// dropped rather than guessed at.
	Images []string `json:"images,omitempty"`
}
