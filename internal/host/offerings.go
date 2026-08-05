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
	"time"

	"github.com/CircleCI-Labs/circleci-editor/internal/offerings"
)

// machineOfferingsFetchTimeout bounds how long GET /api/machine-offerings
// waits on a (possibly cache-missing) fetch before giving up and reporting
// unavailable -- mirrors dockerTagsFetchTimeout: opening the machine-image
// or Xcode picker must never hang the UI indefinitely on a slow or
// half-dead network.
const machineOfferingsFetchTimeout = 12 * time.Second

// offeringsCache is the subset of *offerings.Cache that handleMachineOfferings
// needs, defined here (rather than depended on directly) so tests can
// substitute a fake without making any HTTP calls -- same rationale as
// dockerTagsCache.
//
// Refresh (issue #285, extended by #305) is the manual "check now"
// counterpart to Get's own lazy, TTL-gated fetch, kept on this interface
// rather than a separate one for the same reason dockerTagsCache's is: one
// handler needs both.
type offeringsCache interface {
	Get(ctx context.Context) (offerings.Result, error)
	Refresh(ctx context.Context) (offerings.Result, error)
	Status() offerings.Status
}

// machineOfferingsResponse is the JSON shape returned by
// GET /api/machine-offerings.
//
// Available follows the same convention as dockerTagsResponse.Available:
// false means "there is nothing useful here, and Reason says why" -- which
// for this endpoint only ever means the fetch failed and no previously
// cached catalog exists to fall back to (this cache needs no CIRCLE_TOKEN
// at all -- issue #305, consistent with #160 making orb browsing
// tokenless -- so Available is never false for a missing one). At that
// point the SPA falls back one layer further still, to images.ts's
// hand-curated MACHINE_IMAGES literal, which survives as the offline floor
// now that this live catalog exists -- there is no retry loop here.
//
// Reason may be set even when Available is true: a stale-but-labelled
// catalog (the most recent refresh attempt failed, but an earlier one is
// still being served) is available and explains itself in the same field a
// genuine failure would have used, distinguished by Stale being true
// alongside it.
type machineOfferingsResponse struct {
	Available  bool                `json:"available"`
	Reason     string              `json:"reason,omitempty"`
	Linux      map[string][]string `json:"linux,omitempty"`
	Windows    map[string][]string `json:"windows,omitempty"`
	MacOS      map[string][]string `json:"macos,omitempty"`
	Deprecated map[string][]string `json:"deprecated,omitempty"`
	FetchedAt  string              `json:"fetchedAt,omitempty"`
	Live       bool                `json:"live,omitempty"`
	// Stale reports that FetchedAt is older than the cache's own refresh
	// window (internal/offerings' cacheTTL) -- the "stale-but-labelled"
	// state issue #285 asks every cache to be able to report, rather than
	// silently serving old data as if it were current.
	Stale bool `json:"stale,omitempty"`
}

// handleMachineOfferings serves GET /api/machine-offerings: CircleCI's
// current machine-image catalog (issue #305), fetched and cached by
// internal/offerings from GET /api/v3/catalog/offerings -- which machine
// images are offered for which resource class, and which have been
// deprecated. See that package's own doc comment for the honest-degradation
// states this reports, and internal/dockerhub's package doc comment (this
// endpoint's closest sibling) for why the fetch happens here rather than
// directly from the browser.
//
// Needs no CIRCLE_TOKEN: the upstream endpoint answers unauthenticated,
// verified live (see internal/circleci.GetOfferings's own doc comment), so
// this cache -- like DockerTagsCache and GuidesCache -- is always
// constructed, never gated on whether this host has a token.
func (s *Server) handleMachineOfferings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	if s.offeringsCache == nil {
		// Only reachable in a test that overrode the cache with nil.
		writeJSON(w, http.StatusOK, machineOfferingsResponse{
			Available: false,
			Reason:    "the machine-image catalog cache is not available in this build",
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), machineOfferingsFetchTimeout)
	defer cancel()

	// ?refresh=1 is the manual "check now" affordance issue #285 established
	// and this issue extends to the machine-image/Xcode pickers. Like
	// GET /api/docker-tags, this is a single small request, so -- unlike the
	// orbs/guides endpoints' trigger-and-poll shape -- it is simply awaited
	// within this request: Refresh bypasses the cache's TTL and returns the
	// live result (or, on failure, whatever was cached before), bounded by
	// the same machineOfferingsFetchTimeout as every other call here.
	fetch := s.offeringsCache.Get
	if r.URL.Query().Get("refresh") == "1" {
		fetch = s.offeringsCache.Refresh
	}

	result, err := fetch(ctx)
	if err != nil {
		writeJSON(w, http.StatusOK, machineOfferingsResponse{
			Available: false,
			Reason:    "could not reach CircleCI and no previously cached machine-image catalog is available: " + describeUpstreamError(err),
		})
		return
	}

	status := s.offeringsCache.Status()
	var reason string
	if status.Err != nil {
		// The most recent refresh attempt failed, but an earlier one is
		// still being served (Stale, below, says how old). Named here so
		// the picker can show both facts together rather than only "stale".
		reason = "the most recent refresh attempt failed: " + describeUpstreamError(status.Err)
	}

	writeJSON(w, http.StatusOK, machineOfferingsResponse{
		Available:  true,
		Reason:     reason,
		Linux:      result.Offerings.Linux,
		Windows:    result.Offerings.Windows,
		MacOS:      result.Offerings.MacOS,
		Deprecated: result.Offerings.Deprecated,
		FetchedAt:  result.FetchedAt.UTC().Format(time.RFC3339),
		Live:       result.Live,
		Stale:      status.Stale,
	})
}
