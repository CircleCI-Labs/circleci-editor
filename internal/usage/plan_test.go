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

// White-box tests for planFetch -- issue #307's three explicit delta-fetch
// cases -- kept in package usage (rather than usage_test) because planFetch
// itself is intentionally unexported: it is an internal decision Cache.warm
// makes, not part of this package's API.
package usage

import (
	"testing"
	"time"

	"gotest.tools/v3/assert"
)

var refNow = time.Date(2026, 7, 31, 15, 4, 5, 0, time.UTC) // mid-day, to prove truncation to the day boundary matters.
var refToday = time.Date(2026, 7, 31, 0, 0, 0, 0, time.UTC)

func TestPlanFetch_ColdCache(t *testing.T) {
	start, end, needed := planFetch(refNow, DayBuckets{}, 7)
	assert.Assert(t, needed)
	assert.Equal(t, end, refToday)
	assert.Equal(t, start, refToday.AddDate(0, 0, -7))
}

func TestPlanFetch_SmallGap_FetchesOnlyTheGap(t *testing.T) {
	// Held from 07-20 through 07-28 (exclusive end) -- i.e. covers back
	// further than the 7-day window desires (desiredStart would be 07-24),
	// so there is nothing to backfill, only a 3-day forward gap to 07-31.
	// Every day in range has an explicit (possibly empty) entry, matching
	// what warm's seedEmptyDays guarantees in practice.
	held := DayBuckets{}
	for d := 20; d <= 27; d++ {
		held[time.Date(2026, 7, d, 0, 0, 0, 0, time.UTC).Format(dayLayout)] = map[JobKey]DayAggregate{}
	}
	start, end, needed := planFetch(refNow, held, 7)
	assert.Assert(t, needed)
	assert.Equal(t, start, time.Date(2026, 7, 28, 0, 0, 0, 0, time.UTC))
	assert.Equal(t, end, refToday)
}

func TestPlanFetch_GapLargerThanWindow_FetchesOnlyTheWindow(t *testing.T) {
	// The app was not opened for six weeks: held data ends 2026-06-01,
	// nowhere near covering a 7-day window ending 2026-07-31.
	held := DayBuckets{"2026-06-01": {}}
	start, end, needed := planFetch(refNow, held, 7)
	assert.Assert(t, needed)
	assert.Equal(t, end, refToday)
	assert.Equal(t, start, refToday.AddDate(0, 0, -7)) // the window, not back to 06-01.
}

func TestPlanFetch_AlreadyCurrent_NoFetchNeeded(t *testing.T) {
	held := DayBuckets{}
	for d := 0; d < 7; d++ {
		day := refToday.AddDate(0, 0, -1-d).Format(dayLayout)
		held[day] = map[JobKey]DayAggregate{}
	}
	_, _, needed := planFetch(refNow, held, 7)
	assert.Assert(t, !needed)
}

func TestPlanFetch_WindowGrew_RefetchesWholeWindow(t *testing.T) {
	// Only 7 days held, but the window setting just grew to 14: the held
	// start (7 days back) is after the desired start (14 days back), so the
	// whole 14-day window is fetched rather than trying to backfill on top
	// of what's held.
	held := DayBuckets{}
	for d := 0; d < 7; d++ {
		day := refToday.AddDate(0, 0, -1-d).Format(dayLayout)
		held[day] = map[JobKey]DayAggregate{}
	}
	start, end, needed := planFetch(refNow, held, 14)
	assert.Assert(t, needed)
	assert.Equal(t, end, refToday)
	assert.Equal(t, start, refToday.AddDate(0, 0, -14))
}

func TestPlanFetch_TrailingEdgeExcludesToday(t *testing.T) {
	// The trailing edge must be the last *complete* day boundary, not now
	// itself -- a window ending at "now" would include jobs still running.
	_, end, _ := planFetch(refNow, DayBuckets{}, 7)
	assert.Assert(t, end.Equal(refToday))
	assert.Assert(t, end.Before(refNow))
}
