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
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"
)

// TestParseVCPUCell covers every shape a vCPU cell takes across the ten
// tables, including macOS's clock-speed wrinkle (issue #8).
func TestParseVCPUCell(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		text      string
		wantVCPUs int
		wantOK    bool
	}{
		{"1", 1, true},
		{"16", 16, true},
		// macOS's own spelling: the vCPU count, then clock speed this file
		// has no use for. The leading integer is the answer, not "6 @ 4".
		{"6 @ 4.51 GHz", 6, true},
		{"12 @ 4.51 GHz", 12, true},
		{"", 0, false},
		{"N/A", 0, false},
	} {
		vcpus, ok := parseVCPUCell(tc.text)
		assert.Equal(t, ok, tc.wantOK, "text=%q", tc.text)
		if tc.wantOK {
			assert.Equal(t, vcpus, tc.wantVCPUs, "text=%q", tc.text)
		}
	}
}

// TestParseRAMCell covers every unit spelling the ten tables actually use:
// "2GB" (no space), "8 GB" (space), "8 GiB" (binary unit, machine-gen2's own
// spelling), and gpu-linux-resource-table.adoc's bare number with no unit at
// all (issue #8).
func TestParseRAMCell(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		text         string
		wantRAMBytes float64
		wantOK       bool
	}{
		{"2GB", 2e9, true},
		{"7.5 GB", 7.5e9, true},
		{"8 GiB", 8 * (1 << 30), true},
		// gpu-linux-resource-table.adoc's RAM column: no unit stated anywhere
		// in the table, including its own header. Assumed GB -- see
		// defaultRAMUnit's own doc comment for why that assumption cannot
		// produce a wrong *order*, whatever it does to the absolute number.
		{"30", 30e9, true},
		{"", 0, false},
		{"N/A", 0, false},
		// A unit this package does not recognise: honest failure, not a
		// silent 1x multiplier.
		{"4 PB", 0, false},
	} {
		ramBytes, ok := parseRAMCell(tc.text)
		assert.Equal(t, ok, tc.wantOK, "text=%q", tc.text)
		if tc.wantOK {
			assert.Equal(t, ramBytes, tc.wantRAMBytes, "text=%q", tc.text)
		}
	}
}

// rankOf finds a class by name within one environment's Classes, returning
// its Rank (or nil if the class does not exist or has no Rank).
func rankOf(t *testing.T, env ResourceClassEnvironment, name string) *int {
	t.Helper()
	for _, c := range env.Classes {
		if c.Name == name {
			return c.Rank
		}
	}
	t.Fatalf("no class %q in environment %q", name, env.ID)
	return nil
}

func mustRank(t *testing.T, env ResourceClassEnvironment, name string) int {
	t.Helper()
	rank := rankOf(t, env, name)
	assert.Assert(t, rank != nil, "class %q in %q has no Rank", name, env.ID)
	return *rank
}

// TestRankOrdersEveryTableByVCPUAndRAM is the pinned "print it and eyeball
// it" check (issue #8), made permanent: the Rank this package derives for
// every one of the ten vendored tables, checked against the tables
// themselves rather than against the t-shirt names.
//
// Every table here happens to list its rows in ascending size order already,
// which is exactly why this test matters: a Rank that just numbered rows 0..n
// in table order would pass every one of these except
// gpu-execution-environment-linux, and that is the one table where upstream's
// own row order does *not* match vCPU/RAM order --
// gpu.nvidia.small.multi (4 vCPUs, 15 RAM) sits *after* gpu.nvidia.small
// (4 vCPUs, 16 RAM) in the table, but has less RAM, so a name- or
// row-order-based rank would get it backwards. This is the case issue #8
// asks this package to get right: the columns are the authority, not the
// name or the row position.
//
// Checked against the tables as vendored at circleci-docs 447dc483, same as
// wantResourceClasses in resourceclasses_test.go.
func TestRankOrdersEveryTableByVCPUAndRAM(t *testing.T) {
	t.Parallel()

	environments, err := EmbeddedResourceClasses()
	assert.NilError(t, err)
	byID := environmentsByID(environments)

	wantRanks := map[string]map[string]int{
		"x86": {
			"small": 0, "medium": 1, "medium+": 2, "large": 3,
			"xlarge": 4, "2xlarge": 5, "2xlarge+": 6,
		},
		"x86-gen2": {
			"small.gen2": 0, "medium.gen2": 1, "medium+.gen2": 2, "large.gen2": 3,
			"xlarge.gen2": 4, "2xlarge.gen2": 5, "2xlarge+.gen2": 6,
		},
		"arm": {
			"arm.medium": 0, "arm.large": 1, "arm.xlarge": 2, "arm.2xlarge": 3,
		},
		"linuxvm-execution-environment": {
			// 2xlarge+ has more than double 2xlarge's vCPUs (32 vs 16) but the
			// *same* RAM (64 GB both) -- vCPUs alone separates them.
			"medium": 0, "large": 1, "xlarge": 2, "2xlarge": 3, "2xlarge+": 4,
		},
		"linuxvm-gen2-execution-environment": {
			"medium.gen2": 0, "large.gen2": 1, "xlarge.gen2": 2,
			"2xlarge.gen2": 3, "2xlarge+.gen2": 4,
		},
		"arm-execution-environment-linux": {
			"arm.medium": 0, "arm.large": 1, "arm.xlarge": 2, "arm.2xlarge": 3,
		},
		"windows-execution-environment": {
			"windows.medium": 0, "windows.large": 1, "windows.xlarge": 2, "windows.2xlarge": 3,
		},
		"gpu-execution-environment-linux": {
			// The interesting table -- see this test's own doc comment.
			// small.multi (4 vCPUs, 15 GB) ranks *below* small/small.gen2
			// (4 vCPUs, 16 GB each, tied), even though upstream lists it
			// after them. medium/medium.multi/large all tie at (8 vCPUs,
			// 30 GB) -- indistinguishable by this table's own numbers, so
			// they share a Rank rather than being handed an invented order.
			"gpu.nvidia.small.multi":  0,
			"gpu.nvidia.small":        1,
			"gpu.nvidia.small.gen2":   1,
			"gpu.nvidia.medium.multi": 2,
			"gpu.nvidia.medium":       2,
			"gpu.nvidia.large":        2,
		},
		"gpu-execution-environment-windows": {
			"windows.gpu.nvidia.medium": 0,
		},
		"macos-execution-environment": {
			// m4pro.medium's cell is "6 @ 4.51 GHz" and m4pro.large's is
			// "12 @ 4.51 GHz" -- the leading integer is what must be
			// compared, not the string.
			"m4pro.medium": 0, "m4pro.large": 1,
		},
	}

	assert.Assert(t, is.Len(wantRanks, len(byID)))
	for id, want := range wantRanks {
		env, ok := byID[id]
		assert.Assert(t, ok, "no environment %q", id)
		for name, wantRank := range want {
			assert.Equal(t, mustRank(t, env, name), wantRank, "%s/%s", id, name)
		}
	}
}

// TestRankNeverComparesAcrossExecutors pins that the same class name in two
// different environments -- "medium" is both a Docker x86 class and a
// LinuxVM one, with entirely different specs -- gets independently-derived
// Ranks rather than one number carried over. `large` on Docker (8 GB RAM, x86
// table) and `large` on the LinuxVM table (15 GB RAM) are unrelated machines,
// which is issue #8's own explicit example generalised to same-name classes.
func TestRankNeverComparesAcrossExecutors(t *testing.T) {
	t.Parallel()

	environments, err := EmbeddedResourceClasses()
	assert.NilError(t, err)
	byID := environmentsByID(environments)

	dockerX86 := byID["x86"]
	linuxVM := byID["linuxvm-execution-environment"]

	// Docker's own "medium" (4 GB RAM) sits at rank 1 out of 7 classes;
	// LinuxVM's "medium" (7.5 GB RAM) sits at rank 0 out of 5. Equal names,
	// unequal machines, unequal (and independently-numbered) Ranks.
	assert.Equal(t, mustRank(t, dockerX86, "medium"), 1)
	assert.Equal(t, mustRank(t, linuxVM, "medium"), 0)

	// And explicitly: "large" on Docker (8 GB RAM) is a different machine from
	// "large" on the LinuxVM table (15 GB RAM), which is the issue's own
	// worked example. Their Ranks happening to both be a low integer is not
	// evidence of anything -- what TestRankOrdersEveryTableByVCPUAndRAM
	// actually pins, per table, is that each was computed from its own
	// table's own vCPU/RAM numbers rather than one shared ladder.
	assert.Equal(t, mustRank(t, dockerX86, "large"), 3)
	assert.Equal(t, mustRank(t, linuxVM, "large"), 1)
}

// TestRankIsNilWhenARowCannotBeParsed is the degraded path: one row's vCPU
// cell becomes unparseable, and Rank for *that class alone* becomes nil --
// extraction still succeeds, Spec (the observable fact) is untouched, and
// every other class in the same table keeps the Rank it would have had
// anyway. A single bad cell must never take down the whole table's ordering,
// the same "honest, narrow degradation" this package already applies to
// ExtractResourceClasses' own all-or-nothing failure, one level down.
func TestRankIsNilWhenARowCannotBeParsed(t *testing.T) {
	t.Parallel()

	// docker-resource-table.adoc's own `medium` row -- its vCPU cell, "2",
	// replaced with something no digit-leading regex will parse.
	parsed := parsedSnapshotWithReplacement(t,
		"| `medium`\n| 2\n| 4GB",
		"| `medium`\n| N/A\n| 4GB",
	)

	environments, err := ExtractResourceClasses(parsed)
	assert.NilError(t, err, "one unparseable Rank input must not fail extraction")

	byID := environmentsByID(environments)
	x86 := byID["x86"]

	medium := rankOf(t, x86, "medium")
	assert.Assert(t, medium == nil, "medium's Rank should be nil, got %v", medium)

	// Spec is read from a different cell reference than Rank's own vCPU
	// parse, so the corrupted cell still shows up in it -- proving Spec (the
	// fact) survives independently of Rank (the derived ordering), which is
	// this file's whole reason for keeping them separate.
	for _, c := range x86.Classes {
		if c.Name == "medium" {
			assert.Assert(t, is.Contains(c.Spec, "N/A"))
		}
	}

	// Every other class in the same table is untouched: small is still
	// smaller than large, exactly as if medium's row had never been
	// corrupted.
	assert.Equal(t, mustRank(t, x86, "small"), 0)
	assert.Equal(t, mustRank(t, x86, "large"), 2)
	assert.Equal(t, mustRank(t, x86, "xlarge"), 3)
}

// TestAssignRanksTiesShareARank is assignRanks' own unit test, independent of
// any table: two classes with identical (vCPUs, RAM) must share a Rank
// rather than being handed consecutive ones by whatever order sort.SliceStable
// happens to leave them in.
func TestAssignRanksTiesShareARank(t *testing.T) {
	t.Parallel()

	classes := []ResourceClass{{Name: "a"}, {Name: "b"}, {Name: "c"}}
	readings := []classVCPURAM{
		{vcpus: 4, ramBytes: 16e9, ok: true}, // a
		{vcpus: 2, ramBytes: 8e9, ok: true},  // b -- smaller than a and c
		{vcpus: 4, ramBytes: 16e9, ok: true}, // c -- ties with a
	}

	assignRanks(classes, readings)

	assert.Assert(t, classes[1].Rank != nil)
	assert.Equal(t, *classes[1].Rank, 0) // b: smallest, alone at rank 0
	assert.Assert(t, classes[0].Rank != nil && classes[2].Rank != nil)
	assert.Equal(t, *classes[0].Rank, 1) // a and c tie at rank 1
	assert.Equal(t, *classes[2].Rank, 1)
}
