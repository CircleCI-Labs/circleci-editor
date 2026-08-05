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

package circleci_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
)

func TestListOrbPackages_RequestShapeAndDecoding(t *testing.T) {
	var gotQuery string
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, r.URL.Path, "/api/v3/orb/packages")
		gotQuery = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{
				{
					"id": "pkg-1",
					"attributes": map[string]any{
						"name":       "cci-labs/act",
						"is_private": false,
						"is_listed":  true,
					},
					"references": map[string]any{
						"namespace": map[string]any{"id": "ns-1"},
						"orb_versions": []map[string]any{
							{
								"id": "v-1",
								"attributes": map[string]any{
									"version":    "1.0.5",
									"created_at": "2024-12-19T22:04:37.074Z",
								},
							},
						},
					},
				},
			},
			"page": map[string]any{"next": "cursor-abc"},
		})
	})

	certified := true
	pkgs, next, err := client.ListOrbPackages(context.Background(), circleci.ListOrbsOptions{
		Certified:   &certified,
		NamespaceID: "ns-1",
		Name:        "cci-labs/act",
		Visibility:  "public",
		Limit:       100,
		Cursor:      "cursor-in",
	})
	assert.NilError(t, err)
	assert.Equal(t, next, "cursor-abc")
	assert.Equal(t, len(pkgs), 1)
	assert.Equal(t, pkgs[0].ID, "pkg-1")
	assert.Equal(t, pkgs[0].Name, "cci-labs/act")
	assert.Equal(t, pkgs[0].Private, false)
	assert.Equal(t, pkgs[0].Listed, true)
	assert.Equal(t, pkgs[0].NamespaceID, "ns-1")
	assert.Equal(t, len(pkgs[0].Versions), 1)
	assert.Equal(t, pkgs[0].Versions[0].ID, "v-1")
	assert.Equal(t, pkgs[0].Versions[0].Version, "1.0.5")
	assert.Equal(t, pkgs[0].Versions[0].CreatedAt.UTC().Format(time.RFC3339), "2024-12-19T22:04:37Z")

	q, err := url.ParseQuery(gotQuery)
	assert.NilError(t, err)
	assert.Equal(t, q.Get("filter[certified]"), "true")
	assert.Equal(t, q.Get("filter[namespace_id]"), "ns-1")
	assert.Equal(t, q.Get("filter[name]"), "cci-labs/act")
	assert.Equal(t, q.Get("filter[visibility]"), "public")
	assert.Equal(t, q.Get("page[limit]"), "100")
	assert.Equal(t, q.Get("page[cursor]"), "cursor-in")
}

func TestListOrbPackages_EmptyData(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{}})
	})

	pkgs, next, err := client.ListOrbPackages(context.Background(), circleci.ListOrbsOptions{})
	assert.NilError(t, err)
	assert.Equal(t, next, "")
	assert.Equal(t, len(pkgs), 0)
}

func TestListAllOrbPackages_FollowsCursorAndStops(t *testing.T) {
	var requests []string
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.RawQuery)
		q, _ := url.ParseQuery(r.URL.RawQuery)
		cursor := q.Get("page[cursor]")

		w.WriteHeader(http.StatusOK)
		switch cursor {
		case "":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{orbWireEntry("ns/one", "pkg-1")},
				"page": map[string]any{"next": "page-2"},
			})
		case "page-2":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{orbWireEntry("ns/two", "pkg-2")},
				// No "page" key at all: absent-on-last-page.
			})
		default:
			t.Fatalf("unexpected cursor %q", cursor)
		}
	})

	var pageSizes []int
	pkgs, err := client.ListAllOrbPackages(context.Background(), circleci.ListOrbsOptions{Limit: 100}, func(n int) {
		pageSizes = append(pageSizes, n)
	})
	assert.NilError(t, err)
	assert.Equal(t, len(pkgs), 2)
	assert.Equal(t, pkgs[0].Name, "ns/one")
	assert.Equal(t, pkgs[1].Name, "ns/two")
	assert.DeepEqual(t, pageSizes, []int{1, 1})
	assert.Equal(t, len(requests), 2, "expected exactly two page requests")
}

func TestListAllOrbPackages_StopsAtSafetyCap(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{orbWireEntry("ns/loop", "pkg-loop")},
			"page": map[string]any{"next": "always-more"},
		})
	})

	_, err := client.ListAllOrbPackages(context.Background(), circleci.ListOrbsOptions{}, nil)
	assert.Assert(t, err != nil)
	assert.Assert(t, is.Contains(err.Error(), "exceeded"))
}

func TestListAllOrbPackages_ContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, _ *http.Request) {
		calls++
		if calls == 1 {
			cancel()
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{orbWireEntry("ns/loop", "pkg-loop")},
			"page": map[string]any{"next": "more"},
		})
	})

	_, err := client.ListAllOrbPackages(ctx, circleci.ListOrbsOptions{}, nil)
	assert.Assert(t, err != nil)
	assert.ErrorIs(t, err, context.Canceled)
}

func TestGetOrbPackageByName_Found(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		q, _ := url.ParseQuery(r.URL.RawQuery)
		assert.Equal(t, q.Get("filter[name]"), "cci-labs/act")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{orbWireEntry("cci-labs/act", "pkg-1")},
		})
	})

	pkg, err := client.GetOrbPackageByName(context.Background(), "cci-labs/act")
	assert.NilError(t, err)
	assert.Equal(t, pkg.Name, "cci-labs/act")
}

func TestGetOrbPackageByName_NotFound(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{}})
	})

	_, err := client.GetOrbPackageByName(context.Background(), "nope/nope")
	assert.Assert(t, err != nil)
	assert.ErrorIs(t, err, circleci.ErrOrbNotFound)
}

func TestGetOrbSource_ReturnsRawText(t *testing.T) {
	const yaml = "version: 2.1\ndescription: test orb\n"
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, r.URL.Path, "/api/v3/orb/versions/ver-123/source")
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(yaml))
	})

	got, err := client.GetOrbSource(context.Background(), "ver-123")
	assert.NilError(t, err)
	assert.Equal(t, got, yaml)
}

func TestGetOrbSource_NotFound(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", staticHandler(http.StatusNotFound, `{"message":"not found"}`))

	_, err := client.GetOrbSource(context.Background(), "missing")
	assert.Assert(t, err != nil)
	var apiErr *circleci.APIError
	assert.Assert(t, errors.As(err, &apiErr))
	assert.Equal(t, apiErr.StatusCode, http.StatusNotFound)
}

func TestIsForbidden(t *testing.T) {
	assert.Assert(t, circleci.IsForbidden(&circleci.APIError{StatusCode: 403}))
	assert.Assert(t, !circleci.IsForbidden(&circleci.APIError{StatusCode: 401}))
	assert.Assert(t, !circleci.IsForbidden(nil))
}

func TestCompareVersions(t *testing.T) {
	tests := []struct {
		name string
		a, b string
		want int // -1, 0, or 1 (sign only is checked)
	}{
		{name: "numeric not lexical: 1.10.0 > 1.9.0", a: "1.10.0", b: "1.9.0", want: 1},
		{name: "reverse of above", a: "1.9.0", b: "1.10.0", want: -1},
		{name: "equal versions", a: "2.3.4", b: "2.3.4", want: 0},
		{name: "major beats minor/patch", a: "2.0.0", b: "1.99.99", want: 1},
		{name: "prerelease ranks below stable", a: "1.0.0-beta", b: "1.0.0", want: -1},
		{name: "stable ranks above prerelease", a: "1.0.0", b: "1.0.0-beta", want: 1},
		{name: "dev-style ranks below any parseable version", a: "dev:my-branch", b: "0.0.1", want: -1},
		{name: "parseable beats dev-style (reverse)", a: "1.2.3", b: "dev:my-branch", want: 1},
		{name: "two dev-style versions are indistinguishable here", a: "dev:a", b: "dev:b", want: 0},
		{name: "v-prefixed parses too", a: "v1.2.3", b: "1.2.2", want: 1},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := circleci.CompareVersions(tc.a, tc.b)
			switch {
			case tc.want > 0:
				assert.Assert(t, got > 0, "CompareVersions(%q, %q) = %d, want > 0", tc.a, tc.b, got)
			case tc.want < 0:
				assert.Assert(t, got < 0, "CompareVersions(%q, %q) = %d, want < 0", tc.a, tc.b, got)
			default:
				assert.Equal(t, got, 0)
			}
		})
	}
}

func TestOrbPackage_LatestVersion(t *testing.T) {
	t0 := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	t1 := t0.Add(24 * time.Hour)
	t2 := t0.Add(48 * time.Hour)

	tests := []struct {
		name     string
		versions []circleci.OrbVersion
		want     string // Version of the expected winner
	}{
		{
			name: "numeric semver ordering, not lexical",
			versions: []circleci.OrbVersion{
				{ID: "a", Version: "1.9.0", CreatedAt: t0},
				{ID: "b", Version: "1.10.0", CreatedAt: t1},
			},
			want: "1.10.0",
		},
		{
			name: "prerelease ranked below stable of the same major.minor.patch, even if published later",
			versions: []circleci.OrbVersion{
				{ID: "a", Version: "2.0.0", CreatedAt: t0},
				{ID: "b", Version: "2.0.0-beta.1", CreatedAt: t2},
			},
			want: "2.0.0",
		},
		{
			name: "dev-style ranked below any real release",
			versions: []circleci.OrbVersion{
				{ID: "a", Version: "0.0.1", CreatedAt: t0},
				{ID: "b", Version: "dev:feature-x", CreatedAt: t2},
			},
			want: "0.0.1",
		},
		{
			name: "all dev-style falls back to CreatedAt",
			versions: []circleci.OrbVersion{
				{ID: "a", Version: "dev:old", CreatedAt: t0},
				{ID: "b", Version: "dev:new", CreatedAt: t2},
			},
			want: "dev:new",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			pkg := circleci.OrbPackage{Versions: tc.versions}
			got, ok := pkg.LatestVersion()
			assert.Assert(t, ok)
			assert.Equal(t, got.Version, tc.want)
		})
	}
}

func TestOrbPackage_LatestVersion_Empty(t *testing.T) {
	pkg := circleci.OrbPackage{}
	_, ok := pkg.LatestVersion()
	assert.Assert(t, !ok)
}

// orbWireEntry builds a minimal orb/packages "data" entry for tests.
func orbWireEntry(name, id string) map[string]any {
	return map[string]any{
		"id": id,
		"attributes": map[string]any{
			"name":       name,
			"is_private": false,
			"is_listed":  true,
		},
		"references": map[string]any{
			"namespace":    map[string]any{"id": "ns-" + id},
			"orb_versions": []map[string]any{},
		},
	}
}
