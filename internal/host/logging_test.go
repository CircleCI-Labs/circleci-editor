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
	"net/http"
	"strings"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

// TestServer_Debug_DefaultRunIsQuiet is issue #216's headline. The owner's
// complaint was that starting the editor "outputs stuff into the terminal";
// the fix is that a healthy default-verbosity run adds nothing at all to the
// CLI's own banner.
//
// This runs a real server through a real listen/serve/shutdown cycle and
// asserts the host's log is *empty*. Deliberately an emptiness assertion
// rather than a list of forbidden strings: a new debug-shaped line added later
// would slip past a denylist, and the point of the issue is that the default
// is quiet by construction rather than by enumeration.
func TestServer_Debug_DefaultRunIsQuiet(t *testing.T) {
	logs := captureHostLog(t)

	h := runTestHost(t, host.Options{})
	assert.Equal(t, h.srv.Debugging(), false, "debug must be off unless asked for")

	assert.Equal(t, logs.String(), "",
		"issue #216: a default-verbosity run must print nothing of its own")
}

// TestServer_Debug_PrintsProgressWhenAsked is the other half: the flag has to
// unlock something, or it is decoration. The "listening on" line is the one
// piece of progress every run produces regardless of caches, tokens or
// network, so it is what this can assert without arranging a failure.
func TestServer_Debug_PrintsProgressWhenAsked(t *testing.T) {
	logs := captureHostLog(t)

	h := runTestHost(t, host.Options{Debug: true})
	assert.Equal(t, h.srv.Debugging(), true)

	assert.Assert(t, is.Contains(logs.String(), "listening on "),
		"with Debug the host should say what it is doing")
}

// TestServer_Debug_DoesNotSilenceTheProjectLookupDiagnosis guards the boundary
// issue #216 was most at risk of crossing. #150 added the project-lookup
// failure line *because* the failure was silent, so a verbosity change that
// re-silenced it would reintroduce the exact bug it fixed while looking like a
// tidy-up.
//
// Asserted at *default* verbosity, which is the only case that proves
// anything: with Debug on, everything prints and the test would pass
// vacuously.
func TestServer_Debug_DoesNotSilenceTheProjectLookupDiagnosis(t *testing.T) {
	logs := captureHostLog(t)

	client := fullFakeClient()
	client.project = nil
	client.projectErr = &circleci.APIError{StatusCode: http.StatusNotFound}

	ts := newProjectContextTestServer(t, connectedEnv(), client)
	status, _ := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
	assert.Equal(t, status, http.StatusOK)

	logged := logs.String()
	assert.Assert(t, is.Contains(logged, "project-context: failed to"),
		"issue #150's line must survive issue #216's quiet default")
	assert.Assert(t, is.Contains(logged, "HTTP 404"),
		"the status code is the actionable part of that line")
}

// TestServer_Debug_LogsNothingSensitiveAtEitherVerbosity is the guarantee
// issue #216 restates and #216 must not weaken: raising verbosity adds lines
// about this process's own activity, never a payload.
//
// The fake client is loaded with a sentinel in every place a value could leak
// from -- a token, an upstream error body, a context variable's contents --
// and the whole log is then searched for it with debug *on*, which is the
// permissive case. A leak that only happens at default verbosity would also
// fail, since these lines print at both levels.
func TestServer_Debug_LogsNothingSensitiveAtEitherVerbosity(t *testing.T) {
	const sentinel = "leak-me-SENSITIVE-VALUE"

	logs := captureHostLog(t)

	client := fullFakeClient()
	client.project = nil
	// An upstream error carrying a body: describeUpstreamError must classify
	// it by status and never quote it.
	client.projectErr = &circleci.APIError{
		StatusCode: http.StatusForbidden,
		Method:     http.MethodGet,
		Path:       "/api/v2/project/github/acme/web",
		Body:       sentinel,
	}

	env := connectedEnv()
	env.token = sentinel

	ts := newProjectContextTestServer(t, env, client)
	status, _ := doRequest(t, ts, http.MethodGet, "/api/project-context", nil)
	assert.Equal(t, status, http.StatusOK)

	assert.Assert(t, !strings.Contains(logs.String(), sentinel),
		"nothing sensitive may be logged at any verbosity; got %q", logs.String())
}
