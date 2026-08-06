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

package usage_test

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
	"github.com/CircleCI-Labs/circleci-editor/internal/usage"
)

// fakeExportClient is a fake usage.ExportClient. CreateUsageExportJob always
// succeeds immediately with a completed job (no polling needed) unless
// scripted otherwise, keeping most tests fast and deterministic.
type fakeExportClient struct {
	mu sync.Mutex

	orgID  string
	orgErr error

	downloadURLs []string
	createErr    error

	createCalls []struct{ start, end time.Time }
}

func (f *fakeExportClient) GetOrganization(_ context.Context, slug string) (*circleci.Organization, error) {
	if f.orgErr != nil {
		return nil, f.orgErr
	}
	return &circleci.Organization{ID: f.orgID, Slug: slug}, nil
}

func (f *fakeExportClient) CreateUsageExportJob(_ context.Context, _ string, start, end time.Time, _ []string) (*circleci.UsageExportJob, error) {
	f.mu.Lock()
	f.createCalls = append(f.createCalls, struct{ start, end time.Time }{start, end})
	f.mu.Unlock()

	if f.createErr != nil {
		return nil, f.createErr
	}
	return &circleci.UsageExportJob{ID: "job-1", State: circleci.UsageExportJobCompleted, DownloadURLs: f.downloadURLs}, nil
}

func (f *fakeExportClient) GetUsageExportJob(_ context.Context, _, jobID string) (*circleci.UsageExportJob, error) {
	return &circleci.UsageExportJob{ID: jobID, State: circleci.UsageExportJobCompleted, DownloadURLs: f.downloadURLs}, nil
}

func (f *fakeExportClient) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.createCalls)
}

// fakeDownloader serves fixed, in-memory gzipped CSV content keyed by URL,
// standing in for the real pre-signed-S3-URL fetch.
type fakeDownloader struct {
	files map[string]string // url -> plain (ungzipped) CSV text
	err   error
}

// Download returns f.files[url] directly, already "decompressed" -- the
// Downloader interface's contract is to hand Reduce plain CSV text (see its
// doc comment); the real httpDownloader does the gunzipping internally, so
// this fake has no gzip layer to fake through.
func (f *fakeDownloader) Download(_ context.Context, url string) (io.ReadCloser, error) {
	if f.err != nil {
		return nil, f.err
	}
	content, ok := f.files[url]
	if !ok {
		return nil, errors.New("fakeDownloader: no such url")
	}
	return io.NopCloser(strings.NewReader(content)), nil
}

const testHeader = `"PROJECT_ID","PROJECT_NAME","JOB_NAME","JOB_RUN_DATE","RESOURCE_CLASS","OPERATING_SYSTEM","EXECUTOR","JOB_RUN_SECONDS","MEDIAN_CPU_UTILIZATION_PCT","MAX_CPU_UTILIZATION_PCT","MEDIAN_RAM_UTILIZATION_PCT","MAX_RAM_UTILIZATION_PCT","COMPUTE_CREDITS","TOTAL_CREDITS"` + "\n"

// dayWithinWindow returns a JOB_RUN_DATE n days before today, UTC, so a test
// row lands inside the cache's live window rather than on a fixed calendar
// date.
//
// These were date literals. Against a window measured from time.Now() that is
// a time bomb: "2026-07-29" sat inside a 7-day window the day it was written
// and fell outside it eight days later, so the suite passed for a week and
// then began failing on every platform at once. It surfaced first on one
// runner, which made it look like a flake on that platform -- it was not, and
// three sibling tests here were a day away from going the same way.
func dayWithinWindow(n int) string {
	return time.Now().UTC().AddDate(0, 0, -n).Format("2006-01-02")
}

func testCSVRow(day string) string {
	return `"proj-1","my-project","build","` + day + `","large","linux","docker","120","20","30","40","50","0.2","0.2"` + "\n"
}

// waitWarm blocks until done closes, failing the test if that takes longer
// than 5 seconds -- mirroring internal/orbs' cache_test.go waitWarm, for the
// same reason: nothing here should legitimately take anywhere near that
// long against fakes.
func waitWarm(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for warm cycle to finish")
	}
}

func TestCache_ColdStart_FetchesWholeWindow(t *testing.T) {
	client := &fakeExportClient{orgID: "org-uuid", downloadURLs: []string{"https://example.com/a.csv.gz"}}
	downloader := &fakeDownloader{files: map[string]string{
		"https://example.com/a.csv.gz": testHeader + testCSVRow(dayWithinWindow(1)),
	}}

	c := usage.New(client, downloader, "gh/acme", "", "circleci.com", 7, nil)
	c.Start(context.Background())
	waitWarm(t, c.WarmDone())

	status := c.Status()
	assert.Assert(t, status.Ready)
	assert.Assert(t, !status.Warming)
	assert.Equal(t, client.calls(), 1)

	summaries := c.Summaries()
	assert.Equal(t, len(summaries), 1)
	assert.Equal(t, summaries[0].JobName, "build")
	assert.Equal(t, summaries[0].Runs, 1)
	assert.Equal(t, summaries[0].AvgMedianCPUPct, 20.0)
}

func TestCache_Refresh_NoOpWhileWarming(t *testing.T) {
	blockedClient := &blockingExportClient{unblock: make(chan struct{}), entered: make(chan struct{})}
	c := usage.New(blockedClient, &fakeDownloader{}, "gh/acme", "", "circleci.com", 7, nil)
	c.Start(context.Background())

	// Wait until Start's own background warm has actually reached
	// CreateUsageExportJob (not just set Warming, which Start does
	// synchronously) before asserting a second call is a no-op -- otherwise
	// this races the goroutine Start launched.
	select {
	case <-blockedClient.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the warm cycle to reach CreateUsageExportJob")
	}

	// A second Refresh call while the first warm (from Start) is still in
	// flight must not start a second one.
	c.Refresh(context.Background())
	assert.Equal(t, blockedClient.callCount(), 1)

	close(blockedClient.unblock)
	waitWarm(t, c.WarmDone())
}

// blockingExportClient blocks CreateUsageExportJob until unblock is closed,
// closing entered on first entry, so a test can deterministically wait for
// the call to have started before asserting anything about a concurrent
// Refresh.
type blockingExportClient struct {
	mu          sync.Mutex
	calls       int
	unblock     chan struct{}
	entered     chan struct{}
	enteredOnce sync.Once
}

func (b *blockingExportClient) GetOrganization(_ context.Context, _ string) (*circleci.Organization, error) {
	return &circleci.Organization{ID: "org-uuid"}, nil
}

func (b *blockingExportClient) CreateUsageExportJob(ctx context.Context, _ string, _, _ time.Time, _ []string) (*circleci.UsageExportJob, error) {
	b.mu.Lock()
	b.calls++
	b.mu.Unlock()
	if b.entered != nil {
		b.enteredOnce.Do(func() { close(b.entered) })
	}
	select {
	case <-b.unblock:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return &circleci.UsageExportJob{ID: "job-1", State: circleci.UsageExportJobCompleted}, nil
}

func (b *blockingExportClient) GetUsageExportJob(_ context.Context, _, jobID string) (*circleci.UsageExportJob, error) {
	return &circleci.UsageExportJob{ID: jobID, State: circleci.UsageExportJobCompleted}, nil
}

func (b *blockingExportClient) callCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.calls
}

func TestCache_MultipleDownloadURLs_AllAreFetched(t *testing.T) {
	client := &fakeExportClient{orgID: "org-uuid", downloadURLs: []string{
		"https://example.com/a.csv.gz",
		"https://example.com/b.csv.gz",
	}}
	downloader := &fakeDownloader{files: map[string]string{
		"https://example.com/a.csv.gz": testHeader + testCSVRow(dayWithinWindow(2)),
		"https://example.com/b.csv.gz": testHeader + testCSVRow(dayWithinWindow(1)),
	}}

	c := usage.New(client, downloader, "gh/acme", "", "circleci.com", 7, nil)
	c.Start(context.Background())
	waitWarm(t, c.WarmDone())

	summaries := c.Summaries()
	assert.Equal(t, len(summaries), 1)
	// Both files' single run apiece must have been folded in -- if only
	// DownloadURLs[0] were read (the bug issue #307 explicitly warns
	// against), this would be 1, not 2.
	assert.Equal(t, summaries[0].Runs, 2)
}

func TestCache_NoOrgSlug_FailsHonestly(t *testing.T) {
	client := &fakeExportClient{orgID: "org-uuid"}
	c := usage.New(client, &fakeDownloader{}, "", "", "circleci.com", 7, nil)
	c.Start(context.Background())
	waitWarm(t, c.WarmDone())

	status := c.Status()
	assert.Assert(t, status.Err != nil)
	assert.ErrorContains(t, status.Err, "organization slug")
	assert.Equal(t, client.calls(), 0) // never even attempted a request with nothing to scope it to.
}

func TestCache_Forbidden_DegradesHonestly(t *testing.T) {
	client := &fakeExportClient{orgID: "org-uuid", createErr: &circleci.APIError{StatusCode: 403}}
	c := usage.New(client, &fakeDownloader{}, "gh/acme", "", "circleci.com", 7, nil)
	c.Start(context.Background())
	waitWarm(t, c.WarmDone())

	status := c.Status()
	assert.Assert(t, status.Err != nil)
	assert.Assert(t, circleci.IsForbidden(status.Err))
	// A permissions failure must not be reported as "empty" -- Ready stays
	// false since nothing was ever successfully published.
	assert.Assert(t, !status.Ready)
}

func TestCache_SetWindowDays_RejectsInvalidValues(t *testing.T) {
	c := usage.New(&fakeExportClient{}, &fakeDownloader{}, "gh/acme", "", "circleci.com", 7, nil)
	err := c.SetWindowDays(10)
	assert.ErrorContains(t, err, "7 14 30")
	assert.Equal(t, c.WindowDays(), 7) // unchanged.

	assert.NilError(t, c.SetWindowDays(30))
	assert.Equal(t, c.WindowDays(), 30)
}

func TestCache_DiskPersistence_SurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	client := &fakeExportClient{orgID: "org-uuid", downloadURLs: []string{"https://example.com/a.csv.gz"}}
	downloader := &fakeDownloader{files: map[string]string{
		"https://example.com/a.csv.gz": testHeader + testCSVRow(dayWithinWindow(1)),
	}}

	c1 := usage.New(client, downloader, "gh/acme", dir, "circleci.com", 7, nil)
	c1.Start(context.Background())
	waitWarm(t, c1.WarmDone())
	assert.Equal(t, client.calls(), 1)

	// A second Cache instance, pointed at the same directory and org/host,
	// must load what the first one persisted before doing any network work
	// of its own delta-fetch decision.
	blocked := &blockingExportClient{unblock: make(chan struct{})}
	c2 := usage.New(blocked, downloader, "gh/acme", dir, "circleci.com", 7, nil)
	c2.Start(context.Background())

	// The disk-loaded data must be visible synchronously, before the
	// background warm (which is blocked) has any chance to run.
	summaries := c2.Summaries()
	assert.Equal(t, len(summaries), 1)
	assert.Assert(t, c2.Status().Ready)

	close(blocked.unblock)
	waitWarm(t, c2.WarmDone())
}
