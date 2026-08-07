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

// Package configcheck finds structural problems in a CircleCI config
// without calling the CircleCI API -- no token, no network, no orb
// resolution (issue #15).
//
// # Why this exists
//
// `validate-own-config` (.circleci/config.yml) used to have exactly one
// check: POST the config to CircleCI's compile-config-with-defaults API.
// That needs a CIRCLE_TOKEN, which CircleCI does not hand to pull requests
// from forks -- so the job quietly skipped on every outside contributor's
// PR, and a broken config went unnoticed until a maintainer's own push
// caught it, or didn't. This package is the check that runs regardless: it
// can never resolve an orb, evaluate a config policy, or catch anything
// that requires knowing what CircleCI itself thinks -- only the API does
// that -- but it catches the things a JSON Schema and a look at the
// document's own internal references can catch on their own, which turns
// out to be most of what actually breaks a config by hand-editing: bad
// YAML, a misspelled top-level key, a workflow that requires a job that
// doesn't exist.
//
// # What it deliberately does not do
//
// It is not a JSON Schema evaluator. internal/schema/schema.json is ~190KB
// of draft-07 (properties, $ref, oneOf/anyOf, definitions for steps,
// executors, orbs...); writing a general evaluator for it -- rather than
// adding a well-known dependency for the job -- would be a second project
// the size of this one, for a payoff this package gets more cheaply by
// asking narrower, config-specific questions instead: is the top level a
// mapping, is every top-level key one the schema actually declares (or an
// unmistakable typo of one -- issue #5's exact bug), does `version:` hold a
// value CircleCI accepts, and does every job a workflow requires actually
// exist. Two things schema.json *is* used for directly: knownTopLevelKeys
// reads schema.json's own `properties` object rather than hand-copying its
// key list (so the two cannot drift), and web/src/lib/validation's
// editDistance.go port below exists because that TypeScript module already
// solved "is this a typo" for the same problem one layer down (a
// misspelled step key) -- porting its algorithm keeps "typo" meaning the
// same thing on both sides of the Go/TypeScript boundary instead of
// reinventing a second definition of it.
//
// # What it does that the schema alone could not
//
// The workflow/job cross-reference check (checkWorkflows) has no
// counterpart in schema.json at all: a JSON Schema validates one node
// against a shape, but "does the job this `requires:` names actually exist
// elsewhere in the document" is a question about the document's own
// internal consistency, not its shape. CircleCI's compiler catches this
// too, of course, but only when it runs -- which is exactly the case this
// package exists for when it doesn't.
package configcheck

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/CircleCI-Labs/circleci-editor/internal/schema"
)

// Issue is one problem found in a config. A Check call that returns no
// Issues found nothing wrong -- it is not a claim that CircleCI would
// accept the config, only that this package's narrower questions all came
// back clean. Callers must keep that distinction visible (see this
// package's doc comment): a caller that renders "no issues" the same way
// it would render "CircleCI validated this" recreates the exact problem
// issue #15 was filed over, one layer up.
type Issue struct {
	Message string
}

// setupKey is a real top-level key (dynamic config's `setup: true`) that is
// missing from the vendored schema.json's `properties` object entirely --
// confirmed the same way web/src/lib/validation/topLevelKeys.ts confirmed
// it (grepping schema.json for the literal string, not assuming), and kept
// here as a one-line addition on top of the schema-derived list rather than
// hand-maintaining the whole list, for the same reason that file gives.
const setupKey = "setup"

// knownVersions lists the top-level `version:` values CircleCI accepts.
// Matched against the YAML scalar's own source text (see
// internal/host/configdir.go's circleCIConfigVersions, which this mirrors):
// unquoted 2.1 parses as a float and quoted "2.1" as a string, but yaml.v3
// preserves "2.1" as the node's Value either way, so comparing strings
// sidesteps the type distinction entirely. schema.json's own `version`
// property enum lists only "2.1"/2.1 -- narrower than what the real
// compiler still accepts (issue: legacy 2 and 2.0 configs still run) -- so
// this list is knowingly wider than the vendored schema, on the same
// "never invent a false positive" principle configdir.go already applies.
var knownVersions = map[string]bool{"2": true, "2.0": true, "2.1": true}

// maxTypoDistance is the largest edit distance still treated as a typo
// rather than a different word -- copied from
// web/src/lib/validation/editDistance.ts's MAX_DISTANCE so "typo" means the
// same amount of damage on both sides of the Go/TypeScript boundary.
const maxTypoDistance = 2

// Check parses contents as a CircleCI config and returns every structural
// problem it can find without a network call. An error return means this
// package itself failed (e.g. the embedded schema.json somehow didn't
// parse) -- never that the config under test is invalid; a bad config is
// reported through the returned []Issue instead, per this package's doc
// comment on Issue.
func Check(contents []byte) ([]Issue, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(contents, &doc); err != nil {
		return []Issue{{Message: fmt.Sprintf("not valid YAML: %s", err)}}, nil
	}

	root := documentRoot(&doc)
	if root == nil {
		return []Issue{{Message: "the file is empty"}}, nil
	}
	if root.Kind != yaml.MappingNode {
		return []Issue{{Message: fmt.Sprintf(
			"the top level of the config must be a YAML mapping (key: value pairs), not %s",
			describeKind(root.Kind))}}, nil
	}

	known, err := knownTopLevelKeys()
	if err != nil {
		return nil, err
	}
	knownList := sortedKeys(known)

	entries := mappingEntries(root)
	top, dupes := firstOfEach(entries)

	var issues []Issue
	for _, d := range dupes {
		issues = append(issues, Issue{Message: fmt.Sprintf(
			"line %d: duplicate top-level key %q -- YAML keeps only the first occurrence, so anything under this later one is silently discarded",
			d.Line, d.Key)})
	}

	for _, e := range entries {
		if known[e.Key] {
			continue
		}
		if replacement, ok := nearestUnique(e.Key, knownList); ok {
			issues = append(issues, Issue{Message: fmt.Sprintf(
				"line %d: top-level key %q looks like a typo of %q -- CircleCI does not validate top-level keys at all (see issue #5), so a misspelled block like this compiles successfully and is simply never read",
				e.Line, e.Key, replacement)})
		}
	}

	if v, ok := top["version"]; !ok {
		issues = append(issues, Issue{Message: `missing required top-level "version" key`})
	} else if v.Value != nil && v.Value.Kind == yaml.ScalarNode && !knownVersions[v.Value.Value] {
		issues = append(issues, Issue{Message: fmt.Sprintf(
			"line %d: version: %q is not a value CircleCI accepts (expected one of 2, 2.0, 2.1)",
			v.Line, v.Value.Value)})
	}

	var jobsNode *yaml.Node
	if e, ok := top["jobs"]; ok {
		jobsNode = e.Value
	}
	jobs, jobDupes := jobNames(jobsNode)
	for _, d := range jobDupes {
		issues = append(issues, Issue{Message: fmt.Sprintf(
			"line %d: duplicate job name %q under jobs: -- only the first definition is ever used", d.Line, d.Key)})
	}

	_, hasOrbs := top["orbs"]

	var workflowsNode *yaml.Node
	if e, ok := top["workflows"]; ok {
		workflowsNode = e.Value
	}
	issues = append(issues, checkWorkflows(workflowsNode, jobs, hasOrbs)...)

	return issues, nil
}

// knownTopLevelKeys returns the top-level keys this check recognises,
// read directly from the vendored schema.json's own `properties` object
// rather than hand-copied, so this list and the schema it is drawn from
// cannot silently diverge (unlike setupKey, which schema.json genuinely
// has no entry for -- see that constant's comment).
func knownTopLevelKeys() (map[string]bool, error) {
	var doc struct {
		Properties map[string]json.RawMessage `json:"properties"`
	}
	if err := json.Unmarshal(schema.JSON(), &doc); err != nil {
		return nil, fmt.Errorf("configcheck: parse vendored schema.json: %w", err)
	}
	known := make(map[string]bool, len(doc.Properties)+1)
	for k := range doc.Properties {
		known[k] = true
	}
	known[setupKey] = true
	return known, nil
}

// checkWorkflows finds workflow job invocations ("- build" or
// "- build: {requires: [...]}") that name a job the rest of the document
// never defines. jobs is the set of top-level job names; hasOrbs is unused
// today -- name resolution already skips any name containing "/" (an
// orb-namespaced job), which is the only case orbs actually affect here.
func checkWorkflows(workflowsNode *yaml.Node, jobs map[string]bool, hasOrbs bool) []Issue {
	_ = hasOrbs
	var issues []Issue

	for _, wf := range mappingEntries(workflowsNode) {
		if wf.Key == "version" {
			// The pre-2.1 `workflows: version: 2` sibling key -- not a
			// workflow name, just a version marker at this nesting level.
			continue
		}

		jobsList := findEntry(mappingEntries(wf.Value), "jobs")
		if jobsList == nil || jobsList.Kind != yaml.SequenceNode {
			// Either this workflow has no `jobs:` list, or it has one in a
			// shape this check doesn't recognise. Either way there is
			// nothing here to cross-reference, and guessing would risk a
			// false positive -- see this package's doc comment on why a
			// narrower, certain check beats a broader, guessing one.
			continue
		}

		type invocation struct {
			key        string
			line       int
			matchName  string
			isApproval bool
			requires   []mapEntry
		}

		invocations := make([]invocation, 0, len(jobsList.Content))
		for _, item := range jobsList.Content {
			key, line, params, ok := jobInvocation(resolveAlias(item))
			if !ok {
				continue
			}

			inv := invocation{key: key, line: line, matchName: key}
			for _, p := range mappingEntries(params) {
				switch {
				case p.Key == "type" && p.Value != nil && p.Value.Value == "approval":
					inv.isApproval = true
				case p.Key == "name" && p.Value != nil && p.Value.Kind == yaml.ScalarNode:
					// A `name:` override is how CircleCI lets a workflow run
					// the same job twice under different names; later
					// `requires:` entries target the override, not the job
					// name itself, so matching has to follow it.
					inv.matchName = p.Value.Value
				case p.Key == "requires" && p.Value != nil && p.Value.Kind == yaml.SequenceNode:
					for _, r := range p.Value.Content {
						r = resolveAlias(r)
						if r.Kind == yaml.ScalarNode {
							inv.requires = append(inv.requires, mapEntry{Key: r.Value, Line: r.Line})
						}
					}
				}
			}
			invocations = append(invocations, inv)

			// An approval gate's own key is a name the author invented for
			// this workflow, not a reference to anything defined under
			// jobs: -- only a real job invocation has to resolve.
			if !inv.isApproval && !strings.Contains(key, "/") && !jobs[key] {
				issues = append(issues, Issue{Message: fmt.Sprintf(
					"line %d: workflow %q uses job %q, which is not defined under this config's jobs: block",
					line, wf.Key, key)})
			}
		}

		// A `requires:` target can be another job in this same workflow, an
		// approval gate defined in it, or (via name: above) a renamed
		// instance of either -- never a name from outside this workflow, so
		// the resolvable set is rebuilt fresh per workflow.
		inWorkflow := make(map[string]bool, len(invocations))
		for _, inv := range invocations {
			inWorkflow[inv.matchName] = true
		}

		for _, inv := range invocations {
			for _, req := range inv.requires {
				if strings.Contains(req.Key, "/") || inWorkflow[req.Key] || jobs[req.Key] {
					continue
				}
				issues = append(issues, Issue{Message: fmt.Sprintf(
					"line %d: workflow %q has %q requiring %q, which is not any job or approval gate in this workflow",
					req.Line, wf.Key, inv.key, req.Key)})
			}
		}
	}

	return issues
}

// jobInvocation reads one entry of a workflow's `jobs:` list: either a bare
// job name ("- build") or a single-key mapping naming the job and carrying
// its parameters ("- build: {requires: [...]}"). ok is false for a shape
// neither of those (e.g. a sequence nested where a mapping was expected),
// which the caller treats as nothing to check rather than an error -- see
// checkWorkflows' doc comment on preferring silence to a guess.
func jobInvocation(item *yaml.Node) (key string, line int, params *yaml.Node, ok bool) {
	if item == nil {
		return "", 0, nil, false
	}
	switch item.Kind {
	case yaml.ScalarNode:
		return item.Value, item.Line, nil, true
	case yaml.MappingNode:
		if len(item.Content) < 2 || item.Content[0].Kind != yaml.ScalarNode {
			return "", 0, nil, false
		}
		keyNode := item.Content[0]
		valNode := resolveAlias(item.Content[1])
		var p *yaml.Node
		if valNode != nil && valNode.Kind == yaml.MappingNode {
			p = valNode
		}
		return keyNode.Value, keyNode.Line, p, true
	case yaml.DocumentNode, yaml.SequenceNode, yaml.AliasNode:
		// None of these are a valid workflow job-list entry: a document
		// node never appears nested, a bare sequence isn't a job
		// invocation shape, and resolveAlias already unwrapped any alias
		// before this function ever sees item. Listed explicitly (rather
		// than folded into a default) so a future Kind added upstream
		// trips the exhaustive linter here instead of silently falling
		// through.
		return "", 0, nil, false
	}
	return "", 0, nil, false
}

// jobNames returns the names declared under a top-level `jobs:` mapping,
// and any that were declared more than once.
func jobNames(jobsNode *yaml.Node) (map[string]bool, []mapEntry) {
	entries := mappingEntries(jobsNode)
	seen, dupes := firstOfEach(entries)
	names := make(map[string]bool, len(seen))
	for k := range seen {
		names[k] = true
	}
	return names, dupes
}

// mapEntry is one key/value pair of a YAML mapping, with the key's source
// line for error messages and its value already alias-resolved (see
// resolveAlias) so every caller gets a real node, never one more hop from
// it.
type mapEntry struct {
	Key   string
	Line  int
	Value *yaml.Node
}

// mappingEntries walks m's key/value pairs in document order. Returns nil
// for a nil node or one that isn't a mapping, so callers on an optional key
// (workflowsNode, jobsNode, a job invocation's params) never need their own
// nil check first.
func mappingEntries(m *yaml.Node) []mapEntry {
	if m == nil || m.Kind != yaml.MappingNode {
		return nil
	}
	entries := make([]mapEntry, 0, len(m.Content)/2)
	for i := 0; i+1 < len(m.Content); i += 2 {
		keyNode := m.Content[i]
		if keyNode.Kind != yaml.ScalarNode {
			continue // a non-scalar mapping key is not valid CircleCI config; nothing to name it by
		}
		entries = append(entries, mapEntry{
			Key:   keyNode.Value,
			Line:  keyNode.Line,
			Value: resolveAlias(m.Content[i+1]),
		})
	}
	return entries
}

// firstOfEach splits entries into a map keyed by its first occurrence of
// each key, and the list of entries that turned out to be later
// duplicates. YAML permits a mapping to repeat a key; the CircleCI parser
// (like most YAML parsers, including this checker's own yaml.Unmarshal
// elsewhere) keeps only the first, so a duplicate is reported as a finding
// rather than silently letting the second occurrence win.
func firstOfEach(entries []mapEntry) (map[string]mapEntry, []mapEntry) {
	seen := make(map[string]mapEntry, len(entries))
	var dupes []mapEntry
	for _, e := range entries {
		if _, ok := seen[e.Key]; ok {
			dupes = append(dupes, e)
			continue
		}
		seen[e.Key] = e
	}
	return seen, dupes
}

// findEntry returns the value of the first entry named key, or nil.
func findEntry(entries []mapEntry, key string) *yaml.Node {
	for _, e := range entries {
		if e.Key == key {
			return e.Value
		}
	}
	return nil
}

// resolveAlias follows a YAML alias (`*name`) to the anchor node it points
// at (`&name`), so callers reading a specific key's value never have to
// tell an alias and a literal apart -- this repo's own .circleci/config.yml
// anchors a `filters:` block for exactly this reason (`&release-filters` /
// `*release-filters`), and a future config could anchor anything else this
// checker looks at just as easily.
func resolveAlias(n *yaml.Node) *yaml.Node {
	for n != nil && n.Kind == yaml.AliasNode {
		n = n.Alias
	}
	return n
}

// documentRoot returns a parsed document's single root node, or nil for an
// empty document (e.g. a file that is all comments).
func documentRoot(doc *yaml.Node) *yaml.Node {
	if doc.Kind != yaml.DocumentNode || len(doc.Content) == 0 {
		return nil
	}
	return doc.Content[0]
}

// describeKind names a YAML node kind the way an error message should read,
// e.g. "the top level ... is not a list".
func describeKind(k yaml.Kind) string {
	switch k {
	case yaml.SequenceNode:
		return "a list"
	case yaml.ScalarNode:
		return "a plain scalar value"
	case yaml.AliasNode:
		return "an alias"
	case yaml.MappingNode, yaml.DocumentNode:
		// Check's only caller already excludes MappingNode before reaching
		// here, and documentRoot never itself returns a DocumentNode --
		// listed anyway so the exhaustive linter, not a silent default,
		// is what notices if that ever stops being true.
		return "a document of an unrecognised shape"
	}
	return "a document of an unrecognised shape"
}

// sortedKeys returns m's keys in sorted order, so a caller comparing a typo
// against every known key (nearestUnique) gets a deterministic candidate
// order and therefore a deterministic tie-break.
func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// editDistance is a Go port of
// web/src/lib/validation/editDistance.ts's optimal string alignment
// distance (Levenshtein plus adjacent transposition), kept algorithmically
// identical rather than reimplemented from scratch so "is this a typo"
// means the same thing in this offline Go check as it does in the editor's
// own client-side diagnostics. The transposition term is not optional: it
// exists there (and here) because "stpes"/"steps" and "chekcout"/"checkout"
// are both single transpositions, which plain Levenshtein scores as 2 --
// level with genuinely unrelated two-edit candidates -- and would erase
// exactly the typos this check is for.
func editDistance(a, b string) int {
	rows, cols := len(a)+1, len(b)+1
	d := make([][]int, rows)
	for i := range d {
		d[i] = make([]int, cols)
		d[i][0] = i
	}
	for j := 0; j < cols; j++ {
		d[0][j] = j
	}

	for i := 1; i < rows; i++ {
		for j := 1; j < cols; j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			d[i][j] = minInt(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+cost)
			if i > 1 && j > 1 && a[i-1] == b[j-2] && a[i-2] == b[j-1] {
				d[i][j] = min2(d[i][j], d[i-2][j-2]+cost)
			}
		}
	}
	return d[len(a)][len(b)]
}

func min2(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func minInt(a, b, c int) int {
	return min2(min2(a, b), c)
}

// nearestUnique is a Go port of
// web/src/lib/validation/editDistance.ts's nearestUnique: the single
// closest candidate to typo, or ("", false) when there isn't exactly one.
// Three conditions all have to hold, matching that module's:
//
//   - the distance is at most maxTypoDistance;
//   - the distance is strictly less than the shorter of the two words, so
//     short names ("os" vs "at") can't "near-match" each other;
//   - no other candidate ties for that distance -- a tie is ambiguity, and
//     ambiguity is declined rather than guessed at.
func nearestUnique(typo string, candidates []string) (string, bool) {
	best := ""
	bestDistance := -1
	tied := false

	for _, candidate := range candidates {
		if candidate == typo {
			return "", false // nothing to fix
		}
		distance := editDistance(typo, candidate)
		if distance > maxTypoDistance {
			continue
		}
		shorter := len(typo)
		if len(candidate) < shorter {
			shorter = len(candidate)
		}
		if distance >= shorter {
			continue
		}
		switch {
		case bestDistance == -1 || distance < bestDistance:
			bestDistance = distance
			best = candidate
			tied = false
		case distance == bestDistance:
			tied = true
		}
	}

	if tied || best == "" {
		return "", false
	}
	return best, true
}
