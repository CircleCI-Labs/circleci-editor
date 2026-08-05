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

// Package circleci implements a small HTTP client for the parts of the
// CircleCI API this editor needs (currently: config compilation/validation
// on API v2). We deliberately do not depend on circleci-sdk-go — it has no
// config-compile support and is maintained only for the Terraform provider —
// and we cannot import circleci-cli's own internal/httpcl package (Go's
// internal/ visibility rule blocks that from outside its module). Instead,
// this package re-implements an equivalent client, adapted from
// circleci-cli's MIT-licensed internal/httpcl design (retry policy, header
// handling, error shape). See CONTRIBUTING.md's third-party attributions
// for the full attribution.
package circleci

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	// defaultHost is used when Config.Host is empty.
	defaultHost = "https://circleci.com"

	// defaultUserAgent is used when Config.UserAgent is empty.
	defaultUserAgent = "circleci-editor"

	// maxAttempts bounds the number of HTTP attempts do makes for a single
	// call, including the initial attempt.
	maxAttempts = 3

	// baseBackoff is the delay before the second attempt; each subsequent
	// retry doubles it.
	baseBackoff = 100 * time.Millisecond

	// maxResponseBodyBytes caps how much of a response body do will read,
	// to guard against an excessively large or malicious response.
	maxResponseBodyBytes = 10 << 20 // 10 MiB
)

// Config configures a Client.
type Config struct {
	// Host is the CircleCI API base URL, e.g. "https://circleci.com".
	// Defaults to https://circleci.com when empty. Must use the http or
	// https scheme.
	Host string

	// Token is the CircleCI API token used to authenticate requests. It
	// may be empty, in which case requests are sent unauthenticated (the
	// caller is responsible for deciding whether that is useful).
	Token string

	// UserAgent overrides the default User-Agent header sent with every
	// request.
	UserAgent string

	// HTTPClient overrides the default *http.Client used to execute
	// requests. Defaults to a client with no fixed timeout; callers should
	// bound request duration via the context passed to client methods
	// instead.
	HTTPClient *http.Client
}

// Client is a small HTTP client for the CircleCI API.
type Client struct {
	host       string
	token      string
	userAgent  string
	httpClient *http.Client
}

// NewClient constructs a Client from cfg, normalising and validating the
// configured host.
func NewClient(cfg Config) (*Client, error) {
	host := cfg.Host
	if host == "" {
		host = defaultHost
	}
	host = strings.TrimRight(host, "/")

	u, err := url.Parse(host)
	if err != nil {
		return nil, fmt.Errorf("circleci: parse host %q: %w", host, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("circleci: host %q must use the http or https scheme", host)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("circleci: host %q is missing a hostname", host)
	}

	userAgent := cfg.UserAgent
	if userAgent == "" {
		userAgent = defaultUserAgent
	}

	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{}
	}

	return &Client{
		host:       host,
		token:      cfg.Token,
		userAgent:  userAgent,
		httpClient: httpClient,
	}, nil
}

// HasToken reports whether this client was configured with a non-empty API
// token.
func (c *Client) HasToken() bool {
	return c.token != ""
}

// setHeaders sets the headers common to every request.
//
// The CircleCI v2 API accepts either a "Circle-Token" header or an
// "Authorization: Bearer <token>" header; we send Circle-Token as the
// primary scheme because it is the form documented for, and used
// throughout, the v2 API (including compile-config-with-defaults), while
// Authorization: Bearer is better suited to APIs that also serve non-CircleCI
// clients.
func (c *Client) setHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.userAgent)
	if c.token != "" {
		req.Header.Set("Circle-Token", c.token)
	}
}

// APIError is returned by Client methods when the CircleCI API responds with
// a non-2xx status that persists after retries. It is never returned for a
// well-formed response that merely describes an invalid config (see
// CompileConfig).
type APIError struct {
	// StatusCode is the HTTP status code of the failing response.
	StatusCode int

	// Method and Path identify the request that failed.
	Method, Path string

	// Body is the (possibly truncated) response body, for diagnostics.
	Body string
}

// Error implements the error interface.
func (e *APIError) Error() string {
	return fmt.Sprintf("circleci: %s %s: unexpected status %d: %s", e.Method, e.Path, e.StatusCode, e.Body)
}

// IsUnauthorized reports whether err is an *APIError with StatusCode 401,
// i.e. the configured token was rejected by the CircleCI API.
func IsUnauthorized(err error) bool {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.StatusCode == http.StatusUnauthorized
	}
	return false
}

// IsRateLimited reports whether err is an *APIError with StatusCode 429,
// i.e. the CircleCI API rate-limited this client after exhausting retries.
func IsRateLimited(err error) bool {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.StatusCode == http.StatusTooManyRequests
	}
	return false
}

// IsForbidden reports whether err is an *APIError with StatusCode 403, i.e.
// the configured token was accepted but lacks permission for the request
// (for example, listing private orbs without the right org membership).
func IsForbidden(err error) bool {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.StatusCode == http.StatusForbidden
	}
	return false
}

// IsNotFound reports whether err is an *APIError with StatusCode 404, i.e.
// the token was accepted and the request was well-formed, but the thing it
// named does not exist (or is invisible to this token).
//
// Worth its own predicate rather than being folded into "some other
// failure", because for a lookup keyed by a slug this host *assembled itself*
// — `<vcs>/<org>/<repo>` from the CLI-injected environment — a 404 is the one
// status that points at the slug rather than at the network, the token or
// CircleCI. See issue #150: collapsing it into a generic "the request did not
// succeed" is what made an un-onboarded repository indistinguishable from a
// DNS failure.
func IsNotFound(err error) bool {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.StatusCode == http.StatusNotFound
	}
	return false
}

// IsBadRequest reports whether err is an *APIError with StatusCode 400,
// i.e. CircleCI understood the request but rejected what it carried.
//
// Worth its own predicate for the same reason IsNotFound is: for an endpoint
// this host posts a *config* to, a 400 is the one status that is about the
// submitted document rather than about the token, the network or CircleCI.
// The config-policy decision endpoint answers 400 when the input is not
// parseable YAML, and telling the user that is far more useful than "the
// request did not succeed" — while still not being a verdict on the config's
// policy standing (see internal/host/policy.go).
func IsBadRequest(err error) bool {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.StatusCode == http.StatusBadRequest
	}
	return false
}

// StatusCode returns the HTTP status of err when it is (or wraps) an
// *APIError, and ok=false when err is not an upstream status failure at all
// (a transport error, a timeout, a decode failure).
//
// This is the safe half of an APIError: a status code carries no upstream
// response *body*, and so — unlike err.Error() — may be shown to a user and
// written to the host's log. See describeUpstreamError in internal/host.
func StatusCode(err error) (int, bool) {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.StatusCode, true
	}
	return 0, false
}

// do executes a single logical JSON API call: it marshals body (if non-nil)
// as the JSON request payload, issues the HTTP request against host+path
// via doRaw, and unmarshals a successful response into out (if non-nil).
//
// See doRaw for the retry policy shared by every Client method.
func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var bodyBytes []byte
	if body != nil {
		var err error
		bodyBytes, err = json.Marshal(body)
		if err != nil {
			return fmt.Errorf("circleci: marshal request body for %s %s: %w", method, path, err)
		}
	}

	respBody, err := c.doRaw(ctx, method, path, bodyBytes)
	if err != nil {
		return err
	}

	if out != nil {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("circleci: %s %s: decode response body: %w", method, path, err)
		}
	}
	return nil
}

// doRaw executes a single logical API call and returns the raw response
// body bytes of a successful call, without assuming any particular content
// type. do (JSON in, JSON out) and GetOrbSource (JSON in, plain-text out)
// both build on this.
//
// Transient failures — network errors, HTTP 429, and HTTP 5xx — are retried
// up to maxAttempts times with exponential backoff starting at baseBackoff,
// honouring a Retry-After response header when present. ctx cancellation
// aborts both in-flight requests and any pending backoff sleep. All other
// non-2xx responses are returned immediately as *APIError.
func (c *Client) doRaw(ctx context.Context, method, path string, bodyBytes []byte) ([]byte, error) {
	fullURL := c.host + path

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		var reqBody io.Reader
		if bodyBytes != nil {
			reqBody = bytes.NewReader(bodyBytes)
		}

		req, err := http.NewRequestWithContext(ctx, method, fullURL, reqBody)
		if err != nil {
			return nil, fmt.Errorf("circleci: build request %s %s: %w", method, path, err)
		}
		c.setHeaders(req)

		resp, doErr := c.httpClient.Do(req) //nolint:bodyclose,gosec // closed just below once doErr is checked; fullURL is built from an operator-supplied, scheme-validated Config.Host plus a package-internal constant path, not from request input.
		if doErr != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if attempt == maxAttempts {
				return nil, fmt.Errorf("circleci: %s %s: %w", method, path, doErr)
			}
			if !sleepBackoff(ctx, backoffDelay(attempt, "")) {
				return nil, ctx.Err()
			}
			continue
		}

		respBody, readErr := readLimited(resp.Body)
		_ = resp.Body.Close()
		if readErr != nil {
			return nil, fmt.Errorf("circleci: %s %s: read response body: %w", method, path, readErr)
		}

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return respBody, nil
		}

		apiErr := &APIError{StatusCode: resp.StatusCode, Method: method, Path: path, Body: string(respBody)}

		retryable := resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500
		if !retryable || attempt == maxAttempts {
			return nil, apiErr
		}

		if !sleepBackoff(ctx, backoffDelay(attempt, resp.Header.Get("Retry-After"))) {
			return nil, ctx.Err()
		}
	}

	// Unreachable: every branch of the loop above returns on the final
	// attempt. This satisfies the compiler's control-flow analysis.
	return nil, fmt.Errorf("circleci: %s %s: exhausted retries", method, path)
}

// backoffDelay returns the delay to wait before the attempt following
// attempt. It honours a Retry-After header value (either delay-seconds or an
// HTTP-date, per RFC 9110) when retryAfter is non-empty and parses
// successfully; otherwise it falls back to exponential backoff from
// baseBackoff.
func backoffDelay(attempt int, retryAfter string) time.Duration {
	if d, ok := parseRetryAfter(retryAfter); ok {
		return d
	}
	return baseBackoff * time.Duration(1<<uint(attempt-1)) //nolint:gosec // attempt is bounded by maxAttempts.
}

// parseRetryAfter parses a Retry-After header value, returning ok=false if v
// is empty or not in a recognised format.
func parseRetryAfter(v string) (time.Duration, bool) {
	if v == "" {
		return 0, false
	}
	if secs, err := strconv.Atoi(v); err == nil {
		if secs < 0 {
			return 0, false
		}
		return time.Duration(secs) * time.Second, true
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d, true
		}
		return 0, true
	}
	return 0, false
}

// sleepBackoff waits for d, or until ctx is done, whichever comes first. It
// reports whether the wait completed normally (as opposed to being cut short
// by ctx).
func sleepBackoff(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

// readLimited reads all of r, up to maxResponseBodyBytes, returning an error
// if the body is larger than that.
func readLimited(r io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxResponseBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxResponseBodyBytes {
		return nil, fmt.Errorf("circleci: response body exceeds %d bytes", maxResponseBodyBytes)
	}
	return data, nil
}
