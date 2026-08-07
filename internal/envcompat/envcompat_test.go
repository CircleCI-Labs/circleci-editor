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

package envcompat_test

import (
	"bytes"
	"testing"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/envcompat"
)

// redirect points the deprecation warning at a buffer for the duration of a
// test, so an assertion can read what a user would have seen on stderr.
func redirect(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := envcompat.Warnings
	envcompat.Warnings = &buf
	t.Cleanup(func() { envcompat.Warnings = prev })
	return &buf
}

func TestValue_CurrentNameWins(t *testing.T) {
	buf := redirect(t)
	t.Setenv("CIRCLECI_EDITOR_TEST_A", "new")
	t.Setenv("VCE_TEST_A", "old")

	assert.Equal(t, envcompat.Value("CIRCLECI_EDITOR_TEST_A", "VCE_TEST_A"), "new")
	// Nothing is deprecated about setting the current name, even alongside the
	// old one -- warning there would nag someone who has already migrated and
	// merely left the old export in place.
	assert.Equal(t, buf.String(), "")
}

func TestValue_FallsBackToSupersededNameAndSaysSo(t *testing.T) {
	buf := redirect(t)
	t.Setenv("VCE_TEST_B", "old")

	assert.Equal(t, envcompat.Value("CIRCLECI_EDITOR_TEST_B", "VCE_TEST_B"), "old")
	// The warning must name both spellings: which one to stop using, and what
	// to use instead. A warning that only says "deprecated" makes the reader
	// go and look it up.
	out := buf.String()
	assert.Assert(t, bytes.Contains([]byte(out), []byte("VCE_TEST_B")), out)
	assert.Assert(t, bytes.Contains([]byte(out), []byte("CIRCLECI_EDITOR_TEST_B")), out)
}

func TestValue_WarnsOnlyOncePerVariable(t *testing.T) {
	buf := redirect(t)
	t.Setenv("VCE_TEST_C", "old")

	for range 5 {
		assert.Equal(t, envcompat.Value("CIRCLECI_EDITOR_TEST_C", "VCE_TEST_C"), "old")
	}
	// Some of these variables are read on paths that run per request; a warning
	// repeated per read would bury the output it is meant to stand out in.
	assert.Equal(t, bytes.Count(buf.Bytes(), []byte("VCE_TEST_C")), 1)
}

func TestValue_NeitherSetIsSilent(t *testing.T) {
	buf := redirect(t)
	assert.Equal(t, envcompat.Value("CIRCLECI_EDITOR_TEST_D", "VCE_TEST_D"), "")
	assert.Equal(t, buf.String(), "")
}

func TestSet_ReportsEitherSpelling(t *testing.T) {
	_ = redirect(t)
	assert.Assert(t, !envcompat.Set("CIRCLECI_EDITOR_TEST_E", "VCE_TEST_E"))

	t.Setenv("VCE_TEST_E", "1")
	assert.Assert(t, envcompat.Set("CIRCLECI_EDITOR_TEST_E", "VCE_TEST_E"))
}
