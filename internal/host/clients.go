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
	"sync"
	"time"
)

// lastClientGrace is the answer to "how long after the last browser client
// disappears should the host wait before concluding the user is finished and
// exiting?" (issue #177) -- one number for every mode that exits at all.
//
// It used to be two. Issue #179 gave ordinary browser mode 20s, as a
// change-your-mind budget for reopening a tab closed by accident, and kept
// --app at 6s because a chromeless window's close is an unambiguous quit.
// The owner decided against the split (issue #216: *"I think the browser
// grace mode for closing -- I think 6 seconds is probably better"*), so both
// modes now use the shorter number and there is no per-mode table left to
// maintain -- only the --no-browser/--keep-alive exemptions, which live in
// cmd/circleci-editor's stopOnLastClient.
//
// 6s was derived for --app, and what it has to cover is a *transport* gap:
// the interval during which no /api/heartbeat stream is open even though the
// user has not gone anywhere.
//
// The gap to beat is a reload, which unloads the page (closing the stream)
// and then loads it again (opening a new one). That was measured rather than
// guessed, against the real binary serving the real embedded bundle over
// loopback, by stashing the unload timestamp in sessionStorage and
// subtracting it from the moment the reloaded page's own EventSource fired
// `open` -- which is precisely the interval during which this tracker sees
// zero clients. Chromium, macOS, warm cache: 17-35ms over six reloads. With
// the browser cache cleared before each reload, so the whole bundle is
// refetched and reparsed: 39-43ms. Repeated with ten busy-loop processes
// competing for CPU: 17-35ms warm, 45-72ms cold. So the page's own
// contribution is tens of milliseconds and barely moves under load.
//
// The larger term is the one that is not the page's fault: if the stream
// drops *without* the page unloading (a blip rather than a reload), the
// browser's EventSource waits the server-supplied `retry: 1000` before
// reconnecting -- see writeHeartbeatEvent. So the worst gap to survive is
// ~1s of retry delay plus ~0.1s of reload, and 6s is a little over 5x that.
//
// Not tightened to ~2s, even though the measurements would allow it, because
// the measurements are from one fast machine: a Windows box with an
// antivirus reading a 15MB binary, or a laptop paging in from swap, has no
// measurement here and deserves the headroom. Not stretched further either
// -- the window is also how long the user waits for their prompt back after
// closing the window, and a host that outlives its window is the whole of
// what issue #177 reported.
//
// Deliberately not long enough to cover an interactive OAuth round trip:
// that case is handled exactly instead of approximately, by holdMCPOAuth,
// because no timeout can be both long enough for a human at an identity
// provider's 2FA prompt and short enough to be the answer to this issue.
//
// `task dev` is out of scope for this number: a Vite dev-server reload
// serves hundreds of unbundled modules and its gap is both larger and far
// more variable, so Taskfile's dev:host passes --keep-alive rather than
// depending on any grace period at all.
const lastClientGrace = 6 * time.Second

// clientTracker counts the browser clients currently attached to this host
// and reports how long it has been since the last one left, so Run can exit
// when the user closes the editor (issue #177).
//
// "Attached" means holding the GET /api/heartbeat stream open, which is
// what every loaded page does for as long as it is loaded (see
// handleHeartbeat). That makes presence a property of the TCP connection
// rather than of anything the page has to remember to send: a tab that is
// closed, crashed, backgrounded to death, or unloaded by a reload stops
// counting the moment its connection goes, with no timeout to tune and no
// way for a wedged page to keep the host alive by accident.
//
// Two rules keep the count from being misread:
//
//   - It is not armed until the first client has *ever* connected. A host
//     nobody has opened yet has zero clients for a completely different
//     reason than a host whose window was just closed, and only the second
//     is a reason to exit. This is also the belt to --no-browser's braces:
//     even if a caller enabled last-client exit in a mode where a browser
//     is never opened, the host cannot exit until something actually
//     connected.
//   - Outstanding *holds* suspend it. A hold marks work that must not be
//     cut short -- a config-file write in flight, an interactive MCP OAuth
//     sign-in the user is part-way through -- and while one is held the
//     grace clock does not merely pause, it restarts when the hold is
//     released, so the full grace period is always available after the
//     last thing this process was doing finished.
type clientTracker struct {
	mu sync.Mutex
	// active is the number of open heartbeat streams.
	active int
	// armed records that at least one client has connected at some point.
	armed bool
	// holds is the number of outstanding hold() releases not yet called.
	holds int
	// idleAt is when the state last became "armed, no clients, no holds".
	// Zero when the tracker is not in that state.
	idleAt time.Time
	// changed carries a coalescing wake-up to waitForLastClient. Buffered
	// with capacity 1 and written non-blockingly: a signal that finds the
	// buffer full is dropped, because the waiter re-reads the whole state
	// after every wake-up, so one pending wake-up is as good as ten.
	changed chan struct{}
	// now is time.Now, injectable for tests.
	now func() time.Time
}

func newClientTracker(now func() time.Time) *clientTracker {
	if now == nil {
		now = time.Now
	}
	return &clientTracker{changed: make(chan struct{}, 1), now: now}
}

// join records a newly attached client and returns the function that
// records its departure. The returned function is idempotent, so a handler
// can defer it without reasoning about whether some other path already ran
// it.
func (t *clientTracker) join() (leave func()) {
	t.mu.Lock()
	t.active++
	t.armed = true
	t.idleAt = time.Time{}
	t.mu.Unlock()
	t.signal()

	var once sync.Once
	return func() {
		once.Do(func() {
			t.mu.Lock()
			t.active--
			if t.active < 0 {
				t.active = 0
			}
			if t.active == 0 {
				t.idleAt = t.now()
			}
			t.mu.Unlock()
			t.signal()
		})
	}
}

// hold marks work in progress that a last-client exit must not interrupt,
// and returns the (idempotent) function that releases it. See the type's
// doc comment for what qualifies.
func (t *clientTracker) hold() (release func()) {
	t.mu.Lock()
	t.holds++
	t.mu.Unlock()
	t.signal()

	var once sync.Once
	return func() {
		once.Do(func() {
			t.mu.Lock()
			t.holds--
			if t.holds < 0 {
				t.holds = 0
			}
			if t.holds == 0 && t.active == 0 && t.armed {
				// Restart, not resume: the grace period exists to give a
				// client time to come back, and that time should be
				// measured from the end of the work, not from a departure
				// that happened while the host was still busy.
				t.idleAt = t.now()
			}
			t.mu.Unlock()
			t.signal()
		})
	}
}

// idleFor reports how long the host has been in the state where a
// last-client exit is permitted -- armed, no clients attached, no holds
// outstanding -- and false when it is not in that state at all.
func (t *clientTracker) idleFor() (time.Duration, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if !t.armed || t.active > 0 || t.holds > 0 || t.idleAt.IsZero() {
		return 0, false
	}
	return t.now().Sub(t.idleAt), true
}

// signal wakes waitForLastClient without ever blocking the caller (which is
// always a request handler).
func (t *clientTracker) signal() {
	select {
	case t.changed <- struct{}{}:
	default:
	}
}

// waitForLastClient blocks until the host has been continuously idle (see
// idleFor) for grace, reporting true, or until ctx is done, reporting
// false. "Continuously" is the operative word: a client that reconnects
// inside the grace period -- which is all a reload is, from this side --
// resets the clock, and the wait resumes only if it leaves again.
func (t *clientTracker) waitForLastClient(ctx context.Context, grace time.Duration) bool {
	for {
		if ctx.Err() != nil {
			return false
		}

		elapsed, idle := t.idleFor()
		if idle && elapsed >= grace {
			return true
		}

		// No timer at all while a client is attached: the only thing that
		// can make this loop's answer change is a state transition, and
		// those signal. A timer is armed only for the remaining slice of
		// an in-progress grace period.
		var timer *time.Timer
		var deadline <-chan time.Time
		if idle {
			timer = time.NewTimer(grace - elapsed)
			deadline = timer.C
		}

		select {
		case <-ctx.Done():
			stopTimer(timer)
			return false
		case <-t.changed:
		case <-deadline:
		}
		stopTimer(timer)
	}
}

// stopTimer stops timer if there is one. Extracted so waitForLastClient's
// loop can release its timer on every path without a defer that would
// accumulate one entry per iteration.
func stopTimer(timer *time.Timer) {
	if timer != nil {
		timer.Stop()
	}
}
