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

// Filter scopes a search to one subset of the cached registry (issue #151:
// "some of those filters that you have on the orb registry").
//
// # Why there is no FilterPartner
//
// The orb registry's own "Filter by Orb Type" control offers three choices:
// All, "Certified & Partner" (one combined option, not two), and Popular. It
// is not backed by the CircleCI API at all -- the developer hub queries an
// Algolia index (index "orbs-prod") whose documents carry is_certified,
// is_partner and stats_30_days.orgs, and the combined option is literally the
// Algolia filter string `is_certified:true OR is_partner:true`.
//
// None of that reaches any CircleCI API this host can call. Verified against
// the live API rather than assumed:
//
//   - GET /api/v3/orb/packages returns exactly three attributes per package:
//     name, is_private, is_listed. There is no partner, tier, publisher or
//     badge field.
//   - filter[certified] is real and applied (filter[certified]=true returns
//     circleci/act first; unfiltered returns a11ywatch/a11ywatch). This is
//     what Cache.warmCertified relies on.
//   - Every partner-shaped filter parameter is silently *ignored*, not
//     rejected: filter[partner], filter[is_partner], filter[tier]=partner,
//     filter[publisher]=partner and filter[category]=partner each return the
//     identical unfiltered first page. A "partner" filter built on one of
//     those would therefore be a no-op that looked like it worked.
//   - The graphql-unstable `orbs` field accepts only first, after,
//     certifiedOnly and categoryIds (the API names them in its own
//     "defined-arguments" error), and type Orb has no partner/isPartner
//     field. Its orbCategories are functional ("Testing", "Deployment", ...)
//     with no partner category.
//
// So partner status is not derivable, and the only ways to approximate it are
// a hardcoded namespace list or scraping the dev hub's Algolia index. Both
// would mislabel orbs this app has never verified, and a mislabelled orb is
// worse than an absent filter -- see the same reasoning already recorded on
// OrbBrowser's ResultBadges, which declines to render a Partner badge for
// exactly this reason. If CircleCI ever exposes partner status on the v3
// package attributes, adding FilterPartner here is a two-line change.
type Filter string

const (
	// FilterAll is the unscoped default: every package the cache holds.
	FilterAll Filter = "all"

	// FilterCertified scopes to orbs CircleCI certifies -- the one registry
	// distinction the v3 API genuinely supports (filter[certified], crawled
	// by Cache.warmCertified and carried on OrbPackage.Certified).
	FilterCertified Filter = "certified"

	// FilterPrivate scopes to orbs private to their namespace's
	// organization, read from each package's own is_private attribute (see
	// circleci.OrbPackage.Private).
	//
	// An earlier version of this comment said filter[visibility] was
	// accepted but ignored by the API outright. That was wrong: the filter
	// does work, but only combined with filter[namespace_id] (see
	// circleci.ListOrbsOptions.Visibility) -- and nothing in this codebase
	// ever sends a namespace, because the cache's only crawl
	// (Cache.warmFull) is deliberately unscoped.
	//
	// The practical consequence is worse than "incomplete," and worth
	// stating plainly rather than softening: an unfiltered listing doesn't
	// just drop visibility as a signal, it excludes private orbs entirely.
	// Verified live against the circleci namespace -- 79 orbs with no
	// filters, a disjoint 2 (both private) only when namespace_id and
	// visibility=private are sent together. warmFull sends neither, so no
	// private orb ever reaches the cache regardless of what the host's
	// token can see, and FilterPrivate matches nothing in practice today.
	// That is the actual subject of issue #68, not a hypothetical edge
	// case. Closing it means teaching the warm path to also crawl
	// namespace_id+visibility=private for namespaces the token can see --
	// which in turn needs a way to learn those namespaces, since no
	// org-to-namespaces listing API exists yet (see Cache.warmFull).
	FilterPrivate Filter = "private"
)

// ParseFilter maps a request parameter to a Filter. An empty value means
// FilterAll; anything else unrecognised reports ok=false so the caller can
// reject it rather than silently answering an unfiltered search, which would
// leave the user looking at results their chosen filter should have excluded.
func ParseFilter(raw string) (Filter, bool) {
	switch Filter(raw) {
	case "", FilterAll:
		return FilterAll, true
	case FilterCertified:
		return FilterCertified, true
	case FilterPrivate:
		return FilterPrivate, true
	default:
		return FilterAll, false
	}
}

// Matches reports whether pkg falls within f's scope.
func (f Filter) Matches(pkg OrbPackage) bool {
	switch f {
	case FilterCertified:
		return pkg.Certified
	case FilterPrivate:
		return pkg.Private
	case FilterAll:
		return true
	default:
		// The zero value (which SearchFiltered normalises to FilterAll) and
		// anything ParseFilter would have rejected: scope to everything, since
		// a Filter that matched nothing would silently empty a result list
		// rather than failing where it could be noticed.
		return true
	}
}
