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
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Ranking resource classes by real size, so right-sizing can name a target
// class (issue #8).
//
// # Why this is not read off the class name
//
// `small` < `medium` < `medium+` < `large` < `xlarge` < `2xlarge` < `2xlarge+`
// is CircleCI's own convention today, and it is tempting to hardcode exactly
// that ladder. It would drift the moment a table introduced a class with no
// t-shirt-sized name (a plausible future: the GPU tables already use
// `.multi` rather than a size word), and issue #8 explicitly asks for the
// tables to be the authority, with the names as a sanity check at most. So
// Rank is computed from each row's own vCPUs/RAM columns -- the same
// resourceClassesFromTable already reads for Spec -- never from Name.
//
// # Why this is a rank, not a raw byte count
//
// A caller (the frontend's ResourceClassCatalog, issue #307) only ever asks
// "what is nearer/further in this same table", never "how many bytes of RAM
// does this have". Exposing an ordinal spares it from re-deriving a total
// order out of two numbers, and spares this package from having to decide
// how to spell "not enough vCPUs to also be sure" as a wire value -- an
// ordinal's absence (nil) already says that.
//
// # Why ties are possible, and left as ties
//
// gpu-linux-resource-table.adoc lists `gpu.nvidia.medium`,
// `gpu.nvidia.medium.multi` and `gpu.nvidia.large` with identical vCPUs (8)
// and RAM (30) -- they differ only in GPU count/model, a dimension outside
// vCPUs/RAM entirely. This file has no GPU column to break that tie with, so
// it does not invent one: those three classes share a Rank, and neither
// SmallerClasses nor LargerClasses (resourceclasscatalog.go, once wired) will
// ever call one of them smaller than another. A guessed order would be a
// confident wrong answer; a tie is the honest one.
//
// # Why a bad row does not fail the whole table
//
// ExtractResourceClasses is all-or-nothing about *whether a class exists*
// (see its own doc comment) because a partial class list would misrepresent
// which classes an executor offers. Rank does not carry that risk: a class
// whose vCPU/RAM cell fails to parse simply gets no Rank (nil) and is
// invisible to ranking, which changes nothing about the classes that did
// parse. Fatally failing extraction over an unrankable row would sacrifice a
// real, correct class list to protect a feature (ranking) that ships nothing
// but suggestions.

// classVCPURAM is one row's numeric vCPU/RAM reading, computed only to derive
// Rank -- it is never itself surfaced on the wire, because the tables mix
// GB/GiB and (for the GPU tables) an implicit unit, and a byte count built on
// an assumption is a worse thing to publish than the ordinal it produces.
type classVCPURAM struct {
	vcpus    int
	ramBytes float64
	ok       bool
}

// vcpuCellPattern reads the leading integer off a vCPU cell. `strings.Split`
// on whitespace would also work for a plain "16", but macOS spells its cell
// "6 @ 4.51 GHz" (issue #8's own worked example) -- the leading integer is
// the vCPU count, and everything after it is clock speed this file has no use
// for. A prefix match rather than a full-string one is what lets both shapes
// share one pattern.
var vcpuCellPattern = regexp.MustCompile(`^\s*([0-9]+)`)

// ramCellPattern reads a RAM cell's leading number and whatever unit word (if
// any) follows it. The unit is captured unconditionally, as any run of
// letters -- not as an alternation over the units this file happens to know
// -- specifically so that a *stated but unrecognised* unit ("4 PB") is
// distinguishable from *no unit at all* ("30", gpu-linux-resource-table's own
// spelling). Collapsing those two into one optional-and-ignored group would
// silently treat an unknown unit as GB, which is a worse failure than an
// honest "cannot rank this row".
var ramCellPattern = regexp.MustCompile(`^\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]*)`)

// ramUnitBytes converts a RAM cell's unit suffix to bytes. GiB (binary) and
// GB (decimal) are genuinely different magnitudes, but the distinction never
// changes a Rank: every class in one upstream table is quoted in the same
// unit (verified across all ten tables at circleci-docs 447dc483), so a
// table's internal order is identical whichever convention is used -- this
// exists to convert honestly, not because ranking would break without it.
var ramUnitBytes = map[string]float64{
	"gb":  1e9,
	"gib": 1 << 30,
	"mb":  1e6,
	"tb":  1e12,
}

// defaultRAMUnit is used when a RAM cell carries no unit at all --
// gpu-linux-resource-table.adoc's RAM column ("| 16", "| 30") is the one case
// among the ten tables, and its own header names no unit either. GB is the
// same assumption CircleCI's other tables make explicit, and -- as
// ramUnitBytes' own comment says -- the choice cannot be wrong in a way that
// changes this table's derived order, since every row in it makes the same
// assumption.
const defaultRAMUnit = "gb"

// parseVCPUCell reads a vCPU cell's leading integer. ok is false when the
// cell has no leading digits at all (an upstream shape change, not a
// documented format this package knows).
func parseVCPUCell(text string) (vcpus int, ok bool) {
	m := vcpuCellPattern.FindStringSubmatch(text)
	if m == nil {
		return 0, false
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, false
	}
	return n, true
}

// parseRAMCell reads a RAM cell's magnitude in bytes, applying defaultRAMUnit
// when the cell states no unit word at all. ok is false when the cell has no
// leading number, or states a unit word this package does not recognise --
// see ramCellPattern's own doc comment for why those are kept distinguishable
// rather than both defaulting to GB.
func parseRAMCell(text string) (ramBytes float64, ok bool) {
	m := ramCellPattern.FindStringSubmatch(text)
	if m == nil || m[1] == "" {
		return 0, false
	}
	n, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, false
	}
	unit := strings.ToLower(m[2])
	if unit == "" {
		unit = defaultRAMUnit
	}
	mult, known := ramUnitBytes[unit]
	if !known {
		return 0, false
	}
	return n * mult, true
}

// readVCPURAM reads one row's vCPU/RAM cells by header name -- "vCPUs" and
// "RAM", matched case-insensitively the same way isResourceClassTable matches
// "Class" -- rather than by fixed column index, because column position
// already varies across the ten tables (the GPU tables interleave GPU
// columns between RAM and Disk Size).
func readVCPURAM(header []Cell, row []Cell) classVCPURAM {
	var vcpuText, ramText string
	for i, cell := range header {
		if i >= len(row) {
			break
		}
		switch strings.ToLower(strings.TrimSpace(plainText(cell.Spans))) {
		case "vcpus":
			vcpuText = plainText(row[i].Spans)
		case "ram":
			ramText = plainText(row[i].Spans)
		}
	}
	vcpus, vcpuOK := parseVCPUCell(vcpuText)
	ramBytes, ramOK := parseRAMCell(ramText)
	return classVCPURAM{vcpus: vcpus, ramBytes: ramBytes, ok: vcpuOK && ramOK}
}

// assignRanks sets classes[i].Rank for every i whose readings[i] parsed,
// ordering strictly by (vCPUs, RAM) -- vCPUs first because it is what
// disagrees with RAM at the top of several tables (docker/machine's largest
// "+" class adds vCPUs without adding RAM over its predecessor), RAM as the
// tie-break otherwise. Classes whose reading did not parse are left with a
// nil Rank (assignRanks never touches them), which is what keeps a single bad
// row from being silently treated as the smallest class in its table.
//
// Ties in the sorted (vCPUs, RAM) sequence share a Rank rather than being
// handed consecutive ones -- see this file's own doc comment for why a real
// tie (the GPU-on-Linux table's `medium`/`medium.multi`/`large`) must not be
// broken by anything as arbitrary as table order.
func assignRanks(classes []ResourceClass, readings []classVCPURAM) {
	type entry struct {
		index   int
		reading classVCPURAM
	}
	known := make([]entry, 0, len(readings))
	for i, reading := range readings {
		if reading.ok {
			known = append(known, entry{index: i, reading: reading})
		}
	}
	// Stable so that classes tying on (vCPUs, RAM) keep their upstream table
	// order relative to each other -- irrelevant to Rank itself (they share
	// one), but it keeps this deterministic across repeated runs regardless
	// of sort.Slice's own stability guarantees.
	sort.SliceStable(known, func(i, j int) bool {
		a, b := known[i].reading, known[j].reading
		if a.vcpus != b.vcpus {
			return a.vcpus < b.vcpus
		}
		return a.ramBytes < b.ramBytes
	})

	rank := 0
	for i, e := range known {
		if i > 0 {
			prev := known[i-1].reading
			if e.reading.vcpus != prev.vcpus || e.reading.ramBytes != prev.ramBytes {
				rank++
			}
		}
		value := rank
		classes[e.index].Rank = &value
	}
}
