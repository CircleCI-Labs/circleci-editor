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

package guides

import (
	"strings"
	"testing"

	"gotest.tools/v3/assert"
)

// This file has no companion machineimages.go. That absence is the point of
// issue #242: `web/src/lib/schema/images.ts`'s `MACHINE_IMAGES` table stays a
// hand-curated literal rather than joining `resourceclasses.go` and
// `xcodeversions.go` as a third table derived from the vendored snapshot --
// and these tests pin *why*, the same way TestSnapshotChecksums pins the
// snapshot's own provenance, so the reasoning fails loudly the day it stops
// being true rather than quietly going stale in a comment nobody re-reads.
//
// # What #181/#211's precedent actually requires
//
// Both existing derivations (resource classes, Xcode versions) work because
// upstream's own page carries a table that *is* the authoritative enumeration:
// "Supported Xcode versions for Apple silicon" lists every version CircleCI
// supports, full stop. The configuration reference's machine-image sections are
// a different shape by design, not by upstream oversight: each one is a
// paragraph that names a Developer Hub URL and says, in its own words, "for a
// full list ... refer to" it -- upstream is pointing at a different, unvendored
// site (circleci.com/developer/machine/image/*) as the actual source of truth,
// not enumerating in this page at all. internal/guides only vendors
// circleci-docs (docs/guides, docs/orbs, docs/reference -- see
// UpstreamSources); the Developer Hub is not part of that corpus, so there is
// no offline table to parse it *from*, regardless of what shape a parser took.
//
// TestMachineImageSections_AreProseNotTables confirms the shape claim against
// the parsed model rather than the raw AsciiDoc. TestMachineImageSections_
// DoNotYetNameEveryCurrentlyOfferedWindowsFamily is the sharper, falsifiable
// claim: three of MACHINE_IMAGES's current Windows entries
// (windows-server-2022-nvidia-medium, windows-server-2025-gui,
// windows-server-2025-nvidia-medium) are not named anywhere in this vendored
// snapshot at all, as of the commit VerifySnapshot pins -- so deriving from it
// today would silently ship a *smaller* list than the literal it replaced,
// which is exactly the failure issue #242 warns against ("a list that silently
// omits images people use"). If upstream ever restructures this page into a
// real enumeration -- the day either test below starts failing -- that is the
// signal to revisit derivation, not before.
const machineSectionID = "machine"

// machineImageHeadingAnchors are the level-4 headings under the `machine`
// section (`=== *machine*`) that each cover one image family's availability,
// in document order. Windows and Windows-GPU are listed because
// TestMachineImageSections_DoNotYetNameEveryCurrentlyOfferedWindowsFamily reads
// them; the others are listed so
// TestMachineImageSections_AreProseNotTables covers the whole set issue #242
// discusses, not just the one with a falsifiable gap.
var machineImageHeadingAnchors = []string{
	"available-linux-machine-images-cloud",
	"available-linux-gpu-images",
	"available-android-machine-images",
	"available-windows-machine-images-cloud",
	"available-windows-gpu-image",
}

// blocksByHeadingAnchor groups a section's blocks under the anchor of the
// nearest level-4-or-deeper KindHeading above them -- the same join
// tablesByAnchor uses for tables, generalised to every block kind because
// these tests need to inspect prose and lists, not tables.
func blocksByHeadingAnchor(section Section) map[string][]Block {
	out := map[string][]Block{}
	anchor := ""
	for _, block := range section.Blocks {
		if block.Kind == KindHeading {
			anchor = block.ID
			continue
		}
		if anchor == "" {
			continue
		}
		out[anchor] = append(out[anchor], block)
	}
	return out
}

func machineSection(t *testing.T) Section {
	t.Helper()
	parsed, err := ParseSnapshot()
	assert.NilError(t, err)
	guide := findGuideByID(parsed, ResourceClassGuideID) // "configuration-reference"
	assert.Assert(t, guide != nil)

	for _, section := range guide.Sections {
		if section.ID == machineSectionID {
			return section
		}
	}
	t.Fatalf("the %s guide has no %q section -- upstream removed or renamed the machine executor's own section, which this test's whole premise depends on", ResourceClassGuideID, machineSectionID)
	return Section{}
}

// TestMachineImageSections_AreProseNotTables is the structural half of why
// MACHINE_IMAGES is not derived: unlike the resource and Xcode tables, upstream
// does not enumerate machine images in a `|===` table at all. A KindTable
// appearing under any of these anchors would mean upstream restructured the
// page into the shape #181/#211's machinery expects, which is worth knowing --
// it would make derivation newly viable, not automatically wrong.
func TestMachineImageSections_AreProseNotTables(t *testing.T) {
	t.Parallel()

	byAnchor := blocksByHeadingAnchor(machineSection(t))
	for _, anchor := range machineImageHeadingAnchors {
		blocks, ok := byAnchor[anchor]
		assert.Assert(t, ok, "expected a %q heading under the %q section", anchor, machineSectionID)
		for _, block := range blocks {
			assert.Assert(t, block.Kind != KindTable,
				"the %q section now contains a table -- this is exactly the shape change that would make deriving MACHINE_IMAGES from it viable; see this file's own doc comment and issue #242", anchor)
		}
	}
}

// TestMachineImageSections_DoNotYetNameEveryCurrentlyOfferedWindowsFamily is
// the falsifiable half: three Windows machine-image families MACHINE_IMAGES
// currently offers are not named anywhere in the vendored snapshot's machine
// section, because upstream's own Windows paragraphs point at the Developer
// Hub for "a full list" rather than giving one here. Deriving from this
// section today would therefore ship a list *missing* real, currently-offered
// families -- the opposite of drift prevention. If this test ever fails,
// upstream has started naming these families on this page, which is reason to
// revisit -- not a false alarm to silence.
//
// Checked against plainText, not codeSpanTexts: these family names sit inside
// an AsciiDoc `link:url[`name` label]` macro (see the bullet list under
// "Windows `machine` images"), and this parser's `link:` handling
// (inline.go's matchMacro) does not recurse into the label to find nested
// markup the way the bare-URL form (matchURL) does -- so the backtick-quoted
// name never becomes a SpanCode child at all, only literal text. That is a
// second, independent reason derivation would be harder than #181/#211's
// precedent suggests: even wanting to, "pull the code spans out of this list"
// does not work today without a parser change this issue's scope does not
// call for. Substring-matching the flattened text sidesteps that gap for this
// test's purposes without asking the underlying parser to change.
func TestMachineImageSections_DoNotYetNameEveryCurrentlyOfferedWindowsFamily(t *testing.T) {
	t.Parallel()

	byAnchor := blocksByHeadingAnchor(machineSection(t))
	var windowsText string
	for _, anchor := range []string{"available-windows-machine-images-cloud", "available-windows-gpu-image"} {
		windowsText += " " + plainTextBlocks(byAnchor[anchor])
	}

	notYetNamed := []string{
		"windows-server-2022-nvidia-medium",
		"windows-server-2025-gui",
		"windows-server-2025-nvidia-medium",
	}
	for _, family := range notYetNamed {
		assert.Assert(t, !strings.Contains(windowsText, family),
			"%q now appears in the vendored snapshot's Windows machine-image sections -- upstream may have started enumerating families here; see this file's own doc comment and issue #242\ntext seen: %s", family, windowsText)
	}

	// A sanity check that the walk above actually found real content and did
	// not silently pass by looking at nothing: upstream's own Windows sections
	// do name windows-server-2022-gui, windows-server-2019 and
	// windows-server-2019-cuda today (verified 2026-07-30).
	for _, named := range []string{"windows-server-2022-gui", "windows-server-2019", "windows-server-2019-cuda"} {
		assert.Assert(t, strings.Contains(windowsText, named),
			"expected the Windows machine-image sections to still name %q -- either the snapshot changed in a way worth a fresh look, or this test's anchor/walk logic broke\ntext seen: %s", named, windowsText)
	}
}
