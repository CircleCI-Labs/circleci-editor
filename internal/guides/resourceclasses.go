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
	"regexp"
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
// ExtractResourceClasses fails outright only when it has nothing at all to
// offer -- the guide is missing, or every environment failed to resolve --
// which is the one case a whole-list fallback is the honest answer for. See
// ResourceClasses for what that fallback is and why it is not a hand-written
// list.
//
// A single environment failing (its anchor renamed or removed, or its table
// reshaped) instead degrades that one ResourceClassEnvironment in place
// (Degraded, DegradedReason) while every other environment keeps whatever the
// currently-served documentation says. Before issue #44 this file went
// all-or-nothing on any single failure, on the theory that a partial result
// would leave some executors accurate and others stale with nothing able to
// say which. In practice that theory made things worse: a real upstream
// restructuring (LinuxVM's, which prompted #44) breaks one section, and the
// old behaviour turned that into losing all ten environments' current data
// -- including the nine nothing was wrong with -- for the one built into the
// release instead. Degrading in place is the same "say what you don't know"
// principle applied at the grain the failure actually occurs at.
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

// Generations a class can belong to. GenerationGen1 and GenerationGen2 are
// named constants because every class-name test in this package predates
// gen3 and spells them out; gen3 and any generation after it are matched
// generically by genSuffixPattern below rather than getting a constant each,
// which is the point -- issue #44 asked for a new generation to need no code
// change, and a growing enum of `GenerationGenN` constants would be exactly
// the code change that request was against.
const (
	// GenerationGen1 is CircleCI's original compute generation, spelled with no
	// suffix at all (`xlarge`, `arm.medium`).
	GenerationGen1 = "gen1"
	// GenerationGen2 is spelled as a `.gen2` suffix on the class name
	// (`xlarge.gen2`, `gpu.nvidia.small.gen2`). It *is* expressible in
	// `resource_class`, which is why gen2 (and gen3, and any later generation)
	// classes are offered as ordinary options in their own upstream-labelled
	// group rather than behind a separate control -- see the doc comment on
	// ResourceClassEnvironment.Generation.
	GenerationGen2 = "gen2"
)

// genSuffixPattern matches CircleCI's generation-N suffix on a class name
// (`.gen2`, `.gen3`, ...; verified against `linuxvm-gen3-execution-
// environment`'s own classes -- `medium.gen3`, `large.gen3` -- live on
// circleci-docs 2026-08-07). Matched generically rather than as a fixed
// `.gen2`/`.gen3`/... alternation, which is what lets classGeneration read
// gen3's classes correctly with no change here: hardcoding `.gen2` alone,
// this file's shape before gen3 shipped, silently read every `.gen3` class as
// gen1, a confident wrong answer this package exists to avoid.
var genSuffixPattern = regexp.MustCompile(`(?i)\.gen([0-9]+)$`)

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
	// Generation is GenerationGen1, GenerationGen2, or "gen3"/"gen4"/... for
	// any later generation CircleCI spells the same way -- derived from Name.
	// See genSuffixPattern.
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
	// Classes are the table's rows, in upstream's order. Empty when Degraded is
	// true -- never a previous response's classes carried forward, and never a
	// guess, because a caller cannot tell "empty because degraded" from "empty
	// but current" any other way.
	Classes []ResourceClass `json:"classes"`
	// Degraded reports that *this* environment's table could not be read from
	// the documentation currently being served, while every other environment
	// in the same ExtractResourceClasses result derived normally. DegradedReason
	// says why.
	//
	// Before issue #44, ExtractResourceClasses was all-or-nothing: one
	// disappeared anchor discarded all ten environments' worth of current data
	// rather than the one it actually affected. That traded a real, mostly-
	// correct answer for a stale one over a single environment's problem, which
	// is a worse trade than it looks -- an upstream restructuring is far more
	// likely to touch one section (as it did here, LinuxVM's) than to break
	// every table on the page at once. Degraded is the per-environment version
	// of ResourceClassesResult.Derived, at finer grain.
	Degraded bool `json:"degraded,omitempty"`
	// DegradedReason is set when Degraded is true: a sentence a UI can show
	// next to this one card.
	DegradedReason string `json:"degradedReason,omitempty"`
}

// resourceEnvironmentDef joins one upstream section anchor to the executor key
// its classes belong to. resourceEnvironments below is the entirety of this
// file's hardcoded knowledge of CircleCI's compute offering -- everything else
// is read from the tables, including any *additional* environment discovered
// by discoverResourceEnvironments (see its own doc comment). The order
// ExtractResourceClasses returns is upstream's own document order regardless
// of which of the two sources a def came from.
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

// resourceEnvironments is the join key. Every anchor here is (or was, before
// upstream removed it, in which case it degrades individually rather than
// vanishing -- see ExtractResourceClasses) an explicit `[#id]` line in the
// configuration reference; TestEveryResourceEnvironmentAnchorResolves checks
// that against the vendored snapshot.
//
// This list is not the only source of environments any more (see
// discoverResourceEnvironments), but it is still the *only* source of Kind:
// nothing in a table says whether `medium` belongs to Docker or the machine
// executor, so every environment this project already knows about stays
// declared here rather than guessed at.
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

// executionEnvironmentSuffix is the naming convention every one of upstream's
// *non-Docker* resource-table sections uses on its anchor -- Docker's three
// are bare architecture names ("x86", "x86-gen2", "arm") because they share
// one parent section, while LinuxVM/macOS/Windows/GPU/Arm-VM each get their
// own section and all spell it "...-execution-environment". A new compute
// generation added under an existing family follows the same convention one
// level down (`linuxvm-gen3-execution-environment`, sibling to `-gen2`'s own
// heading), which is what makes the suffix a safe signal for "this heading is
// a resource-table generation this file has not been told about yet",
// checked in discoverResourceEnvironments.
const executionEnvironmentSuffix = "-execution-environment"

// discoverResourceEnvironments finds heading-level anchors that look like a
// resource-table environment resourceEnvironments does not already name, so a
// new one -- a new compute generation, concretely -- becomes visible with no
// code change (issue #44's gen3 ask).
//
// Restricted to *heading* anchors (KindHeading blocks, level 4 and deeper),
// never section anchors, on purpose: `docker-execution-environment` is a
// level-3 section whose own anchor also ends in the suffix, and it encloses
// x86/x86-gen2/arm's tables the same way `linuxvm-execution-environment`
// encloses Gen1's (see tablesByAnchor's section-fallback) -- discovering it
// too would offer a fourth, duplicate "Docker" environment built from
// whichever of its children's tables happened to come first. New generations
// are added as a heading nested in an existing family's section (Gen2's
// heading, then Gen3's, both inside `linuxvm-execution-environment`); a
// wholly new top-level family is not the case this guards, and would need a
// declared Kind here regardless, because nothing upstream states what
// executor a brand new section belongs to.
//
// Every anchor found this way is offered under KindMachine. That is a
// declared guess, not a derived fact -- but every heading-level
// `*-execution-environment` anchor upstream has ever used belongs to the
// machine executor (LinuxVM's generations), and offering a new generation
// under a possibly-wrong kind is a better failure than not offering it at
// all, which is what happened to gen3 before this file knew its anchor
// existed.
func discoverResourceEnvironments(guide Guide, tables map[string]anchoredTable, known map[string]bool) []resourceEnvironmentDef {
	var out []resourceEnvironmentDef
	seen := map[string]bool{}
	for _, section := range guide.Sections {
		for _, block := range section.Blocks {
			if block.Kind != KindHeading || known[block.ID] || seen[block.ID] {
				continue
			}
			if !strings.HasSuffix(block.ID, executionEnvironmentSuffix) {
				continue
			}
			if _, hasTable := tables[block.ID]; !hasTable {
				// Looks like an environment anchor but resolves to no
				// resource-class table -- not the shape this is looking for,
				// and not something worth reporting as a degraded environment
				// either: this file never declared it, so its absence is not
				// a regression to surface, just a heading that is not one of
				// these tables.
				continue
			}
			seen[block.ID] = true
			out = append(out, resourceEnvironmentDef{anchor: block.ID, kind: KindMachine})
		}
	}
	return out
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

// classGeneration derives a generation from a resource class name. Any
// `.genN` suffix (`xlarge.gen2`, `medium.gen3`, `gpu.nvidia.small.gen2`) names
// that generation; a name with no such suffix is gen1, which has none of its
// own.
func classGeneration(name string) string {
	if m := genSuffixPattern.FindStringSubmatch(name); m != nil {
		return "gen" + m[1]
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
// configuration reference: one ResourceClassEnvironment per anchor in
// resourceEnvironments, plus any discoverResourceEnvironments finds, in
// upstream's document order.
//
// Fails outright only when there is nothing to read at all: the guide itself
// is missing, or every declared and discovered anchor failed to resolve. A
// single anchor failing -- upstream renamed or removed it, or its table no
// longer looks like one -- degrades *that* ResourceClassEnvironment
// (Degraded, DegradedReason) rather than the whole result, which is the
// change issue #44 asked for: before it, one disappeared anchor discarded
// nine other environments' worth of perfectly good, current data along with
// the one it actually affected.
func ExtractResourceClasses(parsed []Guide) ([]ResourceClassEnvironment, error) {
	guide := findGuideByID(parsed, ResourceClassGuideID)
	if guide == nil {
		return nil, fmt.Errorf("guides: the %s guide is not available, so resource classes could not be read from CircleCI's own tables", ResourceClassGuideID)
	}

	tables := tablesByAnchor(*guide, isResourceClassTable)

	known := make(map[string]bool, len(resourceEnvironments))
	for _, def := range resourceEnvironments {
		known[def.anchor] = true
	}
	discovered := discoverResourceEnvironments(*guide, tables, known)
	defs := mergeDiscovered(resourceEnvironments, discovered, anchorPositions(*guide))

	out := make([]ResourceClassEnvironment, 0, len(defs))
	resolved := 0
	for _, def := range defs {
		env, err := resourceClassEnvironmentFor(def, tables)
		if err != nil {
			out = append(out, ResourceClassEnvironment{
				ID:             def.anchor,
				Kind:           def.kind,
				Degraded:       true,
				DegradedReason: err.Error(),
			})
			continue
		}
		resolved++
		out = append(out, env)
	}
	// Zero resolved is the one case left where the whole result is worthless
	// rather than merely incomplete -- indistinguishable in practice from the
	// guide having gone missing, so it is reported the same way and
	// ResourceClasses falls all the way back to the embedded snapshot instead
	// of returning ten (or eleven) empty, degraded cards.
	if resolved == 0 {
		return nil, fmt.Errorf("guides: none of the configuration reference's resource-class tables could be read, so resource classes could not be read from CircleCI's own tables")
	}
	return out, nil
}

// resourceClassEnvironmentFor resolves one environment definition against
// tables, the error path ExtractResourceClasses turns into a Degraded entry
// rather than a fatal one.
func resourceClassEnvironmentFor(def resourceEnvironmentDef, tables map[string]anchoredTable) (ResourceClassEnvironment, error) {
	found, ok := tables[def.anchor]
	if !ok {
		return ResourceClassEnvironment{}, fmt.Errorf("the configuration reference no longer has a resource-class table under its %q section", def.anchor)
	}
	classes, err := resourceClassesFromTable(found.table, def.kind)
	if err != nil {
		return ResourceClassEnvironment{}, fmt.Errorf("the resource-class table under %q could not be read (%w)", def.anchor, err)
	}
	return ResourceClassEnvironment{
		ID:           def.anchor,
		Label:        found.label,
		Kind:         def.kind,
		Architecture: commonArchitecture(classes),
		Generation:   commonGeneration(classes),
		Classes:      classes,
	}, nil
}

// anchorPositions maps every section and heading anchor in guide to its index
// in document order, so environments named by resourceEnvironments and
// environments discoverResourceEnvironments finds -- two different sources --
// still come back in one order: upstream's own, which is the order a picker
// should list them in.
func anchorPositions(guide Guide) map[string]int {
	positions := make(map[string]int)
	note := func(id string) {
		if id == "" {
			return
		}
		if _, seen := positions[id]; !seen {
			positions[id] = len(positions)
		}
	}
	for _, section := range guide.Sections {
		note(section.ID)
		for _, block := range section.Blocks {
			if block.Kind == KindHeading {
				note(block.ID)
			}
		}
	}
	return positions
}

// mergeDiscovered inserts each discovered def next to its nearest preceding
// declared sibling in real document order, leaving declared's own relative
// order untouched otherwise.
//
// declared's order is this project's curated picker order, not strictly
// upstream's document order (macOS, for instance, is declared after Arm-VM/
// Windows/GPU even though its section currently comes first) -- so resorting
// the whole list by true position, the simpler-looking approach, would
// silently relitigate that curation every time upstream reshuffles its
// sections. What a *new* anchor needs is narrower: a sensible spot near the
// family it belongs to, which "immediately after whichever declared anchor
// most closely precedes it" gives for exactly the shape issue #44 introduces
// (a new generation's heading sitting right after the previous generation's,
// inside a section declared already) without reordering anything declared
// already covers.
func mergeDiscovered(declared, discoveredDefs []resourceEnvironmentDef, positions map[string]int) []resourceEnvironmentDef {
	out := append([]resourceEnvironmentDef{}, declared...)
	for _, d := range discoveredDefs {
		dPos, ok := positions[d.anchor]
		insertAt := len(out)
		if ok {
			bestIndex, bestPos := -1, -1
			for i, r := range out {
				rPos, rOK := positions[r.anchor]
				if !rOK || rPos >= dPos {
					continue
				}
				if rPos > bestPos {
					bestPos, bestIndex = rPos, i
				}
			}
			if bestIndex >= 0 {
				insertAt = bestIndex + 1
			} else {
				insertAt = 0
			}
		}
		out = append(out[:insertAt:insertAt], append([]resourceEnvironmentDef{d}, out[insertAt:]...)...)
	}
	return out
}

// anchoredTable is an upstream table plus the heading text above it.
type anchoredTable struct {
	table *Table
	label string
}

// tablesByAnchor indexes every table in a guide that `wanted` accepts by the
// anchor of the nearest heading above it -- and, in addition, by the anchor
// of its *enclosing section*, so a caller that still names the section (issue
// #44) keeps working even after upstream interposes a heading between the
// section and its table.
//
// It tracks headings *and* sections, so it keeps working whichever level
// upstream writes these headings at. Today all ten original resource tables
// sit as level-4 KindHeading blocks inside a level-3 section (`docker-
// execution-environment` for the Docker three; each of LinuxVM/macOS/Windows/
// GPU/Arm owns its own level-3 section), while the supported-Xcode table sits
// under a level-3 heading of its own on a different page. If upstream
// promotes or demotes any of them they are still found under the same anchor.
//
// The section-level entry is the fix for the LinuxVM section specifically:
// upstream (circleci-docs, verified live 2026-08-07) restructured
// `linuxvm-execution-environment` from "heading, then its table" to "heading,
// then an example and a `[tabs]` block, then a *new* `Gen1` sub-heading, then
// the table" -- so the table that used to sit directly under the section now
// sits under a heading the section did not use to have. Requiring exact
// adjacency (or even "the nearest heading, however many blocks below") would
// have kept missing it; recording *both* the nearest heading's table (here,
// `linuxvm-gen1`) and, as a fallback, the section's own first qualifying
// table lets a caller ask for either name and get the same table. First
// table under an anchor wins either way: upstream puts at most one matching
// table per heading, and a second would be a shape change this file should
// not paper over.
//
// Shared by resource-class extraction and Xcode-version extraction (issue #211)
// rather than copied: "find the table under upstream's own anchor" is the join
// mechanism both rely on, and two copies of it would be two things to keep in
// step with the parser.
func tablesByAnchor(guide Guide, wanted func(*Table) bool) map[string]anchoredTable {
	out := map[string]anchoredTable{}
	record := func(anchor, label string, table *Table) {
		if _, seen := out[anchor]; !seen {
			out[anchor] = anchoredTable{table: table, label: label}
		}
	}
	for _, section := range guide.Sections {
		anchor := section.ID
		label := section.Title
		var sectionFirst *anchoredTable
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
			record(anchor, label, block.Table)
			if sectionFirst == nil {
				sectionFirst = &anchoredTable{table: block.Table, label: section.Title}
			}
		}
		// The section's own anchor resolves to whichever table came first in
		// its subtree, regardless of how many headings sit between the section
		// and it -- a no-op when the table was already the section's first
		// block (every environment but LinuxVM, both before and after this
		// fix), and the actual fix when it is not.
		if sectionFirst != nil {
			record(section.ID, section.Title, sectionFirst.table)
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
