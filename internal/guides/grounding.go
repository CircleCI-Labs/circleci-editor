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
	"regexp"
	"sort"
	"strings"
)

// This file answers issue #22: the vendored snapshot this package already
// parses and already holds in memory is a grounding corpus that needs no
// credential and no network, and nothing used it. SelectPassages is the
// selection half -- deciding *which* of the ~370 sections across twenty-two
// guides are worth a model's attention for one question -- and it is the
// half that matters. The corpus is roughly 800KB of prose; an Anthropic
// context window is generous but not free, and it is the user's own key
// being billed. "Ground every answer in everything" is not grounding, it is
// stuffing with better marketing -- see groundingCharBudget.
//
// # Why a keyword/section match over the block model, not embeddings
//
// An embedding index would need a vector store, a model call to embed the
// query, and a background job to keep it in sync with a snapshot that
// refreshes on its own TTL (see Cache) -- exactly the retrieval
// infrastructure issue #22 calls out this approach as *not* needing. The
// corpus is small (twenty-two guides, a few hundred sections) and already
// structured into titled, addressable sections with a citable URL apiece
// (Section.URL) -- the same join web/src/lib/guides/guides.ts's
// findSectionForKey already performs for the schema-derived key browser,
// just scored instead of picked by exact key match. A term/key match is
// slower to find a needle in a haystack than embeddings would be, but this
// corpus is not a haystack: it is small enough that an honest, inspectable
// scoring function beats a similarity score nobody here can explain when a
// citation looks wrong.
//
// # Two independent relevance signals
//
// "Relevant to the question and the open config" (the issue's own phrase)
// is two different questions, scored differently because they carry
// different confidence:
//
//   - The question's own words, matched against a section's title (high
//     confidence: the section is *about* the thing that was asked) and body
//     (lower confidence: the section merely *mentions* it).
//   - The open config's own keys, matched against Section.Keys -- the exact
//     join findSectionForKey already trusts for the schema-derived key
//     browser. A config that sets `resource_class: large` is evidence a
//     resource_class question is coming *before* it is asked, the same way
//     a compiler error names the section that explains it (see
//     web/src/lib/ai/deterministicSources.ts, which does this for a
//     diagnostic instead of a config key).
//
// Neither signal is stuffed in unconditionally: a section scores zero, and
// is never selected, unless at least one of them actually hit (see
// minGroundingScore). "Nothing matched" is a correct, common outcome --
// most chat turns are not asking a documentation question at all -- and it
// must produce zero passages, not the nearest few regardless of relevance.

const (
	// groundingCharBudget bounds the total size of every passage
	// SelectPassages returns, combined. ~4 characters per token (the same
	// rule of thumb web/src/lib/ai/context.ts's estimateTokens uses) puts
	// this at roughly 1,500 tokens -- a small fraction of
	// DIRECTORY_CONTEXT_TOKEN_BUDGET's 20,000. That asymmetry is
	// deliberate: a sibling file is something the user chose to keep in
	// `.circleci/` and may be asking about directly, so it is worth
	// spending generously on. Vendored documentation is supplementary --
	// context the app adds on the user's behalf, on the user's own
	// provider bill, without them having asked for a bigger request. A
	// handful of well-chosen sections at low cost beats a comprehensive
	// dump at a cost nobody agreed to.
	groundingCharBudget = 6_000

	// maxGroundingPassages caps passage *count* independently of the char
	// budget, so five short, all-different-guide matches don't crowd a
	// reply with five simultaneous topics -- the same "selection, not
	// stuffing" argument, applied to breadth rather than size. Four leaves
	// room for the configuration reference plus up to three more specific
	// guides on the same question, which is already more sources than the
	// AI pane's own "Sources" footer will ever display at once (see
	// web/src/lib/ai/sources.ts's MAX_SOURCES).
	maxGroundingPassages = 4

	// maxPassageChars caps one *individual* passage, so a single large
	// section (the configuration reference's `docker` section runs to
	// several thousand characters of prose and tables) cannot alone
	// consume the entire budget and crowd out every other candidate. A
	// truncated passage says so in its own text (see truncateHonestly)
	// rather than silently handing the model a partial section as if it
	// were the whole thing.
	maxPassageChars = 2_500

	// minTermLength discards a question word too short to be a meaningful
	// search term on its own ("is", "in", "to"). Three, not four: "orb" and
	// "env" are both real, specific CircleCI vocabulary at three letters,
	// and losing them to a length filter would mean a question about orbs
	// could only ever be found through Section.Keys, never through its own
	// words.
	minTermLength = 3

	// titleMatchWeight and keyMatchWeight are deliberately equal, and
	// minGroundingScore is deliberately set to exactly that weight: either
	// one alone is a strong enough signal to include a section (the
	// section is *about* the word that was asked, or the open config
	// already *sets* the key that section documents), and each is
	// sufficient entirely on its own -- neither needs the other's help to
	// clear the bar.
	titleMatchWeight  = 5
	keyMatchWeight    = 5
	minGroundingScore = 5

	// bodyMatchWeight is deliberately too small to clear minGroundingScore
	// on a single hit: one question term appearing somewhere in a section's
	// prose is weak evidence (most sections of a 22-guide corpus share
	// *some* common word with any real question), but maxBodyTermsUsed
	// distinct terms all appearing (bodyMatchWeight * maxBodyTermsUsed >=
	// minGroundingScore) is a section actually discussing what was asked,
	// not merely adjacent to it.
	bodyMatchWeight  = 2
	maxBodyTermsUsed = 3
)

// groundingStopwords are question words and filler common enough that
// matching one against a section's title or body proves nothing about
// relevance -- see scoreSection's own comment. Deliberately short and
// specific to how a user actually phrases a question to this pane, not a
// general-purpose English stopword list, so it stays reviewable in one
// screenful rather than importing an NLP dependency for four guides' worth
// of text.
var groundingStopwords = map[string]bool{
	"what": true, "why": true, "how": true, "when": true, "where": true,
	"who": true, "which": true, "does": true, "did": true, "do": true,
	"are": true, "was": true, "were": true, "the": true, "this": true,
	"that": true, "these": true, "those": true, "and": true, "for": true,
	"with": true, "you": true, "your": true, "can": true, "could": true,
	"should": true, "would": true, "will": true, "about": true, "from": true,
	"into": true, "not": true, "yes": true, "please": true, "help": true,
	"our": true, "have": true, "has": true, "had": true,
	"get": true, "got": true, "use": true, "using": true, "want": true,
	"need": true, "make": true, "one": true, "any": true, "all": true,
	"config": true, "configuration": true, "circleci": true, "yaml": true,
}

var wordPattern = regexp.MustCompile(`[A-Za-z0-9_]+`)

// Passage is one excerpt of vendored documentation SelectPassages judged
// worth showing a model: enough to read (Text), enough to head a section in
// the prompt (GuideTitle/SectionTitle), and everything needed to cite it
// (URL). URL is always either a Guide.URL or a Section.URL taken verbatim
// from the parsed snapshot -- never constructed -- which is what makes
// TestSelectedPassagesResolveAgainstTheRealSnapshot able to promise every
// passage this function can ever produce resolves through
// NewCitationResolver.
type Passage struct {
	// GuideTitle is the page this passage came from.
	GuideTitle string
	// SectionTitle is the section's own title, or "" when this passage is a
	// guide's lead paragraph rather than a numbered section -- see
	// leadCandidate.
	SectionTitle string
	// URL is where this passage's text lives -- a Section.URL, or a
	// Guide.URL for a lead passage.
	URL string
	// Text is the passage's prose, flattened from the block model (see
	// blocksPlainText) and truncated to maxPassageChars when the source
	// section runs longer.
	Text string
}

// candidate is one section or guide-lead under consideration, before the
// budget decides which ones survive into the returned []Passage.
type candidate struct {
	guideTitle   string
	sectionTitle string
	url          string
	text         string
	score        int
	// order breaks a score tie in document order (the order Sources itself
	// lists guides, then each guide's own section order) rather than by
	// however sort.SliceStable happened to receive equally-scored entries --
	// so which of two equally relevant sections comes first is a fact about
	// the corpus, not an accident of iteration order.
	order int
}

// SelectPassages chooses the vendored documentation worth showing a model
// for one chat turn, or nil when nothing in the corpus clears
// minGroundingScore for this question and config -- which is the common
// case, and a correct one: most chat turns are not documentation questions,
// and grounding them in the configuration reference regardless would be
// exactly the "stuffing" issue #22 warns against.
//
// question is normally the latest user message; configText is the open
// config's own text, whose keys are the "relevant to... the open config"
// half of selection (see this file's own package comment). Either may be
// empty -- an empty question with a config that sets a documented key still
// selects on that key alone, and vice versa.
func SelectPassages(gs []Guide, question, configText string) []Passage {
	terms := queryTerms(question)
	keys := documentedKeysPresentIn(gs, configText)
	if len(terms) == 0 && len(keys) == 0 {
		return nil
	}

	var candidates []candidate
	for gi := range gs {
		g := &gs[gi]
		if c, ok := leadCandidate(g, terms, gi); ok {
			candidates = append(candidates, c)
		}
		for si := range g.Sections {
			sec := &g.Sections[si]
			if c, ok := sectionCandidate(g, sec, terms, keys, gi*1000+si+1); ok {
				candidates = append(candidates, c)
			}
		}
	}
	if len(candidates) == 0 {
		return nil
	}

	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].score != candidates[j].score {
			return candidates[i].score > candidates[j].score
		}
		return candidates[i].order < candidates[j].order
	})

	var out []Passage
	used := 0
	for _, c := range candidates {
		if len(out) >= maxGroundingPassages {
			break
		}
		text := truncateHonestly(c.text, maxPassageChars)
		if used+len(text) > groundingCharBudget {
			// Skip rather than truncate further: a second truncation on
			// top of maxPassageChars's own would leave too little prose to
			// be worth the section header it would sit under. The budget
			// is generous enough (groundingCharBudget vs. maxPassageChars)
			// that this only bites once several candidates have already
			// been included, not on the first one.
			continue
		}
		out = append(out, Passage{
			GuideTitle:   c.guideTitle,
			SectionTitle: c.sectionTitle,
			URL:          c.url,
			Text:         text,
		})
		used += len(text)
	}
	return out
}

// leadCandidate scores a guide's own lead paragraph (the prose between the
// title and its first section) as a candidate in its own right, cited to the
// guide's own URL with no fragment. It exists because the lead is
// sometimes the only place a guide states what it is *about* in plain
// terms -- model.go's own doc comment gives dynamic-config.adoc's lead as
// exactly this case -- and a question matching only the guide's title and
// lead would otherwise find no section to point at.
func leadCandidate(g *Guide, terms map[string]bool, order int) (candidate, bool) {
	if len(g.Lead) == 0 {
		return candidate{}, false
	}
	score := 0
	if hasAnyWord(g.Title, terms) {
		score += titleMatchWeight
	}
	text := blocksPlainText(g.Lead)
	score += bodyMatchWeight * countBodyTermHits(text, terms)
	if score < minGroundingScore {
		return candidate{}, false
	}
	return candidate{
		guideTitle: g.Title,
		url:        g.URL,
		text:       text,
		score:      score,
		order:      order*1000 - 1, // sorts immediately before this guide's own sections
	}, true
}

// sectionCandidate scores one section: its own title against the question's
// words, its documented Section.Keys against keys the open config actually
// sets, and its body against the question's words -- see this file's
// package comment for why the first two outweigh the third.
func sectionCandidate(g *Guide, sec *Section, terms map[string]bool, presentKeys map[string]bool, order int) (candidate, bool) {
	score := 0
	if hasAnyWord(sec.Title, terms) {
		score += titleMatchWeight
	}
	for _, key := range sec.Keys {
		if presentKeys[key] {
			score += keyMatchWeight
		}
	}
	text := blocksPlainText(sec.Blocks)
	if score < minGroundingScore {
		score += bodyMatchWeight * countBodyTermHits(text, terms)
	}
	if score < minGroundingScore {
		return candidate{}, false
	}
	return candidate{
		guideTitle:   g.Title,
		sectionTitle: sec.Title,
		url:          sec.URL,
		text:         text,
		score:        score,
		order:        order,
	}, true
}

// countBodyTermHits is how many *distinct* question terms appear as a whole
// word somewhere in text, capped at maxBodyTermsUsed. Whole-word, not
// substring: web/src/lib/ai/sources.ts's matchesTopic uses substrings
// deliberately, to match both "dependenc(y|ies)" with one term, but that
// module is choosing *ordering* among sources already known safe to show.
// This function is choosing *inclusion* in a model's context window, where
// "build" substring-matching "building-docker-images" on every page that
// mentions building something is exactly the false-positive flood
// minGroundingScore's own comment warns about -- a whole-word match against
// a section's own tokenized text is cheap to compute once per section and
// removes that failure mode outright.
func countBodyTermHits(text string, terms map[string]bool) int {
	if len(terms) == 0 {
		return 0
	}
	body := wordSet(text)
	hits := 0
	for term := range terms {
		if body[term] {
			hits++
			if hits >= maxBodyTermsUsed {
				break
			}
		}
	}
	return hits
}

// hasAnyWord reports whether any of terms appears as a whole word in text
// (a section or guide title, which model.go guarantees is already plain
// text with no inline markup to strip).
func hasAnyWord(text string, terms map[string]bool) bool {
	if len(terms) == 0 {
		return false
	}
	for word := range wordSet(text) {
		if terms[word] {
			return true
		}
	}
	return false
}

// queryTerms tokenizes question into the words worth searching for::
// lowercased, deduplicated, short filler and question words removed (see
// groundingStopwords). Returned as a set because every caller only ever asks
// "is this word present", never iterates in order.
func queryTerms(question string) map[string]bool {
	out := map[string]bool{}
	for _, word := range wordPattern.FindAllString(strings.ToLower(question), -1) {
		if len(word) < minTermLength || groundingStopwords[word] {
			continue
		}
		out[word] = true
	}
	return out
}

// wordSet tokenizes text (already lowercase or not) into the set of distinct
// words it contains, lowercased. Used for both a title's few words and a
// section's whole body -- there is no length at which this corpus is large
// enough to need a memoized version of it (contrast
// web/src/lib/guides/guides.ts's sectionTextCache, built for a search that
// reruns on every keystroke; this runs once per chat turn).
func wordSet(text string) map[string]bool {
	out := map[string]bool{}
	for _, word := range wordPattern.FindAllString(strings.ToLower(text), -1) {
		out[word] = true
	}
	return out
}

// ubiquitousConfigKeys are documented keys present in nearly every real
// config, so their presence is not evidence a section is relevant --
// contrast `docker` or `resource_class`, which only appear in a config that
// actually uses that executor or sets that field. Discovered rather than
// guessed: a resource_class question, scored against a config that (like
// almost any config) sets `workflows:` and `steps:`, was pulling in a
// dynamic-config section whose *heading* happens to read "...`workflows` or
// `steps`..." in prose, purely because those two words are also that
// section's Section.Keys (model.go's heading-derived Keys does not
// distinguish "this section defines the key" from "this section's title
// merely mentions it in backticks") -- see grounding_test.go's own
// regression test for this exact case. Excluding the handful of keys this
// common removes that false signal without touching the far more useful
// default of trusting a specific key like `docker` or `context`.
var ubiquitousConfigKeys = map[string]bool{
	"version": true, "jobs": true, "workflows": true, "steps": true,
}

// documentedKeysPresentIn returns the subset of every key any guide
// documents (mirroring web/src/lib/guides/guides.ts's documentedKeys, minus
// ubiquitousConfigKeys) that also appears to be set in configText --
// checked as `key:` rather than a bare substring, so `context` (a real
// documented key) does not fire on every mention of the English word
// "context" in a comment. `key:` is not a full YAML parse -- a key inside a
// string value or a comment can still false-positive -- but a false
// positive here only ever adds one more candidate section to score, never
// fabricates a citation, so the cost of getting it wrong is a passage that
// turns out mildly irrelevant, not a wrong answer.
func documentedKeysPresentIn(gs []Guide, configText string) map[string]bool {
	out := map[string]bool{}
	if configText == "" {
		return out
	}
	lower := strings.ToLower(configText)
	checked := map[string]bool{}
	for _, g := range gs {
		for _, sec := range g.Sections {
			for _, key := range sec.Keys {
				if checked[key] || ubiquitousConfigKeys[key] {
					continue
				}
				checked[key] = true
				if strings.Contains(lower, strings.ToLower(key)+":") {
					out[key] = true
				}
			}
		}
	}
	return out
}

// blocksPlainText flattens blocks to readable plain text: paragraphs and
// admonitions as prose, code listings fenced and verbatim (a YAML sample
// loses its entire point if reflowed), lists as dashes, tables as
// pipe-separated rows. Mirrors web/src/lib/guides/guides.ts's blocksToText
// in what it recurses into, but renders rather than merely concatenates --
// this text is going in front of a model as the passage itself, not into a
// search index, so headings, code fences and list structure are kept
// legible instead of being flattened to one run-on paragraph.
func blocksPlainText(blocks []Block) string {
	var b strings.Builder
	writeBlocksPlainText(&b, blocks)
	return strings.TrimSpace(b.String())
}

func writeBlocksPlainText(b *strings.Builder, blocks []Block) {
	for _, blk := range blocks {
		writeBlockPlainText(b, blk)
	}
}

func writeBlockPlainText(b *strings.Builder, blk Block) {
	switch blk.Kind {
	case KindParagraph, KindHeading, KindNote:
		if text := plainText(blk.Spans); text != "" {
			b.WriteString(text)
			b.WriteString("\n\n")
		}
	case KindCode:
		b.WriteString("```")
		b.WriteString(blk.Language)
		b.WriteString("\n")
		b.WriteString(blk.Text)
		b.WriteString("\n```\n\n")
	case KindAdmonition:
		b.WriteString(blk.Admonition)
		b.WriteString(": ")
		writeBlocksPlainText(b, blk.Blocks)
	case KindList:
		for _, item := range blk.Items {
			b.WriteString("- ")
			writeBlocksPlainText(b, item.Blocks)
		}
	case KindTable:
		writeTablePlainText(b, blk.Table)
	}
}

func writeTablePlainText(b *strings.Builder, table *Table) {
	if table == nil {
		return
	}
	if len(table.Header) > 0 {
		writeRowPlainText(b, table.Header)
	}
	for _, row := range table.Rows {
		writeRowPlainText(b, row)
	}
	b.WriteString("\n")
}

func writeRowPlainText(b *strings.Builder, row []Cell) {
	cells := make([]string, len(row))
	for i, cell := range row {
		cells[i] = plainText(cell.Spans)
	}
	b.WriteString(strings.Join(cells, " | "))
	b.WriteString("\n")
}

// truncateHonestly returns text unchanged when it already fits within limit,
// and otherwise cuts it at the last paragraph break before limit and says so
// -- never hands a model a partial sentence with nothing to mark it as
// partial, which is this package's general "a gap must look like a gap"
// rule (see KindNote) applied to a passage instead of a parse failure.
func truncateHonestly(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	cut := strings.LastIndex(text[:limit], "\n\n")
	if cut <= 0 {
		cut = limit
	}
	return strings.TrimSpace(text[:cut]) + "\n\n[…rest of this section omitted to stay within budget]"
}
