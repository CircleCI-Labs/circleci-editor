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
	"path"
	"regexp"
	"sort"
	"strings"
)

// This file parses AsciiDoc *block* structure into []Section / []Block.
//
// It is a pragmatic, line-oriented parser for the subset of AsciiDoc that the
// three vendored CircleCI pages actually use, not a general AsciiDoc
// implementation -- parsing the source is preferred to scraping the rendered
// HTML because scraping breaks on every site redesign and would drag the
// docs site's own markup and styling into a pane that should inherit this
// app's theme instead (issue #104). The parser's contract, which its tests pin:
//
//  1. It never fails. Every input produces a document; anything unrecognised
//     survives as literal paragraph text. A guide with one confusing block is
//     far better than an error pane.
//  2. Code samples are byte-exact. A `----` listing is copied verbatim, never
//     span-parsed, re-indented or trimmed internally, because users copy them.
//  3. Gaps are visible. An `include::` that cannot be resolved becomes a
//     KindNote block saying so, with the live page's URL -- never a silent
//     hole.

// admonitionNames are AsciiDoc's five built-in admonition labels.
var admonitionNames = map[string]bool{
	"NOTE": true, "TIP": true, "IMPORTANT": true, "WARNING": true, "CAUTION": true,
}

// includeResolver returns the contents of an Antora resource, given its
// repository path (see resourceID.repoPath). A resolver that does not have the
// resource returns an error, and the parser emits a KindNote in its place.
type includeResolver func(repoPath string) ([]byte, error)

// parser holds one page's parse state.
type parser struct {
	lines []string
	pos   int

	ctx     spanContext
	pageURL string
	resolve includeResolver
	// includeDepth guards against a cycle in the source's own `include::`
	// graph; the snapshot has none today, but a parser that can be made to
	// recurse forever by a data change upstream is not one to ship.
	includeDepth int

	// pendingAttrs is the most recent `[...]` block-attribute line, consumed
	// by whatever block follows it.
	pendingAttrs string
	// pendingAnchor is the most recent `[#id]` line seen since the last block
	// was consumed, tracked separately from pendingAttrs because upstream
	// legitimately stacks more than one `[...]` line before a single heading
	// (`[#linuxvm-gen3-execution-environment]` then `[badge="Beta"]` before
	// `==== Gen3`, verified live on circleci-docs 2026-08-07). pendingAttrs is
	// right to let the later line win -- it is a fresh attribute list each
	// time -- but an anchor from an earlier line in the same stack must
	// survive to the heading, or an explicit id silently becomes a
	// slugified-title guess and every anchor-based lookup for that heading
	// (tablesByAnchor, Guide.Anchors) misses it.
	pendingAnchor string
	// pendingTitle is the most recent `.Title` block-title line.
	pendingTitle string

	// anchors tracks the section IDs already used in this page so a derived
	// anchor can be de-duplicated (the config reference has three separate
	// `<job_name>` headings).
	anchors map[string]bool

	// anchorSections maps every anchor seen anywhere in the page to the ID of
	// the section it falls inside; see Guide.Anchors.
	anchorSections map[string]string

	// images collects the basename of every image this page includes, from
	// its own `image::` macros and from those inside any partial it includes
	// (the map is shared with sub-parsers, exactly as anchors is). See
	// Guide.Images for what it is for: turning a citation of an image asset
	// into a citation of the page that shows it (issue #156).
	images map[string]bool
	// currentSection is the ID of the section whose blocks are being parsed,
	// used to attribute block-level anchors to it.
	currentSection string
}

const maxIncludeDepth = 4

// parseGuide parses one page's AsciiDoc source into a Guide.
//
// id is this project's own stable guide identifier; component/module/pageName
// are the page's Antora coordinates (used for cross-reference resolution);
// resolve supplies `include::` targets and may be nil, in which case every
// include becomes a KindNote.
//
// urlOverride replaces the derived circleci.com URL, and is set only for this
// project's own editor documentation (OriginEditor): those pages are not
// published on circleci.com, so deriving a URL for them would fabricate one
// that 404s. When it is empty the URL comes from the Antora coordinates, which
// is every vendored page.
func parseGuide(id, component, module, pageName, urlOverride string, source []byte, resolve includeResolver) Guide {
	ctx := spanContext{component: component, module: module, pageName: pageName}
	pageURL := urlOverride
	if pageURL == "" {
		pageURL = resourceID{component: component, module: module, family: "page", relpath: pageName + ".adoc"}.pageURL()
	}

	p := &parser{
		lines:          splitLines(string(source)),
		ctx:            ctx,
		pageURL:        pageURL,
		resolve:        resolve,
		anchors:        map[string]bool{},
		anchorSections: map[string]string{},
		images:         map[string]bool{},
	}

	guide := Guide{ID: id, URL: pageURL, Sections: []Section{}}
	guide.Title, guide.Description = p.parseDocumentHeader()

	// Everything up to the first `==`/`===` heading is the lead.
	guide.Lead = p.parseBlocksUntilHeading()

	for p.pos < len(p.lines) {
		section, ok := p.parseSection()
		if !ok {
			break
		}
		guide.Sections = append(guide.Sections, section)
	}
	guide.Anchors = p.anchorSections
	guide.Images = sortedKeys(p.images)
	return guide
}

// sortedKeys returns a map's keys in a stable order, so a parse of the same
// bytes always produces the same Guide (the payload is compared byte-for-byte
// by the disk cache, and a wandering order would defeat that).
func sortedKeys(set map[string]bool) []string {
	if len(set) == 0 {
		return nil
	}
	out := make([]string, 0, len(set))
	for key := range set {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

// splitLines splits on \n and strips a trailing \r, so a CRLF checkout of the
// snapshot parses identically to an LF one. It deliberately keeps a trailing
// empty line's absence/presence irrelevant.
func splitLines(s string) []string {
	raw := strings.Split(s, "\n")
	for i, line := range raw {
		raw[i] = strings.TrimSuffix(line, "\r")
	}
	return raw
}

// parseDocumentHeader consumes the `= Title` line and the attribute lines
// (`:name: value`) that follow it, returning the title and the
// `:page-description:` value.
func (p *parser) parseDocumentHeader() (title, description string) {
	for p.pos < len(p.lines) {
		line := p.lines[p.pos]
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == "":
			p.pos++
			if title != "" {
				// A blank line after the title ends the header.
				return title, description
			}
		case strings.HasPrefix(trimmed, "= "):
			title = plainText(parseSpans(strings.TrimSpace(trimmed[2:]), p.ctx))
			p.pos++
		case strings.HasPrefix(trimmed, ":"):
			name, value, ok := parseAttributeLine(trimmed)
			if ok && name == "page-description" {
				description = value
			}
			p.pos++
		default:
			return title, description
		}
	}
	return title, description
}

// parseAttributeLine parses `:name: value` (or `:name:`), the AsciiDoc
// document-attribute form.
func parseAttributeLine(line string) (name, value string, ok bool) {
	if !strings.HasPrefix(line, ":") {
		return "", "", false
	}
	rest := line[1:]
	end := strings.IndexByte(rest, ':')
	if end < 0 {
		return "", "", false
	}
	return rest[:end], strings.TrimSpace(rest[end+1:]), true
}

// headingLevel returns the AsciiDoc level of a `=`-prefixed heading line
// (`==` is 2), and the heading text. ok is false for any other line.
func headingLevel(line string) (level int, text string, ok bool) {
	trimmed := strings.TrimSpace(line)
	equals := 0
	for equals < len(trimmed) && trimmed[equals] == '=' {
		equals++
	}
	if equals < 2 || equals >= len(trimmed) || trimmed[equals] != ' ' {
		return 0, "", false
	}
	return equals, strings.TrimSpace(trimmed[equals+1:]), true
}

// parseSection parses one level-2 or level-3 section: its heading (plus the
// `[#anchor]` line preceding it, if any) and every block up to the next
// heading of level <= 3.
func (p *parser) parseSection() (Section, bool) {
	// Skip forward to a heading, remembering any `[#anchor]` attribute line
	// we pass on the way (it belongs to the heading that follows it).
	anchor := ""
	for p.pos < len(p.lines) {
		line := strings.TrimSpace(p.lines[p.pos])
		if id, ok := anchorAttr(line); ok {
			anchor = id
			p.pos++
			continue
		}
		if level, text, ok := headingLevel(line); ok && level <= 3 {
			p.pos++
			return p.finishSection(level, text, anchor), true
		}
		if line == "" {
			p.pos++
			continue
		}
		// Stray content before any heading (only possible if parseGuide's
		// lead parse stopped early); skip it rather than loop forever.
		p.pos++
	}
	return Section{}, false
}

func (p *parser) finishSection(level int, headingText, explicitAnchor string) Section {
	titleSpans := parseSpans(headingText, p.ctx)
	title := plainText(titleSpans)

	// Section.ID has to be unique within the guide, because the pane
	// addresses sections by it. Upstream does not guarantee that: the
	// configuration reference reuses `[#steps]` and `[#the-when-step]` on two
	// blocks each. So the *ID* is uniquified, while the *URL*'s fragment
	// keeps the anchor the source actually wrote -- the live page has the
	// same duplicate and resolves it to the first occurrence, so pointing
	// both at that is the closest honest answer available.
	derived := explicitAnchor == ""
	id := explicitAnchor
	if derived {
		id = slugify(title)
	}
	id = p.uniqueAnchor(id)

	url := p.pageURL
	if !derived {
		url = p.pageURL + "#" + explicitAnchor
		p.noteAnchor(explicitAnchor, id)
	}
	p.noteAnchor(id, id)

	previous := p.currentSection
	p.currentSection = id
	blocks := p.parseBlocksUntilHeading()
	p.currentSection = previous

	return Section{
		ID:            id,
		Level:         level,
		Title:         title,
		TitleSpans:    titleSpans,
		URL:           url,
		AnchorDerived: derived,
		Keys:          codeSpanTexts(titleSpans),
		Blocks:        blocks,
	}
}

// noteAnchor records that anchor is reachable by navigating to sectionID.
// First writer wins, matching how a browser resolves a duplicated `id`.
func (p *parser) noteAnchor(anchor, sectionID string) {
	if anchor == "" || sectionID == "" {
		return
	}
	if _, exists := p.anchorSections[anchor]; !exists {
		p.anchorSections[anchor] = sectionID
	}
}

// slugify computes a stable anchor from a heading's plain text, for the
// handful of headings whose source carries no explicit `[#id]`. It is *not* an
// attempt to reproduce Asciidoctor's own auto-id algorithm exactly --
// Section.AnchorDerived exists precisely because a derived anchor must not be
// trusted as a live-page fragment; this only has to be stable so in-pane
// navigation and deep-linking within the app work.
func slugify(title string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(title) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_':
			b.WriteRune(r)
			prevDash = false
		default:
			if !prevDash && b.Len() > 0 {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	base := strings.Trim(b.String(), "-")
	if base == "" {
		return "section"
	}
	return base
}

// uniqueAnchor returns base, or base with a numeric suffix if base is already
// taken within this page, and records the result as taken.
func (p *parser) uniqueAnchor(base string) string {
	candidate := base
	for n := 2; p.anchors[candidate]; n++ {
		candidate = fmt.Sprintf("%s-%d", base, n)
	}
	p.anchors[candidate] = true
	return candidate
}

// anchorAttr recognises an `[#id]` block-anchor line.
func anchorAttr(line string) (string, bool) {
	if !strings.HasPrefix(line, "[#") || !strings.HasSuffix(line, "]") {
		return "", false
	}
	id := line[2 : len(line)-1]
	if id == "" || strings.ContainsAny(id, " \t,") {
		return "", false
	}
	return id, true
}

// parseBlocksUntilHeading parses blocks until the next level-2/3 heading (or
// the `[#anchor]` line that introduces one), leaving p.pos on that line.
func (p *parser) parseBlocksUntilHeading() []Block {
	return p.parseBlocks(func() bool {
		line := strings.TrimSpace(p.lines[p.pos])
		if level, _, ok := headingLevel(line); ok && level <= 3 {
			return true
		}
		if _, ok := anchorAttr(line); ok {
			// Only a section boundary if a level<=3 heading follows it;
			// otherwise it is just an anchor on an ordinary block.
			return p.nextNonBlankIsSectionHeading(p.pos + 1)
		}
		return false
	})
}

func (p *parser) nextNonBlankIsSectionHeading(from int) bool {
	for i := from; i < len(p.lines); i++ {
		line := strings.TrimSpace(p.lines[i])
		if line == "" {
			continue
		}
		if _, ok := anchorAttr(line); ok {
			continue
		}
		level, _, ok := headingLevel(line)
		return ok && level <= 3
	}
	return false
}

// parseBlocks is the main block loop. stop is consulted at the start of every
// iteration; a nil stop runs to the end of the input.
//
// Every arm already delegates to a named helper; splitting the dispatch itself
// would only scatter the block-type precedence that is the point of reading it
// in one place.
//
//nolint:gocyclo // See the note above: one dispatch, not tangled logic.
func (p *parser) parseBlocks(stop func() bool) []Block {
	blocks := []Block{}
	for p.pos < len(p.lines) {
		if stop != nil && stop() {
			return blocks
		}
		raw := p.lines[p.pos]
		line := strings.TrimSpace(raw)

		switch {
		case line == "":
			p.pos++

		case line == "'''" || line == "---" || strings.HasPrefix(line, "toc::"):
			// A thematic break / TOC macro carries no content the pane needs.
			p.pos++

		case line == "////":
			p.skipDelimited("////")

		case strings.HasPrefix(line, "//"):
			// AsciiDoc line comment.
			p.pos++

		case strings.HasPrefix(line, "include::"):
			blocks = append(blocks, p.parseInclude(line)...)

		case strings.HasPrefix(line, "image::"):
			// A block image. The pane has never rendered docs images (the
			// snapshot vendors AsciiDoc, not binary assets), and until now
			// the line fell through to parseParagraph and showed up as
			// literal `image::guides:ROOT:x.png[...]` text in the reader.
			// Recording the filename and dropping the line is strictly
			// better on both counts: no macro noise in the prose, and an
			// offline image-to-page index for citations (issue #156).
			p.noteImage(line)
			p.clearPending()
			p.pos++

		case strings.HasPrefix(line, ":"):
			// A mid-document attribute assignment; nothing to render.
			if _, _, ok := parseAttributeLine(line); ok {
				p.pos++
			} else {
				blocks = append(blocks, p.parseParagraph())
			}

		case isBlockAttrLine(line):
			// A `[#id]` here anchors an ordinary block rather than a section
			// (parseBlocksUntilHeading already peeled off the ones that
			// introduce a section). Upstream cross-references those freely,
			// so record them as reachable via the enclosing section -- the
			// pane cannot scroll to a mid-section anchor, but taking the
			// reader to the right section is a great deal better than a link
			// that does nothing.
			if anchor, ok := anchorAttr(line); ok {
				p.noteAnchor(anchor, p.currentSection)
				p.pendingAnchor = anchor
			}
			p.pendingAttrs = line[1 : len(line)-1]
			p.pos++

		case isBlockTitleLine(raw):
			p.pendingTitle = strings.TrimSpace(raw[1:])
			p.pos++

		case line == "----" || line == "...." || strings.HasPrefix(line, "-----"):
			blocks = append(blocks, p.parseListing(line))

		case fencedLanguage(line) != nil:
			blocks = append(blocks, p.parseFencedListing())

		case line == "|===" || line == ",===" || line == "!===":
			blocks = append(blocks, p.parseTable(line))

		case line == "====":
			blocks = append(blocks, p.parseExampleBlock()...)

		case line == "--":
			blocks = append(blocks, p.parseOpenBlock()...)

		case line == "****" || line == "____":
			// Sidebar / quote: transparent for this pane's purposes.
			blocks = append(blocks, p.parseDelimitedTransparent(line)...)

		case isHeadingLine(line):
			// Levels 2 and 3 are sections, and parseBlocksUntilHeading's own
			// stop function keeps them from reaching here while walking a
			// page. They *do* reach here inside an included partial, whose
			// headings must stay heading blocks: the section the reader is
			// looking at already owns their position in the page, so
			// promoting a partial's headings to sections would reorder the
			// nav relative to the live site.
			level, text, _ := headingLevel(line)
			explicit, hasExplicit := p.pendingAnchor, p.pendingAnchor != ""
			p.pos++
			spans := parseSpans(text, p.ctx)
			id := explicit
			if !hasExplicit {
				id = slugify(plainText(spans))
			}
			p.noteAnchor(id, p.currentSection)
			blocks = append(blocks, Block{
				Kind:  KindHeading,
				Level: level,
				ID:    id,
				Spans: spans,
			})
			p.clearPending()

		case admonitionPrefix(line) != "":
			blocks = append(blocks, p.parseInlineAdmonition())

		case listMarker(line) != nil:
			blocks = append(blocks, p.parseList())

		case descriptionTerm(line) != "":
			blocks = append(blocks, p.parseDescriptionList())

		default:
			blocks = append(blocks, p.parseParagraph())
		}
	}
	return blocks
}

// noteImage records the basename of the image an `image::target[attrs]` macro
// references, so NewCitationResolver can answer "which page shows
// workspace.png?" offline.
//
// Only the basename is kept, deliberately. The macro's target is an Antora
// resource ID whose coordinates are relative to the *including* file
// (`guides:ROOT:dynamic-config-enable.png`), while a citation naming the same
// image arrives as something else entirely -- a published `/docs/.../_images/
// dynamic-config-enable.png` URL, or a raw.githubusercontent.com path into the
// docs repository. The filename is the one part both forms share, and docs
// image filenames are descriptive enough (`workspace.png`,
// `dynamic-config-enable.png`) that collisions across pages are a
// theoretical worry rather than a practical one -- and a collision would
// merely pick one of two pages that both show the image, which is still
// strictly better than citing the asset.
func (p *parser) noteImage(line string) {
	target := strings.TrimPrefix(line, "image::")
	if bracket := strings.IndexByte(target, '['); bracket >= 0 {
		target = target[:bracket]
	}
	target = strings.TrimSpace(target)
	if target == "" {
		return
	}
	// An `image::https://example.com/x.png[]` macro points outside the docs
	// site, so it says nothing about which docs page shows what.
	if strings.Contains(target, "://") {
		return
	}
	// Antora coordinates (`component:module:relpath`) precede the path; the
	// filename is what is wanted, so take the last path element of the last
	// coordinate segment.
	if colon := strings.LastIndexByte(target, ':'); colon >= 0 {
		target = target[colon+1:]
	}
	base := strings.ToLower(path.Base(target))
	if base == "" || base == "." || base == "/" {
		return
	}
	p.images[base] = true
}

// isHeadingLine reports whether line is any `=`-prefixed heading.
func isHeadingLine(line string) bool {
	_, _, ok := headingLevel(line)
	return ok
}

func (p *parser) clearPending() {
	p.pendingAttrs = ""
	p.pendingAnchor = ""
	p.pendingTitle = ""
}

// takePending returns and clears the pending block attributes and title.
func (p *parser) takePending() (attrs, title string) {
	attrs, title = p.pendingAttrs, p.pendingTitle
	p.clearPending()
	return attrs, title
}

// isBlockAttrLine recognises a `[...]` block-attribute line. `[#anchor]` is
// handled separately (it introduces a section), and a `[[...]]` block ID is
// treated the same way as any other attribute line: consumed, not rendered.
func isBlockAttrLine(line string) bool {
	return strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") && len(line) > 2
}

// isBlockTitleLine recognises AsciiDoc's `.Some title` block-title line,
// which must start at column 0 and be followed by a non-space (so a sentence
// beginning with an ellipsis, or a `. ` list item, is not mistaken for one).
func isBlockTitleLine(raw string) bool {
	if len(raw) < 2 || raw[0] != '.' {
		return false
	}
	if raw[1] == '.' || raw[1] == ' ' || raw[1] == '\t' {
		return false
	}
	return true
}

// parseListing consumes a `----` (or `....`) delimited literal block. The
// content is preserved byte-for-byte between the delimiters: leading
// whitespace, blank lines and all. Its language comes only from the source's
// own attribute line -- `[,yaml]`, `[source,yaml]`, `[%linenums,yaml]` -- and
// is left empty when the source declared none rather than guessed at.
func (p *parser) parseListing(delimiter string) Block {
	attrs, title := p.takePending()
	p.pos++ // opening delimiter

	var content []string
	for p.pos < len(p.lines) {
		if strings.TrimSpace(p.lines[p.pos]) == delimiter {
			p.pos++
			break
		}
		content = append(content, p.lines[p.pos])
		p.pos++
	}

	return Block{
		Kind:     KindCode,
		Title:    title,
		Language: listingLanguage(attrs),
		Text:     strings.Join(content, "\n"),
	}
}

// fencedLanguage recognises a Markdown-style code fence -- three or more
// backticks, optionally followed by a bare language word -- and returns that
// language (possibly ""), or nil when the line is not a fence.
//
// Asciidoctor accepts these for Markdown compatibility, and CircleCI's docs use
// them: `orchestrate/pages/pipeline-variables.adoc` writes every one of its YAML
// samples as a ```` ```yaml ```` fence rather than an AsciiDoc `----` listing.
// Before this existed those samples fell through to parseParagraph, with two
// visible consequences on the very page the owner asked for by name (#176):
//
//   - The YAML was rendered as running prose, so `image: cimg/node:17.0` arrived
//     as a sentence rather than as something a reader could copy.
//   - Worse, its `<< pipeline.project.git_url >>` interpolations were
//     span-parsed, and AsciiDoc's cross-reference syntax is *also* `<<...>>` --
//     so twelve config expressions became twelve cross-references to anchors
//     that do not exist. TestSnapshotCrossReferencesAllResolve caught it.
//
// A nil return (rather than an empty string) is what lets the caller distinguish
// "no language" from "not a fence" without a second predicate.
func fencedLanguage(line string) *string {
	if !strings.HasPrefix(line, "```") {
		return nil
	}
	rest := strings.TrimLeft(line, "`")
	// An info string is a single bare word (`yaml`, `shell`). Anything with
	// whitespace or punctuation in it is not something this parser should treat
	// as a language, and a *closing* fence has nothing after the backticks.
	if strings.ContainsAny(rest, " \t`") {
		return nil
	}
	lang := normalizeLanguage(strings.TrimSpace(rest))
	return &lang
}

// parseFencedListing parses a Markdown-style fenced code block. The closing
// fence is any line of backticks; end-of-input closes it too, because an
// unterminated fence upstream must not swallow the parser rather than the
// remainder of one page.
func (p *parser) parseFencedListing() Block {
	_, title := p.takePending()
	lang := fencedLanguage(strings.TrimSpace(p.lines[p.pos]))
	p.pos++ // opening fence

	var content []string
	for p.pos < len(p.lines) {
		trimmed := strings.TrimSpace(p.lines[p.pos])
		if strings.HasPrefix(trimmed, "```") && strings.Trim(trimmed, "`") == "" {
			p.pos++
			break
		}
		content = append(content, p.lines[p.pos])
		p.pos++
	}

	return Block{
		Kind:     KindCode,
		Title:    title,
		Language: *lang,
		Text:     strings.Join(content, "\n"),
	}
}

// listingLanguage extracts the source language from a listing block's
// attribute list. AsciiDoc's shorthand puts the style first and the language
// second (`source,yaml`), and CircleCI's docs also use the empty-style form
// (`,yaml`) and a `%linenums` option (`%linenums,yaml`).
func listingLanguage(attrs string) string {
	if attrs == "" {
		return ""
	}
	parts := splitAttrs(attrs)
	for i, part := range parts {
		part = strings.TrimSpace(part)
		if i == 0 {
			// The style slot: `source`, `%linenums`, `.role` or empty.
			if part == "" || part == "source" || strings.HasPrefix(part, "%") || strings.HasPrefix(part, ".") {
				continue
			}
			// A single bare word in the style slot (`[yaml]`) is a language.
			if len(parts) == 1 && !strings.Contains(part, "=") {
				return normalizeLanguage(part)
			}
			continue
		}
		if part == "" || strings.Contains(part, "=") || strings.HasPrefix(part, "%") {
			continue
		}
		return normalizeLanguage(part)
	}
	return ""
}

// normalizeLanguage collapses the source's spellings onto one name per
// language, so the renderer needs one branch per language rather than one per
// spelling. `yml` and `yaml` both appear in the snapshot, ~40/~100 times.
func normalizeLanguage(lang string) string {
	switch strings.ToLower(lang) {
	case "yml", "yaml":
		return "yaml"
	case "sh", "shell", "bash", "console":
		return "shell"
	case "js", "javascript":
		return "javascript"
	default:
		return strings.ToLower(lang)
	}
}

// skipDelimited consumes a delimited block whose contents are of no interest
// (an AsciiDoc block comment).
func (p *parser) skipDelimited(delimiter string) {
	p.pos++
	for p.pos < len(p.lines) {
		if strings.TrimSpace(p.lines[p.pos]) == delimiter {
			p.pos++
			return
		}
		p.pos++
	}
}

// parseDelimitedTransparent parses a delimited block's contents as ordinary
// blocks, discarding the wrapper. Used for constructs (`--` open blocks,
// sidebars, non-admonition example blocks) whose only role in these pages is
// grouping -- `[.table-scroll]` + `--` around a table, for instance, which is
// a docs-site layout concern with no meaning in this pane.
func (p *parser) parseDelimitedTransparent(delimiter string) []Block {
	p.clearPending()
	p.pos++ // opening delimiter
	blocks := p.parseBlocks(func() bool {
		return strings.TrimSpace(p.lines[p.pos]) == delimiter
	})
	if p.pos < len(p.lines) {
		p.pos++ // closing delimiter
	}
	return blocks
}

// parseOpenBlock parses a `--` open block.
func (p *parser) parseOpenBlock() []Block {
	return p.parseDelimitedTransparent("--")
}

// parseExampleBlock parses a `====` block. When its attribute line names an
// admonition (`[NOTE]`), the block becomes a KindAdmonition wrapping its
// parsed contents -- so a NOTE containing a YAML sample keeps the sample as
// a code block. `[tabs]` and anything else is transparent.
func (p *parser) parseExampleBlock() []Block {
	attrs, title := p.takePending()
	style := strings.TrimSpace(strings.Split(attrs, ",")[0])
	name := strings.ToUpper(style)

	p.pos++ // opening delimiter
	inner := p.parseBlocks(func() bool {
		return strings.TrimSpace(p.lines[p.pos]) == "===="
	})
	if p.pos < len(p.lines) {
		p.pos++ // closing delimiter
	}

	if admonitionNames[name] {
		return []Block{{Kind: KindAdmonition, Admonition: name, Title: title, Blocks: inner}}
	}
	return inner
}

// parseInlineAdmonition parses AsciiDoc's one-paragraph admonition form,
// `NOTE: text` (continuing across following non-blank lines).
func (p *parser) parseInlineAdmonition() Block {
	_, title := p.takePending()
	line := strings.TrimSpace(p.lines[p.pos])
	name := admonitionPrefix(line)
	rest := strings.TrimSpace(line[len(name)+1:])
	p.pos++

	text := p.joinParagraphLines(rest)
	return Block{
		Kind:       KindAdmonition,
		Admonition: name,
		Title:      title,
		Blocks:     []Block{{Kind: KindParagraph, Spans: parseSpans(text, p.ctx)}},
	}
}

// admonitionPrefix returns the admonition name a line opens with (`"NOTE"`
// for `NOTE: ...`), or "" if it opens with none.
func admonitionPrefix(line string) string {
	colon := strings.IndexByte(line, ':')
	if colon <= 0 || colon+1 >= len(line) || line[colon+1] != ' ' {
		return ""
	}
	name := line[:colon]
	if admonitionNames[name] {
		return name
	}
	return ""
}

// joinParagraphLines consumes the continuation lines of a paragraph (every
// following line until a blank line or a line that starts a different block)
// and joins them with spaces, which is how AsciiDoc treats a wrapped
// paragraph.
func (p *parser) joinParagraphLines(first string) string {
	parts := []string{}
	if first != "" {
		parts = append(parts, first)
	}
	for p.pos < len(p.lines) {
		line := strings.TrimSpace(p.lines[p.pos])
		if line == "" || p.startsNewBlock(line) {
			break
		}
		if line == "+" {
			// A list continuation marker; not paragraph text.
			break
		}
		parts = append(parts, line)
		p.pos++
	}
	return strings.Join(parts, " ")
}

// startsNewBlock reports whether line begins a block rather than continuing
// the current paragraph. Kept deliberately conservative: a false negative
// merely glues one line onto a paragraph, whereas a false positive would
// fragment prose into one-line paragraphs.
func (p *parser) startsNewBlock(line string) bool {
	if _, _, ok := headingLevel(line); ok {
		return true
	}
	if _, ok := anchorAttr(line); ok {
		return true
	}
	switch {
	case line == "----" || line == "...." || line == "|===" || line == "====" || line == "--" ||
		line == "'''" || line == "****" || line == "____":
		return true
	case fencedLanguage(line) != nil:
		// A Markdown code fence ends the paragraph above it, exactly as `----`
		// does. Without this, a page that writes `Usage example:` immediately
		// above a fence would glue the fence line onto that sentence.
		return true
	case strings.HasPrefix(line, "include::"):
		return true
	case strings.HasPrefix(line, "image::"):
		return true
	case strings.HasPrefix(line, "//"):
		return true
	case isBlockAttrLine(line):
		return true
	case listMarker(line) != nil:
		return true
	case admonitionPrefix(line) != "":
		return true
	case descriptionTerm(line) != "":
		return true
	}
	return false
}

// parseParagraph consumes one paragraph: the current line plus every
// following line up to a blank line or the start of another block.
func (p *parser) parseParagraph() Block {
	_, title := p.takePending()
	first := strings.TrimSpace(p.lines[p.pos])
	p.pos++
	text := p.joinParagraphLines(first)
	return Block{Kind: KindParagraph, Title: title, Spans: parseSpans(text, p.ctx)}
}

// marker describes a list item's marker.
type marker struct {
	ordered bool
	depth   int
	text    string
}

// listMarker recognises an unordered (`*`, `-`) or ordered (`.`) list item
// and returns its nesting depth and text, or nil for a non-list line.
func listMarker(line string) *marker {
	if line == "" {
		return nil
	}
	switch line[0] {
	case '*':
		depth := 0
		for depth < len(line) && line[depth] == '*' {
			depth++
		}
		if depth < len(line) && line[depth] == ' ' {
			return &marker{depth: depth, text: strings.TrimSpace(line[depth:])}
		}
	case '.':
		depth := 0
		for depth < len(line) && line[depth] == '.' {
			depth++
		}
		if depth < len(line) && line[depth] == ' ' {
			return &marker{ordered: true, depth: depth, text: strings.TrimSpace(line[depth:])}
		}
	case '-':
		if len(line) > 1 && line[1] == ' ' {
			return &marker{depth: 1, text: strings.TrimSpace(line[2:])}
		}
	}
	return nil
}

// parseList parses a list at one nesting depth. Deeper items become a nested
// KindList block inside the item they belong to; a `+` continuation line lets
// an item carry a code sample, which the reusable-config guide relies on.
func (p *parser) parseList() Block {
	_, title := p.takePending()
	first := listMarker(strings.TrimSpace(p.lines[p.pos]))
	depth, ordered := first.depth, first.ordered

	block := Block{Kind: KindList, Title: title, Ordered: ordered, Items: []ListItem{}}

	for p.pos < len(p.lines) {
		line := strings.TrimSpace(p.lines[p.pos])
		if line == "" {
			// A blank line ends the list unless the next non-blank line is
			// another item at this depth (AsciiDoc allows loose lists).
			if !p.nextItemContinuesList(p.pos+1, depth) {
				break
			}
			p.pos++
			continue
		}
		m := listMarker(line)
		if m == nil {
			break
		}
		if m.depth < depth || (m.depth == depth && m.ordered != ordered) {
			break
		}
		if m.depth > depth {
			nested := p.parseList()
			if len(block.Items) == 0 {
				block.Items = append(block.Items, ListItem{Blocks: []Block{}})
			}
			last := len(block.Items) - 1
			block.Items[last].Blocks = append(block.Items[last].Blocks, nested)
			continue
		}

		p.pos++
		lead := Block{Kind: KindParagraph, Spans: parseSpans(p.joinParagraphLines(m.text), p.ctx)}
		attached := p.parseItemContinuations()
		itemBlocks := make([]Block, 0, 1+len(attached))
		itemBlocks = append(itemBlocks, lead)
		itemBlocks = append(itemBlocks, attached...)
		block.Items = append(block.Items, ListItem{Blocks: itemBlocks})
	}
	return block
}

// nextItemContinuesList looks past blank lines for another item at depth.
func (p *parser) nextItemContinuesList(from, depth int) bool {
	for i := from; i < len(p.lines); i++ {
		line := strings.TrimSpace(p.lines[i])
		if line == "" {
			continue
		}
		m := listMarker(line)
		return m != nil && m.depth >= depth
	}
	return false
}

// parseItemContinuations consumes any `+`-attached blocks belonging to the
// list item just parsed.
func (p *parser) parseItemContinuations() []Block {
	var out []Block
	for p.pos < len(p.lines) && strings.TrimSpace(p.lines[p.pos]) == "+" {
		p.pos++
		// Skip blank lines between the marker and its block.
		for p.pos < len(p.lines) && strings.TrimSpace(p.lines[p.pos]) == "" {
			p.pos++
		}
		if p.pos >= len(p.lines) {
			break
		}
		attached := p.parseBlocks(func() bool {
			line := strings.TrimSpace(p.lines[p.pos])
			return line == "" || line == "+" || listMarker(line) != nil || p.startsNewBlock(line)
		})
		out = append(out, attached...)
		if len(attached) == 0 {
			break
		}
	}
	return out
}

// descriptionTerm recognises AsciiDoc's description-list form,
// `term:: definition`, and returns the term (or "" for a non-matching line).
//
// The configuration reference uses it for the values of `run`'s `when` key
// (`on_success:: ...`) and for the cache-key templating examples, so leaving
// it unhandled would render a literal "`on_success`::" to the reader. The
// match is deliberately tight -- the term must be non-empty, must not itself
// contain `::`, and the `::` must be followed by a space -- so that a `::` in
// prose or a macro (all of which are dispatched before this case) is not
// mistaken for one.
func descriptionTerm(line string) string {
	idx := strings.Index(line, ":: ")
	if idx <= 0 {
		return ""
	}
	term := line[:idx]
	if strings.Contains(term, "::") || strings.HasSuffix(term, ":") {
		return ""
	}
	return term
}

// parseDescriptionList parses a run of `term:: definition` lines into a
// KindList whose items each hold the term (bold) and its definition. Using the
// existing list block rather than adding a description-list kind keeps the
// renderer's vocabulary closed (see model.go) at no cost to how it reads.
func (p *parser) parseDescriptionList() Block {
	_, title := p.takePending()
	block := Block{Kind: KindList, Title: title, Items: []ListItem{}}

	for p.pos < len(p.lines) {
		line := strings.TrimSpace(p.lines[p.pos])
		term := descriptionTerm(line)
		if term == "" {
			break
		}
		definition := strings.TrimSpace(line[len(term)+2:])
		p.pos++
		definition = p.joinParagraphLines(definition)

		termSpans := parseSpans(term, p.ctx)
		block.Items = append(block.Items, ListItem{Blocks: []Block{
			{Kind: KindParagraph, Spans: []Span{{Kind: SpanStrong, Children: termSpans}}},
			{Kind: KindParagraph, Spans: parseSpans(definition, p.ctx)},
		}})

		// Blank lines between terms are allowed; anything else ends the list.
		for p.pos < len(p.lines) && strings.TrimSpace(p.lines[p.pos]) == "" {
			if descriptionTerm(strings.TrimSpace(p.nextNonBlank())) == "" {
				return block
			}
			p.pos++
		}
	}
	return block
}

// nextNonBlank returns the next non-blank line without consuming anything.
func (p *parser) nextNonBlank() string {
	for i := p.pos; i < len(p.lines); i++ {
		if strings.TrimSpace(p.lines[i]) != "" {
			return p.lines[i]
		}
	}
	return ""
}

// parseTable parses a `|===` table. Cells begin with `|` and may be written
// several to a line or spread across lines; the column count is taken from
// the header row when there is one, and otherwise from the first row's line
// (which is how AsciiDoc itself decides).
func (p *parser) parseTable(delimiter string) Block {
	attrs, title := p.takePending()
	hasHeader := strings.Contains(attrs, `options="header"`) || strings.Contains(attrs, "options=header") ||
		strings.Contains(attrs, "%header")
	columns := colsCount(attrs)

	p.pos++ // opening delimiter

	var cells []Cell
	firstRowLineCells := 0
	sawFirstRow := false
	for p.pos < len(p.lines) {
		raw := p.lines[p.pos]
		line := strings.TrimSpace(raw)
		if line == delimiter {
			p.pos++
			break
		}
		p.pos++
		if line == "" {
			continue
		}
		lineCells := p.splitTableRow(line)
		if len(lineCells) == 0 {
			// A continuation of the previous cell's text.
			if len(cells) > 0 {
				last := len(cells) - 1
				cells[last].Spans = append(cells[last].Spans, Span{Kind: SpanText, Text: " "})
				cells[last].Spans = append(cells[last].Spans, parseSpans(line, p.ctx)...)
			}
			continue
		}
		if !sawFirstRow {
			firstRowLineCells = len(lineCells)
			sawFirstRow = true
		}
		cells = append(cells, lineCells...)
	}

	if columns <= 0 {
		columns = firstRowLineCells
	}
	if columns <= 0 {
		columns = 1
	}

	table := &Table{Rows: [][]Cell{}}
	start := 0
	if hasHeader && len(cells) >= columns {
		table.Header = cells[:columns]
		start = columns
	}
	for i := start; i < len(cells); i += columns {
		end := i + columns
		if end > len(cells) {
			end = len(cells)
		}
		row := make([]Cell, columns)
		copy(row, cells[i:end])
		for j := range row {
			if row[j].Spans == nil {
				row[j].Spans = []Span{}
			}
		}
		table.Rows = append(table.Rows, row)
	}

	return Block{Kind: KindTable, Title: title, Table: table}
}

// colsCount reads the column count out of a table's `cols=` attribute,
// handling both the explicit list (`cols="1,1,1,2"`) and the repeat shorthand
// (`cols=4*`). Zero means "not declared".
func colsCount(attrs string) int {
	for _, part := range splitAttrs(attrs) {
		name, value, ok := strings.Cut(part, "=")
		if !ok || strings.TrimSpace(name) != "cols" {
			continue
		}
		value = strings.TrimSpace(value)
		if unq, ok := unquote(value); ok {
			value = unq
		}
		if star := strings.IndexByte(value, '*'); star > 0 {
			n := 0
			for _, r := range value[:star] {
				if r < '0' || r > '9' {
					return 0
				}
				n = n*10 + int(r-'0')
			}
			return n
		}
		return len(strings.Split(value, ","))
	}
	return 0
}

// splitAttrs splits an attribute list on commas that are not inside quotes.
func splitAttrs(attrs string) []string {
	var out []string
	var current strings.Builder
	inQuote := byte(0)
	for i := 0; i < len(attrs); i++ {
		c := attrs[i]
		switch {
		case inQuote != 0 && c == inQuote:
			inQuote = 0
			current.WriteByte(c)
		case inQuote == 0 && (c == '"' || c == '\''):
			inQuote = c
			current.WriteByte(c)
		case inQuote == 0 && c == ',':
			out = append(out, current.String())
			current.Reset()
		default:
			current.WriteByte(c)
		}
	}
	out = append(out, current.String())
	return out
}

// cellSpecPattern is an AsciiDoc cell specifier, the optional prefix that may
// sit immediately before a cell's `|`: a span (`2+`, `.3+`, `2.2+`), an alignment
// (`^`, `>`, `.^`, `^.>`), and/or a style (`a` AsciiDoc, `h` header, `l` literal,
// `m` monospace, `s` strong, `e` emphasis, `d` default).
//
// Anchored whole-string, because it is only ever applied to a candidate token
// already isolated by its caller.
var cellSpecPattern = regexp.MustCompile(`^(?:\d+(?:\.\d+)?\+|\.\d+\+)?(?:[<^>](?:\.[<^>])?|\.[<^>])?[aehlmsd]?$`)

// cellSpecChars are the characters cellSpecPattern can match, used to isolate a
// candidate specifier from the end of a cell's text without a backtracking
// regexp.
const cellSpecChars = "0123456789.+<^>aehlmsd"

// isCellSpec reports whether s is entirely a cell specifier, or empty. Applied
// to whatever precedes a line's first `|`: empty is an ordinary row line, a
// specifier is a styled cell opening the line (`a| ...`), and anything else means
// the line is not a row line at all.
func isCellSpec(s string) bool {
	return cellSpecPattern.MatchString(s)
}

// trimTrailingCellSpec strips a cell specifier from the end of s, where s is the
// text between two `|`s and therefore ends with the *next* cell's specifier if it
// has one.
//
// The specifier must be a standalone token -- at the start of s, or preceded by
// whitespace. Without that rule `|Yes|No` would lose the "s" of "Yes" (a valid
// `s` strong specifier) and `|2xlarge+|8` would lose "e+". AsciiDoc recognises a
// specifier only in that position too, so the restriction is fidelity, not a
// concession.
func trimTrailingCellSpec(s string) string {
	cut := len(s)
	for cut > 0 && strings.IndexByte(cellSpecChars, s[cut-1]) >= 0 {
		cut--
	}
	candidate := s[cut:]
	if candidate == "" || !cellSpecPattern.MatchString(candidate) {
		return s
	}
	if cut > 0 && s[cut-1] != ' ' && s[cut-1] != '\t' {
		return s
	}
	return strings.TrimRight(s[:cut], " \t")
}

// splitTableRow splits one source line into its `|`-delimited cells, or returns
// nil when the line is not a row line at all (a continuation of the previous
// cell's text). A cell specifier (`2+|`, `a|`, `.^|`) is dropped: those control
// layout on the docs site, which this pane does not reproduce.
//
// Specifiers are why this is not a plain `strings.Split`. Upstream writes several
// of its tables with AsciiDoc-style cells -- the supported-Xcode table's
// resource-class column, `pipeline-values.adoc`'s `d|`, `operators.adoc`'s and
// `orb-type-comparison.adoc`'s `a|` -- and a line beginning `a|` used to miss the
// `strings.HasPrefix(line, "|")` test and fall through to the continuation
// branch, so its cell was *appended to the previous one* and every later cell in
// the table shifted by one column. In the supported-Xcode table that silently
// mixed Xcode versions and macOS versions into one "Config" column (issue #211),
// which is how an extraction that looks like it is reading a column can be
// reading the wrong one.
func (p *parser) splitTableRow(line string) []Cell {
	parts := strings.Split(line, "|")
	if len(parts) < 2 || !isCellSpec(parts[0]) {
		return nil
	}
	cells := make([]Cell, 0, len(parts)-1)
	for i, part := range parts[1:] {
		// The last part runs to end of line, so nothing follows it that could
		// own a specifier.
		if i < len(parts)-2 {
			part = trimTrailingCellSpec(part)
		}
		cells = append(cells, Cell{Spans: parseSpans(strings.TrimSpace(part), p.ctx)})
	}
	return cells
}

// parseInclude resolves an `include::target[]` against p.resolve and splices
// the included blocks in.
//
// Failure is a first-class, *visible* outcome: an unresolvable include becomes
// a KindNote naming what is missing and pointing at the live page, so a reader
// is told there is more on the site rather than silently shown a short
// section. That is the same "degrade honestly" rule applied at block
// granularity.
func (p *parser) parseInclude(line string) []Block {
	p.pos++
	p.clearPending()

	target := strings.TrimPrefix(line, "include::")
	if bracket := strings.IndexByte(target, '['); bracket >= 0 {
		target = target[:bracket]
	}
	target = strings.TrimSpace(target)

	note := func(reason string) []Block {
		return []Block{{
			Kind: KindNote,
			Spans: []Span{
				{Kind: SpanText, Text: "This part of the page (" + target + ") is not included in the offline snapshot: " + reason + ". "},
				{Kind: SpanLink, Text: "Read it on circleci.com", URL: p.pageURL},
			},
		}}
	}

	if p.resolve == nil {
		return note("no resolver available")
	}
	if p.includeDepth >= maxIncludeDepth {
		return note("nested too deeply to resolve safely")
	}

	id, err := parseResourceID(target, p.ctx)
	if err != nil {
		return note("its resource ID could not be resolved")
	}
	content, err := p.resolve(id.repoPath())
	if err != nil {
		return note("it was not part of the snapshot")
	}

	if id.family == "example" {
		// An `example$` include is a raw file (the snapshot's are YAML), not
		// AsciiDoc: render it as the code sample it is.
		return []Block{{Kind: KindCode, Language: languageForPath(id.relpath), Text: strings.TrimRight(string(content), "\n")}}
	}

	// An included file's own resource IDs resolve against *its* component and
	// module, not the including page's -- that is how Antora itself resolves
	// them, and it matters because these partials are shared between the
	// `guides` and `reference` components. (Getting it backwards makes a
	// partial-that-includes-a-partial resolve to a path the fetcher never
	// fetched; the fetcher walks the closure the same way, and
	// TestFetcherResolvesTheIncludeClosure pins the two agreeing.) pageURL is
	// deliberately *not* switched: the reader is on the including page, so
	// that is the page a "read this on circleci.com" link must point at.
	//
	// p.anchors and p.anchorSections are shared so a partial's anchors cannot
	// collide with the page's and are reachable from a cross-reference.
	sub := &parser{
		lines:          splitLines(string(content)),
		ctx:            spanContext{component: id.component, module: id.module, pageName: p.ctx.pageName},
		pageURL:        p.pageURL,
		resolve:        p.resolve,
		includeDepth:   p.includeDepth + 1,
		anchors:        p.anchors,
		anchorSections: p.anchorSections,
		images:         p.images,
		currentSection: p.currentSection,
	}
	return sub.parseBlocks(nil)
}

// languageForPath maps an included example file's extension to a language for
// the code block it becomes.
func languageForPath(path string) string {
	switch {
	case strings.HasSuffix(path, ".yml"), strings.HasSuffix(path, ".yaml"):
		return "yaml"
	case strings.HasSuffix(path, ".sh"):
		return "shell"
	case strings.HasSuffix(path, ".json"):
		return "json"
	default:
		return ""
	}
}
