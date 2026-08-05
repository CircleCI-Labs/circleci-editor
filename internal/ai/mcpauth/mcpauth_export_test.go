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

package mcpauth

import "net/http"

// ExportedRefuseCrossHostRedirect exports refuseCrossHostRedirect to
// mcpauth_test (a black-box test package, per this repo's convention).
//
// It exists so a test can prove the redirect policy actually refuses a
// cross-host redirect through a real redirect chain. Production callers never
// need it -- Client installs it on the http.Client it builds itself, and the
// only reason a test cannot simply observe that is that tests inject their own
// client in order to trust an httptest certificate.
//
// Kept out of the public API deliberately: it is a policy this package applies
// to its own requests, not a knob for callers.
func ExportedRefuseCrossHostRedirect(req *http.Request, via []*http.Request) error {
	return refuseCrossHostRedirect(req, via)
}
