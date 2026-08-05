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
	"fmt"
	"net/http"
	"time"
)

// heartbeatInterval is how often GET /api/heartbeat sends a keep-alive
// event to an already-connected client. Short enough that the browser's
// EventSource notices a genuinely dead connection promptly; long enough
// that the idle bandwidth/CPU cost of an open tab is negligible.
const heartbeatInterval = 10 * time.Second

// handleHeartbeat serves GET /api/heartbeat: a Server-Sent Events stream
// the SPA subscribes to for as long as a tab is open (issue #110). This is
// what lets the page tell "the host process is still alive" apart from
// "it's gone": a browser EventSource keeps one connection open and fires
// its own "error" event the instant that connection breaks, for any
// reason -- this handler returning (graceful shutdown, see below), the
// process being killed outright (the OS resets the TCP connection with
// nothing left to send an HTTP response at all), or the network otherwise
// dropping it. The detector on the other end needs no polling loop of its
// own; it just reacts to EventSource's built-in lifecycle events.
func (s *Server) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		// Never true for the real net/http server this project ships with;
		// guarded because w is an interface and a future middleware/test
		// double could in principle not implement Flusher.
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	// New's doc comment on readTimeout/writeTimeout explains why they exist
	// (Slowloris-style mitigation for ordinary request/response round
	// trips); left alone, writeTimeout would cut this deliberately
	// long-lived response off at the 30s mark. Clearing the write deadline
	// for this one response is the intended way to opt a streaming handler
	// out of it -- it has no effect on any other request.
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{})

	// This connection is also how the host knows a browser client exists at
	// all (issue #177). The stream is open for exactly as long as a loaded
	// page is loaded, so counting streams counts editor windows -- with no
	// extra endpoint, no "goodbye" message a closing tab might never get to
	// send, and no way for a wedged page to keep the process alive by
	// asserting it is still there. Registered before the response headers
	// go out and released by defer on every return path below, so the count
	// cannot leak. See clientTracker for what Run does with it.
	leave := s.clients.join()
	defer leave()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	if !writeHeartbeatEvent(w, flusher) {
		return
	}

	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-s.shutdownCtx.Done():
			// Ctrl-C/SIGTERM (see cmd/circleci-editor's
			// signal.NotifyContext and Run's assignment to shutdownCtx).
			// Returning immediately -- rather than waiting for the client
			// to eventually notice on its own -- is what lets Run's
			// graceful http.Server.Shutdown finish inside shutdownTimeout:
			// Shutdown does not forcibly close *active* connections, only
			// idle ones (see its own doc comment), so a streaming handler
			// that never returned would hang the whole shutdown until the
			// 5s timeout, itself surfacing as an unclean exit -- exactly
			// the failure mode issue #67 is about not creating.
			return
		case <-r.Context().Done():
			// The client disconnected (tab closed, navigated away).
			return
		case <-ticker.C:
			if !writeHeartbeatEvent(w, flusher) {
				return
			}
		}
	}
}

// writeHeartbeatEvent writes one SSE "ping" event and flushes it,
// reporting whether the write succeeded. A write error means the
// connection is already gone from the client's side; the caller should
// stop rather than keep trying.
//
// Every event repeats "retry: 1000": the SSE spec lets a server tell the
// client's EventSource how long to wait before automatically reconnecting
// after the connection drops, and shortening it from the browser's
// (unspecified, commonly a few seconds) default to 1s matters in both
// directions this handler cares about -- it makes a genuinely dead host
// detected as "gone" sooner after its last successful ping, and it makes a
// momentary blip (rather than a real process exit) self-heal and clear the
// browser's "gone" state sooner too, once the client reconnects
// successfully.
func writeHeartbeatEvent(w http.ResponseWriter, flusher http.Flusher) bool {
	if _, err := fmt.Fprintf(w, "retry: 1000\nevent: ping\ndata: %d\n\n", time.Now().Unix()); err != nil {
		return false
	}
	flusher.Flush()
	return true
}
