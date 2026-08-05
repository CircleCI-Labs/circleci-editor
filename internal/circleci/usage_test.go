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
	"net/http"
	"testing"
	"time"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
)

func TestCreateUsageExportJob_RequestShape(t *testing.T) {
	var gotBody map[string]any
	var gotPath, gotMethod string

	_, client := newFakeCircleCI(t, "the-token", func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		assert.NilError(t, json.NewDecoder(r.Body).Decode(&gotBody))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"usage_export_job_id":"job-1","state":"created"}`))
	})

	start := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 7, 8, 0, 0, 0, 0, time.UTC)

	job, err := client.CreateUsageExportJob(context.Background(), "org-uuid", start, end, nil)
	assert.NilError(t, err)

	assert.Equal(t, gotMethod, http.MethodPost)
	assert.Equal(t, gotPath, "/api/v2/organizations/org-uuid/usage_export_job")
	assert.Equal(t, gotBody["start"], "2026-07-01T00:00:00Z")
	assert.Equal(t, gotBody["end"], "2026-07-08T00:00:00Z")
	// shared_org_ids must be entirely absent, not an empty list -- the
	// endpoint's own field-validation is picky about unexpected/malshaped
	// fields (see this package's usage.go doc comment).
	_, hasSharedOrgIDs := gotBody["shared_org_ids"]
	assert.Equal(t, hasSharedOrgIDs, false)

	assert.Equal(t, job.ID, "job-1")
	assert.Equal(t, job.State, circleci.UsageExportJobCreated)
	assert.Equal(t, len(job.DownloadURLs), 0)
}

func TestCreateUsageExportJob_SharedOrgIDs(t *testing.T) {
	var gotBody map[string]any
	_, client := newFakeCircleCI(t, "the-token", func(w http.ResponseWriter, r *http.Request) {
		assert.NilError(t, json.NewDecoder(r.Body).Decode(&gotBody))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"usage_export_job_id":"job-1","state":"created"}`))
	})

	start := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 7, 8, 0, 0, 0, 0, time.UTC)
	_, err := client.CreateUsageExportJob(context.Background(), "org-uuid", start, end, []string{"shared-org-1"})
	assert.NilError(t, err)

	shared, ok := gotBody["shared_org_ids"].([]any)
	assert.Assert(t, ok)
	assert.Equal(t, len(shared), 1)
	assert.Equal(t, shared[0], "shared-org-1")
}

func TestCreateUsageExportJob_RejectsEndBeforeStart(t *testing.T) {
	_, client := newFakeCircleCI(t, "the-token", func(_ http.ResponseWriter, _ *http.Request) {
		t.Fatal("must not make a request when end is not after start")
	})

	start := time.Date(2026, 7, 8, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	_, err := client.CreateUsageExportJob(context.Background(), "org-uuid", start, end, nil)
	assert.ErrorContains(t, err, "end")
}

func TestCreateUsageExportJob_RequiresOrgID(t *testing.T) {
	_, client := newFakeCircleCI(t, "the-token", func(_ http.ResponseWriter, _ *http.Request) {
		t.Fatal("must not make a request with no organization ID")
	})

	_, err := client.CreateUsageExportJob(context.Background(), "", time.Now(), time.Now().Add(time.Hour), nil)
	assert.ErrorContains(t, err, "organization ID")
}

func TestCreateUsageExportJob_Forbidden(t *testing.T) {
	_, client := newFakeCircleCI(t, "the-token", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"not authorized"}`))
	})

	_, err := client.CreateUsageExportJob(context.Background(), "org-uuid", time.Now(), time.Now().Add(time.Hour), nil)
	assert.Assert(t, is.ErrorContains(err, ""))
	assert.Assert(t, circleci.IsForbidden(err))
}

func TestGetUsageExportJob_Completed(t *testing.T) {
	var gotPath string
	// Real download_urls are pre-signed S3 URLs; only the shape (a list) is
	// exercised here, not the S3 signature scheme.
	_, client := newFakeCircleCI(t, "the-token", func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"usage_export_job_id":"job-1","state":"completed","download_urls":["https://example.com/a.csv.gz","https://example.com/b.csv.gz"]}`))
	})

	job, err := client.GetUsageExportJob(context.Background(), "org-uuid", "job-1")
	assert.NilError(t, err)
	assert.Equal(t, gotPath, "/api/v2/organizations/org-uuid/usage_export_job/job-1")
	assert.Equal(t, job.State, circleci.UsageExportJobCompleted)
	assert.Assert(t, job.State.Done())
	assert.DeepEqual(t, job.DownloadURLs, []string{"https://example.com/a.csv.gz", "https://example.com/b.csv.gz"})
}

func TestUsageExportJobState_Done(t *testing.T) {
	assert.Assert(t, !circleci.UsageExportJobCreated.Done())
	assert.Assert(t, !circleci.UsageExportJobProcessing.Done())
	assert.Assert(t, circleci.UsageExportJobCompleted.Done())
	assert.Assert(t, circleci.UsageExportJobFailed.Done())
}
