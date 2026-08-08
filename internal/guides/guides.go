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

// Package guides serves prose configuration documentation inside the editor,
// parsed from AsciiDoc source into a small block model the app renders with
// its own components (issue #104, widened by #176).
//
// Two kinds of guide, and the distinction is load-bearing:
//
//   - **CircleCI's own documentation** (OriginCircleCI), vendored byte-for-byte
//     from circleci/circleci-docs. Twenty pages, selected by one rule the owner
//     gave: *include a page if it describes something you type in the config
//     file.* See Sources.
//   - **This editor's own documentation** (OriginEditor), authored in this
//     repository under editor/ and embedded alongside the vendored snapshot.
//     It is about the tool, not about CircleCI, and both the model and the pane
//     say so, so nobody mistakes it for official documentation.
//
// # Which upstream pages, and which are excluded on purpose
//
// Over half of circleci-docs is archived or server-admin content: 429 of its
// 811 .adoc files, 3.3 MB, including ten separate versions of the same
// server-admin pages. Vendoring that would make a search for "caching" answer
// with server-admin-4.7, and would degrade the AI grounding in #137 for the
// same reason. So it is excluded *explicitly* -- see ExcludedPathReason, which
// FetchAll applies to every include target and which TestSnapshotExcludes...
// applies to the snapshot itself. Excluding by omission would last exactly
// until the first person writes a glob.
//
// # Provenance and licensing
//
// The AsciiDoc under snapshot/ -- and *only* under snapshot/ -- is vendored
// byte-for-byte from https://github.com/circleci/circleci-docs, the live source
// of circleci.com/docs. (editor/ is this project's own writing, under this
// project's own MIT licence, and is deliberately outside the snapshot so the
// manifest's "these bytes are CircleCI's, unmodified" claim stays exactly
// true.) That repository has **no LICENSE file** and an empty
// `license` field in package.json (verified: `gh api
// repos/circleci/circleci-docs/license` returns 404). Use here rests on an
// explicit grant from this repository's owner, a CircleCI employee, recorded
// in CONTRIBUTING.md's third-party attributions. A request to CircleCI to
// publish a licence on that repository remains open; a verbal grant
// unblocks *this* tool and nobody else's.
//
// Every vendored file is recorded in snapshot/manifest.json with the upstream
// commit SHA it came from and its SHA-256, and TestSnapshotChecksums fails if
// any file drifts from its recorded digest. So the snapshot is auditable
// ("exactly which bytes did you take, from where?") and refreshable without
// guesswork.
//
// # Why the AsciiDoc source, not the rendered HTML
//
// Scraping circleci.com/docs would break on any site redesign, and an
// <iframe> is impossible outright (`X-Frame-Options: SAMEORIGIN`, verified).
// The AsciiDoc source is structured, stable, and diffable, and parsing it
// into a block model (see model.go) means the pane matches this app's own
// light/dark theme instead of importing the docs site's CSS.
//
// # Freshness: vendored floor plus a background TTL refresh
//
// A vendored snapshot alone goes stale between releases; a fetch on every
// launch wastes network and makes a *reference pane* depend on connectivity.
// This package does both, in the only order that degrades well (see Cache):
// the embedded snapshot is the floor, always parseable with no network and no
// token, and a background refresh replaces it with newer upstream AsciiDoc
// when the cached copy is older than refreshTTL. Reads never block on the
// network.
//
// # Refreshing the vendored snapshot
//
//	task guides:refresh    # rewrites snapshot/ and its manifest
//	go test ./internal/guides/...
//
// snapshot/manifest.json is the only place the upstream commit SHA is
// recorded, so nothing else needs updating by hand. The refresh follows
// every `include::` in *every* upstream entry page to a fixed point, so a
// page that grows a new partial upstream picks it up automatically.
//
// The same FetchAll drives both `task guides:refresh` and Cache's seven-day
// background refresh, and both derive their work list from UpstreamSources().
// That is not an incidental sharing of code: it is what makes adding a page to
// Sources sufficient, and what stops a widened snapshot quietly becoming
// nineteen frozen copies and one that updates. TestRefreshCoversEveryUpstream
// Source pins it (issue #176).
//
// # The image index: wider than the snapshot, on purpose
//
// A citation naming an image asset is remapped to the docs page that shows
// it (see citations.go, issue #156), but Guide.Images only ever knows the
// images on the twenty pages above -- Sources' selection rule is about what
// this pane *shows*, not about which pages have pictures. `task guides:
// refresh-image-index` (see imageindex.go and imageindex_build.go) builds a
// separate, much smaller artifact -- a basename to URL map with no prose in
// it at all -- covering every page circleci-docs publishes, and
// CitationResolver.AddImageIndex layers it in as a fallback. It is
// deliberately a *different* command from guides:refresh, run on its own
// schedule: widening which images a citation can resolve against is not the
// same decision as re-vendoring prose, and must not require it.
package guides

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"
	"time"
)

// snapshotFS is the vendored AsciiDoc, embedded at build time so the pane
// works with no network and no token -- the property the schema-derived
// reference already has and that this must not give up.
//
//go:embed snapshot
var snapshotFS embed.FS

// snapshotRoot is snapshotFS's single top-level directory.
const snapshotRoot = "snapshot"

// manifestName is the provenance record's filename inside the snapshot.
const manifestName = "manifest.json"

// UpstreamRepo is the repository the snapshot is taken from, named in
// CONTRIBUTING.md's third-party attributions and surfaced to the UI so the
// pane can always say where its text came from.
const UpstreamRepo = "circleci/circleci-docs"

// Manifest is snapshot/manifest.json: the provenance record for the vendored
// AsciiDoc. It is written by the refresh tool and read at startup.
type Manifest struct {
	// Repo is the upstream repository, e.g. "circleci/circleci-docs".
	Repo string `json:"repo"`
	// Ref is the branch Commit was resolved from -- always DefaultBranch
	// today (circleci/circleci-docs publishes no tags or releases; verified
	// against its GitHub API, issue #286). Recorded explicitly rather than
	// left implicit in code, so the manifest itself says which moving target
	// Commit was pinned from, not just that it was pinned from *something*.
	Ref string `json:"ref"`
	// Commit is the full upstream commit SHA every file was fetched at, so
	// the snapshot corresponds to one consistent point in upstream history
	// rather than to whatever each file happened to be when it was fetched.
	Commit string `json:"commit"`
	// CommittedAt is that commit's own timestamp upstream -- the honest
	// answer to "how old is this text?", as opposed to when it was vendored.
	CommittedAt time.Time `json:"committedAt"`
	// VendoredAt is when the refresh tool ran.
	VendoredAt time.Time `json:"vendoredAt"`
	// Files maps each vendored file's path *within the snapshot directory*
	// (which mirrors its path in the upstream repository) to its SHA-256.
	Files map[string]string `json:"files"`
}

// Origin says who wrote a guide, which is the difference between "CircleCI
// says this" and "this tool says this". It is carried all the way to the pane
// (Guide.Origin, mirrored in web/src/lib/guides/types.ts) because presenting
// this project's own writing as though it were official documentation would be
// dishonest, and because the two have different licences.
type Origin string

const (
	// OriginCircleCI is a page vendored from circleci/circleci-docs and
	// refreshed from upstream. Its licensing rests on the explicit grant
	// recorded in CONTRIBUTING.md's third-party attributions.
	OriginCircleCI Origin = "circleci"
	// OriginEditor is documentation this project wrote about this editor. It
	// lives in editor/, is MIT like the rest of this repository, is never
	// fetched, and never appears in the snapshot manifest.
	OriginEditor Origin = "editor"
)

// SourceDef defines one guide: its stable ID, where its AsciiDoc comes from,
// and how the pane files it.
//
// These are declared here, in Go, rather than discovered by globbing upstream,
// because "which pages belong in this pane" is a product decision that must not
// change silently when upstream reorganises its content tree -- and because a
// glob is exactly how 429 archived and server-admin pages would arrive.
type SourceDef struct {
	// ID is this project's stable identifier, used in persisted UI state and
	// tests. It never changes once shipped, even if upstream renames the page.
	ID string
	// Label is what the pane's guide picker shows. Short on purpose: it sits in
	// a dropdown next to nineteen others.
	Label string
	// Category groups the picker. Chosen so a reader who does not know
	// CircleCI's information architecture can still find the page from the
	// editor feature that raised their question.
	Category string
	// Origin is OriginCircleCI or OriginEditor; see Origin.
	Origin Origin
	// Component, Module and Page are the upstream Antora coordinates, set for
	// OriginCircleCI only.
	Component string
	Module    string
	Page      string
	// File is the filename under editor/, set for OriginEditor only.
	File string
}

// Categories, in the order the picker lists them.
const (
	categoryReference  = "Configuration reference"
	categoryParameters = "Pipeline values and parameters"
	categoryWorkflows  = "Workflows"
	categoryCaching    = "Caching and workspaces"
	categoryContexts   = "Contexts and environment variables"
	categoryPolicies   = "Config policies"
	categoryExecutors  = "Executors and images"
	categoryOrbs       = "Orbs"
	categoryDynamic    = "Dynamic config"
	categoryEditor     = "This editor"
)

// Sources is the set of guides this package serves, in the order the pane lists
// them.
//
// The selection rule is the owner's own, and it is a good one: **include a page
// if it describes something you type in the config file.** Everything here
// answers a question the editor itself raises -- the inspector's `context:`
// field, the DAG's `requires:`, the image picker's resource classes, the orb
// browser -- and each group below names that feature. Pages about what happens
// *after* a config runs (test splitting, artifacts, insights) are deliberately
// absent; this editor's own scope boundary already puts observation in the
// web UI, not here.
//
// The configuration reference stays first: the owner's framing is that it is
// "the Bible on what can and cannot happen in a CircleCI config", and it is
// also the guide the schema-derived key browser joins against
// (CONFIGURATION_REFERENCE_ID). This editor's own documentation comes last, so
// the pane opens on CircleCI's words rather than on ours.
//
// Deliberate exclusions with their reasoning -- scheduled pipelines, org
// policy administration, and the whole of archive/ and server-admin-* -- are in
// issue #176; ExcludedPathReason enforces the last of those.
var Sources = []SourceDef{
	// The reference pair, unchanged from #104.
	{
		ID:        "configuration-reference",
		Label:     "Configuration reference",
		Category:  categoryReference,
		Origin:    OriginCircleCI,
		Component: "reference",
		Module:    "ROOT",
		Page:      "configuration-reference",
	},
	{
		ID:        "reusing-config",
		Label:     "Reusable config",
		Category:  categoryReference,
		Origin:    OriginCircleCI,
		Component: "reference",
		Module:    "ROOT",
		Page:      "reusing-config",
	},

	// Pipeline values and parameters: the owner's specific ask. `<< >>` syntax
	// and `pipeline.git.branch` are typed directly into the config and are the
	// single most common thing this editor cannot autocomplete for you.
	{
		ID:        "pipeline-variables",
		Label:     "Pipeline values and parameters",
		Category:  categoryParameters,
		Origin:    OriginCircleCI,
		Component: "guides",
		Module:    "orchestrate",
		Page:      "pipeline-variables",
	},
	{
		ID:        "selecting-a-workflow-with-parameters",
		Label:     "Selecting a workflow with parameters",
		Category:  categoryParameters,
		Origin:    OriginCircleCI,
		Component: "guides",
		Module:    "orchestrate",
		Page:      "selecting-a-workflow-to-run-using-pipeline-parameters",
	},

	// Workflows: what the DAG pane and the inspector edit constantly --
	// `requires`, branch and tag filters, `type: approval`.
	{
		ID:        "workflows",
		Label:     "Workflows",
		Category:  categoryWorkflows,
		Origin:    OriginCircleCI,
		Component: "guides",
		Module:    "orchestrate",
		Page:      "workflows",
	},
	{
		ID:        "matrix-jobs",
		Label:     "Matrix jobs",
		Category:  categoryWorkflows,
		Origin:    OriginCircleCI,
		Component: "guides",
		Module:    "orchestrate",
		Page:      "using-matrix-jobs",
	},

	// Caching and workspaces: the most misunderstood config area, and the
	// source of the image citation in #156/#171.
	{
		ID:        "caching",
		Label:     "Caching dependencies",
		Category:  categoryCaching,
		Origin:    OriginCircleCI,
		Component: "guides",
		Module:    "optimize",
		Page:      "caching",
	},
	{
		ID:        "persist-data",
		Label:     "Persisting data",
		Category:  categoryCaching,
		Origin:    OriginCircleCI,
		Component: "guides",
		Module:    "optimize",
		Page:      "persist-data",
	},
	{
		ID:        "workspaces",
		Label:     "Workspaces",
		Category:  categoryCaching,
		Origin:    OriginCircleCI,
		Component: "guides",
		Module:    "orchestrate",
		Page:      "workspaces",
	},

	// Contexts and environment variables: pairs with the project-context
	// palette (#105) and the inspector's `context:` combobox (#58). env-vars
	// carries the precedence order, which is where people get burned.
	{
		ID:        "contexts",
		Label:     "Contexts",
		Category:  categoryContexts,
		Origin:    OriginCircleCI,
		Component: "guides",
		Module:    "security",
		Page:      "contexts",
	},
	{
		ID:        "env-vars",
		Label:     "Environment variables",
		Category:  categoryContexts,
		Origin:    OriginCircleCI,
		Component: "guides",
		Module:    "security",
		Page:      "env-vars",
	},

	// Config policies (issue #247): the owner's ask -- "what config policies
	// are, from our documentation" -- once the decision UI (#215) gave people
	// a reason to want it. This is the one page from upstream's dedicated
	// config-policies module that survives the selection rule's own
	// extension for this issue: "pages describing what you write and how
	// policies evaluate it" (the selection rule above was "what you type in
	// the config file" alone, which a governing document about that config is
	// a natural reading of, but which excludes administering the policies
	// themselves). The overview page states what config policies are, how the
	// decision engine works, and the exact decision shape this editor's own
	// PolicyStrip renders (`status`, `enabled_rules`, `hard_failures`,
	// `soft_failures`) -- so it corroborates the wire format already verified
	// against the live decision endpoint (see internal/circleci/policy_test.go)
	// rather than merely explaining a concept.
	//
	// Deliberately excluded, unchanged from the selection rule's "org policy
	// administration, not config authoring": config-policy-reference.adoc
	// (a Rego helper-function reference for people *writing* policies),
	// create-and-manage-config-policies.adoc, test-config-policies.adoc,
	// use-the-cli-for-config-and-policy-development.adoc,
	// manage-contexts-with-config-policies.adoc, and
	// config-policies-for-self-hosted-runner.adoc. Every one of those is
	// written for an organization admin authoring a policy bundle, not for
	// the person authoring the config those policies evaluate -- exactly the
	// distinction the rule draws.
	{
		ID:        "config-policies",
		Label:     "Config policies",
		Category:  categoryPolicies,
		Origin:    OriginCircleCI,
		Component: "guides",
		Module:    "config-policies",
		Page:      "config-policy-management-overview",
	},

	// Executors and images: pairs with the image picker (#77) and the
	// resource-class field (#153).
	{
		ID:        "using-docker",
		Label:     "Docker executor",
		Category:  categoryExecutors,
		Origin:    OriginCircleCI,
		Component: "guides",
		Module:    "execution-managed",
		Page:      "using-docker",
	},
	{
		ID:        "using-macos",
		Label:     "macOS executor",
		Category:  categoryExecutors,
		Origin:    OriginCircleCI,
		Component: "guides",
		Module:    "execution-managed",
		Page:      "using-macos",
	},
	{
		ID:        "using-windows",
		Label:     "Windows executor",
		Category:  categoryExecutors,
		Origin:    OriginCircleCI,
		Component: "guides",
		Module:    "execution-managed",
		Page:      "using-windows",
	},
	{
		ID:        "remote-docker",
		Label:     "Remote Docker",
		Category:  categoryExecutors,
		Origin:    OriginCircleCI,
		Component: "guides",
		Module:    "execution-managed",
		Page:      "building-docker-images",
	},
	{
		ID:        "docker-layer-caching",
		Label:     "Docker layer caching",
		Category:  categoryExecutors,
		Origin:    OriginCircleCI,
		Component: "guides",
		Module:    "optimize",
		Page:      "docker-layer-caching",
	},

	// Orbs: pairs with the orb browser, and is the on-ramp to reusable config
	// (#78/#79).
	{
		ID:        "orb-intro",
		Label:     "Orbs introduction",
		Category:  categoryOrbs,
		Origin:    OriginCircleCI,
		Component: "orbs",
		Module:    "use",
		Page:      "orb-intro",
	},
	{
		ID:        "orb-concepts",
		Label:     "Orb concepts",
		Category:  categoryOrbs,
		Origin:    OriginCircleCI,
		Component: "orbs",
		Module:    "use",
		Page:      "orb-concepts",
	},

	// Both dynamic-config pages, at the owner's explicit request ("Both dynamic
	// config docs are actually helpful"). They do not contradict each other and
	// they are not duplicates: dynamic-config.adoc is titled "Dynamic
	// configuration overview" and links to the other as "the Using Dynamic
	// Configuration how-to guide"; using-dynamic-configuration.adoc opens by
	// saying it "assumes you have already read" the overview. So the overview
	// is ordered first, matching the reading order upstream itself prescribes.
	{
		ID:        "dynamic-config",
		Label:     "Dynamic config overview",
		Category:  categoryDynamic,
		Origin:    OriginCircleCI,
		Component: "guides",
		Module:    "orchestrate",
		Page:      "dynamic-config",
	},
	{
		ID:        "using-dynamic-config",
		Label:     "Using dynamic config",
		Category:  categoryDynamic,
		Origin:    OriginCircleCI,
		Component: "guides",
		Module:    "orchestrate",
		Page:      "using-dynamic-configuration",
	},

	// This editor's own documentation (#176). Last, and in its own category, so
	// the pane never opens on our words where a reader expected CircleCI's.
	{
		ID:       "using-this-editor",
		Label:    "Using this editor",
		Category: categoryEditor,
		Origin:   OriginEditor,
		File:     "using-this-editor.adoc",
	},
	{
		ID:       "editor-limits",
		Label:    "Limits and known gaps",
		Category: categoryEditor,
		Origin:   OriginEditor,
		File:     "editor-limits.adoc",
	},
}

// UpstreamSources is the subset of Sources vendored from circleci-docs: the
// work list for both `task guides:refresh` and Cache's background refresh.
//
// Every caller that touches the network goes through this, so "which pages does
// a refresh cover?" has exactly one answer and it is the same list the pane
// serves.
func UpstreamSources() []SourceDef {
	out := make([]SourceDef, 0, len(Sources))
	for _, src := range Sources {
		if src.Origin == OriginCircleCI {
			out = append(out, src)
		}
	}
	return out
}

// editorRoot is editorFS's single top-level directory.
const editorRoot = "editor"

// editorFS is this project's own documentation about this editor -- our
// writing, our MIT licence, deliberately *not* under snapshot/ so the
// snapshot's provenance claim covers only CircleCI's bytes.
//
//go:embed editor
var editorFS embed.FS

// editorDocsURL is where this editor's own documentation lives outside the app,
// used as the guide URL in place of a circleci.com one. Pointing at the source
// of the very text being displayed is the honest answer to "where is this
// from?" -- and it keeps the pane from ever implying that a page we wrote is
// published on circleci.com.
const editorDocsURL = "https://github.com/CircleCI-Labs/circleci-editor/blob/main/internal/guides/editor"

// entryPath returns the upstream repository path of an OriginCircleCI guide's
// entry page. It is meaningless for OriginEditor and returns "".
func (s SourceDef) entryPath() string {
	if s.Origin != OriginCircleCI {
		return ""
	}
	return resourceID{component: s.Component, module: s.Module, family: "page", relpath: s.Page + ".adoc"}.repoPath()
}

// URL returns the guide's canonical URL: the published circleci.com page for
// CircleCI's documentation, and this repository for our own.
func (s SourceDef) URL() string {
	if s.Origin == OriginEditor {
		return editorDocsURL + "/" + s.File
	}
	return resourceID{component: s.Component, module: s.Module, family: "page", relpath: s.Page + ".adoc"}.pageURL()
}

// ExcludedPathReason returns a human-readable reason when repoPath is upstream
// content this project must never vendor, or "" when the path is acceptable.
//
// Two rules, both measured against circleci-docs at 447dc483 rather than
// guessed at. Together they cover 429 of the corpus's 811 .adoc files and 3.3
// of its 6.1 MB:
//
//   - Anything under an `archive/` directory. Upstream keeps superseded pages
//     there -- including the old scheduled-workflow syntax a user must *not*
//     copy into a config, which is precisely the harm of serving it.
//   - Anything in a `server-admin*` component. There are ten near-identical
//     versions (4.2 through 4.10, plus 4.1 under archive/), so a search for
//     "caching" would answer with an installation guide for a CircleCI Server
//     release the reader is not running.
//
// This is a *predicate*, applied by FetchAll to every include target and by
// TestSnapshotExcludesArchivedAndServerAdminContent to the snapshot itself,
// rather than a set of paths merely left out of Sources. Leaving them out by
// omission would hold only until the first person writes a glob -- and issue
// #176 called that out as the trap to avoid.
func ExcludedPathReason(repoPath string) string {
	for _, segment := range strings.Split(repoPath, "/") {
		switch {
		case segment == "archive":
			return "under archive/: superseded upstream content, which includes config syntax a user must not copy"
		// Exactly `server-admin`, or `server-admin-<version>` -- the two shapes
		// upstream actually uses (`docs/server-admin-4.10/...` and
		// `archive/server 4.1/server-admin/...`). Deliberately not a bare
		// prefix test: that would also swallow a hypothetical
		// `server-administration-overview.adoc`, which is an ordinary guide
		// page. A test caught exactly that, which is why the rule is spelled
		// out rather than approximated.
		case segment == "server-admin", strings.HasPrefix(segment, "server-admin-"):
			return "a server-admin component: ten near-identical versions that would drown config-authoring answers"
		}
	}
	return ""
}

// LoadManifest reads the embedded snapshot's provenance record.
func LoadManifest() (Manifest, error) {
	data, err := snapshotFS.ReadFile(path.Join(snapshotRoot, manifestName))
	if err != nil {
		return Manifest{}, fmt.Errorf("guides: read snapshot manifest: %w", err)
	}
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return Manifest{}, fmt.Errorf("guides: parse snapshot manifest: %w", err)
	}
	return m, nil
}

// snapshotFiles reads every vendored AsciiDoc/example file (i.e. everything
// but the manifest) keyed by its upstream repository path.
func snapshotFiles() (map[string][]byte, error) {
	out := map[string][]byte{}
	err := fs.WalkDir(snapshotFS, snapshotRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel := strings.TrimPrefix(p, snapshotRoot+"/")
		if rel == manifestName {
			return nil
		}
		data, readErr := snapshotFS.ReadFile(p)
		if readErr != nil {
			return readErr
		}
		out[rel] = data
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("guides: walk snapshot: %w", err)
	}
	return out, nil
}

// ParseSnapshot parses the embedded snapshot -- plus this project's own
// embedded editor documentation -- into the served guides. It needs no network,
// no token and no filesystem beyond the binary itself.
func ParseSnapshot() ([]Guide, error) {
	files, err := snapshotFiles()
	if err != nil {
		return nil, err
	}
	return ParseFiles(files)
}

// ParseFiles parses a set of upstream AsciiDoc files -- keyed by upstream
// repository path -- into the served guides, splicing this editor's own
// documentation in at the positions Sources gives it. It is the single parse
// path for both the embedded snapshot and a freshly-fetched refresh, so there
// is no chance of the two rendering differently, and the editor's own pages are
// present either way rather than disappearing the first time a refresh lands.
//
// A guide whose entry page is missing from files is omitted rather than
// erroring: nineteen working guides plus a picker that simply lacks the
// twentieth beats twenty broken ones. Having *no* upstream guide at all is an
// error, because at that point the caller has nothing of CircleCI's to render
// and must say so instead of showing only our own two pages as if the pane had
// loaded.
func ParseFiles(files map[string][]byte) ([]Guide, error) {
	resolve := func(repoPath string) ([]byte, error) {
		data, ok := files[repoPath]
		if !ok {
			return nil, fmt.Errorf("guides: %s is not in this snapshot", repoPath)
		}
		return data, nil
	}

	out := make([]Guide, 0, len(Sources))
	upstream := 0
	for _, src := range Sources {
		var guide Guide
		switch src.Origin {
		case OriginEditor:
			parsed, err := parseEditorGuide(src)
			if err != nil {
				// Our own embedded file failing to parse is a build defect, not
				// a degradation the user can do anything about, but it must
				// still not take CircleCI's twenty pages down with it.
				continue
			}
			guide = parsed
		case OriginCircleCI:
			source, ok := files[src.entryPath()]
			if !ok {
				continue
			}
			guide = parseGuide(src.ID, src.Component, src.Module, src.Page, "", source, resolve)
			upstream++
		}
		guide.Origin = src.Origin
		guide.Category = src.Category
		guide.Title = firstNonEmpty(guide.Title, src.Label)
		out = append(out, guide)
	}
	if upstream == 0 {
		return nil, fmt.Errorf("guides: no CircleCI guide entry page found among %d files", len(files))
	}
	return out, nil
}

// parseEditorGuide parses one of this project's own pages out of editorFS.
//
// It runs through exactly the same parser as CircleCI's AsciiDoc, which is the
// point: our documentation renders with the same components, the same theme and
// the same in-pane cross-references, so the pane has one reading experience
// rather than two. What differs is the URL -- there is no circleci.com page for
// a page we wrote, so section links point at this repository instead.
func parseEditorGuide(src SourceDef) (Guide, error) {
	source, err := editorFS.ReadFile(path.Join(editorRoot, src.File))
	if err != nil {
		return Guide{}, fmt.Errorf("guides: read editor doc %s: %w", src.File, err)
	}
	// No include resolver: our own pages have no `include::` directives, and
	// giving them one would invite a dependency on upstream partials that the
	// manifest does not cover.
	resolve := func(repoPath string) ([]byte, error) {
		return nil, fmt.Errorf("guides: editor documentation does not include %s", repoPath)
	}
	guide := parseGuide(src.ID, "guides", "ROOT", strings.TrimSuffix(src.File, ".adoc"), src.URL(), source, resolve)
	return guide, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// VerifySnapshot checks every vendored file against the SHA-256 recorded in
// the manifest, and that the manifest lists exactly the files present. It
// exists so an accidental local edit -- or a partial refresh -- fails a test
// rather than silently changing what this project claims to be redistributing.
func VerifySnapshot() error {
	manifest, err := LoadManifest()
	if err != nil {
		return err
	}
	files, err := snapshotFiles()
	if err != nil {
		return err
	}

	var missing, unexpected []string
	for name := range manifest.Files {
		if _, ok := files[name]; !ok {
			missing = append(missing, name)
		}
	}
	for name, data := range files {
		want, ok := manifest.Files[name]
		if !ok {
			unexpected = append(unexpected, name)
			continue
		}
		got := hex.EncodeToString(sha256Sum(data))
		if got != want {
			return fmt.Errorf("guides: %s has sha256 %s, manifest records %s", name, got, want)
		}
	}
	sort.Strings(missing)
	sort.Strings(unexpected)
	if len(missing) > 0 {
		return fmt.Errorf("guides: manifest lists files not present in the snapshot: %v", missing)
	}
	if len(unexpected) > 0 {
		return fmt.Errorf("guides: snapshot contains files the manifest does not list: %v", unexpected)
	}
	return nil
}

func sha256Sum(data []byte) []byte {
	sum := sha256.Sum256(data)
	return sum[:]
}
