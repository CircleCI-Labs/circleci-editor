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

// Package envcompat reads an environment variable under its current name and
// falls back to a superseded one, warning once when only the old name is set.
//
// The editor's variables were originally prefixed VCE_, for "visual config
// editor" -- the name of the repository this project grew out of. That name is
// gone: the binary is circleci-editor and the command is `circleci editor`, so
// an initialism for a name nothing else uses any more is a small permanent
// puzzle for anyone reading the documentation. They are now CIRCLECI_EDITOR_*.
//
// The old names keep working. Renaming an environment variable a user may have
// put in a shell profile or a script is the kind of change that should announce
// itself rather than simply stop working, and a fallback costs one lookup. The
// warning goes to stderr once per variable, so a scripted run that sets an old
// name is told exactly what to change without being told repeatedly.
package envcompat

import (
	"fmt"
	"io"
	"os"
	"sync"
)

// warned tracks which superseded names have already been reported, so a
// variable read on a hot path cannot turn into repeated output.
var warned sync.Map

// Warnings is where the deprecation notice is written. A test can redirect it;
// production leaves it at stderr, alongside every other diagnostic this binary
// prints.
var Warnings io.Writer = os.Stderr

// Value returns the value of current if it is set, otherwise the value of
// superseded -- warning once when the fallback is what supplied the value.
//
// An empty current value with superseded also empty returns empty and warns
// about nothing, so this is safe to call unconditionally.
func Value(current, superseded string) string {
	if v := os.Getenv(current); v != "" {
		return v
	}
	v := os.Getenv(superseded)
	if v == "" {
		return ""
	}
	if _, already := warned.LoadOrStore(superseded, true); !already {
		// Ignoring the write error deliberately: a deprecation notice that
		// cannot be printed must not change what the program does, and there is
		// nowhere better to report a failure to report something.
		_, _ = fmt.Fprintf(Warnings, "warning: %s is deprecated and will be removed; use %s instead.\n", superseded, current)
	}
	return v
}

// Set reports whether either name is set, for the variables whose meaning is
// "any non-empty value" rather than a value to be read.
func Set(current, superseded string) bool {
	return Value(current, superseded) != ""
}
