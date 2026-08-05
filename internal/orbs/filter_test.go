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

package orbs_test

import (
	"testing"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
	"github.com/CircleCI-Labs/circleci-editor/internal/orbs"
)

// privatePkg builds a private orb (is_private on the v3 API): one published
// version, and listed within its own org, which is the ordinary shape -- an
// orb can be private *and* listed, so this fixture must not conflate the two
// (see circleci.OrbPackage.Listed).
func privatePkg(name string) orbs.OrbPackage {
	p := pkg(name, false, true)
	p.Private = true
	return p
}

func TestParseFilter(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want orbs.Filter
		ok   bool
	}{
		{"", orbs.FilterAll, true},
		{"all", orbs.FilterAll, true},
		{"certified", orbs.FilterCertified, true},
		{"private", orbs.FilterPrivate, true},
		// "partner" is the one a caller is most likely to try, since the orb
		// registry's own UI offers it. It is deliberately *not* accepted:
		// there is no partner data on any CircleCI API this host can call
		// (see orbs.Filter's doc comment), so answering it would mean either
		// inventing a classification or silently returning an unfiltered
		// list under a partner label.
		{"partner", orbs.FilterAll, false},
		{"Certified", orbs.FilterAll, false},
		{"public", orbs.FilterAll, false},
	} {
		got, ok := orbs.ParseFilter(tc.raw)
		assert.Equal(t, ok, tc.ok, "ParseFilter(%q) ok", tc.raw)
		assert.Equal(t, got, tc.want, "ParseFilter(%q) filter", tc.raw)
	}
}

func TestFilter_Matches(t *testing.T) {
	certified := pkg("circleci/node", true, true)
	community := pkg("acme/thing", false, true)
	private := privatePkg("myorg/deploy")

	assert.Assert(t, orbs.FilterAll.Matches(certified))
	assert.Assert(t, orbs.FilterAll.Matches(community))
	assert.Assert(t, orbs.FilterAll.Matches(private))

	assert.Assert(t, orbs.FilterCertified.Matches(certified))
	assert.Assert(t, !orbs.FilterCertified.Matches(community))
	assert.Assert(t, !orbs.FilterCertified.Matches(private))

	assert.Assert(t, orbs.FilterPrivate.Matches(private))
	assert.Assert(t, !orbs.FilterPrivate.Matches(certified))
	assert.Assert(t, !orbs.FilterPrivate.Matches(community))
}

// filterFixture mixes all three scopes, with one orb matching the query
// "node" in each, so a filtered search has something to keep and something to
// drop.
func filterFixture() []orbs.OrbPackage {
	return []orbs.OrbPackage{
		pkg("circleci/node", true, true),    // certified, matches "node"
		pkg("circleci/slack", true, true),   // certified, does not match
		pkg("acme/node-tools", false, true), // community, matches
		privatePkg("myorg/node-internal"),   // private, matches
		privatePkg("myorg/deploy"),          // private, does not match
	}
}

func TestSearchFiltered_CertifiedScopesResultsAndReportsWhatItHid(t *testing.T) {
	page := orbs.SearchFiltered(filterFixture(), "node", orbs.FilterCertified, 10)

	assert.DeepEqual(t, names(page.Results), []string{"circleci/node"})
	assert.Equal(t, page.Filter, orbs.FilterCertified)
	assert.Equal(t, page.Matched, 1)
	// The whole point of the counts: three orbs match "node", and the filter
	// is the reason two of them are not on screen.
	assert.Equal(t, page.MatchedUnfiltered, 3)
	assert.Equal(t, page.ScopeSize, 2)
}

func TestSearchFiltered_PrivateScopesToPrivateOrbs(t *testing.T) {
	page := orbs.SearchFiltered(filterFixture(), "node", orbs.FilterPrivate, 10)

	assert.DeepEqual(t, names(page.Results), []string{"myorg/node-internal"})
	assert.Equal(t, page.Matched, 1)
	assert.Equal(t, page.MatchedUnfiltered, 3)
	assert.Equal(t, page.ScopeSize, 2)
}

// A query matching nothing *within* the scope must still report a non-zero
// ScopeSize, so the UI can say "none of your private orbs match this" rather
// than the materially different "you have no private orbs".
func TestSearchFiltered_ScopeSizeSurvivesAZeroMatchQuery(t *testing.T) {
	page := orbs.SearchFiltered(filterFixture(), "zzzznothing", orbs.FilterPrivate, 10)

	assert.Equal(t, len(page.Results), 0)
	assert.Equal(t, page.Matched, 0)
	assert.Equal(t, page.MatchedUnfiltered, 0)
	assert.Equal(t, page.ScopeSize, 2)
}

// ...and when there genuinely are no private orbs cached at all, ScopeSize is
// zero. That is the distinction the UI turns into two different sentences.
func TestSearchFiltered_ScopeSizeIsZeroWhenNothingIsInScope(t *testing.T) {
	pkgs := []orbs.OrbPackage{pkg("circleci/node", true, true), pkg("acme/thing", false, true)}

	page := orbs.SearchFiltered(pkgs, "node", orbs.FilterPrivate, 10)
	assert.Equal(t, len(page.Results), 0)
	assert.Equal(t, page.ScopeSize, 0)
	assert.Equal(t, page.MatchedUnfiltered, 1)
}

// An empty query is the browse case: the filter still scopes the list, and
// the counts describe what could be browsed rather than what matched.
func TestSearchFiltered_EmptyQueryBrowsesWithinScope(t *testing.T) {
	page := orbs.SearchFiltered(filterFixture(), "", orbs.FilterPrivate, 10)

	assert.DeepEqual(t, names(page.Results), []string{"myorg/deploy", "myorg/node-internal"})
	assert.Equal(t, page.Matched, 2)
	assert.Equal(t, page.MatchedUnfiltered, 5)
	assert.Equal(t, page.ScopeSize, 2)
}

// A reserved orb name with no published version cannot be referenced in a
// config, so it is not something the user could pick within a scope either --
// the browse counts exclude it, exactly as defaultResults excludes it from
// the list. ScopeSize deliberately still counts it: "does this cache hold any
// private orbs at all" is a question about the crawl, not about what is
// referenceable.
func TestSearchFiltered_EmptyQueryBrowseCountsExcludeUnusableOrbs(t *testing.T) {
	unusable := orbs.OrbPackage{OrbPackage: circleci.OrbPackage{Name: "myorg/reserved", Private: true, Listed: true}}
	pkgs := append(filterFixture(), unusable)

	page := orbs.SearchFiltered(pkgs, "", orbs.FilterPrivate, 10)
	assert.DeepEqual(t, names(page.Results), []string{"myorg/deploy", "myorg/node-internal"})
	assert.Equal(t, page.Matched, 2)
	assert.Equal(t, page.ScopeSize, 3)
}

// FilterAll must reproduce Search exactly -- Search is a wrapper around this
// function precisely so the two can never diverge, and this pins that.
func TestSearchFiltered_FilterAllMatchesSearch(t *testing.T) {
	pkgs := filterFixture()

	for _, query := range []string{"", "node", "slack", "zzz"} {
		page := orbs.SearchFiltered(pkgs, query, orbs.FilterAll, 10)
		assert.DeepEqual(t, names(page.Results), names(orbs.Search(pkgs, query, 10)))
		assert.Equal(t, page.Matched, page.MatchedUnfiltered, "query %q", query)
		assert.Equal(t, page.ScopeSize, len(pkgs), "query %q", query)
	}
}

// An empty Filter (the zero value, e.g. from a struct literal that never set
// it) is normalised to FilterAll rather than matching nothing.
func TestSearchFiltered_EmptyFilterIsAll(t *testing.T) {
	page := orbs.SearchFiltered(filterFixture(), "node", "", 10)

	assert.Equal(t, page.Filter, orbs.FilterAll)
	assert.Equal(t, len(page.Results), 3)
}

// Counts are of *matches*, not of the returned page: a limit that truncates
// the results must not make the counts under-report, or the UI would blame the
// filter for what the limit did.
func TestSearchFiltered_CountsIgnoreTheLimit(t *testing.T) {
	page := orbs.SearchFiltered(filterFixture(), "node", orbs.FilterAll, 1)

	assert.Equal(t, len(page.Results), 1)
	assert.Equal(t, page.Matched, 3)
	assert.Equal(t, page.MatchedUnfiltered, 3)
}

func TestSearchFiltered_NonPositiveLimitReturnsNoResults(t *testing.T) {
	page := orbs.SearchFiltered(filterFixture(), "node", orbs.FilterCertified, 0)
	assert.Equal(t, len(page.Results), 0)
	assert.Equal(t, page.Filter, orbs.FilterCertified)
}
