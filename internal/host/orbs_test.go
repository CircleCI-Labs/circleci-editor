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

package host_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
	"github.com/CircleCI-Labs/circleci-editor/internal/host"
	"github.com/CircleCI-Labs/circleci-editor/internal/orbs"
)

// fakeOrbCache is a fake implementation of the host package's unexported
// orbCache interface.
type fakeOrbCache struct {
	status  orbs.Status
	results []orbs.Result

	// counts, when set, supplies the orbs.Page match counts this fake reports
	// alongside results (Page.Results is always results, and Page.Filter is
	// always whatever was asked for). Left zero by tests that only care about
	// the results themselves.
	counts orbs.Page

	gotQuery  string
	gotLimit  int
	gotFilter orbs.Filter

	// refreshCalls counts calls to Refresh, so a test can assert the manual
	// "check now" affordance (issue #285) triggered exactly the crawl it
	// should have -- no more, no less.
	refreshCalls int
}

func (f *fakeOrbCache) Status() orbs.Status { return f.status }

func (f *fakeOrbCache) SearchFiltered(query string, filter orbs.Filter, limit int) orbs.Page {
	f.gotQuery = query
	f.gotLimit = limit
	f.gotFilter = filter

	page := f.counts
	page.Filter = filter
	page.Results = f.results
	return page
}

func (f *fakeOrbCache) Refresh(context.Context) {
	f.refreshCalls++
}

// fakeOrbClient is a fake implementation of the host package's unexported
// orbSourceClient interface.
type fakeOrbClient struct {
	pkg    *circleci.OrbPackage
	pkgErr error

	source    string
	sourceErr error

	gotName      string
	gotVersionID string
}

func (f *fakeOrbClient) GetOrbPackageByName(_ context.Context, name string) (*circleci.OrbPackage, error) {
	f.gotName = name
	return f.pkg, f.pkgErr
}

func (f *fakeOrbClient) GetOrbSource(_ context.Context, versionID string) (string, error) {
	f.gotVersionID = versionID
	return f.source, f.sourceErr
}

// newOrbsTestServer builds a host.Server with the given fakes (either may be
// nil to leave the real-client construction path in place, which is
// exercised elsewhere) and CIRCLE_TOKEN value, wrapped in an
// httptest.Server closed on cleanup.
func newOrbsTestServer(t *testing.T, token string, cache *fakeOrbCache, client *fakeOrbClient) *httptest.Server {
	t.Helper()

	clearCircleEnv(t)
	t.Setenv("CIRCLE_TOKEN", token)

	opts := host.Options{WorkDir: t.TempDir(), Version: "test-version"}
	if cache != nil {
		opts.OrbCache = cache
	}
	if client != nil {
		opts.OrbClient = client
	}

	srv, err := host.New(opts)
	assert.NilError(t, err)

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func TestServer_OrbsSearch_HappyPath(t *testing.T) {
	cache := &fakeOrbCache{
		status: orbs.Status{Ready: true, Complete: true, Count: 6400},
		results: []orbs.Result{
			{
				Package: orbs.OrbPackage{
					OrbPackage: circleci.OrbPackage{
						Name: "circleci/node",
						Versions: []circleci.OrbVersion{
							{ID: "v1", Version: "5.1.0"},
							{ID: "v2", Version: "5.2.0"},
						},
						Listed: true,
					},
					Certified: true,
				},
				MatchedOn: orbs.MatchPrefixName,
			},
		},
	}
	ts := newOrbsTestServer(t, sentinelToken, cache, nil)

	status, body := doRequest(t, ts, http.MethodGet, "/api/orbs/search?q=node&limit=10", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !strings.Contains(body, sentinelToken), "response leaked the token: %s", body)

	assert.Equal(t, cache.gotQuery, "node")
	assert.Equal(t, cache.gotLimit, 10)

	var got struct {
		Available bool `json:"available"`
		Status    struct {
			Ready    bool `json:"ready"`
			Complete bool `json:"complete"`
			Count    int  `json:"count"`
		} `json:"status"`
		Results []struct {
			Name          string   `json:"name"`
			Private       bool     `json:"private"`
			Certified     bool     `json:"certified"`
			Listed        bool     `json:"listed"`
			LatestVersion string   `json:"latestVersion"`
			Versions      []string `json:"versions"`
			MatchedOn     string   `json:"matchedOn"`
		} `json:"results"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, true)
	assert.Equal(t, got.Status.Ready, true)
	assert.Equal(t, got.Status.Complete, true)
	assert.Equal(t, got.Status.Count, 6400)
	assert.Equal(t, len(got.Results), 1)
	assert.Equal(t, got.Results[0].Name, "circleci/node")
	assert.Equal(t, got.Results[0].Certified, true)
	assert.Equal(t, got.Results[0].Listed, true)
	assert.Equal(t, got.Results[0].LatestVersion, "5.2.0")
	assert.DeepEqual(t, got.Results[0].Versions, []string{"5.2.0", "5.1.0"})
	assert.Equal(t, got.Results[0].MatchedOn, orbs.MatchPrefixName)
}

func TestServer_OrbsSearch_MissingQueryDefaultsToEmpty(t *testing.T) {
	cache := &fakeOrbCache{status: orbs.Status{Ready: true}}
	ts := newOrbsTestServer(t, sentinelToken, cache, nil)

	status, _ := doRequest(t, ts, http.MethodGet, "/api/orbs/search", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, cache.gotQuery, "")
	assert.Equal(t, cache.gotLimit, 25, "expected the default limit when none is supplied")
}

// TestServer_OrbsSearch_RefreshTriggersRecrawl pins issue #285's manual
// refresh affordance: ?refresh=1 must reach the cache's own Refresh (which is
// where the no-op-while-warming rate-limit protection lives, see
// orbs.Cache.Refresh) exactly once per request, and an ordinary request
// (without the parameter) must never trigger it at all.
func TestServer_OrbsSearch_RefreshTriggersRecrawl(t *testing.T) {
	cache := &fakeOrbCache{status: orbs.Status{Ready: true, Complete: true, Count: 1}}
	ts := newOrbsTestServer(t, sentinelToken, cache, nil)

	status, _ := doRequest(t, ts, http.MethodGet, "/api/orbs/search?q=node", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, cache.refreshCalls, 0, "an ordinary search must not trigger a re-crawl")

	status, _ = doRequest(t, ts, http.MethodGet, "/api/orbs/search?q=node&refresh=1", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, cache.refreshCalls, 1)
}

func TestServer_OrbsSearch_LimitClamping(t *testing.T) {
	tests := []struct {
		name      string
		limitParm string
		wantLimit int
	}{
		{name: "within range", limitParm: "10", wantLimit: 10},
		{name: "zero falls back to default", limitParm: "0", wantLimit: 25},
		{name: "negative falls back to default", limitParm: "-5", wantLimit: 25},
		{name: "not a number falls back to default", limitParm: "abc", wantLimit: 25},
		{name: "above max is clamped", limitParm: "1000", wantLimit: 100},
		{name: "exactly max is kept", limitParm: "100", wantLimit: 100},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cache := &fakeOrbCache{status: orbs.Status{Ready: true}}
			ts := newOrbsTestServer(t, sentinelToken, cache, nil)

			status, _ := doRequest(t, ts, http.MethodGet, "/api/orbs/search?limit="+tc.limitParm, nil)
			assert.Equal(t, status, http.StatusOK)
			assert.Equal(t, cache.gotLimit, tc.wantLimit)
		})
	}
}

// Issue #160: the public v3 orb registry answers unauthenticated (verified
// live, read-only, against the real API -- see the PR description), so orb
// search must not refuse outright just because this host has no
// CIRCLE_TOKEN. It used to; now the cache is searched exactly as it would be
// with a token, and only the *private* scope is where a token's absence has
// anything to say (see TestServer_OrbsSearch_NoToken_PrivateFilterStillHonest).
func TestServer_OrbsSearch_NoToken_StillSearches(t *testing.T) {
	cache := &fakeOrbCache{
		status: orbs.Status{Ready: true, Complete: true, Count: 1},
		results: []orbs.Result{{
			Package: orbs.OrbPackage{
				OrbPackage: circleci.OrbPackage{Name: "circleci/node", Listed: true,
					Versions: []circleci.OrbVersion{{ID: "v1", Version: "5.2.0"}}},
			},
			MatchedOn: orbs.MatchExactName,
		}},
	}
	ts := newOrbsTestServer(t, "", cache, nil)

	status, body := doRequest(t, ts, http.MethodGet, "/api/orbs/search?q=node", nil)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Available bool `json:"available"`
		Results   []struct {
			Name string `json:"name"`
		} `json:"results"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, true)
	assert.Equal(t, len(got.Results), 1)
	assert.Equal(t, got.Results[0].Name, "circleci/node")
	assert.Equal(t, cache.gotQuery, "node", "the cache must actually be queried with no token configured")
}

// The Private filter is the one scope a token's absence genuinely changes
// (issue #160): an unauthenticated crawl can never see an organization's
// private namespace, so this is the honest explanation the existing
// "no token at all" case gets, distinct from "a token was shown nothing" --
// see OrbBrowser.tsx's NoResultsMessage for the frontend half of this
// distinction.
func TestServer_OrbsSearch_NoToken_PrivateFilterStillHonest(t *testing.T) {
	ts := newOrbsTestServer(t, "", &fakeOrbCache{status: orbs.Status{Ready: true, Complete: true}}, nil)

	status, body := doRequest(t, ts, http.MethodGet, "/api/orbs/search?q=node&filter=private", nil)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Available bool `json:"available"`
		Match     struct {
			Filter    string `json:"filter"`
			ScopeSize int    `json:"scopeSize"`
		} `json:"match"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, true)
	assert.Equal(t, got.Match.Filter, "private")
	assert.Equal(t, got.Match.ScopeSize, 0, "an unauthenticated crawl finds no private orbs")
}

// The filter parameter reaches the cache, and the response echoes both the
// filter and the counts the UI needs to explain a short list (issue #151).
func TestServer_OrbsSearch_FilterIsAppliedAndCountsAreReported(t *testing.T) {
	cache := &fakeOrbCache{
		status: orbs.Status{Ready: true, Complete: true, Count: 6400, CertifiedCount: 79, PrivateCount: 3},
		counts: orbs.Page{Matched: 1, MatchedUnfiltered: 12, ScopeSize: 79},
		results: []orbs.Result{{
			Package: orbs.OrbPackage{
				OrbPackage: circleci.OrbPackage{Name: "circleci/node", Listed: true,
					Versions: []circleci.OrbVersion{{ID: "v1", Version: "5.2.0"}}},
				Certified: true,
			},
			MatchedOn: orbs.MatchExactName,
		}},
	}
	ts := newOrbsTestServer(t, sentinelToken, cache, nil)

	status, body := doRequest(t, ts, http.MethodGet, "/api/orbs/search?q=node&filter=certified", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, cache.gotFilter, orbs.FilterCertified)

	var got struct {
		Status struct {
			CertifiedCount int `json:"certifiedCount"`
			PrivateCount   int `json:"privateCount"`
		} `json:"status"`
		Match struct {
			Filter            string `json:"filter"`
			Matched           int    `json:"matched"`
			MatchedUnfiltered int    `json:"matchedUnfiltered"`
			ScopeSize         int    `json:"scopeSize"`
		} `json:"match"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Status.CertifiedCount, 79)
	assert.Equal(t, got.Status.PrivateCount, 3)
	assert.Equal(t, got.Match.Filter, "certified")
	assert.Equal(t, got.Match.Matched, 1)
	assert.Equal(t, got.Match.MatchedUnfiltered, 12)
	assert.Equal(t, got.Match.ScopeSize, 79)
}

func TestServer_OrbsSearch_MissingFilterIsAll(t *testing.T) {
	cache := &fakeOrbCache{status: orbs.Status{Ready: true}}
	ts := newOrbsTestServer(t, sentinelToken, cache, nil)

	status, body := doRequest(t, ts, http.MethodGet, "/api/orbs/search?q=node", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, cache.gotFilter, orbs.FilterAll)
	assert.Assert(t, is.Contains(body, `"filter":"all"`))
}

// An unrecognised filter is rejected, not silently ignored. "partner" is the
// case that matters: the orb registry's UI offers it, so a caller may well try
// it, and answering with an unfiltered list labelled "partner" would be a
// mislabel rather than a missing feature (see orbs.Filter).
func TestServer_OrbsSearch_UnrecognisedFilterIsRejected(t *testing.T) {
	for _, raw := range []string{"partner", "public", "Certified"} {
		t.Run(raw, func(t *testing.T) {
			cache := &fakeOrbCache{status: orbs.Status{Ready: true}}
			ts := newOrbsTestServer(t, sentinelToken, cache, nil)

			status, body := doRequest(t, ts, http.MethodGet, "/api/orbs/search?q=node&filter="+raw, nil)
			assert.Equal(t, status, http.StatusBadRequest)
			assert.Assert(t, is.Contains(body, "unrecognised filter"))
			assert.Assert(t, is.Contains(body, "certified, private"))
			assert.Equal(t, cache.gotQuery, "", "an invalid filter must not reach the cache at all")
		})
	}
}

// orbsStatusOf issues a search and decodes just the status block, which is
// what every issue-#257 case below is about.
func orbsStatusOf(t *testing.T, ts *httptest.Server) (struct {
	Ready              bool   `json:"ready"`
	Complete           bool   `json:"complete"`
	Count              int    `json:"count"`
	Warming            bool   `json:"warming"`
	State              string `json:"state"`
	Reason             string `json:"reason"`
	FetchedAt          string `json:"fetchedAt"`
	Stale              bool   `json:"stale"`
	RefreshWindowHours int    `json:"refreshWindowHours"`
	SelfHosted         bool   `json:"selfHosted"`
}, string) {
	t.Helper()

	code, body := doRequest(t, ts, http.MethodGet, "/api/orbs/search", nil)
	assert.Equal(t, code, http.StatusOK)

	var got struct {
		Status struct {
			Ready              bool   `json:"ready"`
			Complete           bool   `json:"complete"`
			Count              int    `json:"count"`
			Warming            bool   `json:"warming"`
			State              string `json:"state"`
			Reason             string `json:"reason"`
			FetchedAt          string `json:"fetchedAt"`
			Stale              bool   `json:"stale"`
			RefreshWindowHours int    `json:"refreshWindowHours"`
			SelfHosted         bool   `json:"selfHosted"`
		} `json:"status"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	return got.Status, body
}

// Issue #257: an empty orb list must say *why* it is empty. Before this, the
// cache recorded a reason and the payload had nowhere to put it, so "there are
// no orbs" and "we could not fetch the orbs" serialised identically.
//
// Each case here is a state that actually occurs, and the assertion is on the
// state name rather than on prose, so the wording stays the client's business
// while which-state-is-this stays the host's.
func TestServer_OrbsSearch_ReportsWhyTheListIsEmpty(t *testing.T) {
	apiErr := &circleci.APIError{
		StatusCode: 500,
		Method:     "GET",
		Path:       "/api/v3/orb/packages",
		Body:       "internal error: db=orbs-primary user=svc-orbs",
	}
	fetched := time.Now().Add(-2 * time.Hour)
	longAgo := time.Now().Add(-30 * 24 * time.Hour)

	tests := []struct {
		name       string
		status     orbs.Status
		wantState  string
		wantReason string
		wantStale  bool
	}{
		{
			name:      "never fetched",
			status:    orbs.Status{},
			wantState: "never-fetched",
		},
		{
			name:      "fetching",
			status:    orbs.Status{Warming: true},
			wantState: "fetching",
		},
		{
			// The distinction the issue was filed for. Same empty list as
			// "empty" below, entirely different thing to tell the user.
			name:       "fetch failed",
			status:     orbs.Status{Err: apiErr},
			wantState:  "failed",
			wantReason: "HTTP 500",
		},
		{
			// Normal on CircleCI Server, whose registry is seeded one orb at a
			// time by an admin (issue #256).
			name:      "fetched and genuinely empty",
			status:    orbs.Status{Ready: true, Complete: true, FetchedAt: fetched},
			wantState: "empty",
		},
		{
			name:      "usable",
			status:    orbs.Status{Ready: true, Complete: true, Count: 6400, FetchedAt: fetched},
			wantState: "ready",
		},
		{
			// A refresh this host knows failed means the list on screen is not
			// current, so it must not be presented as though it were.
			name:       "usable but the refresh failed",
			status:     orbs.Status{Ready: true, Complete: true, Count: 6400, FetchedAt: fetched, Err: apiErr},
			wantState:  "stale",
			wantReason: "HTTP 500",
		},
		{
			name:      "usable but past the refresh window",
			status:    orbs.Status{Ready: true, Complete: true, Count: 6400, FetchedAt: longAgo, Stale: true},
			wantState: "stale",
			wantStale: true,
		},
		{
			// A crawl in flight outranks an earlier stage's failure when there
			// is nothing to show: waiting is the right advice either way, and
			// the reason is still carried, so choosing "fetching" hides nothing.
			name:       "fetching after an earlier stage failed",
			status:     orbs.Status{Warming: true, Err: apiErr},
			wantState:  "fetching",
			wantReason: "HTTP 500",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ts := newOrbsTestServer(t, sentinelToken, &fakeOrbCache{status: tc.status}, nil)

			got, body := orbsStatusOf(t, ts)
			assert.Equal(t, got.State, tc.wantState)
			assert.Equal(t, got.Stale, tc.wantStale)
			if tc.wantReason == "" {
				assert.Equal(t, got.Reason, "")
			} else {
				assert.Assert(t, is.Contains(got.Reason, tc.wantReason))
			}

			// The reason is classified, never err.Error(). *circleci.APIError
			// embeds the upstream response body, and this is the assertion that
			// keeps it from riding along.
			assert.Assert(t, !strings.Contains(body, "svc-orbs"),
				"the upstream response body leaked into the response: %s", body)
			assert.Assert(t, !strings.Contains(body, sentinelToken),
				"response leaked the token: %s", body)
		})
	}
}

// The refresh window and the fetch time are both reported, because a client
// that labels a list "stale" has to be able to say stale relative to what, and
// how old, rather than asserting it with nothing behind it.
func TestServer_OrbsSearch_ReportsFetchTimeAndRefreshWindow(t *testing.T) {
	fetched := time.Date(2026, 7, 30, 9, 15, 0, 0, time.UTC)
	cache := &fakeOrbCache{status: orbs.Status{
		Ready: true, Complete: true, Count: 12, FetchedAt: fetched,
	}}
	ts := newOrbsTestServer(t, sentinelToken, cache, nil)

	got, _ := orbsStatusOf(t, ts)
	assert.Equal(t, got.FetchedAt, "2026-07-30T09:15:00Z")
	assert.Equal(t, got.RefreshWindowHours, int(orbs.RefreshWindow/time.Hour))
}

// Nothing complete has ever been fetched, so there is no fetch time to report
// and the field is absent rather than being the zero time -- which would
// otherwise render as a real-looking timestamp in year 1.
func TestServer_OrbsSearch_OmitsFetchTimeWhenNeverFetched(t *testing.T) {
	ts := newOrbsTestServer(t, sentinelToken, &fakeOrbCache{status: orbs.Status{Warming: true}}, nil)

	got, body := orbsStatusOf(t, ts)
	assert.Equal(t, got.FetchedAt, "")
	assert.Assert(t, !strings.Contains(body, "fetchedAt"))
}

// Whether this host is a CircleCI Server installation changes what an empty
// registry means (issue #256: on Server, empty is the ordinary starting
// state), so the client is told which it is talking to rather than having to
// hedge in both directions.
func TestServer_OrbsSearch_ReportsSelfHosted(t *testing.T) {
	for _, tc := range []struct {
		name string
		host string
		want bool
	}{
		{name: "unset", host: "", want: false},
		{name: "cloud", host: "https://circleci.com", want: false},
		{name: "server", host: "https://circleci.example.com", want: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cache := &fakeOrbCache{status: orbs.Status{Ready: true, Complete: true, Count: 1}}
			ts := newOrbsTestServerOnHost(t, tc.host, cache)

			got, _ := orbsStatusOf(t, ts)
			assert.Equal(t, got.SelfHosted, tc.want)
		})
	}
}

// newOrbsTestServerOnHost is newOrbsTestServer with CIRCLE_HOST set, which has
// to happen after clearCircleEnv and before host.New reads the environment.
func newOrbsTestServerOnHost(t *testing.T, circleHost string, cache *fakeOrbCache) *httptest.Server {
	t.Helper()

	clearCircleEnv(t)
	t.Setenv("CIRCLE_TOKEN", sentinelToken)
	if circleHost != "" {
		t.Setenv("CIRCLE_HOST", circleHost)
	}

	srv, err := host.New(host.Options{
		WorkDir:  t.TempDir(),
		Version:  "test-version",
		OrbCache: cache,
	})
	assert.NilError(t, err)

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func TestServer_OrbsSearch_WrongMethod(t *testing.T) {
	ts := newOrbsTestServer(t, sentinelToken, &fakeOrbCache{}, nil)

	status, body := doRequest(t, ts, http.MethodPost, "/api/orbs/search", nil)
	assert.Equal(t, status, http.StatusMethodNotAllowed)
	assert.Assert(t, is.Contains(body, `"error"`))
}

func TestServer_OrbsSource_HappyPath_LatestVersion(t *testing.T) {
	client := &fakeOrbClient{
		pkg: &circleci.OrbPackage{
			Name: "circleci/node",
			Versions: []circleci.OrbVersion{
				{ID: "v1", Version: "5.1.0"},
				{ID: "v2", Version: "5.2.0"},
			},
		},
		source: "version: 2.1\ndescription: node orb\n",
	}
	ts := newOrbsTestServer(t, sentinelToken, &fakeOrbCache{}, client)

	status, body := doRequest(t, ts, http.MethodGet, "/api/orbs/source?name=circleci/node", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Assert(t, !strings.Contains(body, sentinelToken), "response leaked the token: %s", body)

	assert.Equal(t, client.gotName, "circleci/node")
	assert.Equal(t, client.gotVersionID, "v2", "expected the latest version to be resolved when none was requested")

	var got struct {
		Name    string `json:"name"`
		Version string `json:"version"`
		Source  string `json:"source"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Name, "circleci/node")
	assert.Equal(t, got.Version, "5.2.0")
	assert.Equal(t, got.Source, "version: 2.1\ndescription: node orb\n")
}

// Issue #89's version picker: /api/orbs/source resolves pkg via a live,
// single-name GetOrbPackageByName lookup, which (unlike the crawled cache
// /api/orbs/search ranks against) the real CircleCI API answers with an
// orb's complete version history -- see orbsSourceResponse's own doc
// comment. This is the response the UI's version <select> actually reads
// its options from.
func TestServer_OrbsSource_ReportsFullVersionHistoryAndLatest(t *testing.T) {
	client := &fakeOrbClient{
		pkg: &circleci.OrbPackage{
			Name: "circleci/node",
			Versions: []circleci.OrbVersion{
				{ID: "v1", Version: "5.1.0"},
				{ID: "v3", Version: "5.3.0"},
				{ID: "v2", Version: "5.2.0"},
			},
		},
		source: "version: 2.1\n",
	}
	ts := newOrbsTestServer(t, sentinelToken, &fakeOrbCache{}, client)

	// Requesting an older version explicitly must not narrow the reported
	// version list down to just that one -- the whole point is letting the
	// UI offer switching to any of them from wherever it currently is.
	status, body := doRequest(t, ts, http.MethodGet, "/api/orbs/source?name=circleci/node&version=5.1.0", nil)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Version       string   `json:"version"`
		Versions      []string `json:"versions"`
		LatestVersion string   `json:"latestVersion"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Version, "5.1.0")
	assert.DeepEqual(t, got.Versions, []string{"5.3.0", "5.2.0", "5.1.0"})
	assert.Equal(t, got.LatestVersion, "5.3.0")
}

func TestServer_OrbsSource_HappyPath_SpecificVersion(t *testing.T) {
	client := &fakeOrbClient{
		pkg: &circleci.OrbPackage{
			Name: "circleci/node",
			Versions: []circleci.OrbVersion{
				{ID: "v1", Version: "5.1.0"},
				{ID: "v2", Version: "5.2.0"},
			},
		},
		source: "version: 2.1\n",
	}
	ts := newOrbsTestServer(t, sentinelToken, &fakeOrbCache{}, client)

	status, body := doRequest(t, ts, http.MethodGet, "/api/orbs/source?name=circleci/node&version=5.1.0", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, client.gotVersionID, "v1")

	var got struct {
		Version string `json:"version"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Version, "5.1.0")
}

func TestServer_OrbsSource_CachesSourceFetches(t *testing.T) {
	client := &fakeOrbClient{
		pkg: &circleci.OrbPackage{
			Name:     "circleci/node",
			Versions: []circleci.OrbVersion{{ID: "v1", Version: "5.1.0"}},
		},
		source: "version: 2.1\n",
	}
	ts := newOrbsTestServer(t, sentinelToken, &fakeOrbCache{}, client)

	status1, _ := doRequest(t, ts, http.MethodGet, "/api/orbs/source?name=circleci/node", nil)
	assert.Equal(t, status1, http.StatusOK)

	// Change what the fake would return; a cached second request must
	// still see the original source rather than calling GetOrbSource
	// again.
	client.source = "version: 2.1\ndescription: changed\n"
	client.gotVersionID = ""

	status2, body2 := doRequest(t, ts, http.MethodGet, "/api/orbs/source?name=circleci/node", nil)
	assert.Equal(t, status2, http.StatusOK)
	assert.Equal(t, client.gotVersionID, "", "GetOrbSource must not be called again for a cached version ID")

	var got struct {
		Source string `json:"source"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body2), &got))
	assert.Equal(t, got.Source, "version: 2.1\n")
}

func TestServer_OrbsSource_UnknownOrb_ReturnsNotFound(t *testing.T) {
	client := &fakeOrbClient{pkgErr: circleci.ErrOrbNotFound}
	ts := newOrbsTestServer(t, sentinelToken, &fakeOrbCache{}, client)

	status, body := doRequest(t, ts, http.MethodGet, "/api/orbs/source?name=nope/nope", nil)
	assert.Equal(t, status, http.StatusNotFound)
	assert.Assert(t, is.Contains(body, `"error"`))
}

func TestServer_OrbsSource_UnknownVersion_ReturnsNotFound(t *testing.T) {
	client := &fakeOrbClient{
		pkg: &circleci.OrbPackage{
			Name:     "circleci/node",
			Versions: []circleci.OrbVersion{{ID: "v1", Version: "5.1.0"}},
		},
	}
	ts := newOrbsTestServer(t, sentinelToken, &fakeOrbCache{}, client)

	status, body := doRequest(t, ts, http.MethodGet, "/api/orbs/source?name=circleci/node&version=99.0.0", nil)
	assert.Equal(t, status, http.StatusNotFound)
	assert.Assert(t, is.Contains(body, `"error"`))
}

func TestServer_OrbsSource_MissingName_BadRequest(t *testing.T) {
	ts := newOrbsTestServer(t, sentinelToken, &fakeOrbCache{}, &fakeOrbClient{})

	status, body := doRequest(t, ts, http.MethodGet, "/api/orbs/source", nil)
	assert.Equal(t, status, http.StatusBadRequest)
	assert.Assert(t, is.Contains(body, `"error"`))
}

// Issue #160: GET /api/v3/orb/versions/{id}/source answers unauthenticated
// too (verified live, read-only), so fetching an orb's source must not
// refuse just because this host has no token -- it used to, identically to
// search.
func TestServer_OrbsSource_NoToken_StillFetches(t *testing.T) {
	pkg := &circleci.OrbPackage{
		Name:     "circleci/node",
		Versions: []circleci.OrbVersion{{ID: "v1", Version: "5.2.0"}},
	}
	client := &fakeOrbClient{pkg: pkg, source: "description: a node orb\n"}
	ts := newOrbsTestServer(t, "", &fakeOrbCache{}, client)

	status, body := doRequest(t, ts, http.MethodGet, "/api/orbs/source?name=circleci/node", nil)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Available bool   `json:"available"`
		Source    string `json:"source"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, true)
	assert.Equal(t, got.Source, "description: a node orb\n")
	assert.Equal(t, client.gotName, "circleci/node", "the client must actually be called with no token configured")
}

func TestServer_OrbsSource_UpstreamError(t *testing.T) {
	client := &fakeOrbClient{pkgErr: &circleci.APIError{StatusCode: 500, Method: "GET", Path: "/api/v3/orb/packages", Body: "boom"}}
	ts := newOrbsTestServer(t, sentinelToken, &fakeOrbCache{}, client)

	status, body := doRequest(t, ts, http.MethodGet, "/api/orbs/source?name=circleci/node", nil)
	assert.Equal(t, status, http.StatusBadGateway)
	assert.Assert(t, is.Contains(body, `"error"`))
}

func TestServer_OrbsSource_WrongMethod(t *testing.T) {
	ts := newOrbsTestServer(t, sentinelToken, &fakeOrbCache{}, &fakeOrbClient{})

	status, body := doRequest(t, ts, http.MethodPost, "/api/orbs/source?name=circleci/node", nil)
	assert.Equal(t, status, http.StatusMethodNotAllowed)
	assert.Assert(t, is.Contains(body, `"error"`))
}
