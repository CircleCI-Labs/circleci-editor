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
	"unicode"
)

// This file parses AsciiDoc *inline* markup into []Span. It is not a general
// AsciiDoc implementation and does not try to be: it handles the constructs
// that actually occur in the three vendored pages, and anything else falls
// through as literal text rather than being dropped or mangled.
//
// The constructs handled, all verified present in the snapshot:
//
//	`mono`, ``mono``, `+literal+`      monospace
//	*strong*, **strong**               bold (constrained and unconstrained)
//	_em_, __em__                       italic
//	xref:target[text]                  Antora cross-reference -> absolute URL
//	<<anchor,text>>, <<anchor>>        same-page cross-reference -> SpanRef
//	link:url[text]                     explicit link macro
//	https://host/path[text]            URL macro
//	https://host/path                  bare URL
//	image:file[alt]                    dropped, alt text kept
//	kbd:[Keys], btn:[Label]            rendered as their literal label
//	{attr}                             a known attribute's value, else dropped
//	+++passthrough+++, pass:[x]        contents kept as literal text
//	\*escaped                          backslash escape
//
// Constrained formatting (a single `*` or `_`) follows AsciiDoc's own
// boundary rules, which is what stops a glob like `*.txt` or an identifier
// like `save_cache` from being read as an unterminated bold/italic run.

// inlineAttributes are the AsciiDoc attribute references worth substituting.
// Anything not listed is dropped (with its braces), because rendering a bare
// `{some-attr}` to a reader is worse than rendering nothing: it looks like a
// templating bug in this app rather than an artefact of the source.
var inlineAttributes = map[string]string{
	"empty":   "",
	"nbsp":    " ",
	"sp":      " ",
	"ndash":   "–",
	"mdash":   "—",
	"hellip":  "…",
	"lt":      "<",
	"gt":      ">",
	"amp":     "&",
	"vbar":    "|",
	"cpp":     "C++",
	"plus":    "+",
	"startsb": "[",
	"endsb":   "]",
}

// spanContext is what the inline parser needs from its surroundings to turn
// a relative cross-reference into something addressable.
type spanContext struct {
	// component and module are the Antora coordinates of the page being
	// parsed, so a bare `xref:reusing-config.adoc#x[...]` resolves against
	// the right component.
	component string
	module    string
	// pageName is the basename (no `.adoc`) of the page being parsed, used
	// to detect a cross-reference that points back at this same page and
	// should therefore stay inside the pane. Empty is safe: it only means
	// no same-page xref is detected, so such a reference degrades to an
	// outbound link rather than to a broken one.
	pageName string
}

// parseSpans parses one logical line (or joined paragraph) of AsciiDoc
// inline markup. It never returns nil: an empty input yields an empty slice,
// so callers can always range over the result.
func parseSpans(text string, ctx spanContext) []Span {
	spans := parseSpansInner(text, ctx)
	if spans == nil {
		return []Span{}
	}
	return spans
}

// parseSpansInner does the work; it may return nil for empty input, which
// matters for the recursive calls (a formatted run with empty content
// contributes no children).
func parseSpansInner(text string, ctx spanContext) []Span {
	var spans []Span
	var literal strings.Builder

	flush := func() {
		if literal.Len() > 0 {
			spans = append(spans, Span{Kind: SpanText, Text: literal.String()})
			literal.Reset()
		}
	}

	for i := 0; i < len(text); {
		consumed, produced, ok := matchInline(text, i, ctx)
		if !ok {
			literal.WriteByte(text[i])
			i++
			continue
		}
		flush()
		spans = append(spans, produced...)
		i += consumed
	}
	flush()
	return spans
}

// matchInline attempts to match a single inline construct starting at
// text[i]. It returns how many bytes were consumed and the spans produced.
// A false third result means "no construct starts here"; the caller emits
// text[i] literally and advances one byte.
//
// Every arm below already delegates to a named helper; the switch itself is
// the grammar's precedence order, which is the part worth reading in one
// place.
//
//nolint:gocyclo // See the note above: this is one dispatch, not tangled logic.
func matchInline(text string, i int, ctx spanContext) (consumed int, produced []Span, ok bool) {
	switch text[i] {
	case '\\':
		// AsciiDoc escape: the next character is literal, whatever it is.
		if i+1 < len(text) {
			return 2, []Span{{Kind: SpanText, Text: text[i+1 : i+2]}}, true
		}
		return 0, nil, false

	case '`':
		return matchMono(text, i)

	case '*':
		return matchFormatted(text, i, '*', SpanStrong, ctx)

	case '_':
		return matchFormatted(text, i, '_', SpanEm, ctx)

	case '{':
		return matchAttribute(text, i)

	case '[':
		return matchRoleSpan(text, i, ctx)

	case '<':
		return matchInternalRef(text, i, ctx)

	case '+':
		return matchPassthrough(text, i)

	case 'x', 'l', 'h', 'i', 'k', 'b', 'p', 'm':
		return matchMacro(text, i, ctx)
	}
	return 0, nil, false
}

// matchMono handles the single-backtick, double-backtick and
// backtick-plus (`+literal+`) monospace forms. Content is never
// span-parsed: monospace in these pages is always a config key, a filename
// or a literal value, and re-parsing it would let a `_` inside e.g.
// `save_cache` start an italic run.
func matchMono(text string, i int) (int, []Span, bool) {
	// Double-backtick form first: it is the unconstrained variant, so the
	// single-backtick matcher would otherwise close on the second opening
	// backtick and produce an empty span.
	if strings.HasPrefix(text[i:], "``") {
		if end := strings.Index(text[i+2:], "``"); end >= 0 {
			inner := text[i+2 : i+2+end]
			return 2 + end + 2, []Span{{Kind: SpanCode, Text: trimPassthroughMarkers(inner)}}, true
		}
	}
	end := strings.IndexByte(text[i+1:], '`')
	if end < 0 {
		return 0, nil, false
	}
	inner := text[i+1 : i+1+end]
	if inner == "" {
		return 0, nil, false
	}
	return 1 + end + 1, []Span{{Kind: SpanCode, Text: trimPassthroughMarkers(inner)}}, true
}

// trimPassthroughMarkers strips the leading and trailing `+` markers from
// AsciiDoc's backtick-plus passthrough form, which the source uses where a
// value would otherwise be interpreted -- e.g. the cache-key example whose
// key is a checksum template, where the doubled braces would otherwise be
// read as attribute references.
func trimPassthroughMarkers(s string) string {
	for len(s) >= 2 && s[0] == '+' && s[len(s)-1] == '+' {
		s = s[1 : len(s)-1]
	}
	return s
}

// matchFormatted handles `*strong*`/`**strong**` and `_em_`/`__em__`.
//
// The doubled form is unconstrained: it may start and end anywhere. The
// single form is constrained, meaning the opening marker must sit at a word
// boundary and be followed by a non-space, and the closing marker must be
// preceded by a non-space and followed by a boundary. Those rules are the
// reason `*.txt` and `x_1` don't turn into runaway formatting.
func matchFormatted(text string, i int, marker byte, kind SpanKind, ctx spanContext) (int, []Span, bool) {
	double := string([]byte{marker, marker})
	if strings.HasPrefix(text[i:], double) {
		if end := strings.Index(text[i+2:], double); end > 0 {
			inner := text[i+2 : i+2+end]
			return 2 + end + 2, []Span{{Kind: kind, Children: parseSpansInner(inner, ctx)}}, true
		}
	}

	if !isConstrainedOpen(text, i) {
		return 0, nil, false
	}
	// Find the nearest marker that is a valid constrained close.
	for j := i + 1; j < len(text); j++ {
		if text[j] != marker {
			continue
		}
		if !isConstrainedClose(text, j) {
			continue
		}
		inner := text[i+1 : j]
		if inner == "" {
			return 0, nil, false
		}
		return j - i + 1, []Span{{Kind: kind, Children: parseSpansInner(inner, ctx)}}, true
	}
	return 0, nil, false
}

// isConstrainedOpen reports whether the marker at text[i] can open a
// constrained formatted run: preceded by the start of the line, whitespace
// or punctuation, and followed by a non-space.
func isConstrainedOpen(text string, i int) bool {
	if i+1 >= len(text) || isSpaceByte(text[i+1]) {
		return false
	}
	if i == 0 {
		return true
	}
	prev := rune(text[i-1])
	return unicode.IsSpace(prev) || (!unicode.IsLetter(prev) && !unicode.IsDigit(prev))
}

// isConstrainedClose reports whether the marker at text[i] can close a
// constrained formatted run: preceded by a non-space, and followed by the
// end of the line, whitespace or punctuation.
func isConstrainedClose(text string, i int) bool {
	if i == 0 || isSpaceByte(text[i-1]) {
		return false
	}
	if i+1 >= len(text) {
		return true
	}
	next := rune(text[i+1])
	return unicode.IsSpace(next) || (!unicode.IsLetter(next) && !unicode.IsDigit(next))
}

func isSpaceByte(b byte) bool { return b == ' ' || b == '\t' }

// matchAttribute handles `{attr}` references. A known attribute yields its
// value; an unknown one is dropped entirely rather than shown -- see
// inlineAttributes.
func matchAttribute(text string, i int) (int, []Span, bool) {
	end := strings.IndexByte(text[i:], '}')
	if end < 0 {
		return 0, nil, false
	}
	name := text[i+1 : i+end]
	if name == "" || strings.ContainsAny(name, " \t{") {
		return 0, nil, false
	}
	value, known := inlineAttributes[name]
	if !known {
		return end + 1, nil, true
	}
	if value == "" {
		return end + 1, nil, true
	}
	return end + 1, []Span{{Kind: SpanText, Text: value}}, true
}

// matchRoleSpan handles AsciiDoc's inline role syntax, `[.role]#text#` (and
// the `##text##` unconstrained form). The docs' resource-class tables use it
// heavily -- `[.circle-green]#Yes#` -- purely to colour a word on the docs
// site. The role is dropped and the text kept: this pane's own palette decides
// its colours, and carrying a foreign CSS class name through would be
// meaningless here (that is the same reason this package parses the source
// rather than importing the rendered HTML).
func matchRoleSpan(text string, i int, ctx spanContext) (int, []Span, bool) {
	closeIdx := strings.IndexByte(text[i:], ']')
	if closeIdx < 0 {
		return 0, nil, false
	}
	role := text[i+1 : i+closeIdx]
	if role == "" || strings.ContainsAny(role, "[] \t") {
		return 0, nil, false
	}
	rest := text[i+closeIdx+1:]
	if !strings.HasPrefix(rest, "#") {
		return 0, nil, false
	}

	marker := "#"
	if strings.HasPrefix(rest, "##") {
		marker = "##"
	}
	end := strings.Index(rest[len(marker):], marker)
	if end < 0 {
		return 0, nil, false
	}
	inner := rest[len(marker) : len(marker)+end]
	consumed := closeIdx + 1 + len(marker) + end + len(marker)
	return consumed, parseSpansInner(inner, ctx), true
}

// matchInternalRef handles `<<anchor>>`, `<<#anchor>>` and
// `<<anchor,link text>>`: a cross-reference *within the same page*, which
// becomes a SpanRef the pane can navigate to without leaving the app.
//
// The config-policies page (issue #247) is the first vendored page to write
// the `#`-prefixed form -- Asciidoctor treats `<<#id>>` as identical to
// `<<id>>`, a same-document xref rather than one qualified by a document ID.
// Without stripping it here, the target `"#enablement"` would never match a
// key in `anchorSections` (populated from `[#enablement]`, without the `#`),
// so the reference would silently fail to resolve in the running pane, not
// only in TestSnapshotCrossReferencesAllResolve.
func matchInternalRef(text string, i int, ctx spanContext) (int, []Span, bool) {
	if !strings.HasPrefix(text[i:], "<<") {
		return 0, nil, false
	}
	end := strings.Index(text[i:], ">>")
	if end < 0 {
		return 0, nil, false
	}
	body := text[i+2 : i+end]
	if body == "" {
		return 0, nil, false
	}
	target, label, hasLabel := strings.Cut(body, ",")
	target = strings.TrimPrefix(strings.TrimSpace(target), "#")
	if target == "" {
		return 0, nil, false
	}
	if !hasLabel || strings.TrimSpace(label) == "" {
		label = target
	}
	return end + 2, []Span{{
		Kind:     SpanRef,
		Text:     plainText(parseSpansInner(strings.TrimSpace(label), ctx)),
		Target:   target,
		Children: parseSpansInner(strings.TrimSpace(label), ctx),
	}}, true
}

// matchPassthrough handles `+++raw+++`, whose contents are kept verbatim as
// text. (The source uses it for the odd HTML entity.)
func matchPassthrough(text string, i int) (int, []Span, bool) {
	if !strings.HasPrefix(text[i:], "+++") {
		return 0, nil, false
	}
	end := strings.Index(text[i+3:], "+++")
	if end < 0 {
		return 0, nil, false
	}
	return 3 + end + 3, []Span{{Kind: SpanText, Text: text[i+3 : i+3+end]}}, true
}

// macroPrefixes are the `name:target[attrs]` macros this parser understands,
// longest-first so `https:` is tried before `http:`.
var macroPrefixes = []string{"xref:", "link:", "https://", "http://", "image:", "kbd:", "btn:", "pass:", "mailto:", "menu:", "icon:"}

// matchMacro handles AsciiDoc's `name:target[attrs]` inline macros plus bare
// URLs.
func matchMacro(text string, i int, ctx spanContext) (int, []Span, bool) {
	rest := text[i:]
	var prefix string
	for _, candidate := range macroPrefixes {
		if strings.HasPrefix(rest, candidate) {
			prefix = candidate
			break
		}
	}
	if prefix == "" {
		return 0, nil, false
	}
	// A macro must start at a word boundary, so `foohttps://x` is not one.
	if i > 0 {
		prev := rune(text[i-1])
		if unicode.IsLetter(prev) || unicode.IsDigit(prev) {
			return 0, nil, false
		}
	}

	switch prefix {
	case "https://", "http://":
		return matchURL(text, i, ctx)
	case "kbd:", "btn:":
		// Rendered as the plain label: this app has no key-cap component,
		// and inventing one for two occurrences is not worth it.
		target, attrs, end, ok := splitMacro(rest, len(prefix))
		if !ok {
			return 0, nil, false
		}
		label := attrs
		if label == "" {
			label = target
		}
		return end, []Span{{Kind: SpanCode, Text: label}}, true
	case "pass:":
		_, attrs, end, ok := splitMacro(rest, len(prefix))
		if !ok {
			return 0, nil, false
		}
		return end, []Span{{Kind: SpanText, Text: attrs}}, true
	case "menu:":
		// `menu:Plan[Usage Controls]` describes a path through CircleCI's web
		// app. Rendered as that path with a separator, which is all a reader
		// needs and needs no new span kind.
		target, attrs, end, ok := splitMacro(rest, len(prefix))
		if !ok {
			return 0, nil, false
		}
		parts := []string{strings.TrimSpace(target)}
		for _, part := range strings.Split(attrs, ">") {
			if part = strings.TrimSpace(part); part != "" {
				parts = append(parts, part)
			}
		}
		return end, []Span{{Kind: SpanStrong, Children: []Span{{Kind: SpanText, Text: strings.Join(parts, " › ")}}}}, true
	case "icon:":
		// Decorative only; the snapshot's single occurrence carries no
		// information the surrounding sentence does not.
		_, _, end, ok := splitMacro(rest, len(prefix))
		if !ok {
			return 0, nil, false
		}
		return end, nil, true
	case "image:":
		// Images are not rendered: the snapshot deliberately vendors text
		// only (see guides.go's provenance note), so an <img> would be a
		// broken one. The alt text is kept, which is the informative part.
		_, attrs, end, ok := splitMacro(rest, len(prefix))
		if !ok {
			return 0, nil, false
		}
		if attrs == "" {
			return end, nil, true
		}
		return end, []Span{{Kind: SpanText, Text: attrs}}, true
	case "mailto:":
		target, attrs, end, ok := splitMacro(rest, len(prefix))
		if !ok {
			return 0, nil, false
		}
		label := attrs
		if label == "" {
			label = target
		}
		return end, []Span{{Kind: SpanLink, Text: label, URL: "mailto:" + target}}, true
	case "link:":
		target, attrs, end, ok := splitMacro(rest, len(prefix))
		if !ok {
			return 0, nil, false
		}
		label := attrs
		if label == "" {
			label = target
		}
		return end, []Span{{Kind: SpanLink, Text: label, URL: target}}, true
	case "xref:":
		return matchXref(rest, ctx, i)
	}
	return 0, nil, false
}

// matchURL handles both `https://host/path[label]` and a bare
// `https://host/path` with no bracket.
func matchURL(text string, i int, ctx spanContext) (int, []Span, bool) {
	rest := text[i:]
	// A bracketed URL macro's target ends at the first `[`.
	bracket := strings.IndexByte(rest, '[')
	urlEnd := len(rest)
	for j := 0; j < len(rest); j++ {
		if isSpaceByte(rest[j]) || rest[j] == '[' {
			urlEnd = j
			break
		}
	}
	raw := strings.TrimRight(rest[:urlEnd], ".,;:)")
	if raw == "" {
		return 0, nil, false
	}

	if bracket == urlEnd && bracket < len(rest) {
		_, attrs, end, ok := splitMacro(rest, urlEnd)
		if ok {
			label := firstMacroAttr(attrs)
			if label == "" {
				label = raw
			}
			return end, []Span{{Kind: SpanLink, Text: label, URL: raw, Children: parseSpansInner(label, ctx)}}, true
		}
	}
	return len(raw), []Span{{Kind: SpanLink, Text: raw, URL: raw}}, true
}

// matchXref resolves an Antora `xref:` to an absolute live-docs URL, or --
// when the target is a bare `#anchor` on this same page -- to a SpanRef the
// pane can navigate internally.
func matchXref(rest string, ctx spanContext, _ int) (int, []Span, bool) {
	target, attrs, end, ok := splitMacro(rest, len("xref:"))
	if !ok {
		return 0, nil, false
	}
	label := firstMacroAttr(attrs)

	// `xref:#anchor[...]` and `xref:#[...]`: same page.
	if strings.HasPrefix(target, "#") {
		anchor := strings.TrimPrefix(target, "#")
		if anchor == "" {
			// Degenerate self-reference; render the label as plain text.
			if label == "" {
				return end, nil, true
			}
			return end, parseSpansInner(label, ctx), true
		}
		if label == "" {
			label = anchor
		}
		return end, []Span{{Kind: SpanRef, Text: label, Target: anchor, Children: parseSpansInner(label, ctx)}}, true
	}

	url, anchor, samePage := resolveXref(target, ctx)
	if samePage {
		if label == "" {
			label = anchor
		}
		return end, []Span{{Kind: SpanRef, Text: label, Target: anchor, Children: parseSpansInner(label, ctx)}}, true
	}
	if url == "" {
		// Unresolvable target: show the label as prose rather than a link
		// that goes nowhere.
		if label == "" {
			return end, nil, true
		}
		return end, parseSpansInner(label, ctx), true
	}
	if label == "" {
		label = url
	}
	return end, []Span{{Kind: SpanLink, Text: label, URL: url, Children: parseSpansInner(label, ctx)}}, true
}

// splitMacro splits `name:target[attrs]` given the offset just past `name:`.
// It returns the target, the raw attribute text, and how many bytes the whole
// macro occupies. A macro with no `[` is not a macro (AsciiDoc requires the
// brackets), so ok is false.
func splitMacro(s string, afterPrefix int) (target, attrs string, consumed int, ok bool) {
	open := strings.IndexByte(s[afterPrefix:], '[')
	if open < 0 {
		return "", "", 0, false
	}
	open += afterPrefix
	// Find the matching close bracket, allowing `\]` escapes.
	for j := open + 1; j < len(s); j++ {
		if s[j] == '\\' {
			j++
			continue
		}
		if s[j] == ']' {
			return s[afterPrefix:open], s[open+1 : j], j + 1, true
		}
		if s[j] == '\n' {
			break
		}
	}
	return "", "", 0, false
}

// firstMacroAttr returns the positional label from a macro's attribute list,
// i.e. everything up to the first unquoted comma. `role=` style named
// attributes contribute nothing a reader needs.
func firstMacroAttr(attrs string) string {
	if attrs == "" {
		return ""
	}
	if quoted, ok := unquote(attrs); ok {
		return quoted
	}
	label, _, _ := strings.Cut(attrs, ",")
	label = strings.TrimSpace(label)
	if strings.Contains(label, "=") {
		// A lone named attribute (e.g. `window=_blank`) is not a label.
		return ""
	}
	if unq, ok := unquote(label); ok {
		return unq
	}
	return label
}

func unquote(s string) (string, bool) {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && ((s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'')) {
		return s[1 : len(s)-1], true
	}
	return "", false
}

// plainText flattens spans to their text, for Section.Title and for search.
func plainText(spans []Span) string {
	var b strings.Builder
	writeSpansText(&b, spans)
	return strings.TrimSpace(b.String())
}

func writeSpansText(b *strings.Builder, spans []Span) {
	for _, span := range spans {
		if len(span.Children) > 0 {
			writeSpansText(b, span.Children)
			continue
		}
		b.WriteString(span.Text)
	}
}

// codeSpanTexts returns every monospace run in spans, in order. It is how a
// heading's config keys are discovered (Section.Keys) without a hand-written
// key-to-anchor table: the configuration reference writes every key it
// documents as monospace in that key's own heading.
func codeSpanTexts(spans []Span) []string {
	var out []string
	for _, span := range spans {
		if span.Kind == SpanCode {
			if text := strings.TrimSpace(span.Text); text != "" {
				out = append(out, text)
			}
			continue
		}
		out = append(out, codeSpanTexts(span.Children)...)
	}
	return out
}
