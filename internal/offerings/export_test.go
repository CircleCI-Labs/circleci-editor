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

package offerings

// PendingWaiters reports how many callers are currently blocked on an
// in-flight fetch that another caller started.
//
// Test-only: this file is compiled into the package's test binary and never
// into the shipped binary, so this is not API. It exists so that
// TestCache_ConcurrentFetches_ShareOneRequest can wait for callers to have
// genuinely joined the shared fetch instead of sleeping for a plausible
// interval -- see pendingFetch.waiters for what went wrong without it.
func (c *Cache) PendingWaiters() int {
	c.fetchMu.Lock()
	defer c.fetchMu.Unlock()
	if c.pending == nil {
		return 0
	}
	return c.pending.waiters
}
