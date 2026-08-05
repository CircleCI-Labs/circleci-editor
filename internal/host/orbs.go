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

package host

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
	"github.com/CircleCI-Labs/circleci-editor/internal/orbs"
)

const (
	// orbSourceTimeout bounds how long a single GET /api/orbs/source call
	// is allowed to take, including any retries performed by the circleci
	// client and up to two round trips (resolve the package, then fetch
	// the version's source).
	orbSourceTimeout = 20 * time.Second

	// defaultOrbSearchLimit and maxOrbSearchLimit bound the "limit" query
	// parameter accepted by GET /api/orbs/search.
	defaultOrbSearchLimit = 25
	maxOrbSearchLimit     = 100

	// orbSourceCacheMaxEntries bounds the server's in-process cache of
	// fetched orb source text, keyed by orb version ID (see
	// orbSourceCache). It exists because dragging orbs around the editor's
	// UI is expected to re-request the same orb repeatedly.
	orbSourceCacheMaxEntries = 256
)

// orbCacheState names the mutually exclusive answers to "why does the orb list
// look the way it does". It exists because before issue #257 there was no
// answer at all: orbs.Status recorded a failure reason, orbsStatusPayload had
// nowhere to put it, and so an orb list that was empty because the registry
// call failed was byte-for-byte identical to one that was empty because there
// are no orbs. That is the honest-degradation rule broken at the source.
//
// Derived here rather than in the browser so there is exactly one place that
// decides which state is being reported, and so the decision is testable
// without a DOM. The client renders the state; it does not re-infer it from
// the counts.
type orbCacheState string

const (
	// orbCacheNeverFetched: no packages, nothing in flight, no failure
	// recorded. The cache has not been warmed — normally only observable
	// before Start has run.
	orbCacheNeverFetched orbCacheState = "never-fetched"

	// orbCacheFetching: no packages yet, and a crawl is running. Distinct
	// from a failure precisely because waiting is the right response.
	orbCacheFetching orbCacheState = "fetching"

	// orbCacheEmpty: a fetch completed and the registry genuinely reported no
	// orbs. Normal on a CircleCI Server installation, whose registry is
	// private to the installation and seeded one orb at a time by an admin
	// (issue #256) — which is the whole reason this state must be sayable.
	orbCacheEmpty orbCacheState = "empty"

	// orbCacheFailed: no packages, and a recorded reason why. Reason is
	// always set alongside this state.
	orbCacheFailed orbCacheState = "failed"

	// orbCacheStale: packages that are usable but not current — either the
	// most recent refresh failed (Reason set) or the listing is older than
	// orbs.RefreshWindow. An old registry listing is still a real registry
	// listing, so it is served and labelled rather than withheld.
	orbCacheStale orbCacheState = "stale"

	// orbCacheReady: packages, fetched within the refresh window, no
	// recorded failure.
	orbCacheReady orbCacheState = "ready"
)

// orbsStatusPayload is the JSON shape of orbsSearchResponse.Status.
type orbsStatusPayload struct {
	Ready    bool `json:"ready"`
	Complete bool `json:"complete"`
	Count    int  `json:"count"`
	Warming  bool `json:"warming"`

	// CertifiedCount and PrivateCount break Count down by the two facts a
	// search can be filtered on (see orbs.Filter). PrivateCount in
	// particular is what lets the UI avoid the one materially misleading
	// answer here: an empty private-orb list means "nothing private turned up
	// in what this host's token was shown", which is not the same claim as
	// "your organizations have no private orbs".
	CertifiedCount int `json:"certifiedCount"`
	PrivateCount   int `json:"privateCount"`

	// State is which of orbCacheState's cases this cache is in — the field
	// issue #257 exists to add. Always present.
	State orbCacheState `json:"state"`

	// Reason is the classified, body-free description of the most recent
	// refresh failure, or "" when there is none to report.
	//
	// It goes through describeUpstreamError, which discloses an HTTP status
	// code and never err.Error(). orbs.Status.Err is frequently a
	// *circleci.APIError, whose Error() text embeds the upstream response
	// body; forwarding that verbatim would leak it straight to the client,
	// and is why orbs.Status hands over an error value rather than a string.
	Reason string `json:"reason,omitempty"`

	// FetchedAt is when the current listing was fetched, RFC 3339, omitted
	// when nothing complete has ever been fetched. It is what lets the client
	// say how old a stale list is instead of only that it is old.
	FetchedAt string `json:"fetchedAt,omitempty"`

	// Stale mirrors orbs.Status.Stale: the listing is real but past
	// orbs.RefreshWindow. Carried separately from State because a list can be
	// stale *and* have a failure reason, and both facts are worth saying.
	Stale bool `json:"stale,omitempty"`

	// RefreshWindowHours is what Stale is measured against, so the client can
	// name the window rather than assert staleness with nothing behind it.
	RefreshWindowHours int `json:"refreshWindowHours"`

	// SelfHosted reports that this host is configured against something other
	// than circleci.com (CIRCLE_HOST). It changes what an *empty* registry
	// most likely means, and therefore what is honest to say about one: on
	// CircleCI Server an empty orb registry is the ordinary starting state,
	// whereas on cloud it would be a surprise (issue #256).
	SelfHosted bool `json:"selfHosted"`
}

// describeOrbCacheState classifies the cache's warm state, and returns the
// safe, body-free reason to show alongside it (empty when there is none).
//
// The ordering is the substance of this function. With no packages to show,
// "a fetch is running" outranks a recorded failure, because an earlier failed
// stage does not make waiting the wrong advice — the reason is still returned,
// so nothing is hidden by that choice. With packages to show, any recorded
// failure or any age past the refresh window makes them stale rather than
// ready, because "here are your orbs" must not be said about a list this host
// knows it failed to refresh.
func describeOrbCacheState(status orbs.Status) (orbCacheState, string) {
	reason := ""
	if status.Err != nil {
		reason = describeUpstreamError(status.Err)
	}

	if status.Count == 0 {
		switch {
		case status.Warming:
			return orbCacheFetching, reason
		case reason != "":
			return orbCacheFailed, reason
		case status.Complete:
			return orbCacheEmpty, reason
		default:
			return orbCacheNeverFetched, reason
		}
	}

	if reason != "" || status.Stale {
		return orbCacheStale, reason
	}
	return orbCacheReady, reason
}

// toOrbsStatusPayload converts the cache's warm state to its wire shape,
// classifying the failure reason on the way through so no upstream response
// body can reach the client.
func (s *Server) toOrbsStatusPayload(status orbs.Status) *orbsStatusPayload {
	state, reason := describeOrbCacheState(status)

	fetchedAt := ""
	if !status.FetchedAt.IsZero() {
		fetchedAt = status.FetchedAt.UTC().Format(time.RFC3339)
	}

	return &orbsStatusPayload{
		Ready:              status.Ready,
		Complete:           status.Complete,
		Count:              status.Count,
		CertifiedCount:     status.CertifiedCount,
		PrivateCount:       status.PrivateCount,
		Warming:            status.Warming,
		State:              state,
		Reason:             reason,
		FetchedAt:          fetchedAt,
		Stale:              status.Stale,
		RefreshWindowHours: int(orbs.RefreshWindow / time.Hour),
		SelfHosted:         s.env.IsSelfHosted(),
	}
}

// orbsMatchPayload is the JSON shape of orbsSearchResponse.Match: what this
// particular request matched, as opposed to what the cache holds (Status).
//
// Issue #151 asks that "the result count should make it obvious when a filter
// is why something isn't showing up", so Matched and MatchedUnfiltered are
// reported separately -- their difference is exactly what the active filter is
// hiding, which the UI can then say out loud instead of leaving the user to
// wonder whether an orb exists.
type orbsMatchPayload struct {
	// Filter echoes the filter actually applied ("all", "certified" or
	// "private"), so a client never has to assume its request parameter
	// survived.
	Filter string `json:"filter"`

	// Matched, MatchedUnfiltered and ScopeSize are orbs.Page's counts of the
	// same names -- see that type for what each one counts, including how the
	// first two are defined for an empty (browse) query.
	Matched           int `json:"matched"`
	MatchedUnfiltered int `json:"matchedUnfiltered"`
	ScopeSize         int `json:"scopeSize"`
}

// orbSearchResultPayload is the JSON shape of one entry in
// orbsSearchResponse.Results.
type orbSearchResultPayload struct {
	Name      string `json:"name"`
	Private   bool   `json:"private"`
	Certified bool   `json:"certified"`
	// Listed reports whether this orb opted in to registry listing (see
	// circleci.OrbPackage.Listed). Surfaced so the UI can badge the orbs
	// that were resolved (e.g. by exact name, or because they're a
	// caller's own private orb) but wouldn't turn up by browsing the
	// public registry -- distinct from Private, since an orb can be
	// public yet unlisted, or private yet listed within its own org.
	Listed bool `json:"listed"`
	// LatestVersion is always present, empty when the orb has no published
	// version (a reserved name). It is deliberately not omitempty: clients
	// index this field directly, and a missing key is harder to handle than
	// an empty string.
	LatestVersion string   `json:"latestVersion"`
	Versions      []string `json:"versions"`
	MatchedOn     string   `json:"matchedOn"`
}

// orbsSearchResponse is the JSON shape returned by GET /api/orbs/search.
//
// Available is always true today (issue #160 removed the one thing that
// used to set it false: the absence of a CIRCLE_TOKEN, which turned out not
// to be a reason to refuse — the public v3 orb registry answers
// unauthenticated). It follows the same shape as validateResponse.Available
// nonetheless, and is kept rather than dropped: it costs nothing, and a
// future genuine "nothing can be searched at all" case (there is none today)
// has somewhere to go without another wire-format change. When it is false,
// Source and Reason explain why and Status/Match/Results are omitted
// entirely, since there would be no cache to report on and nothing searched.
type orbsSearchResponse struct {
	Available bool                     `json:"available"`
	Source    string                   `json:"source,omitempty"`
	Reason    string                   `json:"reason,omitempty"`
	Status    *orbsStatusPayload       `json:"status,omitempty"`
	Match     *orbsMatchPayload        `json:"match,omitempty"`
	Results   []orbSearchResultPayload `json:"results,omitempty"`
}

// orbsSourceResponse is the JSON shape returned by GET /api/orbs/source.
//
// Available is always true today, for the same reason orbsSearchResponse's
// is (issue #160: GET /api/v3/orb/versions/{id}/source answers
// unauthenticated too, verified live). Kept for the same forward-shape
// reason. When Available is true, Source holds the orb version's raw YAML
// text; when false, Source instead holds the literal string "unavailable"
// and Reason explains why — the same field serves both roles, exactly as
// /api/validate overloads its own "source" field to mean "where this
// response came from" rather than "orb source code" specifically.
//
// Versions/LatestVersion (issue #89's version picker) are deliberately
// carried here rather than only on /api/orbs/search's results: this
// handler resolves pkg via GetOrbPackageByName, a live single-name lookup,
// which the real CircleCI v3 API answers with that orb's *complete*
// version history. /api/orbs/search instead ranks the host's own crawled
// registry cache (orbCache.SearchFiltered) against a query -- and that crawl (see
// package orbs) fetches many packages per page, which the same API answers
// with only each package's newest version embedded, to keep a
// thousands-of-orbs page a sane size. Concretely: GET .../orb/packages
// with a bulk listing returns one version per package; the identical
// endpoint filtered to one exact name returns all of them. So this is the
// only response in this file that can honestly answer "what versions does
// this orb have" -- the UI's version <select> reads it from here, not from
// whatever search happened to carry.
type orbsSourceResponse struct {
	Available bool   `json:"available"`
	Name      string `json:"name,omitempty"`
	Version   string `json:"version,omitempty"`
	Source    string `json:"source"`
	Reason    string `json:"reason,omitempty"`
	// Versions is newest-first, sortVersionsDescending-order, same as
	// orbSearchResultPayload.Versions. Omitted (not just empty) when
	// Available is false, matching every other field here.
	Versions      []string `json:"versions,omitempty"`
	LatestVersion string   `json:"latestVersion,omitempty"`
}

// handleOrbsSearch serves GET /api/orbs/search: it ranks the locally cached
// copy of the CircleCI orb registry against the "q" query parameter (see
// package orbs for the ranking rules), optionally scoped by the "filter"
// parameter (see orbs.ParseFilter), and reports the cache's current warm
// Status plus this request's own match counts alongside the results, so the
// UI can indicate both when results might still be partial and when the
// active filter is why the list is short.
//
// An unrecognised "filter" is a 400 rather than a silently unfiltered search.
// Quietly ignoring it would hand back results the user's chosen filter should
// have excluded, while the UI went on claiming the filter was applied -- the
// same class of invisible-filter confusion the Match counts exist to prevent.
// (That is not a hypothetical failure mode for orb filters: the registry API
// itself silently ignores every unknown filter parameter, which is exactly why
// there is no partner filter here -- see orbs.Filter.)
func (s *Server) handleOrbsSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	// Issue #160: this used to refuse outright whenever this host had no
	// CIRCLE_TOKEN, on the assumption that every orb endpoint needs one. It
	// doesn't: GET /api/v3/orb/packages (the crawl s.orbCache is built from)
	// and GET /api/v3/orb/versions/{id}/source (handleOrbsSource, below) both
	// answer unauthenticated -- verified live, read-only, against the real
	// registry, not inferred from documentation. s.orbCache is warmed
	// regardless of token (see Run's orbWarmer.Start call and
	// buildCircleCIClients, which build the shared *circleci.Client whether or
	// not env.HasToken -- an empty token just means no Circle-Token header is
	// sent, which is exactly what an anonymous request needs).
	//
	// Only *private* orbs genuinely need a token: an unauthenticated crawl
	// simply never sees an organization's private namespace, so
	// orbsStatusPayload.PrivateCount is naturally 0 without one, and the
	// Private filter's own zero-scope message (OrbBrowser.tsx's
	// NoResultsMessage) already explains that distinctly from "your
	// organizations have none" -- a token is now the only thing that message
	// gates, not this endpoint.

	query := r.URL.Query().Get("q")
	limit := parseOrbLimit(r.URL.Query().Get("limit"))

	rawFilter := r.URL.Query().Get("filter")
	filter, ok := orbs.ParseFilter(rawFilter)
	if !ok {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("unrecognised filter %q; want one of: all, certified, private", rawFilter))
		return
	}

	// ?refresh=1 is the manual "check now" affordance issue #285 adds
	// alongside the contexts palette's own -- see that handler's comment for
	// the naming precedent. Unlike contexts (a cheap re-read this handler can
	// simply block on), a full re-crawl can take up to orbs.fullCrawlTimeout,
	// so this only *triggers* one via Refresh (itself a no-op while a crawl
	// is already running, see that method's doc comment) and answers with
	// whatever is cached right now -- possibly stale, but never withheld
	// while the new crawl runs in the background. s.shutdownCtx, not
	// r.Context(): the crawl must outlive this one request and stop only on
	// server shutdown, exactly like the warm Run starts at boot.
	if r.URL.Query().Get("refresh") == "1" {
		s.orbCache.Refresh(s.shutdownCtx)
	}

	status := s.orbCache.Status()
	page := s.orbCache.SearchFiltered(query, filter, limit)

	payload := make([]orbSearchResultPayload, 0, len(page.Results))
	for _, res := range page.Results {
		payload = append(payload, toOrbSearchResultPayload(res))
	}

	writeJSON(w, http.StatusOK, orbsSearchResponse{
		Available: true,
		Status:    s.toOrbsStatusPayload(status),
		Match: &orbsMatchPayload{
			Filter:            string(page.Filter),
			Matched:           page.Matched,
			MatchedUnfiltered: page.MatchedUnfiltered,
			ScopeSize:         page.ScopeSize,
		},
		Results: payload,
	})
}

// parseOrbLimit parses the "limit" query parameter, falling back to
// defaultOrbSearchLimit for a missing, non-positive, or unparseable value,
// and clamping to maxOrbSearchLimit.
func parseOrbLimit(raw string) int {
	if raw == "" {
		return defaultOrbSearchLimit
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return defaultOrbSearchLimit
	}
	if n > maxOrbSearchLimit {
		return maxOrbSearchLimit
	}
	return n
}

// toOrbSearchResultPayload converts a single orbs.Result to its JSON
// payload shape, sorting Versions newest-first via circleci.CompareVersions.
func toOrbSearchResultPayload(res orbs.Result) orbSearchResultPayload {
	pkg := res.Package
	versions, latest := orbVersionStrings(&pkg.OrbPackage)

	return orbSearchResultPayload{
		Name:          pkg.Name,
		Private:       pkg.Private,
		Certified:     pkg.Certified,
		Listed:        pkg.Listed,
		LatestVersion: latest,
		Versions:      versions,
		MatchedOn:     res.MatchedOn,
	}
}

// orbVersionStrings returns pkg's version strings newest-first (via
// sortVersionsDescending), plus which one pkg.LatestVersion resolves to
// ("" if pkg has no versions at all). Shared by toOrbSearchResultPayload
// and handleOrbsSource: both need exactly this shape, just from a package
// reached two different ways (a crawled orbs.Result vs. a live
// GetOrbPackageByName lookup -- see handleOrbsSource's doc comment on
// orbsSourceResponse for why those two can legitimately disagree on how
// many versions they even know about).
func orbVersionStrings(pkg *circleci.OrbPackage) (versions []string, latest string) {
	versions = make([]string, len(pkg.Versions))
	for i, v := range pkg.Versions {
		versions[i] = v.Version
	}
	sortVersionsDescending(versions)

	if lv, ok := pkg.LatestVersion(); ok {
		latest = lv.Version
	}
	return versions, latest
}

// sortVersionsDescending sorts version strings newest-first using
// circleci.CompareVersions, in place.
func sortVersionsDescending(versions []string) {
	sort.Slice(versions, func(i, j int) bool {
		return circleci.CompareVersions(versions[i], versions[j]) > 0
	})
}

// handleOrbsSource serves GET /api/orbs/source: it resolves the orb named
// by the "name" query parameter (exactly "<namespace>/<name>") — and
// "version", or the orb's latest version if that is omitted — to that
// version's raw YAML source.
func (s *Server) handleOrbsSource(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	// Issue #160: GET /api/v3/orb/versions/{id}/source (fetched below, via
	// s.orbClient) answers unauthenticated -- verified live, read-only. A
	// private orb's exact-name lookup (GetOrbPackageByName) would still 404 or
	// come back empty for a token that cannot see it, same as it would for any
	// other project not visible to the caller; that is a fact about the
	// specific orb requested, not a reason to refuse every request up front.

	name := r.URL.Query().Get("name")
	if name == "" {
		writeError(w, http.StatusBadRequest, "missing required query parameter: name")
		return
	}
	wantVersion := r.URL.Query().Get("version")

	ctx, cancel := context.WithTimeout(r.Context(), orbSourceTimeout)
	defer cancel()

	pkg, err := s.orbClient.GetOrbPackageByName(ctx, name)
	if err != nil {
		if errors.Is(err, circleci.ErrOrbNotFound) {
			writeError(w, http.StatusNotFound, fmt.Sprintf("orb not found: %s", name))
			return
		}
		if circleci.IsUnauthorized(err) {
			writeError(w, http.StatusBadGateway, "CircleCI API rejected the configured token")
			return
		}
		writeError(w, http.StatusBadGateway, "failed to resolve orb via the CircleCI API")
		return
	}

	versionID, resolvedVersion, ok := resolveOrbVersion(pkg, wantVersion)
	if !ok {
		if wantVersion == "" {
			writeError(w, http.StatusNotFound, fmt.Sprintf("orb %s has no published versions", name))
			return
		}
		writeError(w, http.StatusNotFound, fmt.Sprintf("orb %s has no version %q", name, wantVersion))
		return
	}

	source, err := s.getOrbSourceCached(ctx, versionID)
	if err != nil {
		writeError(w, http.StatusBadGateway, "failed to fetch orb source via the CircleCI API")
		return
	}

	versions, latest := orbVersionStrings(pkg)
	writeJSON(w, http.StatusOK, orbsSourceResponse{
		Available:     true,
		Name:          pkg.Name,
		Version:       resolvedVersion,
		Source:        source,
		Versions:      versions,
		LatestVersion: latest,
	})
}

// resolveOrbVersion picks the version of pkg matching want, or pkg's latest
// version if want is empty, returning that version's ID and version string.
// ok is false if want is non-empty and no such version exists, or if want
// is empty and pkg has no versions at all.
func resolveOrbVersion(pkg *circleci.OrbPackage, want string) (versionID, version string, ok bool) {
	if want == "" {
		v, ok := pkg.LatestVersion()
		if !ok {
			return "", "", false
		}
		return v.ID, v.Version, true
	}

	for _, v := range pkg.Versions {
		if v.Version == want {
			return v.ID, v.Version, true
		}
	}
	return "", "", false
}

// getOrbSourceCached fetches an orb version's source, consulting (and
// populating) s.orbSourceCache first, since the UI is expected to
// re-request the same orb repeatedly while the user drags it around.
func (s *Server) getOrbSourceCached(ctx context.Context, versionID string) (string, error) {
	if src, ok := s.orbSourceCache.get(versionID); ok {
		return src, nil
	}

	src, err := s.orbClient.GetOrbSource(ctx, versionID)
	if err != nil {
		return "", err
	}
	s.orbSourceCache.set(versionID, src)
	return src, nil
}

// orbSourceCache is a small, size-bounded, thread-safe cache of fetched orb
// source text keyed by orb version ID. Eviction is plain FIFO — simpler
// than LRU, and sufficient here: the point is to absorb the UI re-fetching
// the same handful of orbs currently being dragged around, not to cache the
// whole registry's source in memory.
type orbSourceCache struct {
	mu         sync.Mutex
	entries    map[string]string
	order      []string
	maxEntries int
}

// newOrbSourceCache constructs an orbSourceCache holding at most maxEntries
// entries.
func newOrbSourceCache(maxEntries int) *orbSourceCache {
	return &orbSourceCache{entries: make(map[string]string), maxEntries: maxEntries}
}

func (c *orbSourceCache) get(key string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.entries[key]
	return v, ok
}

func (c *orbSourceCache) set(key, value string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if _, exists := c.entries[key]; !exists {
		if len(c.order) >= c.maxEntries {
			oldest := c.order[0]
			c.order = c.order[1:]
			delete(c.entries, oldest)
		}
		c.order = append(c.order, key)
	}
	c.entries[key] = value
}
