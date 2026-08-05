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
	"net/http"
	"testing"

	"gotest.tools/v3/assert"
)

// liveOfferingsSampleBody is a trimmed excerpt of the real, live response
// from GET /api/v3/catalog/offerings (verified 2026-07-31, unauthenticated) --
// enough of the shape (linux/windows/macos keyed by resource class,
// deprecated keyed by executor) to exercise decoding without pinning the
// whole ~22KB catalog.
const liveOfferingsSampleBody = `{
  "data": {
    "id": "offerings",
    "type": "offerings",
    "attributes": {
      "linux": {
        "large": ["ubuntu-2204:current", "ubuntu-2404:current", "ubuntu-2404:edge"],
        "gpu.nvidia.medium.multi": ["linux-cuda-12:default", "linux-cuda-12:edge"]
      },
      "windows": {
        "windows.large": ["windows-server-2025-gui:2025.10.1", "windows-server-2025-gui:current"]
      },
      "macos": {
        "m4pro.large": ["xcode:27.0.0", "xcode:16.2.0", "xcode:current", "xcode:edge"]
      },
      "deprecated": {
        "macos": ["xcode:26.0.1"],
        "windows": [],
        "linux": []
      }
    }
  }
}`

func TestGetOfferings_PathAndDecoding(t *testing.T) {
	var gotPath, gotMethod, gotToken string

	_, client := newFakeCircleCI(t, "", func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		gotToken = r.Header.Get("Circle-Token")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(liveOfferingsSampleBody))
	})

	offerings, err := client.GetOfferings(context.Background())
	assert.NilError(t, err)

	assert.Equal(t, gotMethod, http.MethodGet)
	assert.Equal(t, gotPath, "/api/v3/catalog/offerings")
	// Issue #305: verified live that this endpoint answers unauthenticated,
	// consistent with #160 making orb browsing tokenless -- so a Client built
	// with no token (as here) must reach it exactly the same way, sending no
	// Circle-Token header at all rather than an empty one.
	assert.Equal(t, gotToken, "")

	assert.DeepEqual(t, offerings.Linux["large"],
		[]string{"ubuntu-2204:current", "ubuntu-2404:current", "ubuntu-2404:edge"})
	assert.DeepEqual(t, offerings.Windows["windows.large"],
		[]string{"windows-server-2025-gui:2025.10.1", "windows-server-2025-gui:current"})
	assert.DeepEqual(t, offerings.MacOS["m4pro.large"],
		[]string{"xcode:27.0.0", "xcode:16.2.0", "xcode:current", "xcode:edge"})
	assert.DeepEqual(t, offerings.Deprecated["macos"], []string{"xcode:26.0.1"})
	assert.Equal(t, len(offerings.Deprecated["linux"]), 0)
}

func TestGetOfferings_UpstreamFailure(t *testing.T) {
	_, client := newFakeCircleCI(t, "tok", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("upstream is down"))
	})

	_, err := client.GetOfferings(context.Background())
	assert.ErrorContains(t, err, "unexpected status 503")
}
