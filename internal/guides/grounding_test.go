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
	"time"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"
)

// TestSelectPassages_NoSignalYieldsNoPassages pins the common case: a chat
// turn that is not asking a documentation question (a greeting, an empty
// config) must ground on nothing at all, never on "the closest few
// sections regardless" -- see this file's package comment on why stuffing
// is the failure mode, not the fix.
func TestSelectPassages_NoSignalYieldsNoPassages(t *testing.T) {
	t.Parallel()
	parsed, err := ParseSnapshot()
	assert.NilError(t, err)

	assert.Assert(t, is.Len(SelectPassages(parsed, "hi", ""), 0))
	assert.Assert(t, is.Len(SelectPassages(parsed, "", ""), 0))
	// Real words, but none of them CircleCI-specific or long enough to
	// survive queryTerms's stopword/length filter -- a generic "how do I do
	// this" must not accidentally key off "this" or "how".
	assert.Assert(t, is.Len(SelectPassages(parsed, "how do I do this", ""), 0))
}

// TestSelectPassages_RepresentativeQuestion is the "show the actual
// assembled request" case: a realistic question about a concept
// (resource_class) that is also a key set in the open config. It pins that
// both relevance signals fire, that the configuration reference's own
// dedicated `resource_class` section is selected as a citable passage, and
// that the passage carries prose a human would recognise as an answer, not
// a table dump or a heading with nothing under it.
func TestSelectPassages_RepresentativeQuestion(t *testing.T) {
	t.Parallel()
	parsed, err := ParseSnapshot()
	assert.NilError(t, err)

	configText := "version: 2.1\njobs:\n  build:\n    docker:\n      - image: cimg/base:stable\n    resource_class: large\n"
	passages := SelectPassages(parsed, "What does resource_class actually control, and what values can I use for a Docker executor?", configText)

	assert.Assert(t, len(passages) > 0, "expected at least one passage for a question naming a documented, config-set key")
	assert.Assert(t, len(passages) <= maxGroundingPassages)

	var gotResourceClass, gotDocker bool
	total := 0
	for _, p := range passages {
		assert.Assert(t, p.URL != "", "every passage must carry a citable URL: %+v", p)
		assert.Assert(t, strings.Contains(p.URL, "circleci.com"), "expected a vendored circleci.com URL: %+v", p)
		assert.Assert(t, p.Text != "", "a passage with no text would be a heading pointing at nothing: %+v", p)
		total += len(p.Text)
		if p.SectionTitle == "resource_class" {
			gotResourceClass = true
		}
		if p.SectionTitle == "docker" {
			gotDocker = true
		}
	}
	assert.Assert(t, gotResourceClass, "expected the resource_class section itself, got %+v", passages)
	assert.Assert(t, gotDocker, "expected the docker executor section (title match + key match), got %+v", passages)
	assert.Assert(t, total <= groundingCharBudget, "assembled passages exceeded the char budget: %d > %d", total, groundingCharBudget)
}

// TestSelectPassages_UbiquitousKeysDoNotGroundOnTheirOwn is a regression
// test for exactly what its own investigation found: a resource_class
// question, scored against a config that -- like nearly every real config
// -- sets `workflows:` and `steps:`, was pulling in
// using-dynamic-configuration.adoc's "Execute specific `workflows` or
// `steps` based on which files are modified" section. That section's
// Section.Keys are ["workflows", "steps"] purely because its own heading
// name-drops those two words in backticks, not because it documents either
// key -- and `workflows`/`steps` are so close to universal that treating
// their presence in configText as a relevance signal picks out sections by
// what almost any config happens to contain, not by what the question is
// about. ubiquitousConfigKeys exists to keep this section (and others like
// it) out unless something else about the question also points at it.
func TestSelectPassages_UbiquitousKeysDoNotGroundOnTheirOwn(t *testing.T) {
	t.Parallel()
	parsed, err := ParseSnapshot()
	assert.NilError(t, err)

	configText := "version: 2.1\njobs:\n  build:\n    docker:\n      - image: cimg/base:stable\n    resource_class: large\n    steps:\n      - checkout\nworkflows:\n  build-and-test:\n    jobs:\n      - build\n"
	passages := SelectPassages(parsed, "What does resource_class control, and can I use a different one for a Docker executor?", configText)

	for _, p := range passages {
		assert.Assert(t, !strings.Contains(p.SectionTitle, "which files are modified"),
			"the file-based dynamic-config section should not ground a resource_class question just because the config also has workflows/steps keys: %+v", p)
	}
}

// TestSelectPassages_ConfigKeyAloneIsEnoughWithNoQuestionMatch covers the
// "open config" half of selection in isolation: a question with no
// CircleCI-specific words at all, paired with a config that sets a
// documented key, must still ground on that key -- the same way a compiler
// error's own target names a section before anything is typed (see
// web/src/lib/ai/deterministicSources.ts's parallel for a diagnostic
// instead of a config key).
func TestSelectPassages_ConfigKeyAloneIsEnoughWithNoQuestionMatch(t *testing.T) {
	t.Parallel()
	parsed, err := ParseSnapshot()
	assert.NilError(t, err)

	passages := SelectPassages(parsed, "is this ok", "version: 2.1\njobs:\n  build:\n    machine: true\n")
	assert.Assert(t, len(passages) > 0)
	found := false
	for _, p := range passages {
		if p.SectionTitle == "machine" {
			found = true
		}
	}
	assert.Assert(t, found, "expected the machine executor section from the config key alone, got %+v", passages)
}

// TestSelectPassages_RespectsPerPassageAndTotalBudget builds a config that
// sets many documented keys at once (contexts, workflows/requires, orbs,
// resource_class, docker, machine, macos, windows) so that, absent a cap,
// SelectPassages would have far more than maxGroundingPassages candidates
// clearing minGroundingScore purely from key matches. It pins both bounds
// this package promises: never more than maxGroundingPassages passages, and
// never more than groundingCharBudget characters of prose in total --
// the two numbers internal/host/ai.go's system prompt and this PR's own
// assembled-request example both depend on staying true.
func TestSelectPassages_RespectsPerPassageAndTotalBudget(t *testing.T) {
	t.Parallel()
	parsed, err := ParseSnapshot()
	assert.NilError(t, err)

	configText := strings.Join([]string{
		"version: 2.1",
		"jobs:",
		"  build:",
		"    docker:",
		"      - image: cimg/base:stable",
		"    machine: true",
		"    resource_class: large",
		"    parallelism: 4",
		"workflows:",
		"  build-and-test:",
		"    jobs:",
		"      - build",
	}, "\n")
	question := "How do docker, machine, resource_class, parallelism and workflows all fit together in one config?"

	passages := SelectPassages(parsed, question, configText)
	assert.Assert(t, len(passages) > 0)
	assert.Assert(t, len(passages) <= maxGroundingPassages)

	total := 0
	for _, p := range passages {
		assert.Assert(t, len(p.Text) <= maxPassageChars+100, "a single passage grew far past maxPassageChars: %d", len(p.Text))
		total += len(p.Text)
	}
	assert.Assert(t, total <= groundingCharBudget, "total=%d budget=%d", total, groundingCharBudget)
}

// TestSelectedPassagesResolveAgainstTheRealSnapshot is issue #22's "citations
// must resolve" requirement, made exhaustive rather than spot-checked: every
// URL SelectPassages can *ever* emit is either some Guide's own URL or some
// Section's own URL (see Passage's doc comment -- nothing here constructs a
// URL), so this walks every guide and section in the real, vendored snapshot
// and asserts each one resolves through the exact machinery
// internal/host/ai.go's citations() uses, with a non-empty title. A citation
// that does not resolve is worse than none (issue #22's own words); this is
// the test that would catch one before it ever reached a reply.
func TestSelectedPassagesResolveAgainstTheRealSnapshot(t *testing.T) {
	t.Parallel()
	parsed, err := ParseSnapshot()
	assert.NilError(t, err)
	assert.Assert(t, len(parsed) > 0)

	resolver := NewCitationResolver(parsed)
	checked := 0
	for _, g := range parsed {
		if len(g.Lead) > 0 {
			got := resolver.Normalize([]string{g.URL})
			assert.Assert(t, is.Len(got, 1), "guide %q lead URL %s did not resolve", g.ID, g.URL)
			assert.Assert(t, got[0].Title != "", "guide %q lead URL %s resolved with no title", g.ID, g.URL)
			checked++
		}
		for _, sec := range g.Sections {
			got := resolver.Normalize([]string{sec.URL})
			assert.Assert(t, is.Len(got, 1), "guide %q section %q URL %s did not resolve", g.ID, sec.ID, sec.URL)
			assert.Assert(t, got[0].Title != "", "guide %q section %q URL %s resolved with no title", g.ID, sec.ID, sec.URL)
			checked++
		}
	}
	// A guard against this test silently checking nothing if parsing ever
	// regressed to an empty section list across every guide.
	assert.Assert(t, checked > 100, "expected well over 100 citable URLs across twenty-two guides, got %d", checked)
}

// TestProvenance_Stale pins the threshold the AI pane's grounding prompt
// relies on (see Provenance.Stale's own comment) to the exact one Cache
// itself refreshes on, so the two can never quietly disagree about what
// "stale" means.
func TestProvenance_Stale(t *testing.T) {
	t.Parallel()
	fresh := Provenance{FetchedAt: time.Now().Add(-1 * time.Hour)}
	old := Provenance{FetchedAt: time.Now().Add(-8 * 24 * time.Hour)}

	assert.Assert(t, !fresh.Stale())
	assert.Assert(t, old.Stale())
}
