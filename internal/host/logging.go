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

import "log"

// This file is the whole of the host's verbosity policy (issue #216). The
// owner's words: *"I do see it kind of outputs stuff into the terminal. It
// might be good to have a debug flag where you can output that stuff, but by
// default it just launches the UI."*
//
// There are exactly two levels, and the test for which one a line belongs to
// is not how interesting it is -- it is whether a user who never asked for
// diagnostics is worse off for not seeing it:
//
//   - **Default.** The startup banner (printed by the CLI, not from here),
//     the two calm exit lines, and anything *actionable*: a warning that
//     names something the user can do, or a failure that would otherwise be
//     silent. A failure nobody is told about is the bug issue #150 was filed
//     about, so "quiet" must never become "silent about failures".
//   - **Debug (--debug / CIRCLECI_EDITOR_DEBUG).** Progress and bookkeeping: cache warms,
//     refresh checks, disk-cache housekeeping, the redundant "listening on"
//     line. Losing every one of these leaves the user with a working editor
//     and nothing to act on.
//
// Nothing sensitive is logged at *either* level, and that is a property of
// what is passed in rather than of this file: no token reaches a log
// statement anywhere in this package (see internal/ai/secret for the type
// that makes that hard to get wrong), no upstream response body is ever
// interpolated (see describeUpstreamError), and no policy or context
// *contents* are logged -- only names and counts. Raising verbosity adds
// lines about this process's own activity; it never adds a payload.

// logFunc is the diagnostic hook internal/orbs.Cache and internal/guides.Cache
// take, named here so the two levels below can be talked about as values.
type logFunc func(string, ...any)

// discardLogf is the debug hook when debug output is off. A no-op function
// rather than a nil check at every call site: the caches call their hook from
// inside error paths that are already awkward enough, and a hook that is
// always safe to call is one less thing for them to get wrong.
func discardLogf(string, ...any) {}

// debugLogf returns the hook for progress and bookkeeping: log.Printf when
// debug output is enabled, and a no-op otherwise.
//
// Passing this to a subpackage, rather than having the subpackage consult a
// flag or a package-level variable of its own, keeps the verbosity decision
// in one place and keeps it a *value* -- which is also what makes it testable
// without global state, and what keeps `go test ./... -race` on three
// platforms from having to reason about an init-order race between a flag and
// a background cache warm.
func debugLogf(debug bool) logFunc {
	if !debug {
		return discardLogf
	}
	return log.Printf
}

// noticeLogf returns the hook for lines that print at every verbosity because
// the user is worse off not seeing them -- see this file's header. It ignores
// the debug setting on purpose; it exists so that a call site reads as a
// deliberate choice of level rather than as a bare log.Printf that nobody
// audited.
func noticeLogf() logFunc {
	return log.Printf
}

// debugf writes one debug line, for the parts of the server that have a
// receiver to hang it off. Equivalent to debugLogf(s.opts.Debug), and kept as
// a method so handlers and Run don't each have to carry a hook.
func (s *Server) debugf(format string, args ...any) {
	if !s.opts.Debug {
		return
	}
	log.Printf(format, args...)
}

// Debugging reports whether debug output is enabled for this server. Exported
// for the CLI, which prints one extra line at startup when it is on, so that
// a user who passed --debug has confirmation that it took effect (the flag is
// otherwise indistinguishable from a quiet run on a healthy machine, since
// every line it unlocks is optional by construction).
func (s *Server) Debugging() bool {
	return s.opts.Debug
}
