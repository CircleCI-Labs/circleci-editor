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
	"errors"
	"log"
)

// compileOwnerWithoutOrgCaveat explains a compile performed without an
// organization, in the second person, ready to append to a validation
// message. Deliberately does not claim the config is fine -- only that this
// particular failure mode cannot be ruled out from here.
const compileOwnerWithoutOrgCaveat = "This config was compiled without an organization, " +
	"so orbs that resolve per-organization -- private orbs, and URL orbs governed by " +
	"an allow-list -- could not be resolved. Errors that name one of those may not " +
	"reflect a problem with the config itself."

// compileOwnerID returns the organization UUID to compile a config on behalf
// of, and a caveat to state when there is none.
//
// # Why compilation needs an organization at all
//
// Two orb kinds resolve per-organization rather than globally: private orbs,
// and URL orbs, which CircleCI gates on an org-scoped allow-list. Compiling
// without naming an org means the compiler cannot consult either, so a config
// that compiles in CI comes back with, verbatim:
//
//	Orb https://.../go.yml is not permitted by the organization's URL orb allow-list.
//
// That is the worst failure this surface has: a valid config reported invalid,
// for a reason that is about the request rather than the config. Issue #67.
//
// # Why this is a best-effort lookup and not an error
//
// An unresolvable organization must not stop a config being compiled. Every
// config that uses only public orbs -- the overwhelming majority -- compiles
// identically with and without an owner, so failing the whole request to
// obtain a value most requests do not need would trade a rare wrong answer
// for a common absent one. Hence "" plus a caveat rather than an error: the
// compile proceeds exactly as it did before this existed, and the caveat
// keeps the *reporting* honest about what could not be checked.
//
// The empty-string return covers three genuinely different situations, none
// of which is worth distinguishing to the caller because the response is the
// same in all three: no organization slug in the environment (running
// standalone, outside a git checkout), no client to ask with (no token), and
// a lookup that failed upstream.
func (s *Server) compileOwnerID(ctx context.Context) (ownerID, caveat string) {
	orgSlug := s.env.OrgSlug()
	if orgSlug == "" || s.policyClient == nil {
		return "", compileOwnerWithoutOrgCaveat
	}

	id, err := s.resolveOwnerID(ctx, orgSlug)
	if err != nil {
		// Logged, not returned: the user-facing caveat says what could not
		// be checked, which is what they can act on. Why the lookup failed
		// is an operator detail, and it is the same lookup POST
		// /api/policy/decide already reports on in full.
		if errors.Is(err, errOrganizationHasNoID) {
			log.Printf("compile: organization record carries no id; compiling without an owner")
		} else {
			//nolint:gosec // G706: describeUpstreamError returns this package's own bounded prose built from a status code and error class, never attacker-controlled text, so it cannot forge a log line; the same false positive logPolicyUpstreamFailure carries a nolint for.
			log.Printf("compile: could not resolve the organization that owns this project, "+
				"compiling without an owner: %s", describeUpstreamError(err))
		}
		return "", compileOwnerWithoutOrgCaveat
	}

	return id, ""
}
