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

package host_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

// projectBindingFixture is the fixture the whole feature exists for (issue #198): a
// checkout whose git remote — and therefore the slug the CircleCI CLI derives
// from it — says `flakey-todo-list`, while the project CircleCI actually has is
// `flaky-todo-list`. The repository was renamed; GitHub's permanent redirect
// keeps `git push` working, so the stale remote is invisible in daily use.
//
// Written in the exact shape `circleci project link` writes, taken from the CLI's
// own `internal/projectref/projectref.go` rather than from a sample.
const projectBindingFixture = `organization:
  id: 4ada2c32-f0c2-4b60-a6b8-af674858fd51
  name: example-org
project:
  id: 93d2dc11-7495-41a9-ad8c-4ce0773a9789
  slug: gh/example-org/flaky-todo-list
  name: flaky-todo-list
`

// writeBinding writes an info.yml into dir's `.circleci` directory and returns
// its path. Note what this is *not*: production code has no writer for this file
// at all, deliberately (see ProjectBinding's doc comment), so a test that wants
// one writes it itself.
func writeBinding(t *testing.T, dir, contents string) string {
	t.Helper()
	path := filepath.Join(dir, ".circleci", host.ProjectBindingFileName)
	writeFile(t, path, contents)
	return path
}

func TestLoadProjectBinding(t *testing.T) {
	tests := []struct {
		name string
		// contents is written to `.circleci/info.yml`; when write is false no
		// file is created at all.
		contents    string
		write       bool
		wantStatus  string
		wantSlug    string
		wantProject string
		wantOrgID   string
		// wantProblemPhrase must appear in Problem, for the malformed cases.
		wantProblemPhrase string
	}{
		{
			name: "a link-written file is read whole", write: true, contents: projectBindingFixture,
			wantStatus: host.ProjectBindingPresent,
			wantSlug:   "gh/example-org/flaky-todo-list",
			// The recorded ID, which is the half of this file that survives a
			// rename outright.
			wantProject: "93d2dc11-7495-41a9-ad8c-4ce0773a9789",
			wantOrgID:   "4ada2c32-f0c2-4b60-a6b8-af674858fd51",
		},
		{
			// Absence is never an error: most checkouts have never been linked,
			// and the constraint on this feature says so explicitly.
			name: "no file at all is absent, not an error", write: false,
			wantStatus: host.ProjectBindingAbsent,
		},
		{
			// The slug alone is enough. `circleci project link` records the IDs
			// only when it verified the slug against the API, so a file without
			// them is ordinary rather than broken.
			name: "IDs are optional", write: true,
			contents:   "project:\n  slug: gh/acme/web\n",
			wantStatus: host.ProjectBindingPresent,
			wantSlug:   "gh/acme/web",
		},
		{
			// Slug normalization applied to a hand-edited file. Every file the
			// CLI writes already uses the short spelling, so this is about
			// keeping one dialect in one process rather than about fixing the
			// CLI.
			name: "a long VCS spelling normalises like every other slug", write: true,
			contents:   "project:\n  slug: github/acme/web\n",
			wantStatus: host.ProjectBindingPresent,
			wantSlug:   "gh/acme/web",
		},
		{
			name: "a file that is not YAML is malformed, not absent", write: true,
			contents:          "project: [this is not\n  a mapping",
			wantStatus:        host.ProjectBindingMalformed,
			wantProblemPhrase: "not parseable as YAML",
		},
		{
			// The one field the CLI itself treats as required. Accepting a file
			// it would refuse is exactly the disagreement this feature exists to
			// prevent.
			name: "a file with no project.slug is malformed", write: true,
			contents:          "organization:\n  id: 4ada2c32-f0c2-4b60-a6b8-af674858fd51\n",
			wantStatus:        host.ProjectBindingMalformed,
			wantProblemPhrase: "no project.slug",
		},
		{
			name: "an empty file is malformed rather than treated as no binding", write: true,
			contents:          "",
			wantStatus:        host.ProjectBindingMalformed,
			wantProblemPhrase: "no project.slug",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, ".circleci", host.ProjectBindingFileName)
			if tc.write {
				writeBinding(t, dir, tc.contents)
			}

			got := host.LoadProjectBinding(path)

			assert.Equal(t, got.Status, tc.wantStatus)
			// Reported in every state, absence included: "we looked here and
			// there was nothing" is more useful than "there was nothing".
			assert.Equal(t, got.Path, path)
			assert.Equal(t, got.Slug(), tc.wantSlug)

			if tc.wantProblemPhrase != "" {
				assert.Assert(t, is.Contains(got.Problem, tc.wantProblemPhrase))
			} else {
				assert.Equal(t, got.Problem, "")
			}

			if tc.wantStatus == host.ProjectBindingPresent {
				assert.Equal(t, got.Binding.ProjectID, tc.wantProject)
				assert.Equal(t, got.Binding.OrganizationID, tc.wantOrgID)
			} else {
				assert.Assert(t, got.Binding == nil,
					"a binding that is not present must not carry a half-populated value")
			}
		})
	}
}

// TestLoadProjectBinding_UnreadableFile pins that something at that path which
// this host cannot read is malformed rather than absent — the distinction issue
// #198's constraint turns on, and the branch a parse failure does not reach.
//
// Two subtests, because no single failure mode is both portable and precise. The
// permission case is the one worth naming in a diagnostic and is Unix-only (POSIX
// mode bits do not deny reads on Windows, the same limitation
// internal/ai/keystore's 0600 test skips for). The directory case runs everywhere
// and is what keeps this branch covered on Windows at all.
func TestLoadProjectBinding_UnreadableFile(t *testing.T) {
	t.Run("permission denied", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("POSIX permission bits do not deny reads on windows")
		}
		if os.Geteuid() == 0 {
			t.Skip("running as root: a 0000 file is still readable")
		}

		dir := t.TempDir()
		path := writeBinding(t, dir, projectBindingFixture)
		assert.NilError(t, os.Chmod(path, 0o000))
		t.Cleanup(func() { _ = os.Chmod(path, 0o644) })

		got := host.LoadProjectBinding(path)

		assert.Equal(t, got.Status, host.ProjectBindingMalformed)
		assert.Assert(t, is.Contains(got.Problem, "permission denied"))
		assert.Assert(t, got.Binding == nil)
	})

	t.Run("a directory where the binding should be", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), ".circleci", host.ProjectBindingFileName)
		assert.NilError(t, os.MkdirAll(path, 0o755))

		got := host.LoadProjectBinding(path)

		// The Problem's exact wording is platform-dependent here (only Unix
		// reports "is a directory"), so what is pinned is what has to hold
		// everywhere: not absent, not silently usable, and it says something.
		assert.Equal(t, got.Status, host.ProjectBindingMalformed)
		assert.Assert(t, got.Problem != "")
		assert.Assert(t, got.Binding == nil)
	})
}

// TestProjectBinding_EffectiveSlug pins the CLI's own rule, guard included. The
// guard is the load-bearing part: `GET /api/v2/project/circleci/<orgID>/
// <projectID>` answers 404 for a classic VCS project even when both IDs are valid
// — verified against the live API — so the ID form is the right address for
// exactly one kind of project and a confident 404 for the rest.
func TestProjectBinding_EffectiveSlug(t *testing.T) {
	tests := []struct {
		name     string
		binding  host.ProjectBinding
		wantSlug string
	}{
		{
			name: "a CircleCI-native project is addressed by its IDs",
			binding: host.ProjectBinding{
				ProjectSlug:    "circleci/some-org/some-project",
				ProjectID:      "93d2dc11-7495-41a9-ad8c-4ce0773a9789",
				OrganizationID: "4ada2c32-f0c2-4b60-a6b8-af674858fd51",
			},
			wantSlug: "circleci/4ada2c32-f0c2-4b60-a6b8-af674858fd51/93d2dc11-7495-41a9-ad8c-4ce0773a9789",
		},
		{
			name: "a VCS project keeps its slug even though both IDs are known",
			binding: host.ProjectBinding{
				ProjectSlug:    "gh/example-org/flaky-todo-list",
				ProjectID:      "93d2dc11-7495-41a9-ad8c-4ce0773a9789",
				OrganizationID: "4ada2c32-f0c2-4b60-a6b8-af674858fd51",
			},
			wantSlug: "gh/example-org/flaky-todo-list",
		},
		{
			name: "a circleci/ slug missing the organization ID stays as recorded",
			binding: host.ProjectBinding{
				ProjectSlug: "circleci/some-org/some-project",
				ProjectID:   "93d2dc11-7495-41a9-ad8c-4ce0773a9789",
			},
			wantSlug: "circleci/some-org/some-project",
		},
		{
			name:     "nothing recorded yields nothing",
			binding:  host.ProjectBinding{},
			wantSlug: "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.binding.EffectiveSlug(), tc.wantSlug)
		})
	}
}

// TestProjectBindingPath pins where this host looks, which is deliberately not
// quite where the CLI looks: beside the config file that is open, so an explicit
// `--config` into another checkout reads *that* checkout's binding.
func TestProjectBindingPath(t *testing.T) {
	tests := []struct {
		name       string
		configPath string
		workDir    string
		wantPath   string
	}{
		{
			name:       "beside a config in a .circleci directory",
			configPath: filepath.Join("/repo", ".circleci", "config.yml"),
			workDir:    "/elsewhere",
			wantPath:   filepath.Join("/repo", ".circleci", "info.yml"),
		},
		{
			name:       "a continuation config one directory down still binds at .circleci",
			configPath: filepath.Join("/repo", ".circleci", "config.yml"),
			workDir:    "/repo",
			wantPath:   filepath.Join("/repo", ".circleci", "info.yml"),
		},
		{
			name: "an explicit config outside a .circleci directory falls back to the CLI's own anchor",
			// `--config ./generated.yml`: not a checkout layout this host can
			// reason about, so it asks where the CLI would.
			configPath: filepath.Join("/tmp", "generated.yml"),
			workDir:    "/repo",
			wantPath:   filepath.Join("/repo", ".circleci", "info.yml"),
		},
		{
			name:       "no config and no working directory yields nowhere to look",
			configPath: "",
			workDir:    "",
			wantPath:   "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, host.ProjectBindingPath(tc.configPath, tc.workDir), tc.wantPath)
		})
	}
}

// TestResolveProjectIdentity pins the precedence, which is the CLI's: the
// recorded binding beats the CLI-injected environment, because a binding survives
// a repository rename and a remote-derived slug does not.
func TestResolveProjectIdentity(t *testing.T) {
	presentBinding := func(slug, projectID, orgID string) host.ProjectBindingResult {
		return host.ProjectBindingResult{
			Status: host.ProjectBindingPresent,
			Path:   "/repo/.circleci/info.yml",
			Binding: &host.ProjectBinding{
				ProjectSlug:    slug,
				ProjectID:      projectID,
				OrganizationID: orgID,
			},
		}
	}

	tests := []struct {
		name          string
		vcsType       string
		org           string
		repo          string
		binding       host.ProjectBindingResult
		wantSlug      string
		wantSource    string
		wantOrgSlug   string
		wantDisagrees bool
	}{
		{
			// The reported case, resolved. The environment names the repository
			// under its old name; the binding names the project.
			name:    "the binding wins over a stale environment, and the disagreement is reported",
			vcsType: "github", org: "example-org", repo: "flakey-todo-list",
			binding:       presentBinding("gh/example-org/flaky-todo-list", fakeProjectUUID, fakeOrgUUID),
			wantSlug:      "gh/example-org/flaky-todo-list",
			wantSource:    host.ProjectIdentityFromBinding,
			wantOrgSlug:   "gh/example-org",
			wantDisagrees: true,
		},
		{
			// The ordinary case when launched through the CLI from the checkout
			// root: the CLI's own environment already derives from this same
			// file, so reading it here can only confirm what is already there.
			name:    "agreement is not a disagreement",
			vcsType: "github", org: "acme", repo: "web",
			binding:     presentBinding("gh/acme/web", fakeProjectUUID, fakeOrgUUID),
			wantSlug:    "gh/acme/web",
			wantSource:  host.ProjectIdentityFromBinding,
			wantOrgSlug: "gh/acme",
		},
		{
			name:    "no binding falls back to the injected environment",
			vcsType: "github", org: "acme", repo: "web",
			binding:     host.ProjectBindingResult{Status: host.ProjectBindingAbsent},
			wantSlug:    "gh/acme/web",
			wantSource:  host.ProjectIdentityFromEnvironment,
			wantOrgSlug: "gh/acme",
		},
		{
			// Falling back is right; falling back *silently* is not, which is
			// why the malformed status travels along for every caller that
			// renders this identity.
			name:    "a malformed binding falls back rather than blocking the editor",
			vcsType: "github", org: "acme", repo: "web",
			binding: host.ProjectBindingResult{
				Status:  host.ProjectBindingMalformed,
				Path:    "/repo/.circleci/info.yml",
				Problem: "The file is not parseable as YAML.",
			},
			wantSlug:    "gh/acme/web",
			wantSource:  host.ProjectIdentityFromEnvironment,
			wantOrgSlug: "gh/acme",
		},
		{
			// Not launched through the CLI at all: before this issue there was
			// no project, and the committed binding now answers.
			name:        "a binding alone is enough with no environment at all",
			binding:     presentBinding("gh/acme/web", fakeProjectUUID, fakeOrgUUID),
			wantSlug:    "gh/acme/web",
			wantSource:  host.ProjectIdentityFromBinding,
			wantOrgSlug: "gh/acme",
		},
		{
			// An ID-addressed slug's middle segment is an organization ID, not
			// part of any owner slug. Callers have OrganizationID for that.
			name: "an ID-addressed project yields no organization slug",
			binding: presentBinding(
				"circleci/some-org/some-project",
				"93d2dc11-7495-41a9-ad8c-4ce0773a9789",
				"4ada2c32-f0c2-4b60-a6b8-af674858fd51",
			),
			wantSlug:    "circleci/4ada2c32-f0c2-4b60-a6b8-af674858fd51/93d2dc11-7495-41a9-ad8c-4ce0773a9789",
			wantSource:  host.ProjectIdentityFromBinding,
			wantOrgSlug: "",
		},
		{
			name:        "nothing anywhere is a state, not a failure",
			binding:     host.ProjectBindingResult{Status: host.ProjectBindingAbsent},
			wantSlug:    "",
			wantSource:  "",
			wantOrgSlug: "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clearCircleEnv(t)
			t.Setenv("CIRCLE_VCS_TYPE", tc.vcsType)
			t.Setenv("CIRCLE_PROJECT_USERNAME", tc.org)
			t.Setenv("CIRCLE_PROJECT_REPONAME", tc.repo)

			got := host.ResolveProjectIdentity(host.LoadEnvironment(), tc.binding)

			assert.Equal(t, got.Slug, tc.wantSlug)
			assert.Equal(t, got.Source, tc.wantSource)
			assert.Equal(t, got.OrgSlug(), tc.wantOrgSlug)
			assert.Equal(t, got.Disagrees(), tc.wantDisagrees)
			// The loser is kept rather than discarded, so a disagreement can be
			// named on both sides.
			assert.Equal(t, got.EnvironmentSlug, host.LoadEnvironment().ProjectSlug())
		})
	}
}

// TestProjectBindingResult_Description pins that the three states do not read
// alike — the constraint issue #198 states outright, at the smallest surface it
// has.
func TestProjectBindingResult_Description(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".circleci", host.ProjectBindingFileName)

	absent := host.LoadProjectBinding(path).Description()

	writeBinding(t, dir, projectBindingFixture)
	present := host.LoadProjectBinding(path).Description()

	writeBinding(t, dir, "project: [not a mapping")
	malformed := host.LoadProjectBinding(path).Description()

	// All three name the file's purpose, since that is the point of naming it at
	// all rather than leaving it among unexplained other YAML.
	for _, description := range []string{absent, present, malformed} {
		assert.Assert(t, is.Contains(description, "circleci project link"))
	}

	assert.Assert(t, is.Contains(present, "gh/example-org/flaky-todo-list"))
	assert.Assert(t, is.Contains(present, "example-org"))

	assert.Assert(t, is.Contains(malformed, "could not use it"))
	assert.Assert(t, is.Contains(malformed, "not parseable as YAML"))

	assert.Assert(t, absent != present)
	assert.Assert(t, absent != malformed)
	assert.Assert(t, present != malformed)
}

// metaBindingBody is the decoded shape of GET /api/meta's project-identity half.
type metaBindingBody struct {
	ProjectSlug       string `json:"projectSlug"`
	ProjectSlugSource string `json:"projectSlugSource"`
	ProjectWebURL     string `json:"projectWebUrl"`
	ProjectBinding    struct {
		Status                   string `json:"status"`
		Path                     string `json:"path"`
		Slug                     string `json:"slug"`
		ProjectName              string `json:"projectName"`
		OrganizationName         string `json:"organizationName"`
		Problem                  string `json:"problem"`
		Description              string `json:"description"`
		DisagreesWithEnvironment bool   `json:"disagreesWithEnvironment"`
		EnvironmentSlug          string `json:"environmentSlug"`
	} `json:"projectBinding"`
}

// getMetaBinding fetches GET /api/meta and decodes its project-identity half.
func getMetaBinding(t *testing.T, ts *httptest.Server) metaBindingBody {
	t.Helper()

	status, body := doRequest(t, ts, http.MethodGet, "/api/meta", nil)
	assert.Equal(t, status, http.StatusOK)

	var got metaBindingBody
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	return got
}

// TestServer_Meta_PrefersRecordedBinding is issue #198's headline behaviour end to
// end: a checkout whose CLI-injected environment still names the pre-rename
// repository, and an `info.yml` that names the project. The binding wins, the
// source is reported, and the loser is named rather than discarded.
func TestServer_Meta_PrefersRecordedBinding(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, ".circleci", "config.yml"), "version: 2.1\n")
	bindingPath := writeBinding(t, dir, projectBindingFixture)

	clearCircleEnv(t)
	t.Setenv("CIRCLE_TOKEN", sentinelToken)
	t.Setenv("CIRCLE_VCS_TYPE", "github")
	t.Setenv("CIRCLE_PROJECT_USERNAME", "example-org")
	// The stale name, exactly as the reported checkout's remote had it.
	t.Setenv("CIRCLE_PROJECT_REPONAME", "flakey-todo-list")

	got := getMetaBinding(t, newTestServer(t, dir))

	assert.Equal(t, got.ProjectSlug, "gh/example-org/flaky-todo-list")
	assert.Equal(t, got.ProjectSlugSource, "binding")
	// The deep link follows the identity rather than the environment, so the top
	// bar cannot link to a repository that no longer exists under that name.
	assert.Equal(t, got.ProjectWebURL,
		"https://app.circleci.com/projects/gh/example-org/flaky-todo-list")

	assert.Equal(t, got.ProjectBinding.Status, "present")
	assert.Equal(t, got.ProjectBinding.Path, bindingPath)
	assert.Equal(t, got.ProjectBinding.Slug, "gh/example-org/flaky-todo-list")
	assert.Equal(t, got.ProjectBinding.ProjectName, "flaky-todo-list")
	assert.Equal(t, got.ProjectBinding.OrganizationName, "example-org")
	assert.Assert(t, got.ProjectBinding.DisagreesWithEnvironment)
	assert.Equal(t, got.ProjectBinding.EnvironmentSlug, "gh/example-org/flakey-todo-list")
}

// TestServer_Meta_BindingStates pins the three states on the wire, which is where
// the "must not render identically" constraint actually has to hold: a client
// keys off `status`, so absence and unreadability cannot collapse into each other
// no matter how the UI is written.
func TestServer_Meta_BindingStates(t *testing.T) {
	tests := []struct {
		name string
		// contents is written to `.circleci/info.yml`; empty means no file.
		contents       string
		wantStatus     string
		wantSlug       string
		wantSource     string
		wantProblemHas string
	}{
		{
			// The ordinary case, and never an error: most checkouts have never
			// been linked.
			name:       "absent falls through to the environment without complaint",
			wantStatus: "absent", wantSlug: "gh/acme/web", wantSource: "environment",
		},
		{
			name:     "present supersedes the environment",
			contents: "project:\n  slug: gh/acme/renamed\n",
			// No `disagreesWithEnvironment` assertion here; the dedicated test
			// above covers it.
			wantStatus: "present", wantSlug: "gh/acme/renamed", wantSource: "binding",
		},
		{
			// The editor keeps working -- but it says so, which is the whole
			// point. A silent fallback here would be indistinguishable from
			// success.
			name:       "malformed falls back and says so",
			contents:   "project: [not a mapping",
			wantStatus: "malformed", wantSlug: "gh/acme/web", wantSource: "environment",
			wantProblemHas: "not parseable as YAML",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			writeFile(t, filepath.Join(dir, ".circleci", "config.yml"), "version: 2.1\n")
			if tc.contents != "" {
				writeBinding(t, dir, tc.contents)
			}

			clearCircleEnv(t)
			t.Setenv("CIRCLE_VCS_TYPE", "github")
			t.Setenv("CIRCLE_PROJECT_USERNAME", "acme")
			t.Setenv("CIRCLE_PROJECT_REPONAME", "web")

			got := getMetaBinding(t, newTestServer(t, dir))

			assert.Equal(t, got.ProjectBinding.Status, tc.wantStatus)
			assert.Equal(t, got.ProjectSlug, tc.wantSlug)
			assert.Equal(t, got.ProjectSlugSource, tc.wantSource)
			assert.Assert(t, got.ProjectBinding.Description != "",
				"every state must describe itself; a client shows this verbatim")

			if tc.wantProblemHas != "" {
				assert.Assert(t, is.Contains(got.ProjectBinding.Problem, tc.wantProblemHas))
			} else {
				assert.Equal(t, got.ProjectBinding.Problem, "")
			}
		})
	}
}

// TestServer_Meta_BindingAloneNamesTheProject: the editor run *outside* the
// CircleCI CLI has no CIRCLE_* variables at all, so before this issue it had no
// project. The committed binding answers, which is the second of the two cases
// that make reading this file ourselves worth doing.
func TestServer_Meta_BindingAloneNamesTheProject(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, ".circleci", "config.yml"), "version: 2.1\n")
	writeBinding(t, dir, projectBindingFixture)

	clearCircleEnv(t)

	got := getMetaBinding(t, newTestServer(t, dir))

	assert.Equal(t, got.ProjectSlug, "gh/example-org/flaky-todo-list")
	assert.Equal(t, got.ProjectSlugSource, "binding")
	// Nothing to disagree with, which is not the same as agreement.
	assert.Equal(t, got.ProjectBinding.DisagreesWithEnvironment, false)
	assert.Equal(t, got.ProjectBinding.EnvironmentSlug, "")
}

// TestServer_Meta_BindingIsNeverWritten is the constraint as a test. Absence must
// stay absence: nothing in this host may create `.circleci/info.yml`, and a
// request that reads the binding is the one place a bug could.
func TestServer_Meta_BindingIsNeverWritten(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, ".circleci", "config.yml"), "version: 2.1\n")
	bindingPath := filepath.Join(dir, ".circleci", host.ProjectBindingFileName)

	clearCircleEnv(t)
	t.Setenv("CIRCLE_VCS_TYPE", "github")
	t.Setenv("CIRCLE_PROJECT_USERNAME", "acme")
	t.Setenv("CIRCLE_PROJECT_REPONAME", "web")

	ts := newTestServer(t, dir)
	getMetaBinding(t, ts)
	doRequest(t, ts, http.MethodGet, "/api/config-files", nil)
	// A save is the one request that legitimately writes, so it is the one most
	// worth checking does not write *this*.
	status, _ := doRequest(t, ts, http.MethodPut, "/api/config",
		[]byte(`{"contents":"version: 2.1\n"}`))
	assert.Equal(t, status, http.StatusOK)

	_, err := os.Stat(bindingPath)
	assert.Assert(t, os.IsNotExist(err), "this host created a project binding: %v", err)
}

// TestServer_ConfigFiles_NamesTheProjectBinding is issue #198's item 4: the
// classifier is right that `info.yml` is not a config, and leaving it at that
// listed a meaningful file among unexplained other YAML.
func TestServer_ConfigFiles_NamesTheProjectBinding(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, ".circleci", "config.yml"), "version: 2.1\n")
	writeBinding(t, dir, projectBindingFixture)
	// A nested `info.yml` binds nothing -- the CLI only ever reads the one beside
	// `config.yml` -- so it must not be labelled as the binding.
	writeFile(t, filepath.Join(dir, ".circleci", "nested", host.ProjectBindingFileName),
		projectBindingFixture)

	clearCircleEnv(t)
	ts := newTestServer(t, dir)

	status, body := doRequest(t, ts, http.MethodGet, "/api/config-files", nil)
	assert.Equal(t, status, http.StatusOK)

	var got struct {
		Files []struct {
			RelPath          string `json:"relPath"`
			IsConfig         bool   `json:"isConfig"`
			ConfigReason     string `json:"configReason"`
			KnownRole        string `json:"knownRole"`
			KnownRoleSummary string `json:"knownRoleSummary"`
		} `json:"files"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &got))
	assert.Equal(t, len(got.Files), 3)

	byPath := map[string]int{}
	for i, file := range got.Files {
		byPath[file.RelPath] = i
	}

	binding := got.Files[byPath["info.yml"]]
	// Still not a config, and still hidden by default because of that: naming the
	// file is layered on top of the classifier rather than overriding it, so the
	// switcher never offers to open a binding in a config editor.
	assert.Equal(t, binding.IsConfig, false)
	assert.Assert(t, is.Contains(binding.ConfigReason, "No CircleCI structure"))
	assert.Equal(t, binding.KnownRole, "projectBinding")
	assert.Assert(t, is.Contains(binding.KnownRoleSummary, "circleci project link"))
	assert.Assert(t, is.Contains(binding.KnownRoleSummary, "gh/example-org/flaky-todo-list"))

	nested := got.Files[byPath["nested/info.yml"]]
	assert.Equal(t, nested.IsConfig, false)
	assert.Equal(t, nested.KnownRole, "",
		"only the binding beside config.yml binds anything")

	config := got.Files[byPath["config.yml"]]
	assert.Equal(t, config.IsConfig, true)
	assert.Equal(t, config.KnownRole, "")
}
