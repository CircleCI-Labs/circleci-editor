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

package host

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"gotest.tools/v3/assert"
)

func TestParseGitRemote(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		remote   string
		wantHost string
		wantRepo string
	}{
		{"scp-like ssh", "git@github.com:acme/web.git", "github.com", "acme/web"},
		{"scp-like without .git", "git@github.com:acme/web", "github.com", "acme/web"},
		{"scp-like bitbucket", "git@bitbucket.org:acme/web.git", "bitbucket.org", "acme/web"},
		{"https", "https://github.com/acme/web.git", "github.com", "acme/web"},
		{"https without .git", "https://github.com/acme/web", "github.com", "acme/web"},
		{"ssh scheme", "ssh://git@github.com/acme/web.git", "github.com", "acme/web"},
		{"ssh scheme with port", "ssh://git@github.example.com:2222/acme/web.git", "github.example.com", "acme/web"},
		{"git scheme", "git://github.com/acme/web.git", "github.com", "acme/web"},
		{"nested gitlab group", "https://gitlab.com/group/subgroup/web.git", "gitlab.com", "group/subgroup/web"},
		{"self-hosted host kept", "git@git.internal.example:team/web.git", "git.internal.example", "team/web"},

		// A remote URL is allowed to carry credentials, and this value is sent
		// to the browser. Neither the userinfo nor the port may survive.
		{"https with token credentials", "https://x-access-token:ghs_secret@github.com/acme/web.git", "github.com", "acme/web"},
		{"https with user and password", "https://user:hunter2@github.com/acme/web.git", "github.com", "acme/web"},
		{"https with port", "https://github.example.com:8443/acme/web.git", "github.example.com", "acme/web"},

		// Nothing to browse. The two halves are validated independently, and
		// LoadGitInfo requires both before it will build a URL -- so a
		// recognisable host with an unusable path (and vice versa) still
		// reports the half it could make sense of, and yields no link.
		{"empty", "", "", ""},
		{"local path", "/srv/git/web.git", "", ""},
		{"relative path", "../sibling", "", ""},
		{"file url", "file:///srv/git/web.git", "", ""},
		{"single segment path", "https://github.com/acme", "github.com", ""},
		// An SSH alias from ~/.ssh/config, or a bare "localhost": a host with
		// no dot in it is not a hostname this code will build https:// onto --
		// "github" would otherwise match the browsable-host rule and produce
		// https://github/acme/web.
		{"no host dot", "git@localhost:acme/web.git", "", "acme/web"},
		{"ssh alias", "git@github:acme/web.git", "", "acme/web"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			host, repo := parseGitRemote(tt.remote)
			assert.Equal(t, host, tt.wantHost)
			assert.Equal(t, repo, tt.wantRepo)
		})
	}
}

func TestIsWebBrowsableGitHost(t *testing.T) {
	t.Parallel()

	for _, host := range []string{"github.com", "GitHub.com", "github.example.com", "bitbucket.org", "gitlab.com", "gitlab.example.com"} {
		assert.Assert(t, isWebBrowsableGitHost(host), "expected %q to be browsable", host)
	}
	for _, host := range []string{"git.internal.example", "codeberg.org", "example.com"} {
		assert.Assert(t, !isWebBrowsableGitHost(host), "expected %q not to be browsable", host)
	}
}

// initRepo makes a throwaway checkout, or skips when git isn't available --
// LoadGitInfo's whole contract is that it degrades to empty, so a machine
// without git has nothing to assert here.
func initRepo(t *testing.T, remote string) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...) // #nosec G204 -- literal args, test-local dir.
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		assert.NilError(t, err, "git %v: %s", args, out)
	}
	run("init", "--initial-branch=trunk")
	// Identity and hooks are configured locally so this never depends on (or
	// touches) the developer's global git config.
	run("config", "user.email", "test@example.invalid")
	run("config", "user.name", "Test")
	if remote != "" {
		run("remote", "add", "origin", remote)
	}
	return dir
}

func TestLoadGitInfoReadsBranchAndRemote(t *testing.T) {
	t.Parallel()

	dir := initRepo(t, "git@github.com:acme/web.git")
	info := LoadGitInfo(dir)

	assert.Equal(t, info.Branch, "trunk")
	assert.Equal(t, info.RemoteHost, "github.com")
	assert.Equal(t, info.RemoteRepo, "acme/web")
	assert.Equal(t, info.RemoteURL, "https://github.com/acme/web")
}

func TestLoadGitInfoFromASubdirectory(t *testing.T) {
	t.Parallel()

	// The anchor GET /api/meta actually uses is the config file's directory,
	// i.e. `<repo>/.circleci` -- git has to resolve the enclosing repository
	// from there, not only from the root.
	dir := initRepo(t, "https://github.com/acme/web.git")
	sub := filepath.Join(dir, ".circleci")
	assert.NilError(t, os.MkdirAll(sub, 0o755))

	info := LoadGitInfo(sub)
	assert.Equal(t, info.Branch, "trunk")
	assert.Equal(t, info.RemoteURL, "https://github.com/acme/web")
}

func TestLoadGitInfoWithoutARemote(t *testing.T) {
	t.Parallel()

	info := LoadGitInfo(initRepo(t, ""))
	assert.Equal(t, info.Branch, "trunk")
	assert.Equal(t, info.RemoteURL, "")
	assert.Equal(t, info.RemoteRepo, "")
	assert.Equal(t, info.RemoteHost, "")
}

func TestLoadGitInfoUnrecognisedHostGetsNoURL(t *testing.T) {
	t.Parallel()

	// A legible path, but no assumption about a web layout this code has never
	// seen -- the same rule Environment.ProjectWebURLForSlug applies.
	info := LoadGitInfo(initRepo(t, "git@git.internal.example:team/web.git"))
	assert.Equal(t, info.RemoteRepo, "team/web")
	assert.Equal(t, info.RemoteHost, "git.internal.example")
	assert.Equal(t, info.RemoteURL, "")
}

func TestLoadGitInfoOutsideACheckout(t *testing.T) {
	t.Parallel()

	// Editing a config outside a repository is ordinary, not an error.
	info := LoadGitInfo(t.TempDir())
	assert.Equal(t, info, GitInfo{})
}

func TestLoadGitInfoEmptyDirectory(t *testing.T) {
	t.Parallel()

	assert.Equal(t, LoadGitInfo(""), GitInfo{})
}

// metaGitFields is the slice of GET /api/meta issue #214 added.
type metaGitFields struct {
	Branch       string `json:"branch"`
	BranchSource string `json:"branchSource"`
	EnvBranch    string `json:"envBranch"`
	RepoWebURL   string `json:"repoWebUrl"`
	RepoName     string `json:"repoName"`
	RepoHost     string `json:"repoHost"`
}

func fetchMetaGitFields(t *testing.T, workDir string) metaGitFields {
	t.Helper()

	srv, err := New(Options{WorkDir: workDir, Version: "test-version"})
	assert.NilError(t, err)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/meta") // #nosec G107 -- httptest URL.
	assert.NilError(t, err)
	defer func() { assert.NilError(t, resp.Body.Close()) }()
	assert.Equal(t, resp.StatusCode, http.StatusOK)

	var got metaGitFields
	assert.NilError(t, json.NewDecoder(resp.Body).Decode(&got))
	return got
}

// The checkout wins over CIRCLE_BRANCH, and the injected value is still
// reported so the top bar can say the two disagree rather than quietly
// preferring one (issue #214).
func TestMetaPrefersTheCheckoutBranchOverTheInjectedOne(t *testing.T) {
	dir := initRepo(t, "git@github.com:acme/web.git")
	t.Setenv("CIRCLE_BRANCH", "injected-release-branch")

	got := fetchMetaGitFields(t, dir)
	assert.Equal(t, got.Branch, "trunk")
	assert.Equal(t, got.BranchSource, "checkout")
	assert.Equal(t, got.EnvBranch, "injected-release-branch")
	assert.Equal(t, got.RepoWebURL, "https://github.com/acme/web")
	assert.Equal(t, got.RepoName, "acme/web")
	assert.Equal(t, got.RepoHost, "github.com")
}

func TestMetaFallsBackToTheInjectedBranchOutsideACheckout(t *testing.T) {
	t.Setenv("CIRCLE_BRANCH", "injected-release-branch")

	got := fetchMetaGitFields(t, t.TempDir())
	assert.Equal(t, got.Branch, "injected-release-branch")
	assert.Equal(t, got.BranchSource, "environment")
	assert.Equal(t, got.RepoWebURL, "")
}

func TestMetaReportsNoBranchWhenNeitherSourceHasOne(t *testing.T) {
	t.Setenv("CIRCLE_BRANCH", "")

	got := fetchMetaGitFields(t, t.TempDir())
	assert.Equal(t, got, metaGitFields{})
}

// A remote is allowed to carry credentials, and GET /api/meta is served to the
// browser: the sentinel must not appear anywhere in the response.
func TestMetaNeverLeaksRemoteCredentials(t *testing.T) {
	dir := initRepo(t, "https://x-access-token:"+sentinelRemoteSecret+"@github.com/acme/web.git")

	srv, err := New(Options{WorkDir: dir, Version: "test-version"})
	assert.NilError(t, err)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/meta") // #nosec G107 -- httptest URL.
	assert.NilError(t, err)
	defer func() { assert.NilError(t, resp.Body.Close()) }()
	body, err := io.ReadAll(resp.Body)
	assert.NilError(t, err)

	assert.Assert(t, !strings.Contains(string(body), sentinelRemoteSecret),
		"response leaked the remote's credentials: %s", body)
	assert.Assert(t, strings.Contains(string(body), `"repoWebUrl":"https://github.com/acme/web"`))
}

const sentinelRemoteSecret = "sentinel-remote-credential-value"
