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

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
)

// validateTimeout bounds how long a single POST /api/validate call is
// allowed to take, including any retries performed by the circleci client.
const validateTimeout = 20 * time.Second

// validateRequest is the JSON shape accepted by POST /api/validate.
type validateRequest struct {
	Contents *string `json:"contents"`
}

// validateErrorItem describes a single problem found in the submitted
// config, mirroring circleci.CompileError.
type validateErrorItem struct {
	Message string `json:"message"`
}

// validateResponse is the JSON shape returned by POST /api/validate.
//
// Available reports whether server-side validation could be attempted at
// all. Callers must check Available before interpreting Valid, Errors, or
// OutputYAML:
//
//   - When Available is false and Source is "unavailable", this server has
//     no CIRCLE_TOKEN configured at all (see also metaResponse.HasToken).
//     Reason says so. The fix is to supply a token.
//   - When Available is false and Source is "unauthorized", a token was
//     supplied and the CircleCI API refused it (HTTP 401). Reason names the
//     status code. This is deliberately not reported as an HTTP error
//     response: a rejected token is not a bad gateway, it is CircleCI
//     answering — refusing is not the same failure mode as not answering,
//     and the two demand opposite actions (replace the token vs. wait and
//     retry). See issue #224.
//   - In both cases above, Valid/Errors/OutputYAML are meaningless zero
//     values — this is not a validation result, so it must not be presented
//     as "config is invalid".
//   - When Available is true, Source is "api" and the CircleCI
//     compile-config-with-defaults API was actually called. Valid then
//     distinguishes a merely invalid config (Valid=false, Errors populated)
//     from success (Valid=true, OutputYAML populated).
//
// A transport failure, a CircleCI-server-side failure (5xx, rate limiting),
// or any other non-2xx this host cannot classify more specifically is
// instead reported as an HTTP 502 error response rather than through this
// struct — it never appears as Valid=false, and it never appears as
// Available=false either, because "we could not reach CircleCI" and "we
// have nothing to ask CircleCI with" are different facts. See
// describeUpstreamError.
// Caveat is set when the compile went ahead without something that can change
// its verdict — today, only a missing organization, which leaves private and
// URL orbs unresolvable (see compileOwnerID). It is not an error and does not
// contradict Valid: a config can be genuinely valid, or genuinely broken, with
// a caveat attached. It exists so that Valid=false can be *presented* with the
// limits of the check that produced it, rather than as a flat assertion the
// config is wrong.
type validateResponse struct {
	Available  bool                `json:"available"`
	Source     string              `json:"source"`
	Valid      bool                `json:"valid"`
	Errors     []validateErrorItem `json:"errors,omitempty"`
	OutputYAML string              `json:"outputYaml,omitempty"`
	Reason     string              `json:"reason,omitempty"`
	Caveat     string              `json:"caveat,omitempty"`
}

// handleValidate serves POST /api/validate: it submits the given config to
// CircleCI's compile-config-with-defaults API and reports back whether it
// is valid. See validateResponse for the exact response shape and how to
// distinguish "invalid config" from "validation unavailable".
func (s *Server) handleValidate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	defer func() { _ = r.Body.Close() }()

	var req validateRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "malformed request body")
		return
	}
	if req.Contents == nil {
		writeError(w, http.StatusBadRequest, "missing required field: contents")
		return
	}

	if !s.env.HasToken() {
		writeJSON(w, http.StatusOK, validateResponse{
			Available: false,
			Source:    "unavailable",
			Reason:    "no CircleCI API token available; validation requires a token",
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), validateTimeout)
	defer cancel()

	// Naming the organization is what lets CircleCI resolve this org's private
	// orbs and apply its URL orb allow-list. Without it, a config that
	// compiles in CI is reported invalid — issue #67. Best-effort by design:
	// see compileOwnerID for why an unresolvable organization compiles anyway,
	// with a caveat, rather than failing the request.
	ownerID, ownerCaveat := s.compileOwnerID(ctx)

	result, err := s.compiler.CompileConfig(ctx, circleci.CompileRequest{
		ConfigYAML: *req.Contents,
		OwnerID:    ownerID,
	})
	if err != nil {
		// A rejected token and an unreachable API look identical to the
		// browser unless this host tells them apart: both used to arrive as
		// the same HTTP 502 with different prose, which the frontend's
		// generic error handling could not (and should not have had to)
		// distinguish. Issue #224. IsUnauthorized is the one upstream
		// outcome that is not a transport or gateway problem at all — the
		// request reached CircleCI and CircleCI answered "no" — so it is
		// reported at HTTP 200 through the same Available=false channel
		// "no token configured" uses, distinguished by Source, rather than
		// as an error response a generic HTTP client would treat like any
		// other 5xx-adjacent failure.
		//
		// A CompileConfig call never names a project, and the organization it
		// may name (above) is one CircleCI itself just resolved — a lookup
		// that failed contributes no owner at all rather than a doubtful one.
		// So there is still no project-or-org-not-found case to confuse this
		// with: a 404 here would mean something else entirely and falls
		// through to the generic branch below, described honestly by
		// describeUpstreamError rather than guessed at.
		if circleci.IsUnauthorized(err) {
			writeJSON(w, http.StatusOK, validateResponse{
				Available: false,
				Source:    "unauthorized",
				Reason: "the CircleCI API rejected the configured token (HTTP 401). " +
					"This is not the same as CircleCI being unreachable — the request " +
					"arrived and was refused, so the fix is to replace the token, not to wait.",
			})
			return
		}
		writeError(w, http.StatusBadGateway,
			"failed to validate config via the CircleCI API: "+describeUpstreamError(err))
		return
	}

	resp := validateResponse{
		Available:  true,
		Source:     "api",
		Valid:      result.Valid,
		OutputYAML: result.OutputYAML,
	}
	if len(result.Errors) > 0 {
		resp.Errors = make([]validateErrorItem, len(result.Errors))
		for i, e := range result.Errors {
			resp.Errors[i] = validateErrorItem{Message: e.Message}
		}
	}

	// Only attached to a failure, and deliberately so. Compiling without an
	// organization is *stricter* than compiling with one -- it can only fail
	// to resolve an orb that would otherwise have resolved, never invent a
	// success -- so a caveat on Valid=true would qualify a verdict that the
	// missing owner cannot have affected. Noise on every valid config is a
	// real cost: it trains the reader to ignore the field on the one response
	// where it changes what the errors mean.
	if !result.Valid {
		resp.Caveat = ownerCaveat
	}

	writeJSON(w, http.StatusOK, resp)
}
