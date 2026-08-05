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
	"net/http"
	"strconv"
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/usage"
)

// usageCacheState names the mutually exclusive answers to "why does the
// usage-based suggestion data look the way it does" -- the same
// honest-degradation shape internal/host/orbs.go's orbCacheState
// established for issue #257, applied here for issue #307.
type usageCacheState string

const (
	// usageCacheNeverFetched: nothing held, nothing in flight, no failure
	// recorded. Normally only observable before Start has run, or when this
	// host has no CIRCLE_TOKEN / no resolvable organization at all (see
	// s.usageCache's nil-ness in server.go).
	usageCacheNeverFetched usageCacheState = "never-fetched"

	// usageCacheFetching: nothing held yet, and a warm cycle is running.
	usageCacheFetching usageCacheState = "fetching"

	// usageCacheEmpty: a warm cycle completed and genuinely found nothing --
	// e.g. a brand-new organization with no job runs yet in the window.
	usageCacheEmpty usageCacheState = "empty"

	// usageCacheFailed: nothing held, and a recorded reason why. Covers the
	// permissions case issue #307 flags as unverified: usage export may
	// require organization-admin access, and a 403 here degrades to this
	// state with a body-free reason, the same shape #247's policy-fetch
	// degradation uses, rather than looking broken.
	usageCacheFailed usageCacheState = "failed"

	// usageCacheStale: data held, but either the most recent warm cycle
	// failed (reason set) or the covered range has fallen behind the last
	// complete UTC day. Served and labelled, not withheld.
	usageCacheStale usageCacheState = "stale"

	// usageCacheReady: data held, covering through the last complete UTC
	// day, no recorded failure.
	usageCacheReady usageCacheState = "ready"
)

// describeUsageCacheState classifies status the same way
// describeOrbCacheState does, and for the same reason: with nothing to show,
// "a fetch is running" outranks a recorded failure (waiting is still the
// right answer even after an earlier failed attempt); with something to
// show, any recorded failure or staleness demotes ready to stale rather than
// hiding either fact.
func describeUsageCacheState(status usage.Status) (usageCacheState, string) {
	reason := ""
	if status.Err != nil {
		reason = describeUpstreamError(status.Err)
	}

	if !status.Ready {
		switch {
		case status.Warming:
			return usageCacheFetching, reason
		case reason != "":
			return usageCacheFailed, reason
		default:
			return usageCacheNeverFetched, reason
		}
	}

	if reason != "" || status.Stale {
		return usageCacheStale, reason
	}
	if status.CoveredEnd.IsZero() {
		// A warm cycle published successfully, but the configured window
		// held nothing at all -- e.g. a brand-new organization with no job
		// runs yet. Distinct from usageCacheNeverFetched: this cache did try,
		// and came back with a genuine (if empty) answer.
		return usageCacheEmpty, reason
	}
	return usageCacheReady, reason
}

// usageStatusPayload is the JSON shape of usageResponse.Status.
type usageStatusPayload struct {
	Ready      bool            `json:"ready"`
	Warming    bool            `json:"warming"`
	State      usageCacheState `json:"state"`
	Reason     string          `json:"reason,omitempty"`
	WindowDays int             `json:"windowDays"`
	// CoveredFrom/CoveredThrough are RFC 3339 UTC calendar-day boundaries
	// naming the range this cache currently holds data for -- CoveredThrough
	// is the *last complete day covered*, inclusive, matching the trailing-
	// edge rule: a window is never extended to include today, since today's
	// jobs may still be running. Both omitted
	// when nothing is held yet.
	CoveredFrom    string `json:"coveredFrom,omitempty"`
	CoveredThrough string `json:"coveredThrough,omitempty"`
	FetchedAt      string `json:"fetchedAt,omitempty"`
	Stale          bool   `json:"stale,omitempty"`
}

// usageJobPayload is one job's rolled-up utilisation/credit summary, as
// reported by GET /api/usage. It is always scoped to the current project
// (see handleUsage) -- an org-wide export was needed to produce it, but this
// host never forwards another project's rows to the browser, minimising
// exposure of data this editor had to fetch but was never asked to display.
type usageJobPayload struct {
	JobName         string `json:"jobName"`
	ResourceClass   string `json:"resourceClass"`
	Executor        string `json:"executor"`
	OperatingSystem string `json:"operatingSystem"`

	Runs int `json:"runs"`

	AvgMedianCPUPct float64 `json:"avgMedianCpuPct"`
	AvgMaxCPUPct    float64 `json:"avgMaxCpuPct"`
	MaxMaxCPUPct    float64 `json:"maxMaxCpuPct"`

	AvgMedianRAMPct float64 `json:"avgMedianRamPct"`
	AvgMaxRAMPct    float64 `json:"avgMaxRamPct"`
	MaxMaxRAMPct    float64 `json:"maxMaxRamPct"`

	ComputeCredits float64 `json:"computeCredits"`
	TotalCredits   float64 `json:"totalCredits"`
}

// usageResponse is the JSON shape returned by GET /api/usage.
//
// Available is false only when this host has nothing that could ever answer
// (no token, or no resolvable project/organization) -- see
// usageUnavailable. Once a cache exists, Available is always true and
// Status/Jobs report its (possibly empty, possibly stale, possibly failed)
// state honestly instead.
type usageResponse struct {
	Available bool                `json:"available"`
	Reason    string              `json:"reason,omitempty"`
	Status    *usageStatusPayload `json:"status,omitempty"`
	Jobs      []usageJobPayload   `json:"jobs,omitempty"`
}

// usageCache is the subset of *usage.Cache handleUsage needs. Defined here
// (rather than depending on *usage.Cache directly) so tests can substitute a
// fake, the same rationale as orbCache and guidesCache.
type usageCache interface {
	Status() usage.Status
	Summaries() []usage.JobSummary
	Refresh(ctx context.Context)
	WindowDays() int
	SetWindowDays(days int) error
}

// handleUsage serves GET /api/usage: the current project's slice of this
// host's background-warmed Usage Export summary (issue #307), for the
// palette's resource-class right-sizing suggestions.
//
// This endpoint downloads nothing itself -- s.usageWarmer (if non-nil)
// already fetches org-wide usage data in the background, on the same "warm
// at start, never gate a response on it, serve what's cached" model
// internal/orbs.Cache established. What this handler adds is the
// project-scoping: an export names every project in the organisation, but a
// browser asking about *this* project's config is only ever shown this
// project's own rows, identified by CIRCLE_PROJECT_ID.
//
// "refresh=1" triggers the same manual "check now" affordance issue #285
// established for the other caches. "window=7|14|30" changes the
// configured retention/fetch window (issue #307's own explicit setting);
// invalid values are rejected with 400 rather than silently ignored, and a
// successful change also triggers a refresh so it takes effect immediately
// rather than waiting for the cache's next natural cycle.
func (s *Server) handleUsage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	if s.usageCache == nil {
		writeJSON(w, http.StatusOK, usageResponse{
			Available: false,
			Reason:    s.usageUnavailableReason(),
		})
		return
	}

	if rawWindow := r.URL.Query().Get("window"); rawWindow != "" {
		days, err := strconv.Atoi(rawWindow)
		if err != nil || !usage.IsValidWindowDays(days) {
			writeError(w, http.StatusBadRequest, "unrecognised window; want one of: 7, 14, 30 (days)")
			return
		}
		// The browser is the one place this setting is persisted (localStorage,
		// the same convention web/src/state/themeStore.ts uses), so it names its
		// choice on every request rather than this host remembering one across
		// restarts. Only actually re-triggering a fetch on a genuine *change*
		// keeps a page merely reopened with the same window from re-warming for
		// nothing every time.
		if days != s.usageCache.WindowDays() {
			if err := s.usageCache.SetWindowDays(days); err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			s.usageCache.Refresh(s.shutdownCtx)
		}
	} else if r.URL.Query().Get("refresh") == "1" {
		s.usageCache.Refresh(s.shutdownCtx)
	}

	status := s.usageCache.Status()
	projectID := s.env.ProjectID

	var jobs []usageJobPayload
	if projectID != "" {
		for _, j := range s.usageCache.Summaries() {
			if j.ProjectID != projectID {
				continue
			}
			jobs = append(jobs, toUsageJobPayload(j))
		}
	}

	writeJSON(w, http.StatusOK, usageResponse{
		Available: true,
		Status:    toUsageStatusPayload(status),
		Jobs:      jobs,
	})
}

// usageUnavailableReason explains why s.usageCache is nil -- either this
// host has no token at all, or it could not determine which organization to
// scope a usage export to (both checked when the cache would otherwise have
// been constructed; see buildCircleCIClients).
func (s *Server) usageUnavailableReason() string {
	if !s.env.HasToken() {
		return "no CircleCI API token available; a usage export needs a token"
	}
	if s.env.OrgSlug() == "" {
		return "which organization owns this project could not be determined, " +
			"and usage data belongs to an organization"
	}
	return "usage data is not available on this host"
}

func toUsageStatusPayload(status usage.Status) *usageStatusPayload {
	state, reason := describeUsageCacheState(status)

	payload := &usageStatusPayload{
		Ready:      status.Ready,
		Warming:    status.Warming,
		State:      state,
		Reason:     reason,
		WindowDays: status.WindowDays,
		Stale:      status.Stale,
	}
	if !status.CoveredStart.IsZero() {
		payload.CoveredFrom = status.CoveredStart.UTC().Format(time.RFC3339)
	}
	if !status.CoveredEnd.IsZero() {
		// CoveredEnd is exclusive (the day *after* the last complete day
		// held); CoveredThrough is reported inclusive, since "through
		// 2026-07-30" is what a human reads naturally, not "before
		// 2026-07-31".
		payload.CoveredThrough = status.CoveredEnd.Add(-24 * time.Hour).UTC().Format(time.RFC3339)
	}
	if !status.FetchedAt.IsZero() {
		payload.FetchedAt = status.FetchedAt.UTC().Format(time.RFC3339)
	}
	return payload
}

func toUsageJobPayload(j usage.JobSummary) usageJobPayload {
	return usageJobPayload{
		JobName:         j.JobName,
		ResourceClass:   j.ResourceClass,
		Executor:        j.Executor,
		OperatingSystem: j.OperatingSystem,
		Runs:            j.Runs,
		AvgMedianCPUPct: j.AvgMedianCPUPct,
		AvgMaxCPUPct:    j.AvgMaxCPUPct,
		MaxMaxCPUPct:    j.MaxMaxCPUPct,
		AvgMedianRAMPct: j.AvgMedianRAMPct,
		AvgMaxRAMPct:    j.AvgMaxRAMPct,
		MaxMaxRAMPct:    j.MaxMaxRAMPct,
		ComputeCredits:  j.ComputeCredits,
		TotalCredits:    j.TotalCredits,
	}
}
