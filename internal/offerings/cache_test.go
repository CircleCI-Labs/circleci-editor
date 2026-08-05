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

package offerings_test

import (
	"context"
	"errors"
	"runtime"
	"sync"
	"testing"
	"time"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
	"github.com/CircleCI-Labs/circleci-editor/internal/offerings"
)

// fakeFetcher is a fake implementation of offerings.Fetcher, standing in for
// a real *circleci.Client.
type fakeFetcher struct {
	mu sync.Mutex

	result *circleci.Offerings
	err    error
	calls  int

	// unblock, when non-nil, is read once before returning -- it lets a test
	// hold the fetch open for as long as it needs (see
	// TestCache_ConcurrentFetches_ShareOneRequest). While the fetch is held
	// open, Cache.pending cannot be cleared, so every caller that reaches
	// fetchShared must join it; that is what makes "exactly one request"
	// assertable rather than merely likely. Mirrors internal/dockerhub's
	// fakeLister.
	unblock chan struct{}

	// entered, when non-nil, receives once as the fetch begins, so a test can
	// wait for the fetch to be genuinely in flight before acting on it. The
	// send is non-blocking: a second call would itself be the failure the test
	// is looking for, and must not deadlock here and hide it.
	entered chan struct{}
}

func (f *fakeFetcher) GetOfferings(ctx context.Context) (*circleci.Offerings, error) {
	f.mu.Lock()
	unblock, entered := f.unblock, f.entered
	f.mu.Unlock()
	if entered != nil {
		select {
		case entered <- struct{}{}:
		default:
		}
	}
	if unblock != nil {
		select {
		case <-unblock:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return f.result, nil
}

func (f *fakeFetcher) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func sampleOfferings() *circleci.Offerings {
	return &circleci.Offerings{
		Linux:      map[string][]string{"large": {"ubuntu-2404:current"}},
		Windows:    map[string][]string{"windows.large": {"windows-server-2025-gui:current"}},
		MacOS:      map[string][]string{"m4pro.large": {"xcode:26.5.0", "xcode:current"}},
		Deprecated: map[string][]string{"macos": {"xcode:26.0.1"}},
	}
}

func TestCache_Get_FetchesOnFirstCall(t *testing.T) {
	fetcher := &fakeFetcher{result: sampleOfferings()}
	cache := offerings.New(fetcher, "")

	result, err := cache.Get(context.Background())
	assert.NilError(t, err)
	assert.Assert(t, result.Live)
	assert.Assert(t, !result.Empty)
	assert.DeepEqual(t, result.Offerings.Linux["large"], []string{"ubuntu-2404:current"})
	assert.Equal(t, fetcher.callCount(), 1)

	status := cache.Status()
	assert.Assert(t, status.Attempted)
	assert.Assert(t, !status.Fetching)
	assert.Assert(t, !status.Stale)
	assert.Assert(t, !status.Empty)
	assert.NilError(t, status.Err)
}

func TestCache_Status_NeverFetchedBeforeFirstCall(t *testing.T) {
	fetcher := &fakeFetcher{result: sampleOfferings()}
	cache := offerings.New(fetcher, "")

	status := cache.Status()
	assert.Assert(t, !status.Attempted)
	assert.Assert(t, !status.Fetching)
	assert.Assert(t, status.FetchedAt.IsZero())
	assert.Equal(t, fetcher.callCount(), 0)
}

func TestCache_Get_SecondCallWithinTTLServesFromMemoryWithoutFetching(t *testing.T) {
	fetcher := &fakeFetcher{result: sampleOfferings()}
	cache := offerings.New(fetcher, "")

	_, err := cache.Get(context.Background())
	assert.NilError(t, err)

	result, err := cache.Get(context.Background())
	assert.NilError(t, err)
	assert.Assert(t, !result.Live)
	assert.Equal(t, fetcher.callCount(), 1)
}

func TestCache_Get_FetchedAndEmpty(t *testing.T) {
	fetcher := &fakeFetcher{result: &circleci.Offerings{}}
	cache := offerings.New(fetcher, "")

	result, err := cache.Get(context.Background())
	assert.NilError(t, err)
	assert.Assert(t, result.Empty)

	status := cache.Status()
	assert.Assert(t, status.Attempted)
	assert.Assert(t, status.Empty)
	assert.NilError(t, status.Err)
}

func TestCache_Get_FailsWithNothingCached(t *testing.T) {
	fetcher := &fakeFetcher{err: errors.New("network unreachable")}
	cache := offerings.New(fetcher, "")

	_, err := cache.Get(context.Background())
	assert.ErrorContains(t, err, "network unreachable")

	status := cache.Status()
	assert.Assert(t, status.Attempted)
	assert.Assert(t, status.FetchedAt.IsZero())
	assert.ErrorContains(t, status.Err, "network unreachable")
}

func TestCache_Get_FailureAfterASuccessServesStaleLabelled(t *testing.T) {
	fetcher := &fakeFetcher{result: sampleOfferings()}
	cache := offerings.New(fetcher, "")

	first, err := cache.Get(context.Background())
	assert.NilError(t, err)
	assert.Assert(t, first.Live)

	fetcher.mu.Lock()
	fetcher.err = errors.New("upstream 503")
	fetcher.mu.Unlock()

	// Refresh forces past the TTL so the failure path is exercised
	// deterministically rather than waiting a day.
	result, err := cache.Refresh(context.Background())
	assert.NilError(t, err) // A failed refresh with previous data degrades, not errors.
	assert.Assert(t, !result.Live)
	assert.DeepEqual(t, result.Offerings.Linux["large"], []string{"ubuntu-2404:current"})

	status := cache.Status()
	assert.Assert(t, !status.FetchedAt.IsZero()) // Still has the earlier, successful fetch's time.
	assert.ErrorContains(t, status.Err, "upstream 503")
}

func TestCache_Refresh_BypassesTTL(t *testing.T) {
	fetcher := &fakeFetcher{result: sampleOfferings()}
	cache := offerings.New(fetcher, "")

	_, err := cache.Get(context.Background())
	assert.NilError(t, err)
	assert.Equal(t, fetcher.callCount(), 1)

	result, err := cache.Refresh(context.Background())
	assert.NilError(t, err)
	assert.Assert(t, result.Live)
	assert.Equal(t, fetcher.callCount(), 2)
}

func TestCache_DiskPersistence_SurvivesRestart(t *testing.T) {
	dir := t.TempDir()

	fetcher := &fakeFetcher{result: sampleOfferings()}
	first := offerings.New(fetcher, dir)
	_, err := first.Get(context.Background())
	assert.NilError(t, err)

	// A second Cache, as a process restart would construct, must serve the
	// persisted catalog without any fetch at all.
	unreachable := &fakeFetcher{err: errors.New("must not be called")}
	second := offerings.New(unreachable, dir)

	result, err := second.Get(context.Background())
	assert.NilError(t, err)
	assert.Assert(t, !result.Live)
	assert.DeepEqual(t, result.Offerings.Linux["large"], []string{"ubuntu-2404:current"})
	assert.Equal(t, unreachable.callCount(), 0)
}

func TestCache_ConcurrentFetches_ShareOneRequest(t *testing.T) {
	unblock := make(chan struct{})
	entered := make(chan struct{}, 1)
	fetcher := &fakeFetcher{result: sampleOfferings(), unblock: unblock, entered: entered}
	cache := offerings.New(fetcher, "")

	const n = 10
	var wg sync.WaitGroup
	for range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := cache.Get(context.Background())
			assert.NilError(t, err)
		}()
	}

	// One caller wins the race to start the fetch and is now parked inside the
	// fake fetcher, so the fetch cannot complete, so Cache.pending cannot be
	// cleared, so every remaining caller that reaches fetchShared is obliged
	// to join it. Waiting for all n-1 to have *actually joined* -- rather than
	// for them to have merely been scheduled, which is what an earlier version
	// of this test did -- is what makes the assertion below deterministic
	// rather than a statement about how busy the machine is.
	<-entered
	deadline := time.Now().Add(30 * time.Second)
	for cache.PendingWaiters() < n-1 {
		if time.Now().After(deadline) {
			joined := cache.PendingWaiters()
			close(unblock) // Let the parked goroutines finish, then report.
			wg.Wait()
			t.Fatalf("only %d of %d callers joined the in-flight fetch", joined, n-1)
		}
		runtime.Gosched()
	}
	close(unblock)
	wg.Wait()

	assert.Equal(t, fetcher.callCount(), 1)
}
