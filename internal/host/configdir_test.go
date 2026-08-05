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
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

// maxIndexedFileBytesForTest mirrors configdir.go's unexported
// maxIndexedFileBytes (2 MiB). This suite is host_test (black box) by
// convention with the rest of the package, so the value can't be imported;
// it is duplicated here instead. If the production constant ever changes,
// the fixtures sized against this constant stop being "one byte over the
// real cap" and the tests that depend on that would fail loudly (rejecting
// data that should now be accepted, or vice versa) rather than silently
// passing regardless of where the real cap sits.
const maxIndexedFileBytesForTest = 2 << 20

// symlink creates a symbolic link at linkPath pointing at target, failing
// the test immediately if the platform or filesystem can't create one --
// every case here is exercising containment logic that has nothing to say
// about a platform that lacks symlinks at all.
func symlink(t *testing.T, target, linkPath string) {
	t.Helper()
	assert.NilError(t, os.MkdirAll(filepath.Dir(linkPath), 0o755))
	assert.NilError(t, os.Symlink(target, linkPath))
}

func writeFile(t *testing.T, path, contents string) {
	t.Helper()
	assert.NilError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	assert.NilError(t, os.WriteFile(path, []byte(contents), 0o644))
}

// gossFixture is a realistic goss.yaml -- the file the owner actually saw
// the switcher list as a CircleCI config (issue #135), written with goss's
// own top-level blocks: `file`, `package`, `service`, `port`, `command`,
// `process`.
//
// The singular `command:` is the whole point of this fixture. CircleCI's
// key is `commands:`, and plural-vs-singular is the only thing separating
// the two, so any prefix/substring matching on key names would classify
// every goss file in every `.circleci` directory as a CircleCI config.
const gossFixture = `file:
  /etc/passwd:
    exists: true
    mode: "0644"
    owner: root
    group: root
    filetype: file
package:
  curl:
    installed: true
    versions:
      - 7.88.1
service:
  sshd:
    enabled: true
    running: true
port:
  tcp:22:
    listening: true
    ip:
      - 0.0.0.0
command:
  echo hello:
    exit-status: 0
    stdout:
      - hello
    stderr: []
    timeout: 10000
process:
  sshd:
    running: true
`

// continuationFixture is a continuation config of the kind a setup
// workflow selects: real jobs and workflows, but no `version:` at all, so
// it is legitimately not independently valid (issue #106). Rule 2 exists
// precisely so this still classifies as a config.
const continuationFixture = `jobs:
  build:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
      - run: make build
workflows:
  build-and-test:
    jobs:
      - build
`

func TestClassifyConfigContents(t *testing.T) {
	tests := []struct {
		name     string
		contents string
		isConfig bool
		// reasonContains, when non-empty, is asserted against the reason the
		// host would put on the API payload -- the UI shows that string
		// verbatim, so it is part of the behaviour, not an internal detail.
		reasonContains string
	}{
		{
			name:           "a realistic goss.yaml is not a config, despite its top-level command:",
			contents:       gossFixture,
			isConfig:       false,
			reasonContains: "No CircleCI structure",
		},
		{
			// Issue #198 item 4 asked for this to be verified rather than
			// assumed, and it holds for the reason the rule was designed to
			// hold: `organization:` and `project:` are neither a recognised
			// `version:` nor any of the structural keys, and no name-based
			// special case is needed to reach that verdict.
			//
			// The file still gets *named* rather than merely excluded -- see
			// configFileEntry.KnownRole -- which is a separate mechanism layered
			// on top of this one, deliberately: teaching the classifier that
			// `info.yml` is a config would make the switcher offer to open a
			// binding in a config editor.
			name:           "circleci project link's info.yml is not a CircleCI config",
			contents:       projectBindingFixture,
			isConfig:       false,
			reasonContains: "No CircleCI structure",
		},
		{
			name:     "a continuation config with jobs/workflows but no version is a config",
			contents: continuationFixture,
			isConfig: true,
		},
		{
			name:     "a sparse setup config is a config on version alone",
			contents: "version: 2.1\nsetup: true\n",
			isConfig: true,
		},
		{name: "version 2.1 unquoted (parses as a float)", contents: "version: 2.1\n", isConfig: true},
		{name: "version 2.1 quoted (parses as a string)", contents: "version: \"2.1\"\n", isConfig: true},
		{name: "version 2.0", contents: "version: 2.0\n", isConfig: true},
		{name: "version 2 as an int", contents: "version: 2\n", isConfig: true},
		{
			name:           "an unrelated version value does not qualify",
			contents:       "version: 3\nfoo: bar\n",
			isConfig:       false,
			reasonContains: "No CircleCI structure",
		},
		{name: "orbs alone", contents: "orbs:\n  node: circleci/node@5.1.0\n", isConfig: true},
		{name: "executors alone", contents: "executors:\n  linux:\n    docker:\n      - image: cimg/base:current\n", isConfig: true},
		{name: "commands alone (plural -- CircleCI's own key)", contents: "commands:\n  greet:\n    steps:\n      - run: echo hi\n", isConfig: true},
		// Issue #220: `job-groups` is a documented top-level key that the
		// vendored schema defines, and this list did not know it. A fragment
		// whose only CircleCI key is `job-groups:` was classified as "not a
		// config", and the user-visible reason enumerated the key list
		// verbatim -- so it also told the user `job-groups` was not a
		// CircleCI key.
		{
			name:     "job-groups alone qualifies: it is a documented top-level key",
			contents: "job-groups:\n  deploy-and-release:\n    jobs:\n      - deploy\n      - release:\n          requires:\n            - deploy\n",
			isConfig: true,
		},
		{
			name:     "a full config using job-groups and serial-group qualifies",
			contents: "version: 2.1\njob-groups:\n  smoke:\n    jobs:\n      - smoke-test\njobs:\n  smoke-test:\n    type: no-op\nworkflows:\n  main:\n    jobs:\n      - smoke:\n          serial-group: org/smoke\n",
			isConfig: true,
		},
		{name: "a quoted top-level key still matches", contents: "\"jobs\": {}\n", isConfig: true},
		{
			name:           "parameters alone is too generic to qualify",
			contents:       "parameters:\n  vars:\n    - a\n",
			isConfig:       false,
			reasonContains: "No CircleCI structure",
		},
		{
			name:           "a GitHub Actions workflow is ruled out by on: alongside jobs:",
			contents:       "name: CI\non:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n",
			isConfig:       false,
			reasonContains: "GitHub Actions",
		},
		{
			name:           "a v2-era docker-compose file is ruled out despite version: 2.1",
			contents:       "version: \"2.1\"\nservices:\n  db:\n    image: postgres:16\n",
			isConfig:       false,
			reasonContains: "Docker Compose",
		},
		{
			name:     "a config that itself defines services under a job still qualifies",
			contents: "version: 2.1\nservices: {}\njobs:\n  build:\n    docker:\n      - image: cimg/base:current\n",
			isConfig: true,
		},
		{
			name:           "malformed YAML is simply not a config",
			contents:       "version: 2.1\njobs: [unclosed\n",
			isConfig:       false,
			reasonContains: "Not parseable as YAML",
		},
		{
			name:           "tabs where YAML forbids them are not a config either",
			contents:       "jobs:\n\tbuild: {}\n",
			isConfig:       false,
			reasonContains: "Not parseable as YAML",
		},
		{name: "an empty file is not a config", contents: "", isConfig: false, reasonContains: "empty"},
		{name: "a whitespace-only file is not a config", contents: "\n  \n", isConfig: false, reasonContains: "empty"},
		{
			name:           "a comments-only file is not a config",
			contents:       "# nothing here yet\n",
			isConfig:       false,
			reasonContains: "not a YAML mapping",
		},
		{
			name:           "a top-level sequence is not a config",
			contents:       "- one\n- two\n",
			isConfig:       false,
			reasonContains: "not a YAML mapping",
		},
		{
			name:           "a bare scalar is not a config",
			contents:       "just a string\n",
			isConfig:       false,
			reasonContains: "not a YAML mapping",
		},
		{
			name:     "duplicate keys are tolerated rather than rejected",
			contents: "version: 2.1\nversion: 2.1\n",
			isConfig: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := host.ClassifyConfigContents(tc.contents)
			assert.Equal(t, got.IsConfig, tc.isConfig, "reason was: %s", got.Reason)
			assert.Assert(t, got.Reason != "", "every classification must carry a reason")
			if tc.reasonContains != "" {
				assert.Assert(t, is.Contains(got.Reason, tc.reasonContains))
			}
		})
	}
}

func TestListConfigDir(t *testing.T) {
	t.Run("nonexistent directory returns empty, no error", func(t *testing.T) {
		entries, err := host.ListConfigDir(filepath.Join(t.TempDir(), "nope"))
		assert.NilError(t, err)
		assert.Equal(t, len(entries), 0)
	})

	t.Run("finds yml and yaml, ignores other extensions and the write-temp glob", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "config.yml"), "version: 2.1\n")
		writeFile(t, filepath.Join(dir, "continue-config.yml"), "version: 2.1\n")
		writeFile(t, filepath.Join(dir, "setup.yaml"), "setup: true\n")
		writeFile(t, filepath.Join(dir, "README.md"), "not a config\n")
		// A ConfigFile.Write-style temp file must never be indexed -- it is
		// mid-write scratch, not a config a user could open.
		writeFile(t, filepath.Join(dir, ".config-abc123.yml.tmp"), "partial\n")
		// A nested directory (e.g. a project that keeps setup + continuation
		// configs in a subfolder) is walked too -- issue #106 asks for
		// `.circleci/**/*.yml`, not just the top level.
		writeFile(t, filepath.Join(dir, "nested", "extra.yml"), "version: 2.1\n")

		entries, err := host.ListConfigDir(dir)
		assert.NilError(t, err)

		relPaths := make([]string, 0, len(entries))
		for _, e := range entries {
			relPaths = append(relPaths, e.RelPath)
			assert.Assert(t, filepath.IsAbs(e.Path))
		}
		assert.DeepEqual(t, relPaths, []string{
			"config.yml",
			"continue-config.yml",
			"nested/extra.yml",
			"setup.yaml",
		})
	})

	// Classification (issue #135) is metadata on GET /api/config-files, not
	// a filter on the walk: ListConfigDir is also the allowlist
	// resolveIndexedPath enforces, so a file it stopped reporting could not
	// be opened even deliberately.
	t.Run("still lists YAML that is not a CircleCI config", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "config.yml"), "version: 2.1\n")
		writeFile(t, filepath.Join(dir, "goss.yaml"), gossFixture)

		entries, err := host.ListConfigDir(dir)
		assert.NilError(t, err)
		assert.Equal(t, len(entries), 2)
		assert.Equal(t, entries[1].RelPath, "goss.yaml")
	})

	t.Run("reports accurate sizes", func(t *testing.T) {
		dir := t.TempDir()
		const contents = "version: 2.1\njobs: {}\n"
		writeFile(t, filepath.Join(dir, "config.yml"), contents)

		entries, err := host.ListConfigDir(dir)
		assert.NilError(t, err)
		assert.Equal(t, len(entries), 1)
		assert.Equal(t, entries[0].Size, int64(len(contents)))
	})

	// The five subtests below are the symlink coverage this listing lacked
	// entirely before the fix for the local-file-disclosure report: a
	// `.circleci/evil.yml` symlinked to any locally-readable file used to be
	// walked, listed, and served exactly like a real config, because the
	// only containment check applied was lexical (Clean + HasPrefix on the
	// symlink's own path), never on where the symlink actually pointed.
	// filepath.WalkDir's documented default only ever keeps a *directory*
	// symlink from being descended into; a symlinked *file* is walked like
	// any other entry, which is exactly the gap ListConfigDir's own doc
	// comment used to (wrongly) claim didn't exist.

	relPathsOf := func(entries []host.ConfigDirEntry) []string {
		rel := make([]string, 0, len(entries))
		for _, e := range entries {
			rel = append(rel, e.RelPath)
		}
		return rel
	}

	t.Run("excludes a symlinked file whose target is outside dir", func(t *testing.T) {
		outsideDir := t.TempDir()
		secretPath := filepath.Join(outsideDir, "secret.yml")
		writeFile(t, secretPath, "top-secret: outside-the-repo\n")

		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "config.yml"), "version: 2.1\n")
		symlink(t, secretPath, filepath.Join(dir, "evil.yml"))

		entries, err := host.ListConfigDir(dir)
		assert.NilError(t, err)
		// The escaping symlink must be absent from the listing entirely --
		// not merely present-but-unreadable -- because this listing doubles
		// as resolveIndexedPath's allowlist: anything reported here can be
		// opened via ?path=, deliberately or not.
		assert.DeepEqual(t, relPathsOf(entries), []string{"config.yml"})
	})

	t.Run("includes a symlinked file whose target is inside dir", func(t *testing.T) {
		dir := t.TempDir()
		const contents = "version: 2.1\njobs: {}\n"
		writeFile(t, filepath.Join(dir, "config.yml"), contents)
		symlink(t, filepath.Join(dir, "config.yml"), filepath.Join(dir, "alias.yml"))

		entries, err := host.ListConfigDir(dir)
		assert.NilError(t, err)
		assert.DeepEqual(t, relPathsOf(entries), []string{"alias.yml", "config.yml"})

		var alias host.ConfigDirEntry
		for _, e := range entries {
			if e.RelPath == "alias.yml" {
				alias = e
			}
		}
		// The target's real size, not the symlink's own (an Lstat on a
		// symlink reports the length of the link text, not its target).
		assert.Equal(t, alias.Size, int64(len(contents)))
	})

	t.Run("excludes a symlink to a directory, even one named like a YAML file", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "config.yml"), "version: 2.1\n")
		realDir := filepath.Join(dir, "real-subdir")
		assert.NilError(t, os.MkdirAll(realDir, 0o755))
		symlink(t, realDir, filepath.Join(dir, "dirlink.yml"))

		entries, err := host.ListConfigDir(dir)
		assert.NilError(t, err)
		assert.DeepEqual(t, relPathsOf(entries), []string{"config.yml"})
	})

	t.Run("excludes a broken symlink", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "config.yml"), "version: 2.1\n")
		symlink(t, filepath.Join(dir, "does-not-exist.yml"), filepath.Join(dir, "broken.yml"))

		entries, err := host.ListConfigDir(dir)
		assert.NilError(t, err)
		assert.DeepEqual(t, relPathsOf(entries), []string{"config.yml"})
	})

	t.Run("excludes a symlinked directory's contents, not just the link itself", func(t *testing.T) {
		// Belt-and-suspenders on the *directory* half of the symlink
		// story, which was already safe before this fix (WalkDir's real
		// default): a `.circleci/escape` symlinked to an outside directory
		// must not have its contents indexed either.
		outsideDir := t.TempDir()
		writeFile(t, filepath.Join(outsideDir, "secret.yml"), "top-secret: outside-the-repo\n")

		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "config.yml"), "version: 2.1\n")
		symlink(t, outsideDir, filepath.Join(dir, "escape"))

		entries, err := host.ListConfigDir(dir)
		assert.NilError(t, err)
		assert.DeepEqual(t, relPathsOf(entries), []string{"config.yml"})
	})
}

// TestServer_ConfigFiles_PathTraversalRejected exercises resolveIndexedPath
// (unexported) indirectly through the one HTTP boundary that calls it --
// GET/PUT /api/config?path=... -- since that boundary, not the helper
// itself, is what a hostile or buggy client actually has to get past.
func TestServer_ConfigFiles_PathTraversalRejected(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, ".circleci", "config.yml"), "version: 2.1\n")
	writeFile(t, filepath.Join(dir, ".circleci", "continue-config.yml"), "version: 2.1\njobs: {}\n")

	// A sibling file outside .circleci entirely -- must never be reachable
	// via ?path=, however it's spelled.
	writeFile(t, filepath.Join(dir, "secret.yml"), "top-secret: true\n")

	ts := newTestServer(t, dir)

	tests := []struct {
		name string
		path string
	}{
		{name: "escape via ..", path: "../secret.yml"},
		{name: "absolute path outside the indexed dir", path: filepath.Join(dir, "secret.yml")},
		{name: "file that exists but was never indexed (wrong extension)", path: filepath.Join(dir, ".circleci", "config.yml.bak")},
		{name: "a path that simply does not exist", path: filepath.Join(dir, ".circleci", "nope.yml")},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			status, body := doRequest(t, ts, "GET", "/api/config?path="+tc.path, nil)
			assert.Equal(t, status, 400, body)
			assert.Assert(t, is.Contains(body, `"error"`))
		})
	}
}

// TestServer_ConfigFiles_SymlinkEscapeIsNotDisclosed reproduces the
// disclosure the fix closes, at the one boundary an attacker actually
// reaches: `.circleci/evil.yml` symlinked to a file outside the repo used to
// be walked, listed by GET /api/config-files, and served byte-for-byte by
// GET /api/config?path=, because the containment check both endpoints
// ultimately rely on (resolveIndexedPath, via ListConfigDir's own allowlist)
// only ever looked at the symlink's own lexical path.
//
// Both endpoints are checked, deliberately: the report that opened this
// issue is explicit that either one alone -- the listing, or the direct
// read -- is a hole on its own, since the AI pane's directory-context
// assembler drives the listing with ?contents=1 and the file switcher drives
// the direct read.
func TestServer_ConfigFiles_SymlinkEscapeIsNotDisclosed(t *testing.T) {
	outsideDir := t.TempDir()
	secretPath := filepath.Join(outsideDir, "secret.yml")
	const secret = "SECRET_OUTSIDE_THE_REPO"
	writeFile(t, secretPath, secret+"\n")

	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, ".circleci", "config.yml"), "version: 2.1\n")
	evilPath := filepath.Join(dir, ".circleci", "evil.yml")
	symlink(t, secretPath, evilPath)

	ts := newTestServer(t, dir)

	status, body := doRequest(t, ts, "GET", "/api/config-files?contents=1", nil)
	assert.Equal(t, status, 200, body)
	assert.Assert(t, !strings.Contains(body, "evil.yml"), "the escaping symlink must not be listed at all: %s", body)
	assert.Assert(t, !strings.Contains(body, secret), "the secret's contents must never reach the listing response: %s", body)

	status2, body2 := doRequest(t, ts, "GET", "/api/config?path="+evilPath, nil)
	assert.Assert(t, status2 != 200, "an escaping symlink must not be openable via ?path=, got %d: %s", status2, body2)
	assert.Assert(t, !strings.Contains(body2, secret), "the secret's contents must never be served: %s", body2)
}

// TestServer_Config_SymlinkToInsideDirRemainsReadable is the flip side of
// the disclosure test above: a symlink whose target stays inside the indexed
// directory is not the vulnerability, and this fix must not start treating
// it like one. See ListConfigDir's own doc comment for why "included when
// the target is still inside dir" was the containment rule chosen, over
// excluding every symlink outright.
func TestServer_Config_SymlinkToInsideDirRemainsReadable(t *testing.T) {
	dir := t.TempDir()
	ccDir := filepath.Join(dir, ".circleci")
	writeFile(t, filepath.Join(ccDir, "config.yml"), "version: 2.1\n")
	targetPath := filepath.Join(ccDir, "continue-config.yml")
	writeFile(t, targetPath, "version: 2.1\njobs: {}\n")
	aliasPath := filepath.Join(ccDir, "alias.yml")
	symlink(t, targetPath, aliasPath)

	ts := newTestServer(t, dir)

	status, body := doRequest(t, ts, "GET", "/api/config-files", nil)
	assert.Equal(t, status, 200, body)
	assert.Assert(t, is.Contains(body, `"relPath":"alias.yml"`))

	status2, body2 := doRequest(t, ts, "GET", "/api/config?path="+aliasPath, nil)
	assert.Equal(t, status2, 200, body2)
	assert.Assert(t, is.Contains(body2, "jobs"))
}

// TestServer_Config_Get_EnforcesSizeCap covers the other half of the report:
// GET /api/config?path= used to have no size cap at all, unlike the indexed
// listing's maxIndexedFileBytes -- so a symlink to an unbounded source (a
// device file, say) was an unbounded read. ConfigFile.Read now enforces the
// same cap on every read, symlink or not; this exercises it with an ordinary
// oversized file, which is enough to prove the read is bounded regardless of
// what a symlink might point at.
func TestServer_Config_Get_EnforcesSizeCap(t *testing.T) {
	dir := t.TempDir()
	ccDir := filepath.Join(dir, ".circleci")
	writeFile(t, filepath.Join(ccDir, "config.yml"), "version: 2.1\n")
	bigPath := filepath.Join(ccDir, "big.yml")
	assert.NilError(t, os.WriteFile(bigPath, make([]byte, maxIndexedFileBytesForTest+1), 0o644))

	ts := newTestServer(t, dir)

	status, body := doRequest(t, ts, "GET", "/api/config?path="+bigPath, nil)
	assert.Assert(t, status != 200, "a file over the size cap must not be served whole, got %d: %s", status, body)
}

func TestServer_ConfigFiles_Get(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, ".circleci", "config.yml"), "version: 2.1\nsetup: true\n")
	writeFile(t, filepath.Join(dir, ".circleci", "continue-config.yml"), "version: 2.1\njobs: {}\n")

	ts := newTestServer(t, dir)

	status, body := doRequest(t, ts, "GET", "/api/config-files", nil)
	assert.Equal(t, status, 200, body)

	var resp struct {
		Dir         string `json:"dir"`
		PrimaryPath string `json:"primaryPath"`
		Files       []struct {
			Path      string  `json:"path"`
			RelPath   string  `json:"relPath"`
			Size      int64   `json:"size"`
			IsPrimary bool    `json:"isPrimary"`
			Contents  *string `json:"contents"`
			Omitted   bool    `json:"omitted"`
		} `json:"files"`
	}
	assert.NilError(t, json.Unmarshal([]byte(body), &resp))
	assert.Equal(t, len(resp.Files), 2)
	assert.Equal(t, resp.Files[0].RelPath, "config.yml")
	assert.Equal(t, resp.Files[0].IsPrimary, true)
	assert.Equal(t, resp.Files[1].RelPath, "continue-config.yml")
	assert.Equal(t, resp.Files[1].IsPrimary, false)
	// contents were not requested (?contents=1 absent): must be absent,
	// not present-and-empty.
	assert.Assert(t, resp.Files[0].Contents == nil)

	status2, body2 := doRequest(t, ts, "GET", "/api/config-files?contents=1", nil)
	assert.Equal(t, status2, 200, body2)
	assert.NilError(t, json.Unmarshal([]byte(body2), &resp))
	assert.Assert(t, resp.Files[0].Contents != nil)
	assert.Equal(t, *resp.Files[0].Contents, "version: 2.1\nsetup: true\n")
	assert.Equal(t, resp.Files[0].Omitted, false)
}

func TestServer_ConfigFiles_NoConfigYetStillListsPrimary(t *testing.T) {
	dir := t.TempDir()
	ts := newTestServer(t, dir)

	status, body := doRequest(t, ts, "GET", "/api/config-files", nil)
	assert.Equal(t, status, 200, body)
	assert.Assert(t, is.Contains(body, `"isPrimary":true`))
	// The primary file is always a config, even when it doesn't exist yet:
	// hiding it from its own switcher would be absurd.
	assert.Assert(t, is.Contains(body, `"isConfig":true`))
}

// configFilesListing is the subset of GET /api/config-files the
// classification tests below assert on.
type configFilesListing struct {
	Files []struct {
		RelPath      string `json:"relPath"`
		IsPrimary    bool   `json:"isPrimary"`
		IsConfig     bool   `json:"isConfig"`
		ConfigReason string `json:"configReason"`
	} `json:"files"`
}

func TestServer_ConfigFiles_ClassifiesEachFile(t *testing.T) {
	dir := t.TempDir()
	ccDir := filepath.Join(dir, ".circleci")
	writeFile(t, filepath.Join(ccDir, "config.yml"), "version: 2.1\nsetup: true\n")
	writeFile(t, filepath.Join(ccDir, "continue-config.yml"), continuationFixture)
	// The reported defect: goss's own file, listed as if it were a config.
	writeFile(t, filepath.Join(ccDir, "goss.yaml"), gossFixture)
	// A nested one too -- the owner mentioned a subfolder, and the walk is
	// still recursive by design, so classification has to carry the filtering.
	writeFile(t, filepath.Join(ccDir, ".service", "goss.yaml"), gossFixture)
	// Malformed YAML must degrade to "not a config" without failing the
	// listing that the switcher renders.
	writeFile(t, filepath.Join(ccDir, "broken.yml"), "jobs: [unclosed\n")

	ts := newTestServer(t, dir)

	status, body := doRequest(t, ts, "GET", "/api/config-files", nil)
	assert.Equal(t, status, 200, body)

	var resp configFilesListing
	assert.NilError(t, json.Unmarshal([]byte(body), &resp))

	classified := make(map[string]bool, len(resp.Files))
	reasons := make(map[string]string, len(resp.Files))
	for _, f := range resp.Files {
		classified[f.RelPath] = f.IsConfig
		reasons[f.RelPath] = f.ConfigReason
		assert.Assert(t, f.ConfigReason != "", "%s carried no reason", f.RelPath)
	}

	assert.DeepEqual(t, classified, map[string]bool{
		".service/goss.yaml":  false,
		"broken.yml":          false,
		"config.yml":          true,
		"continue-config.yml": true,
		"goss.yaml":           false,
	})
	assert.Assert(t, is.Contains(reasons["goss.yaml"], "No CircleCI structure"))
	assert.Assert(t, is.Contains(reasons["broken.yml"], "Not parseable as YAML"))

	// Every file is still *listed* -- classification hides nothing from the
	// index, so a misclassified real config stays one click away in the UI
	// and openable through ?path=.
	assert.Equal(t, len(resp.Files), 5)
}

// TestServer_ConfigFiles_NonConfigStaysOpenable is the recoverability half
// of issue #135: filtering happens in the UI, so the host must still serve
// a file it classified as "not a config" when the user deliberately opens
// it.
func TestServer_ConfigFiles_NonConfigStaysOpenable(t *testing.T) {
	dir := t.TempDir()
	gossPath := filepath.Join(dir, ".circleci", "goss.yaml")
	writeFile(t, filepath.Join(dir, ".circleci", "config.yml"), "version: 2.1\n")
	writeFile(t, gossPath, gossFixture)

	ts := newTestServer(t, dir)

	status, body := doRequest(t, ts, "GET", "/api/config?path="+gossPath, nil)
	assert.Equal(t, status, 200, body)
	assert.Assert(t, is.Contains(body, "exit-status"))
}

// TestServer_ConfigFiles_MalformedFileDoesNotBlankTheListing pins the
// "degrade honestly" requirement at the boundary the switcher actually
// reads: a directory whose *only* non-primary file is unparseable must
// still return a complete 200 listing.
func TestServer_ConfigFiles_MalformedFileDoesNotBlankTheListing(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, ".circleci", "config.yml"), "version: 2.1\n")
	writeFile(t, filepath.Join(dir, ".circleci", "junk.yml"), "\x00\x01 not: [yaml\n")

	ts := newTestServer(t, dir)

	status, body := doRequest(t, ts, "GET", "/api/config-files", nil)
	assert.Equal(t, status, 200, body)

	var resp configFilesListing
	assert.NilError(t, json.Unmarshal([]byte(body), &resp))
	assert.Equal(t, len(resp.Files), 2)
	assert.Equal(t, resp.Files[0].RelPath, "config.yml")
	assert.Equal(t, resp.Files[0].IsConfig, true)
	assert.Equal(t, resp.Files[1].RelPath, "junk.yml")
	assert.Equal(t, resp.Files[1].IsConfig, false)
}

func TestServer_Config_PathParam_ReadsAndWritesSecondaryFile(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, ".circleci", "config.yml"), "version: 2.1\n")
	continuePath := filepath.Join(dir, ".circleci", "continue-config.yml")
	writeFile(t, continuePath, "version: 2.1\njobs: {}\n")

	ts := newTestServer(t, dir)

	status, body := doRequest(t, ts, "GET", "/api/config?path="+continuePath, nil)
	assert.Equal(t, status, 200, body)
	assert.Assert(t, is.Contains(body, "jobs"))

	newContents := "version: 2.1\njobs:\n  build:\n    docker: []\n"
	reqBody, err := json.Marshal(map[string]string{"contents": newContents})
	assert.NilError(t, err)
	putStatus, putBody := doRequest(t, ts, "PUT", "/api/config?path="+continuePath, reqBody)
	assert.Equal(t, putStatus, 200, putBody)

	onDisk, err := os.ReadFile(continuePath)
	assert.NilError(t, err)
	assert.Equal(t, string(onDisk), newContents)

	// The primary file must be completely untouched by a write scoped to
	// the secondary path -- "never write to a file the user didn't open".
	primary, err := os.ReadFile(filepath.Join(dir, ".circleci", "config.yml"))
	assert.NilError(t, err)
	assert.Equal(t, string(primary), "version: 2.1\n")
}
