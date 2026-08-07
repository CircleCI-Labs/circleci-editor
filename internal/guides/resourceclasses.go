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
	"fmt"
	"strings"
)

// Resource classes, derived from CircleCI's own resource tables rather than
// retyped from them (issue #181).
//
// # Why this exists
//
// The editor's executor field used to carry hand-written resource-class lists.
// They drifted, exactly as hand-written lists do: Docker was offered no Arm
// classes at all, the machine executor was missing `arm.xlarge`/`arm.2xlarge`,
// no gen2 class existed anywhere in the UI, and macOS still offered
// `macos.m1.medium.gen1`, which upstream's table no longer lists. Correcting
// the literals would have reset the same trap.
//
// #180 vendored CircleCI's twelve `execution-resources/` resource tables into
// the binary and put them on the same seven-day refresh as the rest of the
// guides. Deriving the offered classes from those tables means the list
// cannot drift from the platform by more than one refresh cycle -- the same
// reasoning that made vendoring the guides preferable to rewriting them.
//
// # What is derived and what is declared
//
// Everything a table can answer is read from the table:
//
//   - the class names -- the `Class` column's code spans;
//   - each environment's display label -- the upstream heading above its table,
//     verbatim, so "x86 (gen2)" is CircleCI's wording and not ours;
//   - the vCPU/RAM/disk summary -- the table's remaining numeric columns;
//   - which class upstream marks `(default)`;
//   - the size order within one table (Rank) -- from the same vCPU/RAM
//     columns, never from the t-shirt name (see resourceclassrank.go's own
//     doc comment, issue #8);
//   - architecture and generation -- see classArchitecture/classGeneration,
//     both computed from the class *name*, because that is where CircleCI
//     encodes them (`arm.medium`, `xlarge.gen2`). There is no second
//     hand-written arch table to fall out of date.
//
// One thing is declared here and cannot be derived: **which executor key a
// table belongs to**. `medium` is both a Docker class and a LinuxVM class with
// different specs; `small` is Docker-only; `windows.medium` and
// `gpu.nvidia.medium` and `arm.medium` are all `machine`. Nothing in a table
// says which. So resourceEnvironments below joins upstream's own section
// anchors to an executor kind, and that join is the whole of this file's
// hardcoded knowledge.
//
// Anchors are the right join key, for the same reason CONFIGURATION_REFERENCE_ID
// and Section.Keys already are: they are explicit `[#id]` lines that upstream's
// own inbound cross-references depend on, so they are among the most stable
// things on the page -- and when one does disappear, extraction fails loudly
// and the UI says the list is a fallback, rather than quietly serving nine
// environments where there should be ten.
//
// # Failing honestly
//
// ExtractResourceClasses is all-or-nothing. A partial result would leave some
// executors accurate and others stale with nothing in the UI able to say which,
// which is worse than one honest "this list is the one built into this release,
// not CircleCI's current one" notice. See ResourceClasses for what that
// fallback is and why it is not a hand-written list.
//
// # Why this file was not retired for GET /api/v3/catalog/offerings (issue #305)
//
// That live endpoint is also keyed by resource class, and issue #305 asked
// whether it could replace this parser outright. Verified against a live
// snapshot, it cannot: four Docker-only classes ("small", "medium+" and their
// ".gen2" siblings) never appear in the offerings response under any
// executor, and "gpu.nvidia.small" (a real machine class this file extracts)
// is also absent from it. See internal/offerings's
// TestOfferingsIsNotASupersetOfAsciiDocResourceClasses, which pins both gaps
// against a captured response. What that endpoint does add on top of this
// file's output, safely: image <-> resource-class compatibility, used to
// filter the machine-image picker
// (web/src/lib/machineOfferings/compatibility.ts) -- never to decide which
// classes exist, which stays this file's job alone.

// ResourceClassGuideID is the guide whose tables this file reads. The
// configuration reference includes every one of the twelve
// `execution-resources/` partials, in per-environment sections -- so a single
// guide answers the whole question, and `using-docker`/`using-macos`/
// `using-windows` (which include a subset each) need not be consulted.
const ResourceClassGuideID = "configuration-reference"

// Architectures a class can be offered under. These are the values the picker's
// architecture control narrows by; they are *not* config keys, and nothing in
// this project ever writes them -- `resource_class: arm.medium` is how CircleCI
// spells the architecture, and there is no `architecture:` field to write.
const (
	// ArchX86 is x86_64.
	ArchX86 = "x86_64"
	// ArchArm is arm64.
	ArchArm = "arm64"
	// ArchUnstated is used when neither the class name nor the table's own
	// heading states an architecture. macOS is the only case today: every
	// `m4pro.*` class is Apple silicon, but the resource table does not say so
	// (its sibling Xcode table does), and asserting a fact the table does not
	// carry is exactly the drift this file exists to prevent. A picker treats
	// ArchUnstated as "always show".
	ArchUnstated = ""
)

// Generations a class can belong to.
const (
	// GenerationGen1 is CircleCI's original compute generation, spelled with no
	// suffix at all (`xlarge`, `arm.medium`).
	GenerationGen1 = "gen1"
	// GenerationGen2 is the newer generation, spelled as a `.gen2` suffix on
	// the class name (`xlarge.gen2`, `gpu.nvidia.small.gen2`). It *is*
	// expressible in `resource_class`, which is why gen2 classes are offered
	// as ordinary options in their own upstream-labelled group rather than
	// behind a separate control -- see the doc comment on
	// ResourceClassEnvironment.Generation.
	GenerationGen2 = "gen2"
)

// gen2Suffix is how CircleCI spells generation 2 in a resource class name.
const gen2Suffix = ".gen2"

// armSegment is the class-name segment that means arm64. Matched as a whole
// dot-separated segment, not as a prefix: `arm.medium` and
// `arm.2xlarge` are Arm, and a hypothetical `armadillo.medium` would not be.
const armSegment = "arm"

// classColumnHeader is the resource tables' first column. Every one of the
// twelve `execution-resources/` tables leads with it, and requiring it is what
// keeps this from picking up the `Key | Required | Type | Description` tables
// that fill the rest of the configuration reference.
const classColumnHeader = "class"

// defaultMarker is how upstream flags the class a job gets when it names none
// (`| `+"`arm.medium`"+` (default)`).
const defaultMarker = "(default)"

// ResourceClass is one row of one upstream resource table.
type ResourceClass struct {
	// Name is the value to write as `resource_class:`, verbatim from the
	// table's Class column.
	Name string `json:"name"`
	// Spec is the table's own description of the machine, assembled from its
	// remaining numeric columns ("vCPUs 2, RAM 8 GB, Disk Size 100 GB"), for a
	// tooltip. Empty when the table carried no such columns.
	Spec string `json:"spec,omitempty"`
	// Default reports that upstream marks this class "(default)" for its
	// environment.
	Default bool `json:"default,omitempty"`
	// Architecture is ArchX86, ArchArm or ArchUnstated -- derived from Name.
	Architecture string `json:"architecture"`
	// Generation is GenerationGen1 or GenerationGen2 -- derived from Name.
	Generation string `json:"generation"`
	// Rank orders this class among the *other classes in the same
	// ResourceClassEnvironment* -- 0 is the smallest, larger classes get
	// larger Ranks, and classes that tie on both vCPUs and RAM share one.
	// Derived from the table's own vCPU/RAM columns, never from Name -- see
	// resourceclassrank.go's package-level doc comment for why the name is a
	// sanity check only, never the input (issue #8).
	//
	// nil when this row's vCPU or RAM cell could not be parsed as a number.
	// A caller ranking classes must treat nil as "unknown", never as
	// "smallest" or "excluded from the ladder for a reason" -- it is neither;
	// this file simply could not read a number here. Comparing Rank across
	// two ResourceClassEnvironments is always a mistake regardless: `large`
	// on Docker and `large` on macOS are unrelated machines, and Rank is only
	// ever meaningful within the one table it came from.
	Rank *int `json:"rank,omitempty"`
}

// ResourceClassEnvironment is one upstream resource table: the classes it
// lists, and enough context for a picker to group and filter them.
type ResourceClassEnvironment struct {
	// ID is upstream's own section anchor ("x86", "x86-gen2", "arm",
	// "linuxvm-execution-environment", ...). Stable, and the join key
	// `paletteExecutors.ts` names.
	ID string `json:"id"`
	// Label is the upstream heading above the table, verbatim -- what a picker
	// shows as an option group. CircleCI's wording, not ours.
	Label string `json:"label"`
	// Kind is the executor key these classes belong to: "docker", "machine" or
	// "macos". Declared, not derived -- see this file's doc comment.
	Kind string `json:"kind"`
	// Architecture is the architecture every class here shares, or
	// ArchUnstated when the classes disagree or nothing states one.
	Architecture string `json:"architecture"`
	// Generation is the generation every class here shares, or "" when they
	// disagree.
	//
	// Gen2 is a real, writable `resource_class` value (`xlarge.gen2`), so it is
	// represented as its own environment with its own upstream label rather
	// than as a filter: a second dropdown that only ever appends a suffix would
	// be chrome for something the class list can say plainly.
	Generation string `json:"generation"`
	// Classes are the table's rows, in upstream's order.
	Classes []ResourceClass `json:"classes"`
}

// resourceEnvironmentDef joins one upstream section anchor to the executor key
// its classes belong to. This slice is the entirety of this file's hardcoded
// knowledge of CircleCI's compute offering -- everything else is read from the
// tables. Its order is the order a picker lists environments in, which is
// upstream's own document order.
type resourceEnvironmentDef struct {
	anchor string
	kind   string
}

// Executor keys a resource class can belong to. Exactly CircleCI's three
// native executor types -- see ExecutorSpec in configMutations.ts, and
// BUILTIN_EXECUTORS' doc comment for why the palette shows five cards over
// three kinds.
const (
	KindDocker  = "docker"
	KindMachine = "machine"
	KindMacOS   = "macos"
)

// resourceEnvironments is the join key. Every anchor here is an explicit
// `[#id]` line in the configuration reference; TestEveryResourceEnvironment
// AnchorResolves fails if upstream drops one.
var resourceEnvironments = []resourceEnvironmentDef{
	{anchor: "x86", kind: KindDocker},
	{anchor: "x86-gen2", kind: KindDocker},
	{anchor: "arm", kind: KindDocker},
	{anchor: "linuxvm-execution-environment", kind: KindMachine},
	{anchor: "linuxvm-gen2-execution-environment", kind: KindMachine},
	{anchor: "arm-execution-environment-linux", kind: KindMachine},
	{anchor: "windows-execution-environment", kind: KindMachine},
	{anchor: "gpu-execution-environment-linux", kind: KindMachine},
	{anchor: "gpu-execution-environment-windows", kind: KindMachine},
	{anchor: "macos-execution-environment", kind: KindMacOS},
}

// classArchitecture derives an architecture from a resource class name, because
// that is where CircleCI puts it: `arm.medium` is arm64 and `xlarge` is x86_64,
// and there is no `architecture:` config key either could come from instead.
//
// Matched as a whole dot-separated segment so that `arm.2xlarge` is Arm while
// `windows.gpu.nvidia.medium` is not (it has no `arm` segment) -- a prefix or
// substring test would misclassify a future `arm64.medium` or, worse, quietly
// accept something like `alarm.medium`.
//
// A name with no architecture segment is x86_64 *only* for the Linux and
// Windows families, where every class upstream lists is. macOS is deliberately
// ArchUnstated: `m4pro.medium` is Apple silicon, but its table does not say so,
// and this file does not invent facts the tables lack.
func classArchitecture(name, kind string) string {
	for _, segment := range strings.Split(name, ".") {
		if strings.EqualFold(segment, armSegment) {
			return ArchArm
		}
	}
	if kind == KindMacOS {
		return ArchUnstated
	}
	return ArchX86
}

// classGeneration derives a generation from a resource class name. Gen2 is
// spelled as a `.gen2` suffix (`xlarge.gen2`, `gpu.nvidia.small.gen2`);
// everything else is gen1, which has no suffix of its own.
func classGeneration(name string) string {
	if strings.HasSuffix(strings.ToLower(name), gen2Suffix) {
		return GenerationGen2
	}
	return GenerationGen1
}

// ResourceClassesResult is what a caller gets back: the environments to offer,
// and whether they came from the documentation the app is currently serving.
//
// Derived is false when the current documentation's tables could not be read
// and this is the copy embedded in the binary instead, and Reason then says so
// in words a UI can show. The distinction is surfaced all the way to the
// executor field: an empty dropdown is worse than a stale one, but a stale one
// presented as current is worse than either.
type ResourceClassesResult struct {
	Environments []ResourceClassEnvironment `json:"environments"`
	Derived      bool                       `json:"derived"`
	Reason       string                     `json:"reason,omitempty"`
}

// ResourceClasses derives the resource classes to offer from parsed guides,
// falling back to the copy embedded in this binary when the tables cannot be
// read.
//
// It returns no error: the caller is an HTTP handler serving a form control,
// and there is no useful "no answer" for it to render. The honest degradation is
// a fallback plus a reason, which is what this returns.
//
// # Why the fallback is not a hand-written list
//
// Issue #181 asked for a fallback to "the current hardcoded list", and there
// isn't one any more -- deleting it is the fix. What replaces it is strictly
// better and cannot drift at all: **the same extraction, run against the
// snapshot embedded in this binary**.
//
// The two inputs differ. `parsed` is whatever the guides cache currently holds,
// which after a background refresh is AsciiDoc fetched from upstream at runtime
// and therefore of unknown shape -- the only realistic way extraction fails.
// The embedded snapshot is fixed bytes that TestResourceClassesFromVendored
// Snapshot proves parse, so it is available precisely when the refreshed copy
// is not. A retyped literal could only ever have been a worse copy of it.
//
// If even the embedded snapshot cannot be read -- a build defect, which the
// package's own tests make close to impossible -- the result is empty with
// Derived false and a reason. The executor field then falls back to the one
// class its card knows plus free text, and says why. There is no path here that
// silently offers a wrong list.
func ResourceClasses(parsed []Guide) ResourceClassesResult {
	environments, err := ExtractResourceClasses(parsed)
	if err == nil {
		return ResourceClassesResult{Environments: environments, Derived: true}
	}
	reason := err.Error()

	embedded, embeddedErr := EmbeddedResourceClasses()
	if embeddedErr != nil {
		return ResourceClassesResult{
			Environments: []ResourceClassEnvironment{},
			Derived:      false,
			Reason:       reason + "; nor could the copy embedded in this release be read (" + embeddedErr.Error() + ")",
		}
	}
	return ResourceClassesResult{
		Environments: embedded,
		Derived:      false,
		Reason:       reason + "; showing the list embedded in this release instead, which may be older than CircleCI's current tables",
	}
}

// EmbeddedResourceClasses extracts resource classes from the snapshot embedded
// in this binary, ignoring any background refresh. It is the fallback path in
// ResourceClasses, and the input to the test that pins what this project claims
// to offer.
//
// Not memoised: it is called at most once per degraded request, and a
// package-level cache would have to be reset in tests for no benefit.
func EmbeddedResourceClasses() ([]ResourceClassEnvironment, error) {
	parsed, err := ParseSnapshot()
	if err != nil {
		return nil, err
	}
	return ExtractResourceClasses(parsed)
}

// ExtractResourceClasses reads the resource-class tables out of the parsed
// configuration reference.
//
// All-or-nothing on purpose: an error here means the *whole* list falls back,
// because a partial result would offer some executors' real classes and others'
// stale ones with no way for the UI to say which is which.
func ExtractResourceClasses(parsed []Guide) ([]ResourceClassEnvironment, error) {
	guide := findGuideByID(parsed, ResourceClassGuideID)
	if guide == nil {
		return nil, fmt.Errorf("guides: the %s guide is not available, so resource classes could not be read from CircleCI's own tables", ResourceClassGuideID)
	}

	tables := tablesByAnchor(*guide, isResourceClassTable)
	out := make([]ResourceClassEnvironment, 0, len(resourceEnvironments))
	for _, def := range resourceEnvironments {
		found, ok := tables[def.anchor]
		if !ok {
			return nil, fmt.Errorf("guides: the configuration reference no longer has a resource-class table under its %q section, so resource classes could not be read from CircleCI's own tables", def.anchor)
		}
		classes, err := resourceClassesFromTable(found.table, def.kind)
		if err != nil {
			return nil, fmt.Errorf("guides: the resource-class table under %q could not be read (%w), so resource classes could not be read from CircleCI's own tables", def.anchor, err)
		}
		out = append(out, ResourceClassEnvironment{
			ID:           def.anchor,
			Label:        found.label,
			Kind:         def.kind,
			Architecture: commonArchitecture(classes),
			Generation:   commonGeneration(classes),
			Classes:      classes,
		})
	}
	return out, nil
}

// anchoredTable is an upstream table plus the heading text above it.
type anchoredTable struct {
	table *Table
	label string
}

// tablesByAnchor indexes every table in a guide that `wanted` accepts by the
// anchor of the nearest heading above it.
//
// It tracks headings *and* sections, so it keeps working whichever level
// upstream writes these headings at. Today all ten resource tables sit as
// level-4 KindHeading blocks inside the single level-3
// `docker-execution-environment` section (upstream writes the
// LinuxVM/macOS/Windows/GPU/Arm ones as `====` even though they are siblings of
// the Docker one, not children), while the supported-Xcode table sits under a
// level-3 heading of its own on a different page. If upstream promotes or demotes
// any of them they are still found under the same anchor.
//
// Shared by resource-class extraction and Xcode-version extraction (issue #211)
// rather than copied: "find the table under upstream's own anchor" is the join
// mechanism both rely on, and two copies of it would be two things to keep in
// step with the parser.
func tablesByAnchor(guide Guide, wanted func(*Table) bool) map[string]anchoredTable {
	out := map[string]anchoredTable{}
	for _, section := range guide.Sections {
		anchor := section.ID
		label := section.Title
		// if/else rather than a switch on BlockKind: only two of the seven kinds
		// matter here, and a switch would either have to name the other five to
		// satisfy the exhaustive linter or carry a default that says nothing.
		for _, block := range section.Blocks {
			if block.Kind == KindHeading {
				anchor = block.ID
				label = plainText(block.Spans)
				continue
			}
			if block.Kind != KindTable || !wanted(block.Table) {
				continue
			}
			// First table under an anchor wins: upstream puts at most one
			// matching table per heading, and a second would be a shape change
			// this file should not paper over.
			if _, seen := out[anchor]; !seen {
				out[anchor] = anchoredTable{table: block.Table, label: label}
			}
		}
	}
	return out
}

// isResourceClassTable reports whether a parsed table is one of the resource
// tables: a header row whose first column is "Class".
//
// This is a check against the *parsed model*, not a pattern match against
// AsciiDoc source. The tables are wrapped in `[.table-scroll]` open blocks,
// carry `[.circle-green]#**Yes**#` role spans in their availability columns and
// vary between `[cols=5*]`, `[cols=6*]` and an explicit column-width list --
// none of which this has to know, because the parser has already dealt with all
// of it (see asciidoc.go's parseTable).
func isResourceClassTable(table *Table) bool {
	if table == nil || len(table.Header) == 0 || len(table.Rows) == 0 {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(plainText(table.Header[0].Spans)), classColumnHeader)
}

// resourceClassesFromTable reads one resource table's rows.
//
// The class name is the first *code* span in the row's first cell, which is how
// every one of these tables writes it -- and taking the code span rather than
// the cell's text is what makes `| `+"`arm.medium`"+` (default)` yield
// `arm.medium` and a `(default)` flag rather than a class called
// "arm.medium (default)".
func resourceClassesFromTable(table *Table, kind string) ([]ResourceClass, error) {
	out := make([]ResourceClass, 0, len(table.Rows))
	// readings runs parallel to out, and feeds assignRanks below -- kept
	// separate from ResourceClass itself because it is an intermediate
	// (rowIndex -> parsed vCPU/RAM), not something this file ever hands to a
	// caller; ResourceClass only ever gets the ordinal assignRanks produces.
	readings := make([]classVCPURAM, 0, len(table.Rows))
	for _, row := range table.Rows {
		if len(row) == 0 {
			continue
		}
		name := firstCodeSpanText(row[0].Spans)
		if name == "" {
			return nil, fmt.Errorf("a row's Class cell has no code span (%q)", strings.TrimSpace(plainText(row[0].Spans)))
		}
		out = append(out, ResourceClass{
			Name:         name,
			Spec:         specSummary(table.Header, row),
			Default:      strings.Contains(strings.ToLower(plainText(row[0].Spans)), defaultMarker),
			Architecture: classArchitecture(name, kind),
			Generation:   classGeneration(name),
		})
		readings = append(readings, readVCPURAM(table.Header, row))
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("the table has no rows with a class name")
	}
	assignRanks(out, readings)
	return out, nil
}

// availabilityColumns are the resource tables' cloud/server availability
// columns, left out of Spec: they are a per-installation fact, and a tooltip
// that said "Server No" next to a class a reader's own CircleCI Server
// installation does offer would be a confident wrong answer. The Cloud/Server
// question is answered by linking the reader to the table itself
// (ResourceClassEnvironment.URL).
var availabilityColumns = map[string]bool{"cloud": true, "server": true}

// specSummary assembles a row's machine description from the table's own
// columns, skipping the class column itself and the availability columns.
// Column headers come from the table, so a table that grows a "GPU model"
// column starts saying so with no change here.
func specSummary(header []Cell, row []Cell) string {
	parts := make([]string, 0, len(row))
	for i, cell := range row {
		if i == 0 || i >= len(header) {
			continue
		}
		name := strings.TrimSpace(plainText(header[i].Spans))
		if availabilityColumns[strings.ToLower(name)] {
			continue
		}
		value := strings.TrimSpace(plainText(cell.Spans))
		if name == "" || value == "" {
			continue
		}
		parts = append(parts, name+" "+value)
	}
	return strings.Join(parts, ", ")
}

// firstCodeSpanText returns the text of the first inline-code span in spans,
// searching nested children (upstream writes some class names inside a bold
// run), or "" when there is none.
func firstCodeSpanText(spans []Span) string {
	for _, span := range spans {
		if span.Kind == SpanCode && strings.TrimSpace(span.Text) != "" {
			return strings.TrimSpace(span.Text)
		}
		if nested := firstCodeSpanText(span.Children); nested != "" {
			return nested
		}
	}
	return ""
}

// commonArchitecture returns the architecture every class shares, or
// ArchUnstated when they disagree -- in which case a picker shows the
// environment under every architecture rather than hiding it under one.
func commonArchitecture(classes []ResourceClass) string {
	return commonValue(classes, func(c ResourceClass) string { return c.Architecture })
}

// commonGeneration returns the generation every class shares, or "" when they
// disagree.
func commonGeneration(classes []ResourceClass) string {
	return commonValue(classes, func(c ResourceClass) string { return c.Generation })
}

func commonValue(classes []ResourceClass, of func(ResourceClass) string) string {
	if len(classes) == 0 {
		return ""
	}
	first := of(classes[0])
	for _, class := range classes[1:] {
		if of(class) != first {
			return ""
		}
	}
	return first
}

// findGuideByID returns the parsed guide with this ID, or nil.
func findGuideByID(parsed []Guide, id string) *Guide {
	for i := range parsed {
		if parsed[i].ID == id {
			return &parsed[i]
		}
	}
	return nil
}
