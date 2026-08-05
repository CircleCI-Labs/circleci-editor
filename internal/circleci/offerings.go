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
	"net/http"
)

// offeringsV3Path is GET /api/v3/catalog/offerings -- issue #305, found in
// CircleCI-Public/circleci-yaml-language-server's pkg/utils/machineOfferings.go
// (a sibling public repo neither #242 nor #181 knew about when this project's
// own machine-image literal and resource-class parser were written).
//
// Verified live: it answers HTTP 200 both unauthenticated and authenticated,
// so — like the orb registry (#160) — GetOfferings needs no CIRCLE_TOKEN.
const offeringsV3Path = "/api/v3/catalog/offerings"

// Offerings is the decoded body of GET /api/v3/catalog/offerings: which
// machine images CircleCI currently offers, keyed by resource class, plus a
// deprecated list keyed by executor.
//
// Each of Linux, Windows and MacOS maps a resource class (e.g. "large",
// "windows.medium", "m4pro.large") to the image names offered for it (e.g.
// "ubuntu-2404:current", "xcode:26.5.0"). Deprecated is keyed by executor
// ("linux", "windows", "macos") instead, and — per the API's own shape —
// excludes images already listed under Linux/Windows/MacOS: it is
// "everything else this executor once offered", not "everything, with a
// flag".
type Offerings struct {
	Linux      map[string][]string `json:"linux"`
	Windows    map[string][]string `json:"windows"`
	MacOS      map[string][]string `json:"macos"`
	Deprecated map[string][]string `json:"deprecated"`
}

// offeringsV3Response is the JSON response body of GET
// /api/v3/catalog/offerings, in the same data/attributes envelope
// orgSettingsV3Response uses.
type offeringsV3Response struct {
	Data struct {
		Attributes Offerings `json:"attributes"`
	} `json:"data"`
}

// GetOfferings fetches CircleCI's current machine-image catalog: which
// images are offered for which resource class, and which images have been
// deprecated.
//
// Needs no CIRCLE_TOKEN (see offeringsV3Path). A non-nil error means the
// request itself failed or the response could not be decoded — never that
// the catalog was empty, which is a normal-shaped (if unhelpful) response
// callers detect from the returned Offerings' own empty maps.
func (c *Client) GetOfferings(ctx context.Context) (*Offerings, error) {
	var wire offeringsV3Response
	if err := c.do(ctx, http.MethodGet, offeringsV3Path, nil, &wire); err != nil {
		return nil, err
	}
	return &wire.Data.Attributes, nil
}
