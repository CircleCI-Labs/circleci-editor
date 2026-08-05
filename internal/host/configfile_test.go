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
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gotest.tools/v3/assert"
	is "gotest.tools/v3/assert/cmp"

	"github.com/CircleCI-Labs/circleci-editor/internal/host"
)

func TestFindConfigFile_ExplicitPath(t *testing.T) {
	tests := []struct {
		name         string
		startDir     string
		explicitPath string
		wantContains string
	}{
		{
			name:         "absolute path used as-is",
			startDir:     t.TempDir(),
			explicitPath: "/somewhere/config.yml",
			wantContains: "/somewhere/config.yml",
		},
		{
			name:         "relative path resolved against start dir",
			startDir:     t.TempDir(),
			explicitPath: "nested/config.yml",
			wantContains: "nested/config.yml",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := host.FindConfigFile(tc.startDir, tc.explicitPath)
			assert.NilError(t, err)
			assert.Assert(t, filepath.IsAbs(cfg.Path))
			assert.Assert(t, is.Contains(cfg.Path, filepath.FromSlash(tc.wantContains)))
		})
	}
}

func TestFindConfigFile_WalksUpFromNestedDir(t *testing.T) {
	tests := []struct {
		name       string
		configName string
	}{
		{name: "config.yml", configName: "config.yml"},
		{name: "config.yaml", configName: "config.yaml"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			circleciDir := filepath.Join(root, ".circleci")
			assert.NilError(t, os.MkdirAll(circleciDir, 0o755))

			configPath := filepath.Join(circleciDir, tc.configName)
			assert.NilError(t, os.WriteFile(configPath, []byte("version: 2.1\n"), 0o644))

			nested := filepath.Join(root, "a", "b", "c")
			assert.NilError(t, os.MkdirAll(nested, 0o755))

			cfg, err := host.FindConfigFile(nested, "")
			assert.NilError(t, err)
			assert.Equal(t, cfg.Path, configPath)
		})
	}
}

func TestFindConfigFile_StopsAtGitRoot(t *testing.T) {
	root := t.TempDir()
	assert.NilError(t, os.MkdirAll(filepath.Join(root, ".git"), 0o755))

	nested := filepath.Join(root, "a", "b")
	assert.NilError(t, os.MkdirAll(nested, 0o755))

	cfg, err := host.FindConfigFile(nested, "")
	assert.Assert(t, errors.Is(err, host.ErrConfigNotFound))
	assert.Equal(t, cfg.Path, filepath.Join(nested, ".circleci", "config.yml"))
}

func TestFindConfigFile_NotFoundReturnsDefaultPath(t *testing.T) {
	startDir := t.TempDir()

	cfg, err := host.FindConfigFile(startDir, "")
	assert.Assert(t, errors.Is(err, host.ErrConfigNotFound))
	assert.Equal(t, cfg.Path, filepath.Join(startDir, ".circleci", "config.yml"))
}

func TestConfigFile_Read_MissingFile(t *testing.T) {
	cfg := host.ConfigFile{Path: filepath.Join(t.TempDir(), ".circleci", "config.yml")}

	contents, exists, err := cfg.Read()
	assert.NilError(t, err)
	assert.Equal(t, exists, false)
	assert.Equal(t, contents, "")
}

// TestConfigFile_Read_SizeCap covers the gap the local-file-disclosure
// report flagged: GET /api/config?path= (this method, underneath it) had no
// size cap at all, unlike GET /api/config-files' maxIndexedFileBytes limit --
// so a symlink to an unbounded source (a device file, say) was an unbounded
// read. A plain oversized regular file is enough to prove the read itself is
// now bounded; see ConfigFile.Read's own doc comment for why the cap is
// enforced against bytes actually read rather than a stat'd size (a device
// file can report a size of 0 while still yielding unlimited bytes).
func TestConfigFile_Read_SizeCap(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	// One byte over the cap -- the smallest input that must be rejected.
	assert.NilError(t, os.WriteFile(path, make([]byte, maxIndexedFileBytesForTest+1), 0o644))

	cfg := host.ConfigFile{Path: path}
	contents, _, err := cfg.Read()
	assert.Assert(t, err != nil, "a file one byte over the cap must be rejected, not silently read")
	assert.Assert(t, is.Contains(err.Error(), "exceeds"))
	assert.Equal(t, contents, "", "no partial contents should be handed back on a rejected read")
}

// TestConfigFile_Read_AtCapIsStillReadable pins the cap's edge the other
// way: a file exactly at the limit is still ordinary, valid input and must
// not be rejected by an off-by-one in the cap check.
func TestConfigFile_Read_AtCapIsStillReadable(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	body := make([]byte, maxIndexedFileBytesForTest)
	for i := range body {
		body[i] = 'a'
	}
	assert.NilError(t, os.WriteFile(path, body, 0o644))

	cfg := host.ConfigFile{Path: path}
	contents, exists, err := cfg.Read()
	assert.NilError(t, err)
	assert.Equal(t, exists, true)
	assert.Equal(t, len(contents), len(body))
}

// The tests below cover RefuseEscapingPrimarySymlink and the boundary it
// closes: GET/PUT /api/config with no ?path= resolves the server's primary
// config file through resolveConfigTarget's own early return, which never
// consults ListConfigDir or resolveIndexedPath at all -- so a
// `.circleci/config.yml` that is itself a symlink escaping the repository
// was still followed and served in full (bounded only by the size cap
// above), even after the ListConfigDir/resolveIndexedPath fix for
// `.circleci/evil.yml`-style secondary files.
func TestConfigFile_RefuseEscapingPrimarySymlink(t *testing.T) {
	t.Run("a symlink whose target escapes root is refused", func(t *testing.T) {
		root := t.TempDir()
		outsideDir := t.TempDir()
		secretPath := filepath.Join(outsideDir, "secret.yml")
		writeFile(t, secretPath, "PRIVATE_KEY_CONTENT_HERE\n")

		configPath := filepath.Join(root, ".circleci", "config.yml")
		symlink(t, secretPath, configPath)

		cfg := host.ConfigFile{Path: configPath}
		err := cfg.RefuseEscapingPrimarySymlink(root)
		assert.Assert(t, err != nil, "a primary symlink escaping root must be refused")
		assert.Assert(t, is.Contains(err.Error(), "outside the repository"))
		assert.Assert(t, is.Contains(err.Error(), secretPath))
	})

	t.Run("a symlink whose target is inside root is allowed", func(t *testing.T) {
		root := t.TempDir()
		sharedPath := filepath.Join(root, "shared", "config.yml")
		writeFile(t, sharedPath, "version: 2.1\njobs: {}\n")

		configPath := filepath.Join(root, ".circleci", "config.yml")
		symlink(t, sharedPath, configPath)

		cfg := host.ConfigFile{Path: configPath}
		assert.NilError(t, cfg.RefuseEscapingPrimarySymlink(root))
	})

	t.Run("an ordinary (non-symlink) config file is allowed", func(t *testing.T) {
		root := t.TempDir()
		configPath := filepath.Join(root, ".circleci", "config.yml")
		writeFile(t, configPath, "version: 2.1\n")

		cfg := host.ConfigFile{Path: configPath}
		assert.NilError(t, cfg.RefuseEscapingPrimarySymlink(root))
	})

	t.Run("a missing config file is allowed -- nothing to refuse yet", func(t *testing.T) {
		root := t.TempDir()
		cfg := host.ConfigFile{Path: filepath.Join(root, ".circleci", "config.yml")}
		assert.NilError(t, cfg.RefuseEscapingPrimarySymlink(root))
	})

	t.Run("a broken symlink is refused, not silently treated as absent", func(t *testing.T) {
		root := t.TempDir()
		configPath := filepath.Join(root, ".circleci", "config.yml")
		symlink(t, filepath.Join(root, "does-not-exist.yml"), configPath)

		cfg := host.ConfigFile{Path: configPath}
		assert.Assert(t, cfg.RefuseEscapingPrimarySymlink(root) != nil)
	})
}

// TestServer_Config_Get_RefusesEscapingPrimarySymlink reproduces the residual
// disclosure at the HTTP boundary a real client hits: GET /api/config with
// no ?path= is exactly what the editor's own initial load calls, and it
// bypasses ListConfigDir/resolveIndexedPath entirely, so a
// `.circleci/config.yml` symlinked to a file outside the repository was
// served in full regardless of the ListConfigDir fix for secondary files.
func TestServer_Config_Get_RefusesEscapingPrimarySymlink(t *testing.T) {
	root := t.TempDir()
	outsideDir := t.TempDir()
	secretPath := filepath.Join(outsideDir, "secret.yml")
	const secret = "PRIVATE_KEY_CONTENT_HERE"
	writeFile(t, secretPath, secret+"\n")

	configPath := filepath.Join(root, ".circleci", "config.yml")
	symlink(t, secretPath, configPath)

	ts := newTestServer(t, root)

	status, body := doRequest(t, ts, "GET", "/api/config", nil)
	assert.Assert(t, status != 200, "an escaping primary symlink must not be served, got %d: %s", status, body)
	assert.Assert(t, !strings.Contains(body, secret), "the secret's contents must never be served: %s", body)
	assert.Assert(t, strings.Contains(body, "outside the repository"), "the refusal must explain itself on screen, not just fail: %s", body)

	// resolveConfigTarget is shared by GET and PUT -- a save through the
	// same escaping primary path must be refused too, not just a read.
	putStatus, putBody := doRequest(t, ts, "PUT", "/api/config", []byte(`{"contents":"version: 2.1\n"}`))
	assert.Assert(t, putStatus != 200, "writing through an escaping primary symlink must also be refused, got %d: %s", putStatus, putBody)
}

// TestServer_Config_Get_FollowsInRepoPrimarySymlink is the case the fix
// above must not break: a `.circleci/config.yml` symlinked to a file
// elsewhere in the *same* repository -- a config shared across a
// monorepo's several projects, say -- is a legitimate pattern and must
// keep working exactly as it did before RefuseEscapingPrimarySymlink
// existed.
func TestServer_Config_Get_FollowsInRepoPrimarySymlink(t *testing.T) {
	root := t.TempDir()
	const sharedContents = "version: 2.1\njobs: {}\n"
	sharedPath := filepath.Join(root, "shared", "config.yml")
	writeFile(t, sharedPath, sharedContents)

	configPath := filepath.Join(root, ".circleci", "config.yml")
	symlink(t, sharedPath, configPath)

	ts := newTestServer(t, root)

	status, body := doRequest(t, ts, "GET", "/api/config", nil)
	assert.Equal(t, status, 200, body)
	assert.Assert(t, is.Contains(body, "jobs"))
}

// TestServer_Config_Get_ExplicitConfigPathIsNeverRefused proves the third
// requirement: an explicit --config value is the user naming that exact
// file themselves, which is consent rather than an escape, and must be
// honoured even when it points well outside whatever directory WorkDir
// happens to be -- including when the explicit path is itself a symlink
// nowhere near WorkDir. If RefuseEscapingPrimarySymlink ran for this case
// at all, this would be refused exactly like the escaping case above.
func TestServer_Config_Get_ExplicitConfigPathIsNeverRefused(t *testing.T) {
	workDir := t.TempDir()
	elsewhere := t.TempDir()
	const contents = "version: 2.1\nsetup: true\n"
	realPath := filepath.Join(elsewhere, "real-config.yml")
	writeFile(t, realPath, contents)

	explicitPath := filepath.Join(t.TempDir(), "explicit-config.yml")
	symlink(t, realPath, explicitPath)

	srv, err := host.New(host.Options{WorkDir: workDir, ConfigPath: explicitPath, Version: "test-version"})
	assert.NilError(t, err)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	status, body := doRequest(t, ts, "GET", "/api/config", nil)
	assert.Equal(t, status, 200, body)
	assert.Assert(t, is.Contains(body, "setup"))
}

func TestConfigFile_Write_CreatesDirAndRoundTrips(t *testing.T) {
	dir := t.TempDir()
	cfg := host.ConfigFile{Path: filepath.Join(dir, ".circleci", "config.yml")}

	const body = "version: 2.1\njobs: {}\n"
	n, err := cfg.Write(body)
	assert.NilError(t, err)
	assert.Equal(t, n, len(body))

	contents, exists, err := cfg.Read()
	assert.NilError(t, err)
	assert.Equal(t, exists, true)
	assert.Equal(t, contents, body)
}

func TestConfigFile_Write_FullyReplacesExistingContent(t *testing.T) {
	dir := t.TempDir()
	assert.NilError(t, os.MkdirAll(filepath.Join(dir, ".circleci"), 0o755))
	cfg := host.ConfigFile{Path: filepath.Join(dir, ".circleci", "config.yml")}

	_, err := cfg.Write("this is a much longer initial document than the replacement\n")
	assert.NilError(t, err)

	const replacement = "short\n"
	_, err = cfg.Write(replacement)
	assert.NilError(t, err)

	contents, exists, err := cfg.Read()
	assert.NilError(t, err)
	assert.Equal(t, exists, true)
	assert.Equal(t, contents, replacement)

	// No stray temp files should be left behind in the directory.
	entries, err := os.ReadDir(filepath.Join(dir, ".circleci"))
	assert.NilError(t, err)
	assert.Equal(t, len(entries), 1)
	assert.Equal(t, entries[0].Name(), "config.yml")
}
