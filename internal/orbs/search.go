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

package orbs

import (
	"sort"
	"strings"
)

// MatchedOn labels describing why a Result matched the search query, best
// to worst; see Search's doc comment for the full ranking rules.
const (
	MatchExactFullName   = "exact-full-name"
	MatchExactName       = "exact-name"
	MatchPrefixName      = "prefix-name"
	MatchPrefixNamespace = "prefix-namespace"
	MatchSubstring       = "substring"
	MatchFuzzy           = "fuzzy"
	// matchDefault labels a Result returned for an empty query (see
	// defaultResults), which was never actually matched against anything.
	matchDefault = "default"
)

// Result is a single ranked hit returned by Search.
type Result struct {
	Package   OrbPackage
	Score     int
	MatchedOn string

	// tier is the match tier from classify, retained unexported so
	// sortResults can rank on it directly rather than inferring it from
	// Score, which also carries tie-break adjustments.
	tier int
}

// tierScore assigns each match tier (see classify) a base Score, with
// better tiers scoring higher. The 1000-point gap between tiers is far
// larger than the small in-tier nudges matchScore applies below, so those
// nudges can never promote a worse-tier match above a better one.
var tierScore = map[int]int{
	0: 6000, // exact match on the full "<namespace>/<name>"
	1: 5000, // exact match on the orb name alone (ignoring namespace)
	2: 4000, // orb name starts with the query
	3: 3000, // namespace starts with the query
	4: 2000, // query appears anywhere in "<namespace>/<name>"
	5: 1000, // fuzzy subsequence match
}

// Search ranks pkgs against query, case-insensitively, and returns up to
// limit results, best match first.
//
// Deliberately, no tier requires (or even examines) a namespace prefix on
// its own: a user typing "act" should find "cci-labs/act" without knowing,
// or typing, which namespace publishes it. This matters because the
// CircleCI v3 orb registry API has no server-side fuzzy or prefix search of
// its own (see internal/circleci.ListOrbsOptions.Name) — ranking is done
// entirely here, against the locally cached copy of the registry.
//
// Ranking, best to worst:
//
//  1. exact match on the full "<namespace>/<name>"
//  2. exact match on the orb name alone (the part after "/")
//  3. orb name starts with the query
//  4. namespace starts with the query
//  5. query appears anywhere in "<namespace>/<name>"
//  6. query's characters appear, in order (not necessarily contiguously),
//     within "<namespace>/<name>" — a light fuzzy match
//
// Within a tier, ties are broken by: certified or registry-listed orbs
// first, then shorter names, then alphabetically.
//
// An empty query returns the most useful default set — certified orbs,
// alphabetically — rather than nothing, so the UI has something sensible to
// show before the user has typed anything.
//
// Search does no regular-expression compilation (or other per-candidate
// heavy work), so it stays fast enough to run on every keystroke even over
// the ~6,400-orb public registry; see BenchmarkSearch.
//
// Search is the unscoped, count-free form of SearchFiltered — use that when
// the caller needs a registry-style filter (see Filter) or the match counts
// needed to explain why a filtered list is short.
func Search(pkgs []OrbPackage, query string, limit int) []Result {
	return SearchFiltered(pkgs, query, FilterAll, limit).Results
}

// Page is what SearchFiltered returns: one ranked page of results plus the
// counts a UI needs to explain a short list.
//
// The counts exist for one specific requirement of issue #151 -- "the result
// count should make it obvious when a filter is why something isn't showing
// up". A filter that quietly shortens a list is indistinguishable, from the
// user's side, from an orb that does not exist, so Matched and
// MatchedUnfiltered are reported separately and the difference between them
// is exactly "how much this filter is hiding".
type Page struct {
	// Results is the ranked page, best match first, capped at limit.
	Results []Result

	// Filter is the filter actually applied (never the empty string --
	// SearchFiltered normalises an empty Filter to FilterAll), echoed back so
	// a caller rendering this page never has to assume what produced it.
	Filter Filter

	// Matched is how many packages matched within Filter's scope, counted
	// before Results was truncated to limit.
	//
	// For an empty query -- the browse case, where nothing was "matched"
	// against anything -- this and MatchedUnfiltered instead count the
	// packages *eligible* to be browsed (i.e. usable ones: a reserved orb
	// name with no published version can never be referenced in a config, so
	// it is not something the user could pick either way).
	Matched int

	// MatchedUnfiltered is the same count with the filter removed. Equal to
	// Matched when Filter is FilterAll; the shortfall against Matched is what
	// the active filter is hiding.
	MatchedUnfiltered int

	// ScopeSize is how many cached packages fall in Filter's scope at all,
	// regardless of the query. This is what distinguishes "your query matched
	// none of your private orbs" (ScopeSize > 0) from "no private orbs were
	// found at all" (ScopeSize == 0) -- two situations that look identical in
	// an empty result list and mean entirely different things. Counted over
	// every package, usable or not, since "do any private orbs exist here"
	// is a question about the cache's contents rather than about what is
	// referenceable.
	ScopeSize int
}

// SearchFiltered ranks pkgs against query within filter's scope, returning up
// to limit results (best match first) alongside the counts described on Page.
//
// Ranking and the empty-query browse list are exactly Search's, applied to the
// filtered subset: filtering narrows *which* packages are candidates and never
// reorders the ones that survive. Passing FilterAll therefore reproduces
// Search's behaviour precisely, which is why Search is now a thin wrapper
// rather than a separate code path that could drift from this one.
func SearchFiltered(pkgs []OrbPackage, query string, filter Filter, limit int) Page {
	if filter == "" {
		filter = FilterAll
	}
	page := Page{Filter: filter}
	if limit <= 0 {
		return page
	}

	for _, pkg := range pkgs {
		if filter.Matches(pkg) {
			page.ScopeSize++
		}
	}

	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		// Browse: no query to match against, so the counts describe what
		// could be browsed rather than what matched. defaultResults filters
		// to usable packages itself; doing it here too lets one pass produce
		// both counts and the candidate slice.
		scoped := make([]OrbPackage, 0, page.ScopeSize)
		for _, pkg := range pkgs {
			if !isUsable(pkg) {
				continue
			}
			page.MatchedUnfiltered++
			if !filter.Matches(pkg) {
				continue
			}
			page.Matched++
			scoped = append(scoped, pkg)
		}
		page.Results = defaultResults(scoped, limit)
		return page
	}

	results := make([]Result, 0, limit)
	for _, pkg := range pkgs {
		tier, matchedOn, ok := classify(q, pkg.Name)
		if !ok {
			continue
		}
		page.MatchedUnfiltered++
		if !filter.Matches(pkg) {
			continue
		}
		page.Matched++
		results = append(results, Result{
			Package:   pkg,
			Score:     matchScore(tier, pkg),
			MatchedOn: matchedOn,
			tier:      tier,
		})
	}

	sortResults(results)

	if len(results) > limit {
		results = results[:limit]
	}
	page.Results = results
	return page
}

// classify reports whether (already-lowercased) query matches full — a
// package's "<namespace>/<name>", also already lowercased by the caller —
// and if so, which tier (lower is better; see tierScore) and MatchedOn label
// apply.
func classify(query, full string) (tier int, matchedOn string, ok bool) {
	full = strings.ToLower(full)
	namespace, name := splitOrbName(full)

	switch {
	case full == query:
		return 0, MatchExactFullName, true
	case name == query:
		return 1, MatchExactName, true
	case strings.HasPrefix(name, query):
		return 2, MatchPrefixName, true
	case strings.HasPrefix(namespace, query):
		return 3, MatchPrefixNamespace, true
	case strings.Contains(full, query):
		return 4, MatchSubstring, true
	case isSubsequence(query, full):
		return 5, MatchFuzzy, true
	default:
		return 0, "", false
	}
}

// splitOrbName splits a lowercased "<namespace>/<name>" into its two parts.
// If full has no "/", namespace is empty and name is all of full.
func splitOrbName(full string) (namespace, name string) {
	idx := strings.IndexByte(full, '/')
	if idx < 0 {
		return "", full
	}
	return full[:idx], full[idx+1:]
}

// isSubsequence reports whether every byte of query appears in s, in order,
// not necessarily contiguously (e.g. "ndjs" is a subsequence of "node-js").
func isSubsequence(query, s string) bool {
	if query == "" {
		return true
	}
	qi := 0
	for i := 0; i < len(s) && qi < len(query); i++ {
		if s[i] == query[qi] {
			qi++
		}
	}
	return qi == len(query)
}

// matchScore turns a match tier into a Score for callers that want a single
// comparable number. Ordering itself is decided by sortResults, which applies
// the tie-break signals as explicit keys; keeping them out of one packed
// integer avoids the arithmetic collisions that let a weak signal cancel a
// strong one.
//
// Certified is weighted far above the name-length nudge, and both stay well
// inside the 1000-point gap between tiers so a better match always wins.
func matchScore(tier int, pkg OrbPackage) int {
	score := tierScore[tier]
	if pkg.Certified {
		score += 100
	}
	if pkg.Listed {
		score += 5
	}
	if !isUsable(pkg) {
		score -= 200
	}
	// Reward shorter names slightly.
	penalty := len(pkg.Name)
	if penalty > 4 {
		penalty = 4
	}
	score -= penalty
	return score
}

// isUsable reports whether an orb can actually be referenced in a config.
// A reserved orb name with no published version cannot be, so such entries
// must never outrank a usable orb that matched equally well.
func isUsable(pkg OrbPackage) bool {
	return len(pkg.Versions) > 0
}

// sortResults orders results best-first using explicit ranked keys rather
// than one packed score.
//
// The key order matters and is deliberate: an orb the user cannot reference
// (no published version) is useless however well its name matches, and an
// official CircleCI orb is almost always what someone typing "node" or
// "slack" wants. Ranking certification above name length and alphabetical
// order is what makes "node" resolve to circleci/node instead of an
// alphabetically earlier community orb of the same name.
func sortResults(results []Result) {
	sort.SliceStable(results, func(i, j int) bool {
		a, b := results[i], results[j]

		if a.tier != b.tier {
			return a.tier < b.tier // Lower tier is a better match.
		}
		if ua, ub := isUsable(a.Package), isUsable(b.Package); ua != ub {
			return ua // Usable orbs first.
		}
		if a.Package.Certified != b.Package.Certified {
			return a.Package.Certified // Official orbs first.
		}
		if a.Package.Listed != b.Package.Listed {
			return a.Package.Listed // Registry-listed before unlisted.
		}
		if la, lb := len(a.Package.Name), len(b.Package.Name); la != lb {
			return la < lb // Shorter, more likely-canonical names first.
		}
		return strings.ToLower(a.Package.Name) < strings.ToLower(b.Package.Name)
	})
}

// defaultResults returns Search's result set for an empty query: certified
// orbs (falling back to whatever is available if none are certified yet,
// e.g. in the brief window before the certified stage of a cold cache warm
// completes), alphabetically, capped at limit.
func defaultResults(pkgs []OrbPackage, limit int) []Result {
	// Reserved orb names with no published version cannot be referenced in a
	// config, so they are never worth browsing.
	usable := make([]OrbPackage, 0, len(pkgs))
	for _, pkg := range pkgs {
		if isUsable(pkg) {
			usable = append(usable, pkg)
		}
	}

	candidates := make([]OrbPackage, 0, len(usable))
	for _, pkg := range usable {
		if pkg.Certified {
			candidates = append(candidates, pkg)
		}
	}
	if len(candidates) == 0 {
		candidates = usable
	}

	sort.Slice(candidates, func(i, j int) bool {
		return strings.ToLower(candidates[i].Name) < strings.ToLower(candidates[j].Name)
	})

	if len(candidates) > limit {
		candidates = candidates[:limit]
	}

	results := make([]Result, 0, len(candidates))
	for _, pkg := range candidates {
		results = append(results, Result{Package: pkg, Score: tierScore[0], MatchedOn: matchDefault})
	}
	return results
}
