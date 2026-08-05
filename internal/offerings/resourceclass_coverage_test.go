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
	"encoding/json"
	"os"
	"testing"

	"gotest.tools/v3/assert"

	"github.com/CircleCI-Labs/circleci-editor/internal/circleci"
	"github.com/CircleCI-Labs/circleci-editor/internal/guides"
)

// TestOfferingsIsNotASupersetOfAsciiDocResourceClasses pins issue #305's own
// verification, so a future change cannot silently re-introduce the
// assumption it disproved.
//
// # Why this test exists
//
// Issue #305 asked, explicitly, whether GET /api/v3/catalog/offerings could
// retire #181's ~115-line AsciiDoc resource-class parser
// (internal/guides/resourceclasses.go) now that the offerings endpoint is
// also keyed by resource class -- "verify it is a genuine superset before
// deleting a working parser." It is not, and this test is that verification,
// made durable:
//
//   - Four Docker-only classes -- "small", "medium+", and their ".gen2"
//     siblings -- never appear in the offerings response at all, under any
//     executor. That tracks: Docker resource classes are pure compute-size
//     choices with no CircleCI-managed image list to enumerate (a Docker job
//     runs whatever image the user names), so an endpoint whose whole shape
//     is "resource class -> image list" has structurally nothing to say
//     about them.
//   - One `machine: true` class -- "gpu.nvidia.small" (the un-suffixed,
//     first-generation GPU class) -- is in the vendored resource table but
//     absent from the live offerings snapshot below, which lists only its
//     ".gen2" and ".multi" successors. Whether that is the platform having
//     quietly retired it or the table lagging behind, this endpoint is not
//     an enumeration this project can treat as authoritative for "which
//     classes exist" without periodically re-checking exactly this gap.
//
// The comparison also runs in the other direction and finds the opposite
// kind of gap: offerings lists five ".gen3" classes
// (2xlarge.gen3/2xlarge+.gen3/large.gen3/medium.gen3/xlarge.gen3) that do not
// appear anywhere in the vendored AsciiDoc tables yet. That is exactly the
// kind of platform-outpaces-docs drift issue #181 already worries about for
// the documentation snapshot -- and exactly why this issue keeps both
// sources rather than replacing one with the other: the union, not either
// side alone, is what the platform actually offers today.
//
// This finding is also referenced from internal/guides/resourceclasses.go's
// own doc comment, which points here rather than repeating the reasoning.
//
// Windows and macOS are checked too, and -- unlike Docker and the Linux GPU
// class above -- match exactly in both directions: every class either side
// names, the other one does too. That asymmetry (two of four executor
// families agree completely; two do not) is itself part of the finding: a
// blanket "offerings covers resource classes" or "offerings doesn't cover
// resource classes" would both be wrong.
func TestOfferingsIsNotASupersetOfAsciiDocResourceClasses(t *testing.T) {
	data, err := os.ReadFile("testdata/live-snapshot-2026-07-31.json")
	assert.NilError(t, err)
	var live circleci.Offerings
	assert.NilError(t, json.Unmarshal(data, &live))

	offeredClasses := map[string]bool{}
	for class := range live.Linux {
		offeredClasses[class] = true
	}
	for class := range live.Windows {
		offeredClasses[class] = true
	}
	for class := range live.MacOS {
		offeredClasses[class] = true
	}

	environments, err := guides.EmbeddedResourceClasses()
	assert.NilError(t, err)

	docClasses := map[string]bool{}
	windowsClasses := map[string]bool{}
	macosClasses := map[string]bool{}
	for _, env := range environments {
		for _, class := range env.Classes {
			switch {
			case env.Kind == guides.KindDocker:
				docClasses[class.Name] = true
			case env.Kind == guides.KindMachine &&
				(env.ID == "windows-execution-environment" || env.ID == "gpu-execution-environment-windows"):
				windowsClasses[class.Name] = true
			case env.Kind == guides.KindMacOS:
				macosClasses[class.Name] = true
			}
		}
	}

	// The concrete, named gap: these four Docker-only classes must never be
	// reported as offered, because the live endpoint genuinely does not
	// carry them -- if this assertion ever fails, offerings has started
	// covering Docker after all and the parser retirement this test blocks
	// is worth reconsidering.
	for _, class := range []string{"small", "medium+", "small.gen2", "medium+.gen2"} {
		assert.Assert(t, docClasses[class], "expected %q in the AsciiDoc-derived Docker classes", class)
		assert.Assert(t, !offeredClasses[class], "expected %q to be genuinely absent from live offerings -- if this now fails, re-check the finding in this file's doc comment", class)
	}

	// The one machine-executor gap found: a real, documented class the live
	// catalog does not list.
	assert.Assert(t, !offeredClasses["gpu.nvidia.small"], "expected \"gpu.nvidia.small\" to be absent from live offerings -- if this now fails, re-check the finding in this file's doc comment")

	// Windows and macOS, by contrast, match exactly.
	for class := range windowsClasses {
		assert.Assert(t, offeredClasses[class], "expected Windows class %q to be offered live", class)
	}
	for class := range macosClasses {
		assert.Assert(t, offeredClasses[class], "expected macOS class %q to be offered live", class)
	}

	// The reverse gap: offerings' own gen3 classes, absent from the vendored
	// docs entirely.
	for _, class := range []string{"2xlarge.gen3", "2xlarge+.gen3", "large.gen3", "medium.gen3", "xlarge.gen3"} {
		assert.Assert(t, offeredClasses[class], "expected %q in the live snapshot fixture", class)
		assert.Assert(t, !docClasses[class] && !windowsClasses[class] && !macosClasses[class],
			"expected %q to be absent from the AsciiDoc-derived classes -- if this now fails, the docs may have caught up and this test's example should be refreshed", class)
	}
}
