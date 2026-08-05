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
	"fmt"
	"testing"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
	"github.com/CircleCI-Labs/circleci-editor/internal/orbs"
)

// pkg builds a realistic searchable orb: one with at least one published
// version. Ranking deliberately demotes orbs with no versions, since they
// cannot be referenced in a config, so fixtures must carry a version unless a
// test is specifically exercising that case (see pkgNoVersions).
func pkg(name string, certified, listed bool) orbs.OrbPackage {
	return orbs.OrbPackage{
		OrbPackage: circleci.OrbPackage{
			Name:     name,
			Listed:   listed,
			Versions: []circleci.OrbVersion{{ID: name + "-v1", Version: "1.0.0"}},
		},
		Certified: certified,
	}
}

// pkgNoVersions builds a reserved orb name with no published version.
func pkgNoVersions(name string, certified, listed bool) orbs.OrbPackage {
	return orbs.OrbPackage{
		OrbPackage: circleci.OrbPackage{Name: name, Listed: listed},
		Certified:  certified,
	}
}

func names(results []orbs.Result) []string {
	out := make([]string, len(results))
	for i, r := range results {
		out[i] = r.Package.Name
	}
	return out
}

func TestSearch_FindsOrbWithoutNamespace(t *testing.T) {
	pkgs := []orbs.OrbPackage{
		pkg("cci-labs/act", false, true),
		pkg("circleci/node", true, true),
		pkg("someorg/reaction", false, true),
	}

	results := orbs.Search(pkgs, "act", 10)
	assert.Assert(t, len(results) > 0, "expected at least one result for %q", "act")
	assert.Equal(t, results[0].Package.Name, "cci-labs/act")
	assert.Equal(t, results[0].MatchedOn, orbs.MatchExactName)
}

func TestSearch_ExactBeatsPrefixBeatsFuzzy(t *testing.T) {
	pkgs := []orbs.OrbPackage{
		pkg("circleci/node", true, true),         // exact name match on "node"
		pkg("circleci/node-toolbox", true, true), // prefix match on "node"
		pkg("acme/nnooddee", false, true),        // fuzzy subsequence match on "node"
	}

	results := orbs.Search(pkgs, "node", 10)
	assert.DeepEqual(t, names(results), []string{"circleci/node", "circleci/node-toolbox", "acme/nnooddee"})
	assert.Equal(t, results[0].MatchedOn, orbs.MatchExactName)
	assert.Equal(t, results[1].MatchedOn, orbs.MatchPrefixName)
	assert.Equal(t, results[2].MatchedOn, orbs.MatchFuzzy)
}

func TestSearch_RanksCertifiedNodeAboveIncidentalSubstring(t *testing.T) {
	pkgs := []orbs.OrbPackage{
		pkg("circleci/node", true, true),
		pkg("someorg/anode-adjacent-thing", false, true), // "node" only as a substring
	}

	results := orbs.Search(pkgs, "node", 10)
	assert.Assert(t, len(results) == 2)
	assert.Equal(t, results[0].Package.Name, "circleci/node")
}

func TestSearch_NamespacePrefixMatch(t *testing.T) {
	pkgs := []orbs.OrbPackage{
		pkg("cci-labs/act", false, true),
		pkg("unrelated/other", false, true),
	}

	results := orbs.Search(pkgs, "cci-lab", 10)
	assert.Equal(t, len(results), 1)
	assert.Equal(t, results[0].Package.Name, "cci-labs/act")
	assert.Equal(t, results[0].MatchedOn, orbs.MatchPrefixNamespace)
}

func TestSearch_ExactFullNameBeatsExactName(t *testing.T) {
	pkgs := []orbs.OrbPackage{
		pkg("circleci/node", true, true),
		pkg("somewhere/circleci/node", false, true), // not a realistic name, just exercises the tier
	}
	// "circleci/node" should match its own full name exactly, ranking
	// above anything that only matches the bare "node" part.
	results := orbs.Search(pkgs, "circleci/node", 10)
	assert.Assert(t, len(results) > 0)
	assert.Equal(t, results[0].Package.Name, "circleci/node")
	assert.Equal(t, results[0].MatchedOn, orbs.MatchExactFullName)
}

func TestSearch_CaseInsensitive(t *testing.T) {
	pkgs := []orbs.OrbPackage{pkg("CircleCI/Node", true, true)}

	results := orbs.Search(pkgs, "NODE", 10)
	assert.Equal(t, len(results), 1)
	assert.Equal(t, results[0].MatchedOn, orbs.MatchExactName)
}

func TestSearch_EmptyQueryReturnsCertified(t *testing.T) {
	pkgs := []orbs.OrbPackage{
		pkg("circleci/node", true, true),
		pkg("circleci/go", true, true),
		pkg("someorg/uncertified", false, true),
	}

	results := orbs.Search(pkgs, "", 10)
	assert.DeepEqual(t, names(results), []string{"circleci/go", "circleci/node"})
}

func TestSearch_EmptyQueryFallsBackWhenNothingCertified(t *testing.T) {
	pkgs := []orbs.OrbPackage{
		pkg("someorg/b", false, true),
		pkg("someorg/a", false, true),
	}

	results := orbs.Search(pkgs, "", 10)
	assert.DeepEqual(t, names(results), []string{"someorg/a", "someorg/b"})
}

func TestSearch_LimitIsRespected(t *testing.T) {
	pkgs := []orbs.OrbPackage{
		pkg("a/act1", false, true),
		pkg("b/act2", false, true),
		pkg("c/act3", false, true),
	}

	results := orbs.Search(pkgs, "act", 2)
	assert.Equal(t, len(results), 2)
}

func TestSearch_NonPositiveLimitReturnsNil(t *testing.T) {
	pkgs := []orbs.OrbPackage{pkg("a/act", false, true)}
	assert.Equal(t, len(orbs.Search(pkgs, "act", 0)), 0)
	assert.Equal(t, len(orbs.Search(pkgs, "act", -1)), 0)
}

func TestSearch_NoMatchReturnsEmpty(t *testing.T) {
	pkgs := []orbs.OrbPackage{pkg("a/act", false, true)}
	results := orbs.Search(pkgs, "zzz-nomatch-zzz", 10)
	assert.Equal(t, len(results), 0)
}

// BenchmarkSearch exercises Search over a synthetic ~6,400-entry corpus
// (matching the approximate size of the real public orb registry), to
// demonstrate it stays fast enough to run on every keystroke.
func BenchmarkSearch(b *testing.B) {
	const corpusSize = 6400
	pkgs := make([]orbs.OrbPackage, corpusSize)
	namespaces := []string{"circleci", "cci-labs", "someorg", "anotherorg", "widgets-inc"}
	for i := 0; i < corpusSize; i++ {
		ns := namespaces[i%len(namespaces)]
		pkgs[i] = pkg(fmt.Sprintf("%s/orb-%d", ns, i), i%80 == 0, true)
	}
	// Plant a realistic needle so the benchmark also exercises every tier
	// of classify rather than always bailing out on a full miss.
	pkgs[42] = pkg("cci-labs/act", false, true)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = orbs.Search(pkgs, "act", 25)
	}
}

// TestSearch_CertifiedOutranksAlphabeticallyEarlierCommunityOrb covers a
// ranking regression found against the live registry: because nearly every
// registry orb is listed, treating "certified OR listed" as one signal gave
// every orb the same bonus, so alphabetical order decided the winner and
// searching "node" surfaced agence-adeliom/node above circleci/node.
func TestSearch_CertifiedOutranksAlphabeticallyEarlierCommunityOrb(t *testing.T) {
	t.Parallel()

	pkgs := []orbs.OrbPackage{
		pkg("agence-adeliom/node", false, true),
		pkg("ahmadnassri/node", false, true),
		pkg("circleci/node", true, true),
	}

	results := orbs.Search(pkgs, "node", 10)

	assert.Assert(t, len(results) > 0)
	assert.Equal(t, results[0].Package.Name, "circleci/node",
		"the certified orb must rank first even though community orbs sort earlier alphabetically")
}

// TestSearch_UnusableOrbsRankBelowUsableOnes covers reserved orb names that
// have no published version: they cannot be referenced in a config, so however
// well the name matches they must not outrank a usable orb.
func TestSearch_UnusableOrbsRankBelowUsableOnes(t *testing.T) {
	t.Parallel()

	pkgs := []orbs.OrbPackage{
		pkgNoVersions("aaa/slack", false, true), // exact name match, but unusable
		pkg("zzz/slack", false, true),           // exact name match and usable
	}

	results := orbs.Search(pkgs, "slack", 10)

	assert.Equal(t, len(results), 2)
	assert.Equal(t, results[0].Package.Name, "zzz/slack",
		"an orb with a published version must outrank a reserved name with none")
}

// TestSearch_EmptyQueryExcludesUnusableOrbs keeps the browse list free of orbs
// that cannot be added to a config.
func TestSearch_EmptyQueryExcludesUnusableOrbs(t *testing.T) {
	t.Parallel()

	pkgs := []orbs.OrbPackage{
		pkgNoVersions("circleci/reserved", true, true),
		pkg("circleci/node", true, true),
	}

	results := orbs.Search(pkgs, "", 10)

	assert.Equal(t, len(results), 1)
	assert.Equal(t, results[0].Package.Name, "circleci/node")
}
