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
	"strings"
	"testing"
	"time"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
	"github.com/CircleCI-Labs/circleci-editor/internal/host"
	"github.com/CircleCI-Labs/circleci-editor/internal/offerings"
)

// fakeOfferingsCache is a fake implementation of the host package's
// unexported offeringsCache interface.
type fakeOfferingsCache struct {
	result offerings.Result
	err    error
	status offerings.Status

	refreshResult    offerings.Result
	refreshErr       error
	refreshResultSet bool
	refreshCalls     int
}

func (f *fakeOfferingsCache) Get(context.Context) (offerings.Result, error) {
	return f.result, f.err
}

func (f *fakeOfferingsCache) Refresh(context.Context) (offerings.Result, error) {
	f.refreshCalls++
	if f.refreshResultSet {
		return f.refreshResult, f.refreshErr
	}
	return f.result, f.err
}

func (f *fakeOfferingsCache) Status() offerings.Status {
	return f.status
}

func newOfferingsServer(t *testing.T, cache *fakeOfferingsCache) *httptest.Server {
	t.Helper()

	srv, err := host.New(host.Options{
		WorkDir:        t.TempDir(),
		Version:        "test-version",
		OfferingsCache: cache,
	})
	assert.NilError(t, err)

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func TestServer_MachineOfferings_HappyPath(t *testing.T) {
	fetchedAt := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	cache := &fakeOfferingsCache{result: offerings.Result{
		Offerings: circleci.Offerings{
			Linux:      map[string][]string{"large": {"ubuntu-2404:current"}},
			Windows:    map[string][]string{"windows.large": {"windows-server-2025-gui:current"}},
			MacOS:      map[string][]string{"m4pro.large": {"xcode:26.5.0"}},
			Deprecated: map[string][]string{"macos": {"xcode:26.0.1"}},
		},
		FetchedAt: fetchedAt,
		Live:      true,
	}}
	ts := newOfferingsServer(t, cache)

	status, body := doRequest(t, ts, http.MethodGet, "/api/machine-offerings", nil)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Available  bool                `json:"available"`
		Linux      map[string][]string `json:"linux"`
		Windows    map[string][]string `json:"windows"`
		MacOS      map[string][]string `json:"macos"`
		Deprecated map[string][]string `json:"deprecated"`
		Live       bool                `json:"live"`
		Stale      bool                `json:"stale"`
		FetchedAt  string              `json:"fetchedAt"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Assert(t, got.Available)
	assert.Assert(t, got.Live)
	assert.Assert(t, !got.Stale)
	assert.DeepEqual(t, got.Linux, map[string][]string{"large": {"ubuntu-2404:current"}})
	assert.DeepEqual(t, got.Windows, map[string][]string{"windows.large": {"windows-server-2025-gui:current"}})
	assert.DeepEqual(t, got.MacOS, map[string][]string{"m4pro.large": {"xcode:26.5.0"}})
	assert.DeepEqual(t, got.Deprecated, map[string][]string{"macos": {"xcode:26.0.1"}})
	assert.Equal(t, got.FetchedAt, "2026-07-31T12:00:00Z")
}

func TestServer_MachineOfferings_UnavailableWhenNeverFetchedAndFetchFails(t *testing.T) {
	cache := &fakeOfferingsCache{err: errors.New("network unreachable")}
	ts := newOfferingsServer(t, cache)

	status, body := doRequest(t, ts, http.MethodGet, "/api/machine-offerings", nil)
	assert.Equal(t, status, http.StatusOK) // Degradation, not an HTTP error -- see the handler's doc comment.

	var got struct {
		Available bool   `json:"available"`
		Reason    string `json:"reason"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Assert(t, !got.Available)
	assert.Assert(t, got.Reason != "")
	// Never forward the raw upstream error/body to a browser.
	assert.Assert(t, !strings.Contains(got.Reason, "network unreachable"))
}

func TestServer_MachineOfferings_StaleButLabelled(t *testing.T) {
	fetchedAt := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	cache := &fakeOfferingsCache{
		result: offerings.Result{
			Offerings: circleci.Offerings{Linux: map[string][]string{"large": {"ubuntu-2404:current"}}},
			FetchedAt: fetchedAt,
			Live:      false,
		},
		status: offerings.Status{
			Attempted: true,
			FetchedAt: fetchedAt,
			Stale:     true,
			Err:       errors.New("upstream 503"),
		},
	}
	ts := newOfferingsServer(t, cache)

	status, body := doRequest(t, ts, http.MethodGet, "/api/machine-offerings", nil)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Available bool   `json:"available"`
		Stale     bool   `json:"stale"`
		Reason    string `json:"reason"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Assert(t, got.Available)
	assert.Assert(t, got.Stale)
	assert.Assert(t, got.Reason != "")
}

func TestServer_MachineOfferings_RefreshQueryParamCallsRefresh(t *testing.T) {
	cache := &fakeOfferingsCache{result: offerings.Result{
		Offerings: circleci.Offerings{Linux: map[string][]string{"large": {"ubuntu-2404:current"}}},
		FetchedAt: time.Now(),
		Live:      false,
	}}
	ts := newOfferingsServer(t, cache)

	status, _ := doRequest(t, ts, http.MethodGet, "/api/machine-offerings?refresh=1", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, cache.refreshCalls, 1)
}

func TestServer_MachineOfferings_WorksWithNoCircleToken(t *testing.T) {
	t.Setenv("CIRCLE_TOKEN", "")

	cache := &fakeOfferingsCache{result: offerings.Result{
		Offerings: circleci.Offerings{Linux: map[string][]string{"large": {"ubuntu-2404:current"}}},
		FetchedAt: time.Now(),
	}}
	ts := newOfferingsServer(t, cache)

	status, _ := doRequest(t, ts, http.MethodGet, "/api/machine-offerings", nil)
	assert.Equal(t, status, http.StatusOK)
}

func TestServer_MachineOfferings_MethodNotAllowed(t *testing.T) {
	ts := newOfferingsServer(t, &fakeOfferingsCache{})

	status, _ := doRequest(t, ts, http.MethodPost, "/api/machine-offerings", nil)
	assert.Equal(t, status, http.StatusMethodNotAllowed)
}
