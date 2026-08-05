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
	"testing"
	"time"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
	"github.com/CircleCI-Labs/circleci-editor/internal/host"
	"github.com/CircleCI-Labs/circleci-editor/internal/usage"
)

// fakeUsageCache is a fake implementation of the host package's unexported
// usageCache interface.
type fakeUsageCache struct {
	status    usage.Status
	summaries []usage.JobSummary

	refreshCalls int
	setWindowErr error
	gotWindow    int
	windowDays   int
}

func (f *fakeUsageCache) Status() usage.Status          { return f.status }
func (f *fakeUsageCache) Summaries() []usage.JobSummary { return f.summaries }
func (f *fakeUsageCache) Refresh(context.Context)       { f.refreshCalls++ }
func (f *fakeUsageCache) WindowDays() int               { return f.windowDays }
func (f *fakeUsageCache) SetWindowDays(days int) error {
	f.gotWindow = days
	if f.setWindowErr != nil {
		return f.setWindowErr
	}
	f.windowDays = days
	return nil
}

func newUsageTestServer(t *testing.T, projectID string, cache *fakeUsageCache) *httptest.Server {
	t.Helper()

	clearCircleEnv(t)
	t.Setenv("CIRCLE_TOKEN", sentinelToken)
	if projectID != "" {
		t.Setenv("CIRCLE_PROJECT_ID", projectID)
	}

	opts := host.Options{WorkDir: t.TempDir(), Version: "test-version"}
	if cache != nil {
		opts.UsageCache = cache
	}

	srv, err := host.New(opts)
	assert.NilError(t, err)

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

type usageResponseBody struct {
	Available bool `json:"available"`
	Reason    string
	Status    struct {
		Ready          bool   `json:"ready"`
		Warming        bool   `json:"warming"`
		State          string `json:"state"`
		Reason         string `json:"reason"`
		WindowDays     int    `json:"windowDays"`
		CoveredFrom    string `json:"coveredFrom"`
		CoveredThrough string `json:"coveredThrough"`
		FetchedAt      string `json:"fetchedAt"`
		Stale          bool   `json:"stale"`
	} `json:"status"`
	Jobs []struct {
		JobName         string  `json:"jobName"`
		ResourceClass   string  `json:"resourceClass"`
		Executor        string  `json:"executor"`
		OperatingSystem string  `json:"operatingSystem"`
		Runs            int     `json:"runs"`
		AvgMedianCPUPct float64 `json:"avgMedianCpuPct"`
		MaxMaxRAMPct    float64 `json:"maxMaxRamPct"`
	} `json:"jobs"`
}

func TestHandleUsage_ScopesToCurrentProjectOnly(t *testing.T) {
	fetchedAt := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	coveredStart := time.Date(2026, 7, 24, 0, 0, 0, 0, time.UTC)
	coveredEnd := time.Date(2026, 7, 31, 0, 0, 0, 0, time.UTC)

	cache := &fakeUsageCache{
		windowDays: 7,
		status: usage.Status{
			Ready:        true,
			WindowDays:   7,
			CoveredStart: coveredStart,
			CoveredEnd:   coveredEnd,
			FetchedAt:    fetchedAt,
		},
		summaries: []usage.JobSummary{
			{
				JobKey:          usage.JobKey{ProjectID: "proj-this", JobName: "build", ResourceClass: "large"},
				Runs:            12,
				AvgMedianCPUPct: 18.0,
				MaxMaxRAMPct:    50.0,
			},
			{
				JobKey: usage.JobKey{ProjectID: "proj-other", JobName: "deploy", ResourceClass: "medium"},
				Runs:   9,
			},
		},
	}
	ts := newUsageTestServer(t, "proj-this", cache)

	status, body := doRequest(t, ts, http.MethodGet, "/api/usage", nil)
	assert.Equal(t, status, http.StatusOK)

	var got usageResponseBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, true)
	assert.Equal(t, got.Status.Ready, true)
	assert.Equal(t, got.Status.State, "ready")
	assert.Equal(t, got.Status.WindowDays, 7)
	assert.Equal(t, got.Status.CoveredThrough, "2026-07-30T00:00:00Z")

	// Only this project's job -- "proj-other" must never reach the browser,
	// even though the cache holds it (issue #307: minimise what an org-wide
	// fetch actually exposes to any one project's view).
	assert.Equal(t, len(got.Jobs), 1)
	assert.Equal(t, got.Jobs[0].JobName, "build")
	assert.Equal(t, got.Jobs[0].Runs, 12)
	assert.Equal(t, got.Jobs[0].AvgMedianCPUPct, 18.0)
}

func TestHandleUsage_NoProjectID_ReportsStatusButNoJobs(t *testing.T) {
	cache := &fakeUsageCache{status: usage.Status{Ready: true}, summaries: []usage.JobSummary{
		{JobKey: usage.JobKey{ProjectID: "proj-1", JobName: "build"}, Runs: 5},
	}}
	ts := newUsageTestServer(t, "", cache)

	status, body := doRequest(t, ts, http.MethodGet, "/api/usage", nil)
	assert.Equal(t, status, http.StatusOK)

	var got usageResponseBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, true)
	assert.Equal(t, len(got.Jobs), 0)
}

func TestHandleUsage_NeverFetched(t *testing.T) {
	cache := &fakeUsageCache{status: usage.Status{Ready: false}}
	ts := newUsageTestServer(t, "proj-1", cache)

	_, body := doRequest(t, ts, http.MethodGet, "/api/usage", nil)
	var got usageResponseBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Status.State, "never-fetched")
}

func TestHandleUsage_Fetching(t *testing.T) {
	cache := &fakeUsageCache{status: usage.Status{Ready: false, Warming: true}}
	ts := newUsageTestServer(t, "proj-1", cache)

	_, body := doRequest(t, ts, http.MethodGet, "/api/usage", nil)
	var got usageResponseBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Status.State, "fetching")
}

func TestHandleUsage_ReadyButGenuinelyEmpty(t *testing.T) {
	// A successful warm cycle that found nothing in the window (e.g. a
	// brand-new organization) must read as distinct from never having
	// fetched at all.
	cache := &fakeUsageCache{status: usage.Status{Ready: true}}
	ts := newUsageTestServer(t, "proj-1", cache)

	_, body := doRequest(t, ts, http.MethodGet, "/api/usage", nil)
	var got usageResponseBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Status.State, "empty")
}

func TestHandleUsage_Forbidden_DegradesHonestly(t *testing.T) {
	cache := &fakeUsageCache{status: usage.Status{
		Ready: false,
		Err:   &circleci.APIError{StatusCode: http.StatusForbidden},
	}}
	ts := newUsageTestServer(t, "proj-1", cache)

	status, body := doRequest(t, ts, http.MethodGet, "/api/usage", nil)
	assert.Equal(t, status, http.StatusOK) // Never a 5xx: this is a degraded-but-honest 200, like orbsSearchResponse.
	var got usageResponseBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Status.State, "failed")
	assert.Assert(t, got.Status.Reason != "")
}

func TestHandleUsage_StaleServedAndLabelled(t *testing.T) {
	cache := &fakeUsageCache{status: usage.Status{Ready: true, Stale: true}, summaries: []usage.JobSummary{
		{JobKey: usage.JobKey{ProjectID: "proj-1", JobName: "build"}, Runs: 3},
	}}
	ts := newUsageTestServer(t, "proj-1", cache)

	_, body := doRequest(t, ts, http.MethodGet, "/api/usage", nil)
	var got usageResponseBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Status.State, "stale")
	assert.Equal(t, len(got.Jobs), 1) // stale data is still served, not withheld.
}

func TestHandleUsage_Refresh(t *testing.T) {
	cache := &fakeUsageCache{status: usage.Status{Ready: true}}
	ts := newUsageTestServer(t, "proj-1", cache)

	doRequest(t, ts, http.MethodGet, "/api/usage?refresh=1", nil)
	assert.Equal(t, cache.refreshCalls, 1)
}

func TestHandleUsage_ChangeWindow_TriggersRefresh(t *testing.T) {
	cache := &fakeUsageCache{windowDays: 7, status: usage.Status{Ready: true}}
	ts := newUsageTestServer(t, "proj-1", cache)

	status, _ := doRequest(t, ts, http.MethodGet, "/api/usage?window=14", nil)
	assert.Equal(t, status, http.StatusOK)
	assert.Equal(t, cache.gotWindow, 14)
	assert.Equal(t, cache.refreshCalls, 1)
}

func TestHandleUsage_SameWindow_DoesNotRefresh(t *testing.T) {
	cache := &fakeUsageCache{windowDays: 7, status: usage.Status{Ready: true}}
	ts := newUsageTestServer(t, "proj-1", cache)

	doRequest(t, ts, http.MethodGet, "/api/usage?window=7", nil)
	assert.Equal(t, cache.refreshCalls, 0)
}

func TestHandleUsage_InvalidWindow_Rejected(t *testing.T) {
	cache := &fakeUsageCache{windowDays: 7, status: usage.Status{Ready: true}}
	ts := newUsageTestServer(t, "proj-1", cache)

	status, _ := doRequest(t, ts, http.MethodGet, "/api/usage?window=9", nil)
	assert.Equal(t, status, http.StatusBadRequest)
	assert.Equal(t, cache.refreshCalls, 0)
}

func TestHandleUsage_NoToken_Unavailable(t *testing.T) {
	clearCircleEnv(t)
	srv, err := host.New(host.Options{WorkDir: t.TempDir(), Version: "test-version"})
	assert.NilError(t, err)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	status, body := doRequest(t, ts, http.MethodGet, "/api/usage", nil)
	assert.Equal(t, status, http.StatusOK)
	var got usageResponseBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, got.Available, false)
	assert.Assert(t, got.Reason != "")
}

func TestHandleUsage_WrongMethod(t *testing.T) {
	ts := newUsageTestServer(t, "proj-1", &fakeUsageCache{})
	status, _ := doRequest(t, ts, http.MethodPost, "/api/usage", nil)
	assert.Equal(t, status, http.StatusMethodNotAllowed)
}
