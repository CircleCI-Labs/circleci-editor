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

package circleci

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

// The usage-export endpoints, verified live against the real API (issue
// #307) rather than guessed from documentation:
//
//	POST /api/v2/organizations/{orgID}/usage_export_job
//	GET  /api/v2/organizations/{orgID}/usage_export_job/{usageExportJobID}
//
// The POST accepts exactly three fields: start, end, shared_org_ids. It
// rejects both project_id and project_ids with an "Unexpected field" 400 --
// confirmed by probing one unknown field at a time, because the endpoint
// reports only the *first* unexpected field it finds and a two-field probe
// (project_ids alongside a deliberately bogus field) came back naming only
// the bogus one, which would otherwise read as project_ids being accepted.
// It is not: the export is always org-wide and date-ranged, never
// project-scoped, so a caller filters PROJECT_ID client-side.
//
// orgID is the organization's UUID (the same value circleci policy decide
// resolves via GetOrganization -- see policy.go's own comment on why a slug
// has to be resolved first), not the "<vcs>/<org>" slug.
const (
	createUsageExportJobPathFormat = "/api/v2/organizations/%s/usage_export_job"
	getUsageExportJobPathFormat    = "/api/v2/organizations/%s/usage_export_job/%s"
)

// UsageExportJobState is the lifecycle of an async usage-export job, as
// reported by the "state" field of both the create and get responses.
type UsageExportJobState string

// UsageExportJobCreated, UsageExportJobProcessing and UsageExportJobCompleted
// are the three states issue #307's own live verification named ("created ->
// processing -> completed").
const (
	// UsageExportJobCreated is the state a job starts in, immediately after
	// CreateUsageExportJob returns.
	UsageExportJobCreated UsageExportJobState = "created"

	// UsageExportJobProcessing means the export is running.
	UsageExportJobProcessing UsageExportJobState = "processing"

	// UsageExportJobCompleted means the export succeeded; DownloadURLs is
	// populated.
	UsageExportJobCompleted UsageExportJobState = "completed"

	// UsageExportJobFailed is not among the three states issue #307's own
	// live verification named ("created -> processing -> completed"), but a
	// job that never reaches "completed" needs some state that means "stop
	// polling, this did not work" rather than polling forever. Treated the
	// same as an unrecognised state by GetUsageExportJob's caller (see
	// internal/usage) -- both stop polling, neither is silently read as
	// completed.
	UsageExportJobFailed UsageExportJobState = "failed"
)

// Done reports whether s is a terminal state -- one a poller should stop on,
// whether or not the job actually succeeded.
func (s UsageExportJobState) Done() bool {
	return s == UsageExportJobCompleted || s == UsageExportJobFailed
}

// UsageExportJob is the state of one usage-export job, as returned by both
// CreateUsageExportJob and GetUsageExportJob.
type UsageExportJob struct {
	ID    string
	State UsageExportJobState

	// DownloadURLs is a list, deliberately not a single URL: issue #307's own
	// live verification found a single day, single-org export already
	// returning two pre-signed URLs, not one -- a large org over a 30-day
	// window will return more. Every caller must iterate this list; treating
	// it as one file silently drops data with no error to show for it.
	// Empty until State is UsageExportJobCompleted.
	DownloadURLs []string
}

// usageExportJobWireRequest is the JSON request body for
// POST .../usage_export_job. start/end are sent as RFC 3339 timestamps.
// shared_org_ids is omitted entirely (nil slice) when the caller supplies
// none -- this client never asks for a project_id/project_ids field to be
// sent, because the endpoint rejects both (see this file's package comment).
type usageExportJobWireRequest struct {
	Start        string   `json:"start"`
	End          string   `json:"end"`
	SharedOrgIDs []string `json:"shared_org_ids,omitempty"`
}

// usageExportJobWireResponse is the JSON shape of both the create and get
// responses.
type usageExportJobWireResponse struct {
	ID           string   `json:"usage_export_job_id"`
	State        string   `json:"state"`
	DownloadURLs []string `json:"download_urls"`
}

func (w usageExportJobWireResponse) toJob() *UsageExportJob {
	return &UsageExportJob{
		ID:           w.ID,
		State:        UsageExportJobState(w.State),
		DownloadURLs: w.DownloadURLs,
	}
}

// CreateUsageExportJob starts an async usage-export job covering
// [start, end) for the organization identified by orgID (its UUID, not its
// slug -- see GetOrganization), optionally widened to sharedOrgIDs' usage as
// well. The returned job's State is normally UsageExportJobCreated; the
// caller polls GetUsageExportJob until State.Done().
//
// A non-nil error here is most often a permissions problem: usage export may
// require organization-admin access, unverified as of this writing (issue
// #307) -- IsForbidden(err) is how a caller tells that apart from a
// transient failure, the same split internal/host/policy.go already makes
// for the config-policy decision endpoint (#247's degrade-honestly rule).
func (c *Client) CreateUsageExportJob(ctx context.Context, orgID string, start, end time.Time, sharedOrgIDs []string) (*UsageExportJob, error) {
	if orgID == "" {
		return nil, fmt.Errorf("circleci: create usage export job requires an organization ID")
	}
	if !end.After(start) {
		return nil, fmt.Errorf("circleci: create usage export job: end (%s) must be after start (%s)", end, start)
	}

	path := fmt.Sprintf(createUsageExportJobPathFormat, escapePathSegments(orgID))
	wireReq := usageExportJobWireRequest{
		Start:        start.UTC().Format(time.RFC3339),
		End:          end.UTC().Format(time.RFC3339),
		SharedOrgIDs: sharedOrgIDs,
	}

	var wire usageExportJobWireResponse
	if err := c.do(ctx, http.MethodPost, path, wireReq, &wire); err != nil {
		return nil, err
	}
	return wire.toJob(), nil
}

// GetUsageExportJob polls the state of a usage-export job previously started
// by CreateUsageExportJob. DownloadURLs is populated once State is
// UsageExportJobCompleted.
func (c *Client) GetUsageExportJob(ctx context.Context, orgID, jobID string) (*UsageExportJob, error) {
	if orgID == "" {
		return nil, fmt.Errorf("circleci: get usage export job requires an organization ID")
	}
	if jobID == "" {
		return nil, fmt.Errorf("circleci: get usage export job requires a job ID")
	}

	path := fmt.Sprintf(getUsageExportJobPathFormat, escapePathSegments(orgID), escapePathSegments(jobID))

	var wire usageExportJobWireResponse
	if err := c.do(ctx, http.MethodGet, path, nil, &wire); err != nil {
		return nil, err
	}
	return wire.toJob(), nil
}
