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
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/guides"
	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

// fakeGuidesCache substitutes for *guides.Cache so a test can drive the
// handler's degraded branches without reaching for the network or the embedded
// snapshot.
type fakeGuidesCache struct {
	guides     []guides.Guide
	provenance guides.Provenance
	err        error

	// refreshCalls counts calls to Refresh, so a test can assert the manual
	// "check now" affordance (issue #285) triggered a check exactly when it
	// should have.
	refreshCalls int
}

func (f *fakeGuidesCache) Guides() ([]guides.Guide, guides.Provenance, error) {
	return f.guides, f.provenance, f.err
}

func (f *fakeGuidesCache) Refresh(context.Context) {
	f.refreshCalls++
}

func newGuidesTestServer(t *testing.T, token string, cache host.Options) *httptest.Server {
	t.Helper()

	clearCircleEnv(t)
	t.Setenv("CIRCLE_TOKEN", token)
	// Never let a test's background refresh reach the real internet.
	t.Setenv(guides.NoRefreshEnvVar, "1")

	opts := cache
	opts.WorkDir = t.TempDir()
	opts.Version = "test-version"

	srv, err := host.New(opts)
	assert.NilError(t, err)

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// TestServer_Guides_NoToken_ServesTheVendoredGuides is this endpoint's
// load-bearing assertion, and it mirrors the schema endpoint's: the guides are
// AsciiDoc embedded in the binary, so they must be served with no CIRCLE_TOKEN
// and with no request ever reaching CircleCI or GitHub. Note the server is
// never Run here -- only Handler() is used -- so this also pins that the cache
// loads on first use, not only from Run.
func TestServer_Guides_NoToken_ServesTheVendoredGuides(t *testing.T) {
	ts := newGuidesTestServer(t, "", host.Options{})

	status, body := doRequest(t, ts, http.MethodGet, "/api/guides", nil)
	assert.Equal(t, status, http.StatusOK)

	var payload struct {
		Available  bool `json:"available"`
		Provenance struct {
			Repo   string `json:"repo"`
			Commit string `json:"commit"`
			Source string `json:"source"`
		} `json:"provenance"`
		Guides []struct {
			ID       string `json:"id"`
			Origin   string `json:"origin"`
			Category string `json:"category"`
			Title    string `json:"title"`
			URL      string `json:"url"`
			Sections []struct {
				ID    string   `json:"id"`
				Title string   `json:"title"`
				Keys  []string `json:"keys"`
			} `json:"sections"`
		} `json:"guides"`
		Links []struct {
			ID    string `json:"id"`
			Label string `json:"label"`
			URL   string `json:"url"`
		} `json:"links"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &payload))

	assert.Equal(t, payload.Available, true)
	assert.Equal(t, payload.Provenance.Repo, "circleci/circleci-docs")
	assert.Equal(t, payload.Provenance.Source, "vendored")
	assert.Assert(t, is.Len(payload.Provenance.Commit, 40))

	// Every guide internal/guides declares, in that order. Twenty of CircleCI's
	// config-adjacent pages (issue #176) plus this project's own two pages about
	// the editor, which are ours rather than vendored and are marked as such.
	assert.Assert(t, is.Len(payload.Guides, len(guides.Sources)))
	for i, src := range guides.Sources {
		assert.Equal(t, payload.Guides[i].ID, src.ID)
		assert.Equal(t, payload.Guides[i].Origin, string(src.Origin))
		assert.Equal(t, payload.Guides[i].Category, src.Category)
	}
	assert.Equal(t, payload.Guides[0].ID, "configuration-reference")

	// The origin distinction survives the JSON boundary, which is what lets the
	// pane avoid presenting this project's writing as CircleCI's.
	var circleci, editor int
	for _, guide := range payload.Guides {
		switch guide.Origin {
		case "circleci":
			circleci++
		case "editor":
			editor++
		default:
			t.Fatalf("guide %s has origin %q", guide.ID, guide.Origin)
		}
	}
	assert.Equal(t, circleci, 21)
	assert.Equal(t, editor, 2)

	// A spot check that real content came through, not an empty shell.
	var sawVersionKey bool
	for _, section := range payload.Guides[0].Sections {
		for _, key := range section.Keys {
			if key == "version" {
				sawVersionKey = true
			}
		}
	}
	assert.Assert(t, sawVersionKey, "the configuration reference did not expose a `version` key section")

	// Outbound links are always present, whether or not parsing succeeded, so
	// the pane can always offer a way to the live page.
	assert.Assert(t, is.Len(payload.Links, len(guides.Sources)))
	for i, link := range payload.Links {
		assert.Assert(t, link.Label != "")
		if guides.Sources[i].Origin == guides.OriginEditor {
			// Our own pages link to this repository, not to circleci.com: there
			// is no published CircleCI page for a page we wrote.
			assert.Assert(t, is.Contains(link.URL, "github.com/CircleCI-Labs/circleci-editor"))
			continue
		}
		assert.Assert(t, is.Contains(link.URL, "https://circleci.com/docs/"))
	}
}

// TestServer_Guides_DegradesHonestly covers the branch that must never produce
// a blank pane: the cache has nothing usable. The response still carries every
// outbound link and a human-readable reason.
func TestServer_Guides_DegradesHonestly(t *testing.T) {
	for name, cache := range map[string]*fakeGuidesCache{
		"parse failed":   {err: errors.New("guides: snapshot is unreadable")},
		"nothing loaded": {},
	} {
		t.Run(name, func(t *testing.T) {
			ts := newGuidesTestServer(t, "", host.Options{GuidesCache: cache})

			status, body := doRequest(t, ts, http.MethodGet, "/api/guides", nil)
			assert.Equal(t, status, http.StatusOK)

			var payload struct {
				Available bool   `json:"available"`
				Reason    string `json:"reason"`
				Links     []struct {
					URL string `json:"url"`
				} `json:"links"`
			}
			assert.NilError(t, json.Unmarshal([]byte(body), &payload))
			assert.Equal(t, payload.Available, false)
			assert.Assert(t, payload.Reason != "", "an unavailable response must say why")
			assert.Assert(t, is.Len(payload.Links, len(guides.Sources)))
		})
	}
}

// TestServer_Guides_SurfacesRefreshStateWithoutBlocking pins that a
// background refresh in flight (or one that failed) is reported alongside
// perfectly usable content -- never as a loading or error state.
func TestServer_Guides_SurfacesRefreshStateWithoutBlocking(t *testing.T) {
	cache := &fakeGuidesCache{
		guides: []guides.Guide{{ID: "configuration-reference", Title: "Configuration reference", URL: "https://circleci.com/docs/reference/configuration-reference/"}},
		provenance: guides.Provenance{
			Repo:       "circleci/circleci-docs",
			Commit:     "0123456789abcdef0123456789abcdef01234567",
			Source:     guides.SourceVendored,
			Refreshing: true,
			Error:      "fetch guides: no such host",
		},
	}
	ts := newGuidesTestServer(t, "", host.Options{GuidesCache: cache})

	status, body := doRequest(t, ts, http.MethodGet, "/api/guides", nil)
	assert.Equal(t, status, http.StatusOK)

	var payload struct {
		Available  bool `json:"available"`
		Provenance struct {
			Refreshing bool   `json:"refreshing"`
			Error      string `json:"error"`
		} `json:"provenance"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &payload))
	assert.Equal(t, payload.Available, true)
	assert.Equal(t, payload.Provenance.Refreshing, true)
	assert.Assert(t, is.Contains(payload.Provenance.Error, "no such host"))
}

// TestServer_Guides_RefreshTriggersACheck pins issue #285's manual refresh
// affordance: ?refresh=1 must reach the cache's own Refresh (where the
// no-op-while-already-refreshing rate-limit protection lives, see
// guides.Cache.Refresh) exactly once per request, and an ordinary request
// must never trigger one at all.
func TestServer_Guides_RefreshTriggersACheck(t *testing.T) {
	cache := &fakeGuidesCache{
		guides: []guides.Guide{{ID: "configuration-reference", Title: "Configuration reference"}},
	}
	ts := newGuidesTestServer(t, "", host.Options{GuidesCache: cache})

	status, _ := doRequest(t, ts, http.MethodGet, "/api/guides", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, cache.refreshCalls, 0, "an ordinary request must not trigger a check")

	status, _ = doRequest(t, ts, http.MethodGet, "/api/guides?refresh=1", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, cache.refreshCalls, 1)
}

func TestServer_Guides_RejectsNonGET(t *testing.T) {
	ts := newGuidesTestServer(t, "", host.Options{})

	status, _ := doRequest(t, ts, http.MethodPost, "/api/guides", []byte("{}"))
	assert.Equal(t, status, http.StatusMethodNotAllowed)
}
