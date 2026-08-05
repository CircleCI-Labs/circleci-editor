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
	is "gotest.tools/v3/assert/cmp"
)

// wantResourceClasses is what this project claims to offer, per executor
// environment, spelled out in full.
//
// **This is the test issue #181 asks for**: it fails the moment the vendored
// resource tables and the classes this editor offers disagree, which is the only
// thing standing between "derived from CircleCI's own tables" and "a slower
// literal". Because the offered list is *computed* from the tables rather than
// retyped from them, the two can only disagree in one direction -- upstream
// changed -- and the failure is the prompt to look.
//
// When `task guides:refresh` brings in a genuinely changed table, update this
// map and say so in the changelog. Do not update it to match a shape change you
// have not read: a class disappearing here means it disappeared from CircleCI's
// documentation, which is a fact worth noticing rather than a test to silence.
//
// Checked against the tables as vendored at circleci-docs 447dc483.
var wantResourceClasses = map[string][]string{
	// Docker, from docker-resource-table.adoc.
	"x86": {"small", "medium", "medium+", "large", "xlarge", "2xlarge", "2xlarge+"},
	// Docker gen2, from docker-gen2-resource-table.adoc.
	"x86-gen2": {"small.gen2", "medium.gen2", "medium+.gen2", "large.gen2", "xlarge.gen2", "2xlarge.gen2", "2xlarge+.gen2"},
	// Docker on Arm, from docker-arm-resource-table.adoc -- the four classes
	// issue #181 was opened because the editor offered none of.
	"arm": {"arm.medium", "arm.large", "arm.xlarge", "arm.2xlarge"},
	// Linux VM, from machine-resource-table.adoc. Note `2xlarge+`, which the old
	// hand-written machine list also lacked, and the absence of `small`/`medium+`,
	// which Docker has and the machine executor does not.
	"linuxvm-execution-environment": {"medium", "large", "xlarge", "2xlarge", "2xlarge+"},
	// Linux VM gen2, from machine-gen2-resource-table.adoc.
	"linuxvm-gen2-execution-environment": {"medium.gen2", "large.gen2", "xlarge.gen2", "2xlarge.gen2", "2xlarge+.gen2"},
	// Arm VM, from arm-resource-table.adoc -- `arm.xlarge`/`arm.2xlarge` are the
	// "larger ARM sizes" the issue reports missing.
	"arm-execution-environment-linux": {"arm.medium", "arm.large", "arm.xlarge", "arm.2xlarge"},
	// Windows, from windows-resource-table.adoc.
	"windows-execution-environment": {"windows.medium", "windows.large", "windows.xlarge", "windows.2xlarge"},
	// GPU on Linux, from gpu-linux-resource-table.adoc. The old hand-written GPU
	// list had neither `.gen2` nor either `.multi` class.
	"gpu-execution-environment-linux": {
		"gpu.nvidia.small", "gpu.nvidia.small.gen2", "gpu.nvidia.small.multi",
		"gpu.nvidia.medium.multi", "gpu.nvidia.medium", "gpu.nvidia.large",
	},
	// GPU on Windows, from gpu-windows-resource-table.adoc.
	"gpu-execution-environment-windows": {"windows.gpu.nvidia.medium"},
	// macOS, from macos-resource-table.adoc. Upstream no longer documents the
	// `macos.m1.medium.gen1`/`macos.x86.medium.gen2` classes this editor was
	// still offering.
	"macos-execution-environment": {"m4pro.medium", "m4pro.large"},
}

func classNames(classes []ResourceClass) []string {
	out := make([]string, 0, len(classes))
	for _, class := range classes {
		out = append(out, class.Name)
	}
	return out
}

func environmentsByID(environments []ResourceClassEnvironment) map[string]ResourceClassEnvironment {
	out := make(map[string]ResourceClassEnvironment, len(environments))
	for _, env := range environments {
		out[env.ID] = env
	}
	return out
}

// TestResourceClassesFromVendoredSnapshot is the drift check: every environment
// this project offers, extracted from the vendored tables, against
// wantResourceClasses.
func TestResourceClassesFromVendoredSnapshot(t *testing.T) {
	t.Parallel()

	environments, err := EmbeddedResourceClasses()
	assert.NilError(t, err)
	assert.Assert(t, is.Len(environments, len(wantResourceClasses)))

	byID := environmentsByID(environments)
	for id, want := range wantResourceClasses {
		env, ok := byID[id]
		assert.Assert(t, ok, "no environment extracted for %q", id)
		assert.DeepEqual(t, classNames(env.Classes), want)
	}
}

// TestResourceClassEnvironmentsCoverEveryExecutorKind pins that all three of
// CircleCI's native executor keys get classes. A refresh that quietly dropped
// the macOS table would otherwise leave that card with nothing but free text.
func TestResourceClassEnvironmentsCoverEveryExecutorKind(t *testing.T) {
	t.Parallel()

	environments, err := EmbeddedResourceClasses()
	assert.NilError(t, err)

	byKind := map[string]int{}
	for _, env := range environments {
		assert.Assert(t, len(env.Classes) > 0, "%s has no classes", env.ID)
		byKind[env.Kind]++
	}
	assert.Equal(t, byKind[KindDocker], 3)
	assert.Equal(t, byKind[KindMachine], 6)
	assert.Equal(t, byKind[KindMacOS], 1)
}

// TestResourceClassEnvironmentLabelsComeFromUpstream checks that the option-group
// labels a picker shows are CircleCI's own headings rather than wording invented
// here -- the property that lets the UI say "x86 (gen2)" without this project
// deciding what to call a compute generation.
func TestResourceClassEnvironmentLabelsComeFromUpstream(t *testing.T) {
	t.Parallel()

	environments, err := EmbeddedResourceClasses()
	assert.NilError(t, err)
	byID := environmentsByID(environments)

	assert.Equal(t, byID["x86"].Label, "x86")
	assert.Equal(t, byID["x86-gen2"].Label, "x86 (gen2)")
	assert.Equal(t, byID["arm"].Label, "Arm")
	assert.Equal(t, byID["linuxvm-execution-environment"].Label, "LinuxVM execution environment")
	assert.Equal(t, byID["arm-execution-environment-linux"].Label, "Arm VM execution environment")
	assert.Equal(t, byID["macos-execution-environment"].Label, "macOS execution environment")
}

// TestEveryResourceEnvironmentAnchorResolves validates the one thing this
// package hardcodes: the section anchors resourceEnvironments joins executor
// kinds to. Each must be an anchor the configuration reference really defines --
// which is what makes an anchor a safer join key than a heading's wording, and
// what makes a disappeared anchor a loud extraction failure rather than a
// quietly missing environment.
func TestEveryResourceEnvironmentAnchorResolves(t *testing.T) {
	t.Parallel()

	parsed, err := ParseSnapshot()
	assert.NilError(t, err)
	guide := findGuideByID(parsed, ResourceClassGuideID)
	assert.Assert(t, guide != nil)

	for _, def := range resourceEnvironments {
		_, known := guide.Anchors[def.anchor]
		assert.Assert(t, known, "%q is not an anchor in the configuration reference", def.anchor)
		assert.Assert(t, def.kind == KindDocker || def.kind == KindMachine || def.kind == KindMacOS, "%q has kind %q", def.anchor, def.kind)
	}
}

// TestArchitectureIsDerivedFromTheClassName is the architecture axis: computed
// from the name CircleCI writes, because `resource_class: arm.medium` is the
// only place the architecture appears. There is no `architecture:` config key,
// and no second hand-written map here to fall out of date.
func TestArchitectureIsDerivedFromTheClassName(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name string
		kind string
		want string
	}{
		{"medium", KindDocker, ArchX86},
		{"2xlarge+", KindDocker, ArchX86},
		{"xlarge.gen2", KindDocker, ArchX86},
		{"arm.medium", KindDocker, ArchArm},
		{"arm.2xlarge", KindMachine, ArchArm},
		{"windows.large", KindMachine, ArchX86},
		{"gpu.nvidia.small", KindMachine, ArchX86},
		// No `arm` segment anywhere: a Windows GPU class is x86, and a
		// substring test would have to be careful not to say otherwise.
		{"windows.gpu.nvidia.medium", KindMachine, ArchX86},
		// A whole segment, not a prefix: this must not read as Arm.
		{"alarm.medium", KindDocker, ArchX86},
		// macOS states no architecture in its own table, and this file does not
		// invent one -- see ArchUnstated.
		{"m4pro.medium", KindMacOS, ArchUnstated},
	} {
		assert.Equal(t, classArchitecture(tc.name, tc.kind), tc.want, "class=%s kind=%s", tc.name, tc.kind)
	}
}

// TestGenerationIsDerivedFromTheClassName pins issue #181's gen2 question: gen2
// *is* expressible in a `resource_class` value, as a `.gen2` suffix, so it is
// offered as ordinary classes rather than behind a control that would change
// nothing.
func TestGenerationIsDerivedFromTheClassName(t *testing.T) {
	t.Parallel()

	assert.Equal(t, classGeneration("xlarge"), GenerationGen1)
	assert.Equal(t, classGeneration("arm.medium"), GenerationGen1)
	assert.Equal(t, classGeneration("xlarge.gen2"), GenerationGen2)
	assert.Equal(t, classGeneration("2xlarge+.gen2"), GenerationGen2)
	assert.Equal(t, classGeneration("gpu.nvidia.small.gen2"), GenerationGen2)
	// `.gen1` is not a spelling CircleCI uses on any current class, but reading
	// it as gen1 rather than as "unknown" is the right answer if it returns.
	assert.Equal(t, classGeneration("macos.m1.medium.gen1"), GenerationGen1)
}

// TestBothArchitecturesAreOfferedForDockerAndMachine is the reported defect,
// stated as an assertion: Docker offers Arm classes, and the machine executor
// offers the larger Arm sizes.
func TestBothArchitecturesAreOfferedForDockerAndMachine(t *testing.T) {
	t.Parallel()

	environments, err := EmbeddedResourceClasses()
	assert.NilError(t, err)

	architectures := map[string]map[string]bool{}
	for _, env := range environments {
		for _, class := range env.Classes {
			if architectures[env.Kind] == nil {
				architectures[env.Kind] = map[string]bool{}
			}
			architectures[env.Kind][class.Architecture] = true
		}
	}
	// Both kinds span both architectures, which is what makes an architecture
	// filter meaningful for them and only them.
	assert.Assert(t, architectures[KindDocker][ArchArm])
	assert.Assert(t, architectures[KindDocker][ArchX86])
	assert.Assert(t, architectures[KindMachine][ArchArm])
	assert.Assert(t, architectures[KindMachine][ArchX86])
	// macOS states neither, so a filter there would be theatre.
	assert.DeepEqual(t, architectures[KindMacOS], map[string]bool{ArchUnstated: true})
}

// TestDefaultResourceClassesComeFromTheTables checks the "(default)" marker
// upstream writes beside a class survives extraction as a flag rather than
// becoming part of the class name.
func TestDefaultResourceClassesComeFromTheTables(t *testing.T) {
	t.Parallel()

	environments, err := EmbeddedResourceClasses()
	assert.NilError(t, err)
	byID := environmentsByID(environments)

	defaults := map[string]string{}
	for _, env := range environments {
		for _, class := range env.Classes {
			if class.Default {
				defaults[env.ID] = class.Name
			}
		}
	}
	assert.Equal(t, defaults["windows-execution-environment"], "windows.medium")
	assert.Equal(t, defaults["arm-execution-environment-linux"], "arm.medium")
	// The name is the code span, so the marker never leaks into it.
	assert.Equal(t, byID["arm-execution-environment-linux"].Classes[0].Name, "arm.medium")
}

// TestResourceClassSpecsComeFromTheTableColumns checks the tooltip text is
// assembled from the table's own columns, and that the cloud/server
// availability columns are left out of it (see availabilityColumns).
func TestResourceClassSpecsComeFromTheTableColumns(t *testing.T) {
	t.Parallel()

	environments, err := EmbeddedResourceClasses()
	assert.NilError(t, err)
	byID := environmentsByID(environments)

	assert.Equal(t, byID["x86"].Classes[0].Spec, "vCPUs 1, RAM 2GB")
	assert.Equal(t, byID["arm-execution-environment-linux"].Classes[0].Spec, "vCPUs 2, RAM 8GB, Disk Size 100 GB")
	for _, env := range environments {
		for _, class := range env.Classes {
			assert.Assert(t, !strings.Contains(class.Spec, "Cloud"), "%s: %q", class.Name, class.Spec)
			assert.Assert(t, !strings.Contains(class.Spec, "Server"), "%s: %q", class.Name, class.Spec)
		}
	}
}

// TestExtractResourceClassesRejectsAShapeChange covers the fallback trigger: an
// upstream table that no longer leads with a `Class` column, or a section whose
// anchor has gone, must fail extraction rather than yield a short list. All-or-
// nothing, so the UI has one thing to say rather than nine accurate cards and
// one silently stale one.
func TestExtractResourceClassesRejectsAShapeChange(t *testing.T) {
	t.Parallel()

	t.Run("a renamed first column", func(t *testing.T) {
		t.Parallel()
		parsed := parsedSnapshotWithReplacement(t, "| Class | vCPUs | RAM | Cloud | Server", "| Size | vCPUs | RAM | Cloud | Server")
		_, err := ExtractResourceClasses(parsed)
		assert.ErrorContains(t, err, "no longer has a resource-class table")
	})

	t.Run("a removed section anchor", func(t *testing.T) {
		t.Parallel()
		parsed := parsedSnapshotWithReplacement(t, "[#arm-execution-environment-linux]", "[#arm-vm-execution-environment]")
		_, err := ExtractResourceClasses(parsed)
		assert.ErrorContains(t, err, "arm-execution-environment-linux")
	})

	t.Run("a class cell with no code span", func(t *testing.T) {
		t.Parallel()
		parsed := parsedSnapshotWithReplacement(t, "| `windows.gpu.nvidia.medium`", "| windows.gpu.nvidia.medium")
		_, err := ExtractResourceClasses(parsed)
		assert.ErrorContains(t, err, "could not be read")
	})

	t.Run("the guide itself missing", func(t *testing.T) {
		t.Parallel()
		_, err := ExtractResourceClasses(nil)
		assert.ErrorContains(t, err, "is not available")
	})
}

// TestResourceClassesFallsBackToTheEmbeddedSnapshot is the honest-degradation
// path: when the documentation currently in memory cannot be read, the result is
// the embedded snapshot's list, flagged as not derived, with a reason a UI can
// show. Never an empty list, and never a stale list presented as current.
func TestResourceClassesFallsBackToTheEmbeddedSnapshot(t *testing.T) {
	t.Parallel()

	embedded, err := EmbeddedResourceClasses()
	assert.NilError(t, err)

	result := ResourceClasses(nil)
	assert.Assert(t, !result.Derived)
	assert.Assert(t, strings.Contains(result.Reason, "embedded in this release"), "reason=%q", result.Reason)
	assert.DeepEqual(t, result.Environments, embedded)

	// And the ordinary path reports itself as derived, with no reason to show.
	parsed, err := ParseSnapshot()
	assert.NilError(t, err)
	ok := ResourceClasses(parsed)
	assert.Assert(t, ok.Derived)
	assert.Equal(t, ok.Reason, "")
	assert.DeepEqual(t, ok.Environments, embedded)
}

// TestResourceClassEnvironmentOrderIsUpstreamDocumentOrder pins the order a
// picker lists environments in: CircleCI's own, so a reader who knows the
// configuration reference finds the groups where they expect them.
func TestResourceClassEnvironmentOrderIsUpstreamDocumentOrder(t *testing.T) {
	t.Parallel()

	environments, err := EmbeddedResourceClasses()
	assert.NilError(t, err)

	ids := make([]string, 0, len(environments))
	for _, env := range environments {
		ids = append(ids, env.ID)
	}
	assert.DeepEqual(t, ids, []string{
		"x86", "x86-gen2", "arm",
		"linuxvm-execution-environment", "linuxvm-gen2-execution-environment",
		"arm-execution-environment-linux",
		"windows-execution-environment",
		"gpu-execution-environment-linux", "gpu-execution-environment-windows",
		"macos-execution-environment",
	})
}

// parsedSnapshotWithReplacement re-parses the vendored snapshot with one
// substring replaced everywhere it occurs, so a test can ask what happens when
// upstream changes a table's shape without touching the checksum-enforced
// snapshot on disk (which VerifySnapshot would rightly fail on).
func parsedSnapshotWithReplacement(t *testing.T, old, replacement string) []Guide {
	t.Helper()

	files, err := snapshotFiles()
	assert.NilError(t, err)
	replaced := 0
	for name, data := range files {
		text := string(data)
		if !strings.Contains(text, old) {
			continue
		}
		replaced += strings.Count(text, old)
		files[name] = []byte(strings.ReplaceAll(text, old, replacement))
	}
	// A test that silently replaced nothing would pass for the wrong reason.
	assert.Assert(t, replaced > 0, "%q does not occur in the snapshot", old)

	parsed, err := ParseFiles(files)
	assert.NilError(t, err)
	return parsed
}
