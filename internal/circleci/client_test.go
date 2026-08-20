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
	"errors"
	"fmt"
	"net/http"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
)

func TestNewClient_HostNormalization(t *testing.T) {
	tests := []struct {
		name    string
		host    string
		wantErr string
	}{
		{name: "empty defaults to circleci.com"},
		{name: "trims trailing slash", host: "https://circleci.example.com/"},
		{name: "https accepted", host: "https://circleci.example.com"},
		{name: "http accepted", host: "http://localhost:8080"},
		{name: "missing scheme rejected", host: "circleci.example.com", wantErr: "must use the http or https scheme"},
		{name: "unsupported scheme rejected", host: "ftp://circleci.example.com", wantErr: "must use the http or https scheme"},
		{name: "missing host rejected", host: "https://", wantErr: "missing a hostname"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := circleci.NewClient(circleci.Config{Host: tc.host})
			if tc.wantErr == "" {
				assert.NilError(t, err)
				return
			}
			assert.ErrorContains(t, err, tc.wantErr)
		})
	}
}

func TestClient_HasToken(t *testing.T) {
	withToken, err := circleci.NewClient(circleci.Config{Token: "tok"})
	assert.NilError(t, err)
	assert.Assert(t, withToken.HasToken())

	withoutToken, err := circleci.NewClient(circleci.Config{})
	assert.NilError(t, err)
	assert.Assert(t, !withoutToken.HasToken())
}

func TestAPIError_Error(t *testing.T) {
	err := &circleci.APIError{StatusCode: 500, Method: "POST", Path: "/api/v2/x", Body: "boom"}
	assert.Assert(t, is.Contains(err.Error(), "500"))
	assert.Assert(t, is.Contains(err.Error(), "/api/v2/x"))
	assert.Assert(t, is.Contains(err.Error(), "boom"))
}

func TestIsUnauthorized_IsRateLimited(t *testing.T) {
	assert.Assert(t, circleci.IsUnauthorized(&circleci.APIError{StatusCode: 401}))
	assert.Assert(t, !circleci.IsUnauthorized(&circleci.APIError{StatusCode: 403}))
	assert.Assert(t, !circleci.IsUnauthorized(nil))

	assert.Assert(t, circleci.IsRateLimited(&circleci.APIError{StatusCode: 429}))
	assert.Assert(t, !circleci.IsRateLimited(&circleci.APIError{StatusCode: 500}))
	assert.Assert(t, !circleci.IsRateLimited(nil))
}

// TestIsNotFound_StatusCode covers the two predicates issue #150 needed: a 404
// must be distinguishable from every other failure (an un-onboarded repository
// is not a broken token), and the status code must be readable without going
// anywhere near APIError.Body, which can quote secret metadata.
func TestIsNotFound_StatusCode(t *testing.T) {
	assert.Assert(t, circleci.IsNotFound(&circleci.APIError{StatusCode: 404}))
	assert.Assert(t, !circleci.IsNotFound(&circleci.APIError{StatusCode: 403}))
	assert.Assert(t, !circleci.IsNotFound(nil))
	assert.Assert(t, !circleci.IsNotFound(errors.New("dial tcp: no such host")))

	// Wrapped, the way every Client method wraps what it returns.
	wrapped := fmt.Errorf("looking up a project: %w", &circleci.APIError{StatusCode: 404})
	assert.Assert(t, circleci.IsNotFound(wrapped))

	status, ok := circleci.StatusCode(wrapped)
	assert.Assert(t, ok)
	assert.Equal(t, status, 404)

	_, ok = circleci.StatusCode(errors.New("dial tcp: no such host"))
	assert.Assert(t, !ok)

	_, ok = circleci.StatusCode(context.DeadlineExceeded)
	assert.Assert(t, !ok)
}

// TestIsResourceExhausted guards the `&&` in IsResourceExhausted, not just its
// happy path: the function exists to tell "the orb registry choked on this
// page[limit]" apart from "CircleCI is having an outage that happens to
// return 502s," and those two situations share a status code. If the body
// check were ever dropped (or loosened to `||`), an ordinary 502 outage would
// be misread as a page-size problem and the orb crawl would burn its retry
// budget halving page size for no reason instead of just surfacing the
// outage.
func TestIsResourceExhausted(t *testing.T) {
	const resourceExhaustedBody = `{"error":{"type":"ResourceExhausted","title":"Bad Gateway."}}`

	tests := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "502 with the ResourceExhausted body marker",
			err:  &circleci.APIError{StatusCode: http.StatusBadGateway, Body: resourceExhaustedBody},
			want: true,
		},
		{
			// The case that matters: a plain 502 gateway outage must not be
			// read as "the page was too large," or an unrelated outage turns
			// into a pointless page-size-halving loop.
			name: "502 with an unrelated body is not resource exhaustion",
			err:  &circleci.APIError{StatusCode: http.StatusBadGateway, Body: "<html><body><h1>502 Bad Gateway</h1></body></html>"},
			want: false,
		},
		{
			name: "502 with a different JSON error type is not resource exhaustion",
			err:  &circleci.APIError{StatusCode: http.StatusBadGateway, Body: `{"error":{"type":"Unavailable","title":"Bad Gateway."}}`},
			want: false,
		},
		{
			name: "the marker in a non-502 status is not resource exhaustion",
			err:  &circleci.APIError{StatusCode: http.StatusInternalServerError, Body: resourceExhaustedBody},
			want: false,
		},
		{
			name: "a non-APIError is never resource exhaustion",
			err:  errors.New("dial tcp: connection refused"),
			want: false,
		},
		{
			// errors.As must see through wrapping, since every Client method
			// wraps what it returns (see TestIsNotFound_StatusCode above).
			name: "a wrapped APIError is still detected via errors.As",
			err:  fmt.Errorf("listing orb packages: %w", &circleci.APIError{StatusCode: http.StatusBadGateway, Body: resourceExhaustedBody}),
			want: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, circleci.IsResourceExhausted(tc.err), tc.want)
		})
	}
}
